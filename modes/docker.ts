import {coerce, diff, gt, satisfies} from "../utils/semver.ts";
import {type Deps, type ModeContext, type PackageInfo, fieldSep, fetchWithEtag, isSameVersionScheme, passesCooldown, stripv, formatVersionPrecision, maxTagPages} from "./shared.ts";
import {esc} from "../utils/utils.ts";

export type DockerImageRef = {
  registry: string | null,
  namespace: string,
  repo: string,
  tag: string,
  fullImage: string,
};

// Match semver or semver-prefix tags, with optional suffix like -alpine
// Examples: "18", "18.19", "18.19.1", "v1.2.3", "18-alpine", "1.2.3-bookworm"
const dockerTagRe = /^(v?\d+(?:\.\d+){0,2})(-.+)?$/;

// Extraction regexes
// Dockerfile instructions are case-insensitive
export const dockerfileFromRe = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;
export const composeImageRe = /^\s*image:\s*['"]?([^\s'"#]+)['"]?/gm;
// Matches shorthand `container: image:tag` (not object form with `{`)
export const workflowContainerRe = /^\s*container:\s*['"]?([^\s'"#{}]+:[^\s'"#{}:]+)['"]?\s*$/gm;
// Matches `uses: docker://image:tag`
export const workflowDockerUsesRe = /^\s*(?:-\s*)?uses:\s*['"]?docker:\/\/([^'"#\s]+)['"]?/gm;

// docker.io and index.docker.io are Docker Hub itself, not a third-party registry.
const hubRegistryRe = /^(?:index\.)?docker\.io$/;

function parseImageParts(imagePart: string): {registry: string | null, namespace: string, repo: string} {
  const parts = imagePart.split("/");
  if (parts.length > 1 && hubRegistryRe.test(parts[0])) parts.shift();
  if (parts.length === 1) {
    return {registry: null, namespace: "library", repo: parts[0]};
  } else if (parts.length === 2 && !parts[0].includes(".") && !parts[0].includes(":")) {
    return {registry: null, namespace: parts[0], repo: parts[1]};
  } else {
    return {registry: parts[0], namespace: parts.slice(1, -1).join("/"), repo: parts[parts.length - 1]};
  }
}

// Hub images are addressable with or without the `docker.io/` registry and `library/`
// namespace, so a user-supplied name in any of those spellings matches the image.
export function dockerImageNames(image: string): Array<string> {
  const {registry, namespace, repo} = parseImageParts(image);
  if (registry) return [image];
  const paths = namespace === "library" ? [repo, `library/${repo}`] : [`${namespace}/${repo}`];
  return [...new Set([image, ...paths, ...paths.map(path => `docker.io/${path}`)])];
}

export function parseDockerImageRef(ref: string): DockerImageRef | null {
  ref = ref.replace(/^docker:\/\//, "");

  if (ref.includes("@")) return null; // digest-pinned, skip

  const colonIndex = ref.lastIndexOf(":");
  if (colonIndex === -1 || ref.lastIndexOf("/") > colonIndex) {
    return null; // no tag specified, skip
  }

  const imagePart = ref.substring(0, colonIndex);
  const tag = ref.substring(colonIndex + 1);

  if (!tag || !dockerTagRe.test(tag)) return null; // non-semver tag

  const {registry, namespace, repo} = parseImageParts(imagePart);
  return {registry, namespace, repo, tag, fullImage: imagePart};
}

export function parseDockerTag(tag: string): {version: string, suffix: string} | null {
  const match = dockerTagRe.exec(tag);
  if (!match) return null;
  return {version: match[1], suffix: match[2] || ""};
}

export function formatDockerVersion(newSemver: string, oldTag: string): string {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return oldTag;
  return formatVersionPrecision(newSemver, oldParsed.version, oldParsed.suffix);
}

export function extractDockerRefs(content: string, regex: RegExp): Array<{ref: DockerImageRef, match: string}> {
  const results: Array<{ref: DockerImageRef, match: string}> = [];
  for (const m of content.matchAll(regex)) {
    const ref = parseDockerImageRef(m[1]);
    if (ref) results.push({ref, match: m[1]});
  }
  return results;
}

// Dedup concurrent lookups for the same repo within one run — a Dockerfile and
// a Makefile can reference the same image from independent fetch tasks, which
// would double the requests and race the cache writes. Keyed by ctx so each
// updates() call (and each test) starts fresh.
const hubTagsByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, string>>>>();

export function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  let byRepo = hubTagsByCtx.get(ctx);
  if (!byRepo) hubTagsByCtx.set(ctx, byRepo = new Map());
  const key = `${namespace}/${repo}`;
  let promise = byRepo.get(key);
  if (!promise) byRepo.set(key, promise = fetchDockerHubTagsUncached(namespace, repo, ctx));
  return promise;
}

async function fetchDockerHubTagsUncached(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  const baseUrl = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags`;
  const pageUrl = (page: number) => `${baseUrl}?page_size=100&ordering=last_updated&page=${page}`;
  const pageOpts = {headers: {"accept-encoding": "gzip, deflate, br"}};

  // Hub tag pages carry per-architecture image lists; only name and push date are read.
  const reduceTagsPage = (data: Record<string, any>) => ({
    count: data.count,
    results: (data.results || []).map((r: Record<string, any>) => ({
      name: r.name, tag_last_pushed: r.tag_last_pushed, last_updated: r.last_updated,
    })),
  });

  const fetchPage = async (page: number): Promise<any | null> => {
    try {
      const result = await fetchWithEtag(pageUrl(page), ctx, pageOpts, reduceTagsPage);
      if (!("body" in result)) return null;
      return JSON.parse(result.body);
    } catch { return null; }
  };

  const firstPage = await fetchPage(1);
  if (!firstPage) return tags;
  for (const result of firstPage.results || []) {
    tags[result.name] = result.tag_last_pushed || result.last_updated || "";
  }
  const totalPages = Math.min(Math.ceil((firstPage.count || 0) / 100), maxTagPages);
  if (totalPages < 2) return tags;

  const rest = await Promise.all(
    Array.from({length: totalPages - 1}, (_, idx) => fetchPage(idx + 2)),
  );
  for (const page of rest) {
    if (!page) continue;
    for (const result of page.results || []) {
      tags[result.name] = result.tag_last_pushed || result.last_updated || "";
    }
  }
  return tags;
}

// Resolve the manifest digest for a single tag (used to keep `image:tag@sha256:…` pins in sync).
export async function fetchDockerTagDigest(namespace: string, repo: string, tag: string, ctx: ModeContext): Promise<string | null> {
  const url = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags/${tag}`;
  try {
    const result = await fetchWithEtag(url, ctx, {headers: {"accept-encoding": "gzip, deflate, br"}}, data => ({digest: data.digest}));
    if (!("body" in result)) return null;
    const digest = JSON.parse(result.body).digest;
    return typeof digest === "string" ? digest : null;
  } catch { return null; }
}

export async function fetchDockerInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const {registry, namespace, repo} = parseImageParts(name);

  if (registry) {
    throw new Error(`Non-Docker-Hub registries are not yet supported: ${registry}`);
  }

  const tags = await fetchDockerHubTags(namespace, repo, ctx);
  return [{tags, name}, null];
}

