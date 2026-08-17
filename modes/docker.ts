import {coerce, diff, gt, satisfies} from "../utils/semver.ts";
import {longestFirstAlternation} from "../utils/utils.ts";
import {type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, effectiveConcurrency, getLimiter, isSameVersionScheme, passesCooldown, reduceJson, stripv, throwFetchError, formatVersionPrecision, maxTagPages} from "./shared.ts";

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

// A Dockerfile and a Makefile can reference the same image from independent fetch tasks, which
// would double the requests and race the cache writes. Keyed by ctx so each run starts fresh.
const hubTagsByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, string>>>>();

export function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  return dedupe(hubTagsByCtx, ctx, `${namespace}/${repo}`, () =>
    fetchDockerHubTagsUncached(namespace, repo, ctx));
}

// "Nothing to offer" rather than "the registry is unwell": an unknown repo, and the 401/403 an
// anonymous read of a private one gets, which renovate also swallows.
const noTagsStatus = new Set([401, 403, 404]);

const tagDate = (result: Record<string, any>): string => result.tag_last_pushed || result.last_updated || "";

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
    const url = pageUrl(page);
    const result = await fetchWithEtag(url, ctx, pageOpts, reduceJson(reduceTagsPage));
    if ("body" in result) return JSON.parse(result.body);
    // Everything else is a host problem, and a rate-limited or broken registry read as up to date
    // hides the updates the run exists to find. Renovate raises ExternalHostError for those.
    if (!noTagsStatus.has(result.res?.status as number)) throwFetchError(result.res, url, `${namespace}/${repo}`, ctx.dockerApiUrl);
    return null;
  };

  const addPage = (page: any) => {
    for (const result of page?.results || []) tags[result.name] = tagDate(result);
  };

  const limit = getLimiter(ctx);
  const firstPage = await limit(() => fetchPage(1));
  if (!firstPage) return tags;
  addPage(firstPage);
  // Every page is walked: `ordering=last_updated` is a push order, so a backport or an unevenly
  // rebuilt tag puts a higher version behind an older page and no date bounds the walk. Hub reports
  // the total up front, so the rest go out a wave at a time, doubling up to the socket budget.
  const totalPages = Math.min(Math.ceil((firstPage.count || 0) / 100), maxTagPages);
  const maxWave = effectiveConcurrency(ctx);
  for (let next = 2, wave = 1; next <= totalPages; next += wave, wave = Math.min(wave * 2, maxWave)) {
    const pages = await Promise.all(
      Array.from({length: Math.min(wave, totalPages - next + 1)}, (_, idx) => limit(() => fetchPage(next + idx))),
    );
    for (const page of pages) addPage(page);
  }
  return tags;
}

