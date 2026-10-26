import {parse, satisfies, semverVersioning} from "../utils/semver.ts";
import {getOrSet, longestFirstAlternation, pMap, tryOrNull} from "../utils/utils.ts";
import {
  type Deps, type ModeContext, type PackageInfo, dedupe, effectiveConcurrency, fieldSep, fetchWithEtag, fetchWithRetry, hashRe,
  passesCooldown, prereleaseOpts, reduceJson, stripv, throwFetchError, formatVersionPrecision,
} from "./shared.ts";

type ImageParts = {registry: string | null, namespace: string, repo: string};
export type DockerImageRef = ImageParts & {tag: string, fullImage: string, digest?: string, digestOnly?: boolean};
type DockerTag = {version: string, prerelease: string, suffix: string};

const dockerTagRe = /^(v?\d+(?:\.\d+)*(?:_\d+)?)([a-zA-Z][a-zA-Z0-9]*)?(-.+)?$/; // no `i`, `stripv` only strips lowercase

const dockerfileImageRe = /^\s*(?:#\s*syntax\s*=\s*|FROM(?:\s+--\S+)*\s+(?!--)|(?:ONBUILD\s+)?COPY(?:\s+--\S+)*?\s+--from=)(\S+)/i;
const runFlagsRe = /^\s*(?:ONBUILD\s+)?RUN(?:\s+--\S+)+/i;
const mountImageRe = /(?<=\s--mount=(?:[^\s,]*,)*from=)[^\s,]+/gi;
const composeImageRe = /^[ \t]*image:\s*['"]?([^\s'"#]+)['"]?/gm;
// zero-width so a rewrite's `offset` stays on the key, which is what locallyBuiltImages records
const keyStart = String.raw`(?<=^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)`;
const dockerArgRe = /^\uFEFF?[ \t]*ARG\s+(\w+)(?:[ =](\S*))?/i;
const dockerDirectiveRe = /^\s*#\s*(syntax|escape|check)\s*=\s*(\S+)/i;
const heredocInstructionRe = /^\s*(?:ONBUILD\s+)?(?:ADD|COPY|RUN)\s/i;
const shellWordRe = /(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g;

function resolveDockerVariables(value: string, getValue: (name: string) => string | undefined): string {
  if (!value.includes("$")) return value;
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (variable, braced, bare) => getValue(braced || bare) ?? variable);
}

type DockerArg = {value: string, resolved: string, start: number};

function heredocDelimiters(text: string): Array<{chomp: boolean, name: string}> {
  const words = Array.from(text.matchAll(shellWordRe), ([word]) => word);
  const delimiters: Array<{chomp: boolean, name: string}> = [];
  for (const [index, word] of words.entries()) {
    const operator = /^\d*<<-?/.exec(word)?.[0];
    if (!operator || word.includes("<", operator.length)) continue;
    const name = word.slice(operator.length) || words[index + 1];
    if (name) delimiters.push({chomp: operator.endsWith("-"), name: name.replace(/\\(.)|["']/g, "$1")});
  }
  return delimiters;
}

function *dockerfileInstructions(content: string): Generator<{text: string, index: number}> { // blanks comments and continuations so offsets match `content`
  let escape = "\\";
  let inDirectives = true;
  let heredocs: Array<{chomp: boolean, name: string}> = [];
  let text = "";
  let start = 0;
  let nextLine = 0;
  for (const line of content.split("\n")) {
    const index = nextLine;
    nextLine += line.length + 1;
    if (heredocs.length) {
      const {chomp, name} = heredocs[0];
      if ((chomp ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === name) heredocs.shift();
      continue;
    }
    if (inDirectives) {
      const directive = dockerDirectiveRe.exec(line);
      if (directive) {
        if (directive[1].toLowerCase() === "escape") escape = directive[2];
        yield {text: line, index};
        continue;
      }
      inDirectives = false;
    }
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) {
      if (text) text += `${" ".repeat(line.length)}\n`;
      continue;
    }
    if (!text) start = index;
    const end = line.trimEnd().length;
    if (line[end - 1] === escape && line[end - 2] !== escape) {
      text += `${line.slice(0, end - 1)} ${line.slice(end)}\n`;
      continue;
    }
    text += line;
    yield {text, index: start};
    heredocs = text.includes("<<") && heredocInstructionRe.test(text) ? heredocDelimiters(text) : [];
    text = "";
  }
  if (text) yield {text, index: start};
}

function *dockerfileImages(content: string, recursive = false): Generator<{
  image: string, index: number, args: Map<string, DockerArg>, resolved: string,
}> {
  const args = new Map<string, DockerArg>();
  const imageAt = (image: string, index: number) => ({image, index, args,
    resolved: resolveDockerVariables(image, name => args.get(name)?.[recursive ? "resolved" : "value"])});
  let sawFrom = false;
  for (const {text, index} of dockerfileInstructions(content)) {
    const arg = sawFrom ? null : dockerArgRe.exec(text);
    if (arg) {
      const value = arg[2]?.replace(/^(['"])(.*)\1$/, "$2") ?? "";
      args.set(arg[1], {value, resolved: resolveDockerVariables(value, name => args.get(name)?.resolved),
        start: index + text.lastIndexOf(value)});
      continue;
    }
    sawFrom ||= /^\s*FROM\s/i.test(text);
    const single = dockerfileImageRe.exec(text);
    if (single) yield imageAt(single[1], index + single[0].length - single[1].length);
    const runFlags = runFlagsRe.exec(text)?.[0];
    if (!runFlags || !/from=/i.test(runFlags)) continue;
    for (const mount of runFlags.matchAll(mountImageRe)) yield imageAt(mount[0], index + mount.index);
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
  if (ref.includes("$")) return null;
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

export function extractDockerRefs(content: string, fileType: "dockerfile" | "compose"): Array<{ref: DockerImageRef, match: string}> {
  const results: Array<{ref: DockerImageRef, match: string}> = [];
  if (fileType === "dockerfile") {
    for (const {image, resolved} of dockerfileImages(content, true)) {
      const ref = parseDockerImageRef(resolved);
      if (ref) results.push({ref, match: image});
    }
    return results;
  }
  const locallyBuilt = locallyBuiltImages(content);
  for (const match of content.matchAll(composeImageRe)) {
    if (locallyBuilt.has(match.index + match[0].indexOf("image:"))) continue;
    const ref = parseDockerImageRef(match[1].replace(/^\$\{\w+:-([^${}]+)\}$/, "$1"));
    if (ref) results.push({ref, match: match[1]});
  }
  return results;
}

function locallyBuiltImages(content: string): Set<number> {
  const result = new Set<number>();
  const scopes = new Map<number, {built: boolean, images: Array<number>}>();
  for (const line of content.matchAll(/^.*$/gm)) {
    if (!line[0].trim() || line[0].trimStart().startsWith("#")) continue;
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
const dockerTagPageSize = 100; // Hub caps page_size at 100
const maxDockerTagPages = 10; // anonymous requests are refused past 1000 tags

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
    const pageUrl = (page: number) => `${baseUrl}?page_size=${dockerTagPageSize}&ordering=last_updated&page=${page}`;
    const fetchPage = (url: string) => fetchHubJson(url, ctx, `${namespace}/${repo}`, data => ({
      count: data.count,
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

    const page = await fetchPage(pageUrl(1));
    if (!page) return tags;
    take(page);
    const pageUrls = Array.from({length: Math.min(maxDockerTagPages, Math.ceil(page.count / dockerTagPageSize)) - 1},
      (_, index) => pageUrl(index + 2));
    const pages = await pMap(pageUrls, url => tryOrNull(fetchPage(url)), {concurrency: effectiveConcurrency(ctx)});
    for (const laterPage of pages) { // pages run newest first, so a failed one only drops older tags
      if (!laterPage) break;
      take(laterPage);
    }
    return tags;
  });
}

export async function fetchDockerHubTags(namespace: string, repo: string, ctx: ModeContext): Promise<Record<string, string>> {
  return (await fetchDockerHubTagPages(namespace, repo, ctx)).dates;
}

const localRegistryRe = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const bearerChallengeRe = /(?:^|,\s*)Bearer\s+(.+)$/i;
const challengeParamRe = /(\w+)=(?:"([^"]*)"|([^\s,]*))/g;
const nextLinkRe = /<([^>]+)>[^,]*?;\s*rel="?next"?/;
const manifestAccept = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const registryTokensByCtx = new WeakMap<ModeContext, Map<string, Promise<string | null>>>();
const registryTagsByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, string>>>>();

const registryUrl = (registry: string, path: string, suffix: string) =>
  `${localRegistryRe.test(registry) ? "http" : "https"}://${registry}/v2/${path}/${suffix}`;

async function fetchRegistryToken(challenge: string, path: string, ctx: ModeContext): Promise<string | null> {
  const params: Record<string, string> = {};
  for (const match of challenge.matchAll(challengeParamRe)) params[match[1].toLowerCase()] ??= match[2] ?? match[3];
  if (!params.realm) return null;
  const tokenUrl = new URL(params.realm);
  if (params.service) tokenUrl.searchParams.set("service", params.service);
  tokenUrl.searchParams.set("scope", params.scope || `repository:${path}:pull`);
  const res = await fetchWithRetry(ctx, tokenUrl.href);
  if (noTagsStatus.has(res.status)) return null;
  if (!res.ok) throwFetchError(res, tokenUrl.href, path, tokenUrl.host);
  const data = await res.json();
  const token = data.token ?? data.access_token;
  return typeof token === "string" ? token : null;
}

async function fetchRegistry(url: string, path: string, ctx: ModeContext, method = "GET", headers: Record<string, string> = {}): Promise<Response> {
  const tokens = getOrSet(registryTokensByCtx, ctx, () => new Map<string, Promise<string | null>>());
  const key = `${new URL(url).host}/${path}`;
  const send = (token: string | null | undefined) =>
    fetchWithRetry(ctx, url, {method, headers: {...headers, ...(token && {authorization: `Bearer ${token}`})}});
  const used = await tokens.get(key);
  const res = await send(used);
  if (res.status !== 401) return res;
  const challenge = bearerChallengeRe.exec(res.headers.get("www-authenticate") ?? "")?.[1];
  if (!challenge) return res;
  const token = await getOrSet(tokens, key, () => fetchRegistryToken(challenge, path, ctx));
  return token && token !== used ? send(token) : res;
}

function fetchRegistryTags(registry: string, path: string, ctx: ModeContext): Promise<Record<string, string>> {
  return dedupe(registryTagsByCtx, ctx, `${registry}/${path}`, async () => {
    const tags: Record<string, string> = {};
    if (registry === "quay.io") { // lists newest first, its registry API lexically
      for (let page = 1; page <= maxDockerTagPages; page++) {
        const url = `https://quay.io/api/v1/repository/${path}/tag/?limit=100&onlyActiveTags=true&page=${page}`;
        const res = await fetchWithRetry(ctx, url, {headers: {"x-requested-with": "XMLHttpRequest"}});
        if (noTagsStatus.has(res.status)) break;
        if (!res.ok) throwFetchError(res, url, `${registry}/${path}`, registry);
        const data = await res.json();
        for (const {name, start_ts} of data.tags ?? []) tags[name] = start_ts ? new Date(start_ts * 1000).toISOString() : "";
        if (!data.has_additional) break;
      }
      return tags;
    }
    let url: string | undefined = registryUrl(registry, path, "tags/list?n=1000");
    for (let page = 0; url && page < maxDockerTagPages; page++) {
      const res = await fetchRegistry(url, path, ctx);
      if (noTagsStatus.has(res.status)) break;
      if (!res.ok) throwFetchError(res, url, `${registry}/${path}`, registry);
      const data = await res.json();
      for (const tag of data.tags ?? []) tags[tag] = "";
      for (const {tag = [], timeUploadedMs} of Object.values<any>(data.manifest ?? {})) { // Google registries list upload times
        for (const name of tag) if (Number(timeUploadedMs)) tags[name] = new Date(Number(timeUploadedMs)).toISOString();
      }
      const next = nextLinkRe.exec(res.headers.get("link") ?? "")?.[1];
      url = next ? new URL(next, url).href : undefined;
    }
    return tags;
  });
}

export async function fetchDockerTagDigest(image: string, tag: string, ctx: ModeContext): Promise<string | null> {
  const {registry, namespace, repo} = parseImageParts(image);
  if (registry) {
    const path = image.slice(registry.length + 1);
    const url = registryUrl(registry, path, `manifests/${tag}`);
    const res = await fetchRegistry(url, path, ctx, "HEAD", {accept: manifestAccept});
    if (noTagsStatus.has(res.status)) return null;
    if (!res.ok) throwFetchError(res, url, `${image}:${tag}`, registry);
    return res.headers.get("docker-content-digest");
  }
  // The listing carries the same manifest digest, so a tag only costs a request when it is missing there.
  const listed = (await fetchDockerHubTagPages(namespace, repo, ctx)).digests.get(tag);
  if (listed) return listed;
  const url = `${ctx.dockerApiUrl}/v2/repositories/${namespace}/${repo}/tags/${tag}`;
  const digest = (await fetchHubJson(url, ctx, `${namespace}/${repo}:${tag}`, data => ({digest: data.digest})))?.digest;
  return typeof digest === "string" ? digest : null; // absent on tags pushed before Docker Hub recorded manifest digests
}

const registryTagDatesByCtx = new WeakMap<ModeContext, Map<string, Promise<string>>>();
const imageCreatedLabel = "org.opencontainers.image.created";
const imageDate = (date: unknown) => typeof date === "string" && Date.parse(date) >= Date.UTC(2000, 0) ? date : ""; // reproducible builds stamp 1970 or 0001
const annotatedDate = (manifest: any) => imageDate(manifest?.annotations?.[imageCreatedLabel]);

export function fetchRegistryTagDate(image: string, tag: string, ctx: ModeContext): Promise<string> {
  const registry = parseImageParts(image).registry!;
  const path = image.slice(registry.length + 1);
  return dedupe(registryTagDatesByCtx, ctx, `${image}:${tag}`, async () => {
    const fetchJson = async (suffix: string) => {
      const url = registryUrl(registry, path, suffix);
      const res = await fetchRegistry(url, path, ctx, "GET", {accept: manifestAccept});
      if (noTagsStatus.has(res.status)) return null;
      if (!res.ok) throwFetchError(res, url, `${image}:${tag}`, registry);
      return res.json();
    };
    let manifest = await fetchJson(`manifests/${tag}`);
    for (let depth = 0; depth < 3 && !annotatedDate(manifest); depth++) {
      const platform = manifest?.manifests?.find((entry: any) => entry.platform?.os !== "unknown");
      if (!platform) break;
      manifest = await fetchJson(`manifests/${platform.digest}`);
    }
    if (annotatedDate(manifest) || !manifest?.config?.digest) return annotatedDate(manifest);
    const config = await fetchJson(`blobs/${manifest.config.digest}`);
    return imageDate(config?.created) || imageDate(config?.config?.Labels?.[imageCreatedLabel]);
  });
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
  const tags = registry ? await fetchRegistryTags(registry, name.slice(registry.length + 1), ctx) :
    filterStableTags(repo, await fetchDockerHubTags(namespace, repo, ctx));
  return [{tags, name}, null];
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

const maxDateLookups = 3;

export async function findDockerVersion(
  tagMap: Record<string, string>,
  oldTag: string,
  semvers: Set<string>,
  cooldownDays?: number,
  now?: number,
  pinnedRange?: string,
  usePre = false,
  useRel = false,
  resolveDate?: (tag: string) => Promise<string>,
): Promise<{newTag: string, date: string} | null> {
  const oldParsed = parseDockerTag(oldTag);
  if (!oldParsed) return null;

  const oldShape = dockerVersionShape(oldParsed.version);
  const oldIsDate = firstVersionField(oldParsed.version) >= dateVersionMin;
  const oldSemver = dockerSemver(oldParsed);
  const {effectiveSemvers, skipsPrerelease} = prereleaseOpts(oldSemver, usePre, useRel, semvers);
  const extended = oldShape.length > 2 || oldShape.includes("_");
  const unresolved = new Set(resolveDate && cooldownDays && now ? Object.keys(tagMap).filter(tag => !tagMap[tag]) : []);
  const dates = unresolved.size ? {...tagMap} : tagMap;
  const pick = () => {
    let bestVersion = parse(oldSemver)!;
    let bestParsed = oldParsed;
    let best = {newTag: "", date: ""};

    for (const [tagName, lastUpdated] of Object.entries(dates)) {
      const parsed = parseDockerTag(tagName);
      if (!parsed || parsed.suffix !== oldParsed.suffix || dockerVersionShape(parsed.version) !== oldShape) continue;
      if (!oldIsDate && firstVersionField(parsed.version) >= dateVersionMin) continue;
      if (!unresolved.has(tagName) && !passesCooldown(lastUpdated, cooldownDays, now)) continue;

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
    return {best, bestVersion};
  };

  let {best, bestVersion} = pick();
  for (let lookups = 1; unresolved.has(best.newTag); lookups++) {
    unresolved.delete(best.newTag);
    dates[best.newTag] = await resolveDate!(best.newTag) || dates[best.newTag];
    if (lookups === maxDateLookups) unresolved.clear();
    ({best, bestVersion} = pick());
  }

  if (!best.newTag) return null;
  if (extended) return best;
  const [bestRelease, bestPre = ""] = bestVersion.version.split("-");
  const formatted = formatVersionPrecision(bestRelease, oldParsed.version, `${bestPre}${oldParsed.suffix}`);
  const newTag = formatted in tagMap && (formatted === best.newTag || passesCooldown(dates[formatted], cooldownDays, now)) ?
    formatted : best.newTag;
  return newTag === oldTag ? null : {newTag, date: best.date};
}

const tagEnd = "(?![\\w.@+/-])";

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

function replaceImageRefs(content: string, byRef: Map<string, string>, prefixes: Array<string>,
  canReplace = (_offset: number) => true): string {
  if (!byRef.size) return content;
  const refs = longestFirstAlternation(byRef.keys());
  let newContent = content;
  for (const prefix of prefixes) {
    newContent = newContent.replace(new RegExp(`(${prefix})(${refs})${tagEnd}`, "gm"),
      (match, start, ref, offset) => canReplace(offset) ? `${start}${byRef.get(ref) ?? ref}` : match);
  }
  return newContent;
}

export function updateDockerfile(content: string, deps: Deps): string {
  const replacements = imageReplacements(deps);
  if (!replacements.size) return content;
  const edits = new Map<number, [number, string]>();
  for (const {image, index, args, resolved} of dockerfileImages(content)) {
    const replacement = replacements.get(resolved);
    if (!replacement) continue;
    if (image === resolved) {
      edits.set(index, [image.length, replacement]);
      continue;
    }
    const oldAt = resolved.lastIndexOf("@");
    const newAt = replacement.lastIndexOf("@");
    const oldDigest = resolved.slice(oldAt + 1);
    const newDigest = replacement.slice(newAt + 1);
    const replacesDigest = oldAt !== -1 && newAt !== -1 && oldDigest !== newDigest;
    const relativeDigest = replacesDigest ? image.lastIndexOf(oldDigest) : -1;
    const argValueOf = (name: string) => args.get(name)?.value;
    let tailStart = 0;
    let rewritesArg = false;
    for (const variable of image.matchAll(/\$(?:\{(\w+)\}|(\w+))/g)) {
      tailStart = variable.index + variable[0].length;
      const argValue = args.get(variable[1] || variable[2]);
      const prefix = resolveDockerVariables(image.slice(0, variable.index), argValueOf);
      let suffix = resolveDockerVariables(image.slice(tailStart), argValueOf);
      if (replacesDigest) suffix = suffix.replace(oldDigest, () => newDigest);
      if (!argValue || !replacement.startsWith(prefix) || !replacement.endsWith(suffix)) continue;
      edits.set(argValue.start, [argValue.value.length, replacement.slice(prefix.length, suffix ? -suffix.length : undefined)]);
      rewritesArg = true;
    }
    const tailPrefix = resolveDockerVariables(image.slice(0, tailStart), argValueOf);
    if (!rewritesArg && tailStart < image.length && replacement.startsWith(tailPrefix)) {
      edits.set(index + tailStart, [image.length - tailStart, replacement.slice(tailPrefix.length)]);
    } else if (relativeDigest !== -1) {
      edits.set(index + relativeDigest, [oldDigest.length, newDigest]);
    }
  }
  const chunks: Array<string> = [];
  let end = 0;
  for (const [start, [length, value]] of [...edits].sort(([left], [right]) => left - right)) {
    chunks.push(content.slice(end, start), value);
    end = start + length;
  }
  chunks.push(content.slice(end));
  return chunks.join("");
}

export function updateComposeFile(content: string, deps: Deps): string {
  const locallyBuilt = locallyBuiltImages(content);
  return replaceImageRefs(content, imageReplacements(deps), [
    String.raw`${keyStart}image:\s*['"]?(?:\$\{\w+:-(?=[^{}$]+\}['"]?(?:\s|[,}#]|$)))?`,
  ], offset => !locallyBuilt.has(offset));
}

export function updateWorkflowDockerImages(content: string, deps: Deps): string {
  return replaceImageRefs(content, imageReplacements(deps), [
    String.raw`${keyStart}(?:container|image):\s*['"]?`,
    String.raw`${keyStart}uses:\s*['"]?docker://`,
  ]);
}

export const dockerExactFileNames = [
  "Dockerfile", "dockerfile", "Containerfile", "containerfile", "compose.yml", "compose.yaml",
  "compose.override.yml", "compose.override.yaml", "docker-compose.yml", "docker-compose.yaml",
  "docker-compose.override.yml", "docker-compose.override.yaml",
];

export function isComposeFile(filename: string): boolean {
  return /^(?:docker-|compose).*\.ya?ml$/.test(filename);
}

export function isDockerfile(filename: string): boolean {
  return /^(?:[Dd]ocker|[Cc]ontainer)file|\.(?:[Dd]ocker|[Cc]ontainer)file$/.test(filename);
}

export function isDockerFileName(filename: string): boolean {
  return isDockerfile(filename) || isComposeFile(filename);
}

export function getDockerInfoUrl(ref: DockerImageRef): string {
  if (ref.registry) return "";
  if (ref.namespace === "library") return `https://hub.docker.com/_/${ref.repo}`;
  return `https://hub.docker.com/r/${ref.namespace}/${ref.repo}`;
}