export function findDockerVersion(
  tagMap: Record<string, string>,
  oldTag: string,
  semvers: Set<string>,
  cooldownDays?: number,
  now?: number,
  pinnedRange?: string,
): {newTag: string, date: string} | null {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return null;

  const oldCoerced = coerce(stripv(oldParsed.version))?.version;
  if (!oldCoerced) return null;

  let bestVersion = oldCoerced;
  let bestTag = "";
  let bestDate = "";

  for (const [tagName, lastUpdated] of Object.entries(tagMap)) {
    const parsed = parseDockerTag(tagName);
    if (!parsed || parsed.suffix !== oldParsed.suffix) continue;
    if (!isSameVersionScheme(parsed.version, oldParsed.version)) continue;

    const coerced = coerce(stripv(parsed.version))?.version;
    if (!coerced) continue;

    if (pinnedRange && !satisfies(coerced, pinnedRange)) continue;

    if (!passesCooldown(lastUpdated, cooldownDays, now)) continue;

    if (coerced === bestVersion) {
      // duplicate tags coerce to the same version — keep the most recently pushed one
      if (bestTag && Date.parse(lastUpdated) > Date.parse(bestDate)) {
        bestTag = tagName;
        bestDate = lastUpdated;
      }
      continue;
    }

    const d = diff(bestVersion, coerced);
    if (!d || !semvers.has(d)) continue;

    if (gt(coerced, bestVersion)) {
      bestVersion = coerced;
      bestTag = tagName;
      bestDate = lastUpdated;
    }
  }

  if (!bestTag || bestVersion === oldCoerced) return null;
  // The precision-matched tag is synthesized, so keep the real Hub tag when the registry
  // does not publish it — writing a tag that does not exist breaks the build.
  const formatted = formatDockerVersion(bestVersion, oldTag);
  const newTag = formatted in tagMap ? formatted : bestTag;
  if (newTag === oldTag) return null;
  return {newTag, date: bestDate};
}

