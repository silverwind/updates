import {parse, satisfies, semverVersioning} from "../utils/semver.ts";
import {longestFirstAlternation} from "../utils/utils.ts";
import {
  type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, isSameVersionScheme,
  passesCooldown, prereleaseOpts, reduceJson, stripv, throwFetchError, formatVersionPrecision,
} from "./shared.ts";

export type DockerImageRef = {
  registry: string | null,
  namespace: string,
  repo: string,
  tag: string,
  fullImage: string,
  digest?: string,
  digestOnly?: boolean,
};
type DockerTag = {version: string, prerelease: string, suffix: string};

const dockerTagRe = /^(v?\d+(?:\.\d+)*)([a-z][a-z0-9]*)?(-.+)?$/i;

export const dockerfileFromRe = /^[ \t]*FROM\b[^\r\n]*(?:(?<=\\)[ \t]*\r?\n[^\r\n]*)*/gim;
export const composeImageRe = /^[ \t]*image:\s*['"]?([^\s'"#]+)['"]?/gm;
const dockerArgRe = /^[ \t]*ARG\s+(\w+)(?:[ =](\S*))?/i;
const dockerFromInstructionRe = /^[ \t]*FROM\s+(?:--platform=\S+\s+)?(\S+)/i;
const unfoldDockerInstruction = (instruction: string) => instruction.replace(/\\[ \t]*\r?\n[ \t]*/g, " ");

function resolveDockerVariables(value: string, getValue: (name: string) => string | undefined): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (variable, braced, bare) => {
    const resolved = getValue(braced || bare);
    return resolved === undefined ? variable : resolved;
  });
}

type DockerArg = {value: string, resolved: string, start: number};

