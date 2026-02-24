import {coerce, diff, gte, valid} from "../utils/semver.ts";
import {type Deps, type ModeContext, type PackageInfo, esc, fieldSep} from "./shared.ts";

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
export const dockerfileFromRe = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gm;
export const composeImageRe = /^\s*image:\s*['"]?([^\s'"#]+)['"]?/gm;
// Matches shorthand `container: image:tag` (not object form with `{`)
export const workflowContainerRe = /^\s*container:\s*['"]?([^\s'"#{}]+:[^\s'"#{}]+)['"]?\s*$/gm;
// Matches `uses: docker://image:tag`
export const workflowDockerUsesRe = /^\s*-?\s*uses:\s*['"]?docker:\/\/([^'"#\s]+)['"]?/gm;

export function parseDockerImageRef(ref: string): DockerImageRef | null {
  // Strip docker:// prefix if present
  ref = ref.replace(/^docker:\/\//, "");

  if (ref.includes("@")) return null; // digest-pinned, skip

  const colonIndex = ref.lastIndexOf(":");
  let imagePart: string;
  let tag: string;

  if (colonIndex === -1 || ref.lastIndexOf("/") > colonIndex) {
    return null; // no tag specified, skip
  } else {
    imagePart = ref.substring(0, colonIndex);
    tag = ref.substring(colonIndex + 1);
  }

  if (!tag || !dockerTagRe.test(tag)) return null; // non-semver tag

  const parts = imagePart.split("/");
  let registry: string | null = null;
  let namespace: string;
  let repo: string;

  if (parts.length === 1) {
    // Official Docker Hub image: "node"
    namespace = "library";
    repo = parts[0];
  } else if (parts.length === 2 && !parts[0].includes(".") && !parts[0].includes(":")) {
    // Docker Hub user image: "myorg/app"
    namespace = parts[0];
    repo = parts[1];
  } else {
    // Custom registry: "ghcr.io/owner/repo"
    registry = parts[0];
    namespace = parts.slice(1, -1).join("/") || parts[1];
    repo = parts[parts.length - 1];
  }

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

  const hadV = oldParsed.version.startsWith("v");
  const bare = newSemver.replace(/^v/, "");
  const numParts = oldParsed.version.replace(/^v/, "").split(".").length;

  const newParts = bare.split(".");
  let formatted: string;
  if (numParts === 1) formatted = newParts[0];
  else if (numParts === 2) formatted = `${newParts[0]}.${newParts[1] || "0"}`;
  else formatted = bare;

  return `${hadV ? "v" : ""}${formatted}${oldParsed.suffix}`;
}

export function extractDockerRefs(content: string, regex: RegExp): Array<{ref: DockerImageRef, match: string}> {
  const results: Array<{ref: DockerImageRef, match: string}> = [];
  for (const m of content.matchAll(regex)) {
    const ref = parseDockerImageRef(m[1]);
    if (ref) results.push({ref, match: m[1]});
  }
  return results;
}

const maxPages = 10;

export async function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  let url: string | null = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags?page_size=100&ordering=last_updated`;
  let page = 0;

  while (url && page < maxPages) {
    page++;
    try {
      const res = await ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.fetchTimeout)});
      if (!res?.ok) break;
      const data = await res.json();
      for (const result of data.results || []) {
        tags[result.name] = result.tag_last_pushed || result.last_updated || "";
      }
      // Rewrite absolute next URL to use our base URL (for test mock servers)
      const next = data.next;
      if (next) {
        const nextUrl = new URL(next);
        const baseUrl = new URL(ctx.dockerApiUrl);
        nextUrl.protocol = baseUrl.protocol;
        nextUrl.host = baseUrl.host;
        url = nextUrl.toString();
      } else {
        url = null;
      }
    } catch {
      break;
    }
  }
  return tags;
}

export function resolveDockerImage(name: string): {registry: string | null, namespace: string, repo: string} {
  const parts = name.split("/");
  if (parts.length === 1) {
    return {registry: null, namespace: "library", repo: parts[0]};
  } else if (parts.length === 2 && !parts[0].includes(".") && !parts[0].includes(":")) {
    return {registry: null, namespace: parts[0], repo: parts[1]};
  } else {
    return {registry: parts[0], namespace: parts.slice(1, -1).join("/") || parts[1], repo: parts[parts.length - 1]};
  }
}

export async function fetchDockerInfo(name: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const {registry, namespace, repo} = resolveDockerImage(name);

  if (registry) {
    throw new Error(`Non-Docker-Hub registries are not yet supported: ${registry}`);
  }

  const tags = await fetchDockerHubTags(namespace, repo, ctx);
  return [{tags, name}, type, null, name];
}

export function findDockerVersion(
  tagMap: Record<string, string>,
  oldTag: string,
  semvers: Set<string>,
): {newTag: string, date: string} | null {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return null;

  const oldCoerced = coerce(oldParsed.version.replace(/^v/, ""))?.version;
  if (!oldCoerced) return null;

  let bestVersion = oldCoerced;
  let bestTag = "";
  let bestDate = "";

  for (const [tagName, lastUpdated] of Object.entries(tagMap)) {
    const parsed = parseDockerTag(tagName);
    if (!parsed || parsed.suffix !== oldParsed.suffix) continue;

    const coerced = coerce(parsed.version.replace(/^v/, ""))?.version;
    if (!coerced || !valid(coerced)) continue;

    const d = diff(bestVersion, coerced);
    if (!d || !semvers.has(d)) continue;

    if (gte(coerced, bestVersion)) {
      bestVersion = coerced;
      bestTag = tagName;
      bestDate = lastUpdated;
    }
  }

  if (!bestTag || bestVersion === oldCoerced) return null;
  const newTag = formatDockerVersion(bestVersion, oldTag);
  if (newTag === oldTag) return null;
  return {newTag, date: bestDate};
}

export function updateDockerfile(content: string, deps: Deps): string {
  let newContent = content;
  for (const [key, dep] of Object.entries(deps)) {
    const [_type, name] = key.split(fieldSep);
    const oldTag = dep.oldOrig || dep.old;
    newContent = newContent.replace(
      new RegExp(`(FROM\\s+(?:--platform=\\S+\\s+)?)${esc(name)}:${esc(oldTag)}`, "g"),
      `$1${name}:${dep.new}`,
    );
  }
  return newContent;
}

export function updateComposeFile(content: string, deps: Deps): string {
  let newContent = content;
  for (const [key, dep] of Object.entries(deps)) {
    const [_type, name] = key.split(fieldSep);
    const oldTag = dep.oldOrig || dep.old;
    newContent = newContent.replace(
      new RegExp(`(image:\\s*['"]?)${esc(name)}:${esc(oldTag)}`, "g"),
      `$1${name}:${dep.new}`,
    );
  }
  return newContent;
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  let newContent = content;
  for (const [key, dep] of Object.entries(deps)) {
    const [_type, name] = key.split(fieldSep);
    const oldTag = dep.oldOrig || dep.old;
    // container: image:tag or image: image:tag
    newContent = newContent.replace(
      new RegExp(`((?:container|image):\\s*['"]?)${esc(name)}:${esc(oldTag)}`, "g"),
      `$1${name}:${dep.new}`,
    );
    // uses: docker://image:tag
    newContent = newContent.replace(
      new RegExp(`(uses:\\s*['"]?docker://)${esc(name)}:${esc(oldTag)}`, "g"),
      `$1${name}:${dep.new}`,
    );
  }
  return newContent;
}

export const dockerTypes = ["docker"];

// Exact filenames for auto-discovery via findUpSync
export const dockerExactFileNames = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

export function isComposeFile(filename: string): boolean {
  return /^(?:docker-)?compose\.ya?ml$/.test(filename) || /^docker-.+\.ya?ml$/.test(filename);
}

export function isDockerfile(filename: string): boolean {
  return /^Dockerfile(\..+)?$/.test(filename);
}

// Check if a filename matches any Docker file pattern
export function isDockerFileName(filename: string): boolean {
  return isDockerfile(filename) || isComposeFile(filename);
}

export function getExtractionRegex(filename: string): RegExp {
  if (isDockerfile(filename)) return dockerfileFromRe;
  return composeImageRe;
}

export function getDockerInfoUrl(ref: DockerImageRef): string {
  if (!ref.registry) {
    if (ref.namespace === "library") {
      return `https://hub.docker.com/_/${ref.repo}`;
    }
    return `https://hub.docker.com/r/${ref.namespace}/${ref.repo}`;
  }
  return "";
}