// Resolve the manifest digest for a single tag (used to keep `image:tag@sha256:…` pins in sync).
export async function fetchDockerTagDigest(namespace: string, repo: string, tag: string, ctx: ModeContext): Promise<string | null> {
  const url = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags/${tag}`;
  try {
    const result = await fetchWithEtag(url, ctx, {headers: {"accept-encoding": "gzip, deflate, br"}}, reduceJson(data => ({digest: data.digest})));
    if (!("body" in result)) return null;
    const digest = JSON.parse(result.body).digest;
    return typeof digest === "string" ? digest : null;
  } catch { return null; }
}

// Ubuntu numbers a release after the year and month it ships in, so only an even-year `.04` is ever
// an LTS, and Hub publishes the development series under its future number months before it ships.
// Renovate reads both facts out of bundled distro-info data. The number alone dates the release, at
// the start of the following month because a release lands in the second half of its own.
const ubuntuLtsRe = /^\d?[02468]\.04$/;

function isStableUbuntuVersion(version: string, now: number): boolean {
  if (!ubuntuLtsRe.test(version)) return false;
  const [year, month] = version.split(".");
  return now >= Date.UTC(2000 + Number(year), Number(month));
}

// Images renovate gives a distro versioning to in its dockerfile manager. Keyed by repo so any
// namespace matches, as renovate's `depName === 'ubuntu' || depName.endsWith('/ubuntu')` does.
// Debian needs no entry: Hub only ever numbers a released Debian.
const imageStability: Record<string, (version: string, now: number) => boolean> = {
  ubuntu: isStableUbuntuVersion,
};

export function filterStableTags(repo: string, tags: Record<string, string>, now: number = Date.now()): Record<string, string> {
  const isStable = imageStability[repo];
  if (!isStable) return tags;
  return Object.fromEntries(Object.entries(tags).filter(([tag]) => {
    const version = parseDockerTag(tag)?.version;
    return !version || isStable(version, now);
  }));
}

export async function fetchDockerInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const {registry, namespace, repo} = parseImageParts(name);

  if (registry) {
    throw new Error(`Non-Docker-Hub registries are not yet supported: ${registry}`);
  }

  const tags = await fetchDockerHubTags(namespace, repo, ctx);
  return [{tags: filterStableTags(repo, tags), name}, null];
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

  const oldFields = stripv(oldParsed.version).split(".").length;

  let bestVersion = oldCoerced;
  let bestTag = "";
  let bestDate = "";

  for (const [tagName, lastUpdated] of Object.entries(tagMap)) {
    const parsed = parseDockerTag(tagName);
    if (!parsed || parsed.suffix !== oldParsed.suffix) continue;
    // Only tags of the authored precision are candidates, as renovate's docker isCompatible
    // requires an equal release length: a floating `1.2` must not become a pinned `1.3.6`.
    if (stripv(parsed.version).split(".").length !== oldFields) continue;
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
  // The formatted tag is synthesized from a coerced version, so keep the real Hub tag when the
  // registry does not publish that spelling, as `26.04` coerces and formats back to `26.4`.
  const formatted = formatDockerVersion(bestVersion, oldTag);
  const newTag = formatted in tagMap ? formatted : bestTag;
  if (newTag === oldTag) return null;
  return {newTag, date: bestDate};
}

// Ends a tag match. Excludes `@` and `+` on top of tag characters so a digest-pinned or
// build-suffixed occurrence, which the extractor skips, is never rewritten to a bare tag
// the digest then contradicts.
const tagEnd = "(?![\\w.@+-])";

// One pass per pattern over an alternation of every authored `image:tag`, longest first so
// `node:18-alpine` wins over `node:18`. Keys carry the authored case, as a tag is case-sensitive
// and only the Dockerfile instruction keyword needs a case-insensitive match.
function replaceImageRefs(content: string, deps: Deps, patterns: Array<(refs: string) => RegExp>): string {
  const byRef = new Map<string, string>();
  for (const [key, dep] of Object.entries(deps)) {
    const name = key.split(fieldSep)[1];
    byRef.set(`${name}:${dep.oldOrig || dep.old}`, `${name}:${dep.new}`);
  }
  if (!byRef.size) return content;

  const refs = longestFirstAlternation(byRef.keys());
  let newContent = content;
  for (const makeRegex of patterns) {
    // A ref that case-insensitively matched some other dep's spelling is left alone.
    newContent = newContent.replace(makeRegex(refs), (_, prefix, ref) => `${prefix}${byRef.get(ref) ?? ref}`);
  }
  return newContent;
}

export function updateDockerfile(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    refs => new RegExp(`(FROM\\s+(?:--platform=\\S+\\s+)?)(${refs})${tagEnd}`, "gi"),
  ]);
}

export function updateComposeFile(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    refs => new RegExp(`(image:\\s*['"]?)(${refs})${tagEnd}`, "g"),
  ]);
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  return replaceImageRefs(content, deps, [
    refs => new RegExp(`((?:container|image):\\s*['"]?)(${refs})${tagEnd}`, "g"),
    refs => new RegExp(`(uses:\\s*['"]?docker://)(${refs})${tagEnd}`, "g"),
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
  return isDockerfile(filename) ? dockerfileFromRe : composeImageRe;
}

export function getDockerInfoUrl(ref: DockerImageRef): string {
  if (ref.registry) return "";
  if (ref.namespace === "library") return `https://hub.docker.com/_/${ref.repo}`;
  return `https://hub.docker.com/r/${ref.namespace}/${ref.repo}`;
}