function *dockerfileFromInstructions(content: string, recursive = false): Generator<{
  instruction: RegExpMatchArray, args: Map<string, DockerArg>, from: RegExpExecArray, resolved: string,
}> {
  const args = new Map<string, DockerArg>();
  let sawFrom = false;
  for (const instruction of content.matchAll(/^[ \t]*(?:ARG|FROM)\b[^\r\n]*(?:(?<=\\)[ \t]*\r?\n[^\r\n]*)*/gim)) {
    const unfolded = unfoldDockerInstruction(instruction[0]);
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

function parseImageParts(imagePart: string): {registry: string | null, namespace: string, repo: string} {
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

  if (hasTag && !digest && (!tag || !dockerTagRe.test(tag))) return null;

  const {registry, namespace, repo} = parseImageParts(imagePart);
  return {registry, namespace, repo, tag, fullImage: imagePart, ...(digest && {digest}), ...(!hasTag && {digestOnly: true})};
}

export function parseDockerTag(tag: string): DockerTag | null {
  const match = dockerTagRe.exec(tag);
  if (!match) return null;
  return {version: match[1], prerelease: match[2] || "", suffix: match[3] || ""};
}

export function formatDockerVersion(newSemver: string, oldTag: string, prerelease = ""): string {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return oldTag;
  return formatVersionPrecision(newSemver, oldParsed.version, `${prerelease}${oldParsed.suffix}`);
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
  for (const m of content.matchAll(regex)) {
    if (locallyBuilt?.has(m.index + m[0].indexOf("image:"))) continue;
    const ref = parseDockerImageRef(m[1]);
    if (ref) results.push({ref, match: m[1]});
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
    const scope = scopes.get(indent) ?? {built: false, images: []};
    scopes.set(indent, scope);
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

const hubTagsByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, string>>>>();
const noTagsStatus = new Set([401, 403, 404]);
const maxDockerTagPages = 20;

export function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  return dedupe(hubTagsByCtx, ctx, `${namespace}/${repo}`, async () => {
    const tags: Record<string, string> = {};
    const baseUrl = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags`;
    const pageUrl = (page: number) => `${baseUrl}?page_size=1000&ordering=last_updated&page=${page}`;
    const fetchPage = async (url: string): Promise<any | null> => {
      const result = await fetchWithEtag(url, ctx, {headers: {"accept-encoding": "gzip, deflate, br"}}, reduceJson(data => ({
        count: data.count,
        next: data.next,
        results: (data.results || []).map((tag: Record<string, any>) => ({
          name: tag.name, tag_last_pushed: tag.tag_last_pushed, last_updated: tag.last_updated,
        })),
      })));
      if ("body" in result) {
        const page = JSON.parse(result.body);
        for (const tag of page?.results ?? []) tags[tag.name] = tag.tag_last_pushed || tag.last_updated || "";
        return page;
      }
      if (!noTagsStatus.has(result.res?.status as number)) throwFetchError(result.res, url, `${namespace}/${repo}`, ctx.dockerApiUrl);
      return null;
    };

    const firstPage = await fetchPage(pageUrl(1));
    if (!firstPage) return tags;
    const seen = new Set<string>();
    let page = firstPage;
    for (let pageNumber = 2; pageNumber <= maxDockerTagPages &&
      (page.next || pageNumber <= Math.ceil((firstPage.count || 0) / 1000)); pageNumber++) {
      const nextUrl = page.next ? new URL(page.next, baseUrl).href : pageUrl(pageNumber);
      if (new URL(nextUrl).origin !== new URL(baseUrl).origin || seen.has(nextUrl)) break;
      seen.add(nextUrl);
      const result = await fetchPage(nextUrl);
      if (!result) break;
      page = result;
    }
    return tags;
  });
}

export async function fetchDockerTagDigest(
  namespace: string,
  repo: string,
  tag: string,
  ctx: ModeContext,
): Promise<string | null> {
  const url = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags/${tag}`;
  const result = await fetchWithEtag(url, ctx, {headers: {"accept-encoding": "gzip, deflate, br"}},
    reduceJson(data => ({digest: data.digest})));
  if ("body" in result) {
    const digest = JSON.parse(result.body)?.digest; // absent on tags pushed before Docker Hub recorded manifest digests
    return typeof digest === "string" ? digest : null;
  }
  if (!noTagsStatus.has(result.res?.status as number)) throwFetchError(result.res, url, `${namespace}/${repo}:${tag}`, ctx.dockerApiUrl);
  return null;
}

const ubuntuLtsRe = /^\d?[02468]\.04$/;

function isStableUbuntuVersion(version: string, now: number): boolean {
  if (!ubuntuLtsRe.test(version)) return false;
  const [year, month] = version.split(".");
  return now >= Date.UTC(2000 + Number(year), Number(month));
}

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

const dockerSemver = (coerced: string, prerelease: string) => prerelease ? `${coerced}-${prerelease}` : coerced;

function coerceDockerVersion(version: string): string | null {
  const parts = stripv(version).split(".").slice(0, 3);
  if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
  return [...parts.map(part => String(Number(part))), ...new Array(3 - parts.length).fill("0")].join(".");
}

function compareExtendedDockerTags(left: DockerTag, right: DockerTag): number {
  const leftParts = stripv(left.version).split(".").map(Number);
  const rightParts = stripv(right.version).split(".").map(Number);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function extendedDockerLevel(left: DockerTag, right: DockerTag): string | null {
  const leftParts = stripv(left.version).split(".").map(Number);
  const rightParts = stripv(right.version).split(".").map(Number);
  const changed = leftParts.findIndex((part, index) => part !== rightParts[index]);
  if (changed === -1) return left.prerelease === right.prerelease ? null : "patch";
  return changed === 0 ? "major" : changed === 1 ? "minor" : "patch";
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

  const oldCoerced = coerceDockerVersion(oldParsed.version);
  if (!oldCoerced) return null;

  const oldFields = stripv(oldParsed.version).split(".").length;
  const oldSemver = dockerSemver(oldCoerced, oldParsed.prerelease);
  const {effectiveSemvers, skipsPrerelease} = prereleaseOpts(oldSemver, usePre, useRel, semvers);
  const extended = oldFields > 3;
  let bestVersion = parse(oldSemver)!;
  let bestParsed = oldParsed;
  let bestTag = "";
  let bestDate = "";

  for (const [tagName, lastUpdated] of Object.entries(tagMap)) {
    const parsed = parseDockerTag(tagName);
    if (!parsed || parsed.suffix !== oldParsed.suffix || stripv(parsed.version).split(".").length !== oldFields ||
      !isSameVersionScheme(parsed.version, oldParsed.version)) continue;
    if (!passesCooldown(lastUpdated, cooldownDays, now)) continue;

    if (extended) {
      if (parsed.prerelease && (!usePre && !oldParsed.prerelease || useRel)) continue;
      if (compareExtendedDockerTags(parsed, bestParsed) <= 0) continue;
      const level = extendedDockerLevel(oldParsed, parsed);
      if (!level || !semvers.has(level)) continue;
      bestParsed = parsed;
      bestTag = tagName;
      bestDate = lastUpdated;
      continue;
    }

    const coerced = coerceDockerVersion(parsed.version);
    if (!coerced) continue;
    const candidate = parse(dockerSemver(coerced, parsed.prerelease));
    if (!candidate) continue;
    if (parsed.prerelease && skipsPrerelease(candidate)) continue;
    if (pinnedRange && !satisfies(coerced, pinnedRange)) continue;

    if (candidate.version === bestVersion.version) {
      if (bestTag && Date.parse(lastUpdated) > Date.parse(bestDate)) {
        bestTag = tagName;
        bestDate = lastUpdated;
      }
      continue;
    }

    const d = semverVersioning.diff(bestVersion, candidate);
    if (!d || !effectiveSemvers.has(d)) continue;

    if (semverVersioning.compare(candidate, bestVersion) > 0) {
      bestVersion = candidate;
      bestTag = tagName;
      bestDate = lastUpdated;
    }
  }

  if (extended) return bestTag ? {newTag: bestTag, date: bestDate} : null;
  if (!bestTag || bestVersion.version === oldSemver) return null;
  const [bestRelease, bestPre = ""] = bestVersion.version.split("-");
  const formatted = formatDockerVersion(bestRelease, oldTag, bestPre);
  const newTag = formatted in tagMap ? formatted : bestTag;
  if (newTag === oldTag) return null;
  return {newTag, date: bestDate};
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

function replaceImageRefs(
  content: string,
  byRef: Map<string, string>,
  prefixes: Array<string>,
  canReplace: (offset: number) => boolean = () => true,
): string {
  if (!byRef.size) return content;

  const refs = longestFirstAlternation(byRef.keys());
  let newContent = content;
  for (const prefix of prefixes) {
    newContent = newContent.replace(new RegExp(`(${prefix})(${refs})${tagEnd}`, "g"), (match, start, ref, offset) =>
      canReplace(offset) ? `${start}${byRef.get(ref) ?? ref}` : match);
  }
  return newContent;
}

export function updateDockerfile(content: string, deps: Deps): string {
  const separator = "(?:[ \\t]+|\\\\[ \\t]*\\r?\\n[ \\t]*)";
  const replacements = imageReplacements(deps);
  const refs = longestFirstAlternation(replacements.keys());
  const updated = replacements.size ? content.replace(
    new RegExp(`(FROM${separator}+(?:--platform=\\S+${separator}+)?)(${refs})${tagEnd}`, "gi"),
    (_match, prefix, ref) => `${prefix}${replacements.get(ref) ?? ref}`,
  ) : content;
  const edits = new Map<number, {end: number, value: string}>();
  for (const {instruction, args, from, resolved} of dockerfileFromInstructions(updated)) {
    const replacement = replacements.get(resolved);
    if (!replacement) continue;
    const oldDigest = resolved.slice(resolved.lastIndexOf("@") + 1);
    const newDigest = replacement.slice(replacement.lastIndexOf("@") + 1);
    const replacesDigest = resolved.includes("@") && replacement.includes("@") && oldDigest !== newDigest;
    if (replacesDigest) {
      const relativeDigest = instruction[0].lastIndexOf(oldDigest);
      if (relativeDigest !== -1) edits.set(instruction.index! + relativeDigest, {
        end: instruction.index! + relativeDigest + oldDigest.length, value: newDigest,
      });
    }
    for (const variable of from[1].matchAll(/\$(?:\{(\w+)\}|(\w+))/g)) {
      const argValue = args.get(variable[1] || variable[2]);
      const prefix = resolveDockerVariables(from[1].slice(0, variable.index), name => args.get(name)?.value);
      let suffix = resolveDockerVariables(from[1].slice(variable.index + variable[0].length), name => args.get(name)?.value);
      if (replacesDigest) suffix = suffix.replace(oldDigest, newDigest);
      if (!argValue || argValue.start < 0 || !replacement.startsWith(prefix) || !replacement.endsWith(suffix)) continue;
      edits.set(argValue.start, {
        end: argValue.start + argValue.value.length,
        value: replacement.slice(prefix.length, suffix ? -suffix.length : undefined),
      });
    }
  }
  let result = updated;
  for (const [start, edit] of [...edits].sort(([left], [right]) => right - left)) {
    result = `${result.slice(0, start)}${edit.value}${result.slice(edit.end)}`;
  }
  return result;
}

export function updateComposeFile(content: string, deps: Deps): string {
  const locallyBuilt = locallyBuiltImages(content);
  return replaceImageRefs(content, imageReplacements(deps), [String.raw`image:\s*['"]?`],
    offset => !locallyBuilt.has(offset));
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  return replaceImageRefs(content, imageReplacements(deps), [
    String.raw`(?:container|image):\s*['"]?`,
    String.raw`uses:\s*['"]?docker://`,
  ]);
}

export const dockerExactFileNames = [
  "Dockerfile",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

export function isComposeFile(filename: string): boolean {
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
