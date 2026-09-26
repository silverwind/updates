import {parse, satisfies, semverVersioning} from "../utils/semver.ts";
import {getOrSet, longestFirstAlternation, pMap} from "../utils/utils.ts";
import {
  type Deps, type ModeContext, type PackageInfo, dedupe, effectiveConcurrency, fieldSep, fetchWithEtag, hashRe,
  passesCooldown, prereleaseOpts, reduceJson, stripv, throwFetchError, formatVersionPrecision,
} from "./shared.ts";

type ImageParts = {registry: string | null, namespace: string, repo: string};
export type DockerImageRef = ImageParts & {tag: string, fullImage: string, digest?: string, digestOnly?: boolean};
type DockerTag = {version: string, prerelease: string, suffix: string};

const dockerTagRe = /^(v?\d+(?:\.\d+)*(?:_\d+)?)([a-zA-Z][a-zA-Z0-9]*)?(-.+)?$/; // no `i`, `stripv` only strips lowercase

export const dockerfileFromRe = /^[ \t]*FROM\b[^\r\n]*(?:(?<=\\)[ \t]*\r?\n[^\r\n]*)*/gim;
export const composeImageRe = /^[ \t]*image:\s*['"]?([^\s'"#]+)['"]?/gm;
// zero-width so a rewrite's `offset` stays on the key, which is what locallyBuiltImages records
const keyStart = String.raw`(?<=^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)`;
const dockerArgRe = /^\uFEFF?[ \t]*ARG\s+(\w+)(?:[ =](\S*))?/i;
const dockerFromInstructionRe = /^\uFEFF?[ \t]*FROM\s+(?:--platform=\S+\s+)?(\S+)/i;

function resolveDockerVariables(value: string, getValue: (name: string) => string | undefined): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (variable, braced, bare) => getValue(braced || bare) ?? variable);
}

type DockerArg = {value: string, resolved: string, start: number};