// Ends a tag match. Excludes `@` and `+` on top of tag characters so a digest-pinned or
// build-suffixed occurrence, which the extractor skips, is never rewritten to a bare tag
// the digest then contradicts.
const tagEnd = "(?![\\w.@+-])";

function replaceImageRefs(content: string, deps: Deps, patterns: Array<(name: string, tag: string) => RegExp>): string {
  let newContent = content;
  for (const [key, dep] of Object.entries(deps)) {
    const name = key.split(fieldSep)[1];
    const oldTag = dep.oldOrig || dep.old;
    for (const makeRegex of patterns) {
      newContent = newContent.replace(makeRegex(esc(name), esc(oldTag)), `$1${name}:${dep.new}`);
    }
  }
  return newContent;
}

export function updateDockerfile(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    (name, tag) => new RegExp(`(FROM\\s+(?:--platform=\\S+\\s+)?)${name}:${tag}${tagEnd}`, "gi"),
  ]);
}

export function updateComposeFile(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    (name, tag) => new RegExp(`(image:\\s*['"]?)${name}:${tag}${tagEnd}`, "g"),
  ]);
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    (name, tag) => new RegExp(`((?:container|image):\\s*['"]?)${name}:${tag}${tagEnd}`, "g"),
    (name, tag) => new RegExp(`(uses:\\s*['"]?docker://)${name}:${tag}${tagEnd}`, "g"),
  ]);
}

// Exact filenames for auto-discovery via findUpSync, which cannot glob. Deliberately
// narrower than isDockerFileName, which every entry must still satisfy.
export const dockerExactFileNames = [
  "Dockerfile",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

export function isComposeFile(filename: string): boolean {
  // `compose` is the canonical Compose Spec name; `docker-` also covers swarm stack files
  return /^(?:docker-|compose).*\.ya?ml$/.test(filename);
}

export function isDockerfile(filename: string): boolean {
  return /^Dockerfile(\..+)?$/.test(filename);
}

export function isDockerFileName(filename: string): boolean {
  return isDockerfile(filename) || isComposeFile(filename);
}

export function getExtractionRegex(filename: string): RegExp {
  if (isDockerfile(filename)) return dockerfileFromRe;
  return composeImageRe;
}

export function getDockerInfoUrl(ref: DockerImageRef): string {
  if (ref.registry) return "";
  if (ref.namespace === "library") return `https://hub.docker.com/_/${ref.repo}`;
  return `https://hub.docker.com/r/${ref.namespace}/${ref.repo}`;
}