function *dockerfileFromInstructions(content: string, recursive = false): Generator<{
  instruction: RegExpExecArray, args: Map<string, DockerArg>, from: RegExpExecArray, resolved: string,
}> {
  const args = new Map<string, DockerArg>();
  let sawFrom = false;
  for (const instruction of content.matchAll(/^\uFEFF?[ \t]*(?:ARG|FROM)\b[^\r\n]*(?:(?<=\\)[ \t]*\r?\n[^\r\n]*)*/gim)) {
    const unfolded = instruction[0].replace(/\\[ \t]*\r?\n[ \t]*/g, " ");
    const arg = dockerArgRe.exec(unfolded);
    if (arg) {
      if (!sawFrom) {
        const value = arg[2]?.replace(/^(['"])(.*)\1$/, "$2") ?? "";
        const relativeStart = instruction[0].lastIndexOf(value);
        args.set(arg[1], {value, resolved: resolveDockerVariables(value, name => args.get(name)?.resolved),
          start: relativeStart < 0 ? -1 : instruction.index + relativeStart});
      }
      continue;
    }
    sawFrom = true;
    const from = dockerFromInstructionRe.exec(unfolded);
    if (from) yield {instruction, args, from,
      resolved: resolveDockerVariables(from[1], name => args.get(name)?.[recursive ? "resolved" : "value"])};
  }
}

const hubRegistryRe = /^(?:(?:index|registry-1)\.)?docker\.io$/;

function parseImageParts(imagePart: string): ImageParts {
  const parts = imagePart.split("/");
  if (parts.length > 1 && hubRegistryRe.test(parts[0])) parts.shift();
  const registry = parts.length > 2 ||
    parts.length > 1 && (parts[0] === "localhost" || parts[0].includes(".") || parts[0].includes(":")) ?
    parts.shift()! : null;
  return {registry, namespace: parts.length === 1 ? "library" : parts.slice(0, -1).join("/"), repo: parts.at(-1)!};
}

export function dockerImageNames(image: string): Array<string> {
  const {registry, namespace, repo} = parseImageParts(image);
  if (registry) return [image];
  const paths = namespace === "library" ? [repo, `library/${repo}`] : [`${namespace}/${repo}`];
  return [...new Set([image, ...paths, ...paths.map(path => `docker.io/${path}`)])];
}

export function parseDockerImageRef(ref: string): DockerImageRef | null {
  ref = ref.replace(/^docker:\/\//, "");

  const [taggedRef, digest, ...extra] = ref.split("@");
  if (extra.length || digest && !/^[a-z][a-z0-9+._-]*:[0-9a-f]+$/i.test(digest)) return null;

  const colonIndex = taggedRef.lastIndexOf(":");
  const hasTag = colonIndex !== -1 && taggedRef.lastIndexOf("/") < colonIndex;
  if (!hasTag && !digest) return null;

  const imagePart = hasTag ? taggedRef.substring(0, colonIndex) : taggedRef;
  const tag = hasTag ? taggedRef.substring(colonIndex + 1) : "latest";

  if (hasTag && !digest && !dockerTagRe.test(tag)) return null;

  const {registry, namespace, repo} = parseImageParts(imagePart);
  return {registry, namespace, repo, tag, fullImage: imagePart, ...(digest && {digest}), ...(!hasTag && {digestOnly: true})};
}

export function parseDockerTag(tag: string): DockerTag | null {
  const match = dockerTagRe.exec(tag);
  if (!match) return null;
  if (match[2] && !match[3] && hashRe.test(tag)) return null; // a commit hash, not a date tag
  return {version: match[1], prerelease: match[2] || "", suffix: match[3] || ""};
}

export function extractDockerRefs(content: string, regex: RegExp): Array<{ref: DockerImageRef, match: string}> {
  const results: Array<{ref: DockerImageRef, match: string}> = [];
  if (regex === dockerfileFromRe) {
    for (const {from, resolved} of dockerfileFromInstructions(content, true)) {
      const ref = parseDockerImageRef(resolved);
      if (ref) results.push({ref, match: from[1]});
    }
    return results;
  }
  const locallyBuilt = regex === composeImageRe ? locallyBuiltImages(content) : null;
  for (const match of content.matchAll(regex)) {
    if (locallyBuilt?.has(match.index + match[0].indexOf("image:"))) continue;
    const ref = parseDockerImageRef(match[1]);
    if (ref) results.push({ref, match: match[1]});
  }
  return results;
}

function locallyBuiltImages(content: string): Set<number> {
  const result = new Set<number>();
  const scopes = new Map<number, {built: boolean, images: Array<number>}>();
  for (const line of content.matchAll(/^.*$/gm)) {
    if (!line[0].trim()) continue;
    const indent = /^[ \t]*/.exec(line[0])![0].length;
    for (const level of scopes.keys()) {
      if (level > indent) scopes.delete(level);
    }
    const scope = getOrSet(scopes, indent, () => ({built: false, images: []}));
    if (/^[ \t]*build\s*:/.test(line[0])) {
      scope.built = true;
      for (const offset of scope.images) result.add(offset);
    } else if (/^[ \t]*image\s*:/.test(line[0])) {
      const offset = line.index + indent;
      if (scope.built) result.add(offset);
      else scope.images.push(offset);
    }
  }
  return result;
}

type HubTags = {dates: Record<string, string>, digests: Map<string, string>};

const hubTagsByCtx = new WeakMap<ModeContext, Map<string, Promise<HubTags>>>();
const noTagsStatus = new Set([401, 403, 404]);
const maxDockerTagPages = 20;

async function fetchHubJson(url: string, ctx: ModeContext, name: string, reduce: (data: any) => any, cacheKey = url): Promise<any> {
  const result = await fetchWithEtag(url, ctx, {headers: {"accept-encoding": "gzip, deflate, br"}}, reduceJson(reduce), cacheKey);
  if ("body" in result) return JSON.parse(result.body);
  if (!noTagsStatus.has(result.res?.status as number)) throwFetchError(result.res, url, name, ctx.dockerApiUrl);
  return null;
}

function fetchDockerHubTagPages(namespace: string, repo: string, ctx: ModeContext): Promise<HubTags> {
  return dedupe(hubTagsByCtx, ctx, `${namespace}/${repo}`, async () => {
    const tags: HubTags = {dates: {}, digests: new Map()};
    const baseUrl = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags`;
    const pageUrl = (page: number) => `${baseUrl}?page_size=1000&ordering=last_updated&page=${page}`;
    const fetchPage = (url: string) => fetchHubJson(url, ctx, `${namespace}/${repo}`, data => ({
      count: data.count,
      next: data.next,
      results: (data.results || []).map((tag: Record<string, any>) => ({
        name: tag.name, tag_last_pushed: tag.tag_last_pushed, last_updated: tag.last_updated, digest: tag.digest,
      })),
    }), `${url}#digest`); // the digest in the key keeps entries reduced without it from being reused
    const take = (page: any): void => {
      for (const tag of page.results ?? []) {
        tags.dates[tag.name] = tag.tag_last_pushed || tag.last_updated || "";
        if (typeof tag.digest === "string") tags.digests.set(tag.name, tag.digest);
      }
    };

    let page = await fetchPage(pageUrl(1));
    if (!page) return tags;
    take(page);
    const pageUrls = Array.from({length: Math.min(maxDockerTagPages, Math.ceil(page.count / 1000)) - 1},
      (_, index) => pageUrl(index + 2));
    const seen = new Set(pageUrls);
    const pages = await pMap(pageUrls, async url => {
      try { return {value: await fetchPage(url)}; } catch (reason) { return {reason}; }
    }, {concurrency: effectiveConcurrency(ctx)});
    for (const result of pages) {
      if ("reason" in result) throw result.reason;
      if (!result.value) return tags;
      take(result.value);
      page = result.value;
    }
    const baseOrigin = new URL(baseUrl).origin;
    for (let pageNumber = pageUrls.length + 2; pageNumber <= maxDockerTagPages && page.next; pageNumber++) {
      const next = new URL(page.next, baseUrl);
      if (next.origin !== baseOrigin || seen.has(next.href)) break;
      seen.add(next.href);
      page = await fetchPage(next.href);
      if (!page) break;
      take(page);
    }
    return tags;
  });
}

export async function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  return (await fetchDockerHubTagPages(namespace, repo, ctx)).dates;
}

export async function fetchDockerTagDigest(namespace: string, repo: string, tag: string, ctx: ModeContext): Promise<string | null> {
  // The listing carries the same manifest digest, so a tag only costs a request when it is missing there.
  const listed = (await fetchDockerHubTagPages(namespace, repo, ctx)).digests.get(tag);
  if (listed) return listed;
  const url = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags/${tag}`;
  const digest = (await fetchHubJson(url, ctx, `${namespace}/${repo}:${tag}`, data => ({digest: data.digest})))?.digest;
  return typeof digest === "string" ? digest : null; // absent on tags pushed before Docker Hub recorded manifest digests
}

const ubuntuLtsRe = /^\d?[02468]\.04$/;

export function filterStableTags(repo: string, tags: Record<string, string>, now = Date.now()): Record<string, string> {
  if (repo !== "ubuntu") return tags;
  return Object.fromEntries(Object.entries(tags).filter(([tag]) => {
    const version = parseDockerTag(tag)?.version;
    return !version || ubuntuLtsRe.test(version) && now >= Date.UTC(2000 + Number(version.split(".")[0]), 4);
  }));
}

export async function fetchDockerInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const {registry, namespace, repo} = parseImageParts(name);
  if (registry) throw new Error(`Non-Docker-Hub registries are not yet supported: ${registry}`);
  return [{tags: filterStableTags(repo, await fetchDockerHubTags(namespace, repo, ctx)), name}, null];
}

const dockerSemver = ({version, prerelease}: DockerTag) => `${coerceDockerVersion(version)}${prerelease ? `-${prerelease}` : ""}`;

// ranges match on the release only, prerelease stability is decided separately by prereleaseOpts
export function dockerTagVersion(tag: string): string {
  const parsed = parseDockerTag(tag);
  return parsed ? coerceDockerVersion(parsed.version) : "";
}

const dockerVersionSep = /[._]/;
const dockerVersionParts = (tag: DockerTag) => stripv(tag.version).split(dockerVersionSep).map(Number);
const dockerVersionShape = (version: string) => stripv(version).replace(/\d+/g, ""); // keeps `21_35` off `21.35`

const dateVersionMin = 20000000;
const firstVersionField = (version: string) => Number(stripv(version).split(dockerVersionSep)[0]);

// every part is numeric by construction, dockerTagRe only admits digits between separators
function coerceDockerVersion(version: string): string {
  const parts = stripv(version).split(dockerVersionSep);
  return `${Number(parts[0])}.${Number(parts[1] || 0)}.${Number(parts[2] || 0)}`;
}

function compareExtendedDockerTags(left: DockerTag, right: DockerTag): number {
  const leftParts = dockerVersionParts(left);
  const rightParts = dockerVersionParts(right);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  if (Boolean(left.prerelease) !== Boolean(right.prerelease)) return left.prerelease ? -1 : 1;
  return left.prerelease.localeCompare(right.prerelease);
}

function extendedDockerLevel(left: DockerTag, right: DockerTag): string {
  const rightParts = dockerVersionParts(right);
  const changed = dockerVersionParts(left).findIndex((part, index) => part !== rightParts[index]);
  if (changed === 0) return "major";
  if (changed === 1) return "minor";
  return "patch";
}

export function findDockerVersion(
  tagMap: Record<string, string>,
  oldTag: string,
  semvers: Set<string>,
  cooldownDays?: number,
  now?: number,
  pinnedRange?: string,
  usePre = false,
  useRel = false,
): {newTag: string, date: string} | null {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return null;

  const oldShape = dockerVersionShape(oldParsed.version);
  const oldIsDate = firstVersionField(oldParsed.version) >= dateVersionMin;
  const oldSemver = dockerSemver(oldParsed);
  const {effectiveSemvers, skipsPrerelease} = prereleaseOpts(oldSemver, usePre, useRel, semvers);
  const extended = oldShape.length > 2 || oldShape.includes("_");
  let bestVersion = parse(oldSemver)!;
  let bestParsed = oldParsed;
  let best = {newTag: "", date: ""};

  for (const [tagName, lastUpdated] of Object.entries(tagMap)) {
    const parsed = parseDockerTag(tagName);
    if (!parsed || parsed.suffix !== oldParsed.suffix || dockerVersionShape(parsed.version) !== oldShape) continue;
    if (!oldIsDate && firstVersionField(parsed.version) >= dateVersionMin) continue;
    if (!passesCooldown(lastUpdated, cooldownDays, now)) continue;

    const semver = dockerSemver(parsed);
    if (pinnedRange && !satisfies(semver, pinnedRange)) continue;

    if (extended) {
      if (parsed.prerelease && (!usePre && !oldParsed.prerelease || useRel)) continue;
      if (compareExtendedDockerTags(parsed, bestParsed) <= 0 || !semvers.has(extendedDockerLevel(oldParsed, parsed))) continue;
      bestParsed = parsed;
      best = {newTag: tagName, date: lastUpdated};
      continue;
    }

    const candidate = parse(semver);
    if (!candidate || parsed.prerelease && skipsPrerelease(candidate)) continue;

    if (candidate.version === bestVersion.version) {
      if (best.newTag && Date.parse(lastUpdated) > Date.parse(best.date)) best = {newTag: tagName, date: lastUpdated};
      continue;
    }

    const diff = semverVersioning.diff(bestVersion, candidate);
    if (!diff || !effectiveSemvers.has(diff) || semverVersioning.compare(candidate, bestVersion) <= 0) continue;
    bestVersion = candidate;
    best = {newTag: tagName, date: lastUpdated};
  }

  if (!best.newTag) return null;
  if (extended) return best;
  const [bestRelease, bestPre = ""] = bestVersion.version.split("-");
  const formatted = formatVersionPrecision(bestRelease, oldParsed.version, `${bestPre}${oldParsed.suffix}`);
  const newTag = formatted in tagMap ? formatted : best.newTag;
  return newTag === oldTag ? null : {newTag, date: best.date};
}

const tagEnd = "(?![\\w.@+-])";

function imageReplacements(deps: Deps): Map<string, string> {
  const byRef = new Map<string, string>();
  for (const [key, dep] of Object.entries(deps)) {
    const name = key.split(fieldSep)[1];
    if (!dep.oldDigest) byRef.set(`${name}:${dep.oldOrig || dep.old}`, `${name}:${dep.new}`);
    else if (dep.newDigest) byRef.set(dep.digestOnly ? `${name}@${dep.oldDigest}` :
      `${name}:${dep.oldOrig || dep.old}@${dep.oldDigest}`, dep.digestOnly ? `${name}@${dep.newDigest}` :
      `${name}:${dep.new}@${dep.newDigest}`);
  }
  return byRef;
}

function replaceImageRefs(content: string, byRef: Map<string, string>, prefixes: Array<string>, flags = "gm",
  canReplace = (_offset: number) => true): string {
  if (!byRef.size) return content;
  const refs = longestFirstAlternation(byRef.keys());
  let newContent = content;
  for (const prefix of prefixes) {
    newContent = newContent.replace(new RegExp(`(${prefix})(${refs})${tagEnd}`, flags),
      (match, start, ref, offset) => canReplace(offset) ? `${start}${byRef.get(ref) ?? ref}` : match);
  }
  return newContent;
}

export function updateDockerfile(content: string, deps: Deps): string {
  const separator = "(?:[ \\t]+|\\\\[ \\t]*\\r?\\n[ \\t]*)";
  const replacements = imageReplacements(deps);
  if (!replacements.size) return content;
  let updated = replaceImageRefs(content, replacements,
    [`^\\uFEFF?[ \\t]*FROM${separator}+(?:--platform=\\S+${separator}+)?`], "gim");
  const edits = new Map<number, [number, string]>();
  for (const {instruction, args, from, resolved} of dockerfileFromInstructions(updated)) {
    const replacement = replacements.get(resolved);
    if (!replacement) continue;
    const oldAt = resolved.lastIndexOf("@");
    const newAt = replacement.lastIndexOf("@");
    const oldDigest = resolved.slice(oldAt + 1);
    const newDigest = replacement.slice(newAt + 1);
    const replacesDigest = oldAt !== -1 && newAt !== -1 && oldDigest !== newDigest;
    const relativeDigest = replacesDigest ? instruction[0].lastIndexOf(oldDigest) : -1;
    if (relativeDigest !== -1) edits.set(instruction.index + relativeDigest, [oldDigest.length, newDigest]);
    const argValueOf = (name: string) => args.get(name)?.value;
    for (const variable of from[1].matchAll(/\$(?:\{(\w+)\}|(\w+))/g)) {
      const argValue = args.get(variable[1] || variable[2]);
      const prefix = resolveDockerVariables(from[1].slice(0, variable.index), argValueOf);
      let suffix = resolveDockerVariables(from[1].slice(variable.index + variable[0].length), argValueOf);
      if (replacesDigest) suffix = suffix.replace(oldDigest, newDigest);
      if (!argValue || argValue.start < 0 || !replacement.startsWith(prefix) || !replacement.endsWith(suffix)) continue;
      edits.set(argValue.start, [argValue.value.length, replacement.slice(prefix.length, suffix ? -suffix.length : undefined)]);
    }
  }
  for (const [start, [length, value]] of [...edits].sort(([left], [right]) => right - left)) {
    updated = `${updated.slice(0, start)}${value}${updated.slice(start + length)}`;
  }
  return updated;
}

export function updateComposeFile(content: string, deps: Deps): string {
  const locallyBuilt = locallyBuiltImages(content);
  return replaceImageRefs(content, imageReplacements(deps), [String.raw`${keyStart}image:\s*['"]?`], "gm",
    offset => !locallyBuilt.has(offset));
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  return replaceImageRefs(content, imageReplacements(deps), [
    String.raw`${keyStart}(?:container|image):\s*['"]?`,
    String.raw`${keyStart}uses:\s*['"]?docker://`,
  ]);
}

export const dockerExactFileNames =
  ["Dockerfile", "Containerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];

export function isComposeFile(filename: string): boolean {
  return /^(?:docker-|compose).*\.ya?ml$/.test(filename);
}

export function isDockerfile(filename: string): boolean {
  return /^(?:[Dd]ocker|[Cc]ontainer)file|\.(?:[Dd]ocker|[Cc]ontainer)file$/.test(filename);
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
