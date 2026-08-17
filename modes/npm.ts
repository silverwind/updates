import {env} from "node:process";
import {parse, satisfies, validRange} from "../utils/semver.ts";
import rc from "../utils/rc.ts";
import {getOrSet, tryOrNull} from "../utils/utils.ts";
import {
  type Config, type CheckResult, type Dep, type Deps, type ModeContext, type PackageInfo, type PackageRepository,
  normalizeUrl, getFetchOpts, fieldSep, fetchForgeEtag, selectTag, fetchWithEtag, fetchImmutable, dedupe,
  coerceToVersion, hashRe, fetchActionTags, throwFetchError, fetchWithRetry, defaultApiUrls, parseCommitDate, reduceJson,
} from "./shared.ts";

export type Npmrc = {
  registry: string,
  ca?: string,
  cafile?: string,
  cert?: string,
  certfile?: string,
  key?: string,
  keyfile?: string,
  [other: string]: any,
};

export type AuthAndRegistry = {
  auth: {
    token: string,
    type: string,
    username?: string | undefined,
    password?: string | undefined,
  } | undefined,
  registry: string,
};

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/]+)\/(?:.*\/)?([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
// matches each path segment incl. its scope, e.g. `foo/@scope/pkg` -> [`foo`, `@scope/pkg`]
const segmentRe = /(@[^/]+\/)?([^/]+)/g;
// the published name inside one segment, dropping yarn's `@range` discriminator: `qs@~6.14.1` -> `qs`
const segmentNameRe = /^(?:@[^/]+\/)?[^@]+/;

// The dep types whose keys are selectors rather than plain package names.
export const selectorTypes = new Set(["resolutions", "overrides"]);

// resolves a `resolutions`/`overrides` key to the published package, keeping the scope on the
// final segment, e.g. `@babel/core` -> `@babel/core`, `foo/@scope/pkg` -> `@scope/pkg`
export function resolutionsBasePackage(name: string): string {
  const segments = name.match(segmentRe);
  const last = segments ? segments[segments.length - 1] : name;
  return segmentNameRe.exec(last)?.[0] ?? last;
}

const defaultRegistry = defaultApiUrls.registry;
const npmrcCache = new Map<string, Npmrc>();
const authCache = new Map<string, AuthAndRegistry>();

// npm resolves `.npmrc` beside or above the manifest, so `dir` is the manifest's directory and two
// manifests can carry different ones. Omitting it falls back to the cwd.
export function getNpmrc(dir?: string): Npmrc {
  return getOrSet(npmrcCache, dir ?? "", () => rc("npm", {registry: defaultRegistry}, dir) as Npmrc);
}

function replaceEnvVar(token: string): string {
  return token.replace(/^\$\{?([^}]*)\}?$/, (_, envVar) => env[envVar] || "");
}

function getAuthInfoForUrl(regUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  const get = (key: string) => config[`${regUrl}:${key}`] || config[`${regUrl}/:${key}`];

  const bearerToken = get("_authToken");
  if (bearerToken) return {token: replaceEnvVar(bearerToken), type: "Bearer"};

  const username = get("username");
  const password = get("_password");
  if (username && password) {
    const pass = Buffer.from(replaceEnvVar(password), "base64").toString("utf8");
    return {token: Buffer.from(`${username}:${pass}`).toString("base64"), type: "Basic", username, password: pass};
  }

  const legacyToken = get("_auth");
  if (legacyToken) return {token: replaceEnvVar(legacyToken), type: "Basic"};

  return undefined;
}

function getRegistryAuthToken(registryUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  const parsed = new URL(registryUrl.startsWith("//") ? `http:${registryUrl}` : registryUrl);
  let pathname: string | undefined;

  while (pathname !== "/" && parsed.pathname !== pathname) {
    pathname = parsed.pathname || "/";
    const regUrl = `//${parsed.host}${pathname.replace(/\/$/, "")}`;
    const authInfo = getAuthInfoForUrl(regUrl, config);
    if (authInfo) return authInfo;
    const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
    parsed.pathname = new URL("..", new URL(normalized, "http://x")).pathname;
  }

  // Global legacy fallback
  const globalAuth = config["_auth"];
  if (globalAuth) return {token: replaceEnvVar(globalAuth), type: "Basic"};
  return undefined;
}

// Never the default registry as a fallback, that would override an explicit --registry.
function scopedRegistry(scope: string, npmrcConfig: Npmrc): string {
  const url: string = npmrcConfig[`${scope}:registry`] || "";
  return !url || url.endsWith("/") ? url : `${url}/`;
}

function getAuthAndRegistry(name: string, registry: string, dir: string | undefined): AuthAndRegistry {
  const npmrcConfig = getNpmrc(dir);
  const scope = name.startsWith("@") ? name.split("/")[0] : "";
  return getOrSet(authCache, `${dir ?? ""}${fieldSep}${scope}:${registry}`, () => {
    // A scope's own registry wins whether or not it carries credentials, as renovate registers the
    // scope→registry rule unconditionally: falling back would leak a private name to the wrong host.
    let result: AuthAndRegistry | undefined;
    const scoped = scope && scopedRegistry(scope, npmrcConfig);
    if (scoped) {
      try {
        const url = normalizeUrl(scoped);
        if (url !== registry) result = {auth: getRegistryAuthToken(url, npmrcConfig), registry: url};
      } catch {}
    }
    return result ?? {auth: getRegistryAuthToken(registry, npmrcConfig), registry};
  });
}

function resolveNpmRegistry(name: string, config: Config, args: Record<string, any>, dir: string | undefined): AuthAndRegistry & {originalRegistry: string} {
  const originalRegistry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || getNpmrc(dir).registry || defaultRegistry,
  );
  return {...getAuthAndRegistry(name, originalRegistry, dir), originalRegistry};
}

function npmPackageUrl(registry: string, name: string, version?: string): string {
  const base = `${registry}/${name.replace(/\//g, "%2f")}`;
  return version ? `${base}/${version}` : base;
}

// Per run, like go's goLatestByCtx and docker's hubTagsByCtx: a second updates() call in one
// process must re-request rather than answer from the finished run's map.
const npmDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();
const npmVersionInfoByCtx = new WeakMap<ModeContext, Map<string, Promise<NpmVersionInfo>>>();
const npmFullDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any> | null>>>();

// Bumped when the reducer drops or adds a field: an entry an older shape wrote still revalidates
// to a 304, so only a key it was never stored under refetches it.
const docShape = "v2";
// Keyed by url and doc flavor too, as the abbreviated doc omits fields a later dated call needs.
const docCacheKey = (url: string, needsDates: boolean) => `${url}\0${docShape}${needsDates ? "-dates" : ""}`;

// The doc shape is kept, so legacy cache entries with full bodies stay readable.
function reduceNpmDoc(data: Record<string, any>): Record<string, any> {
  const versions: Record<string, {deprecated?: true}> = {};
  for (const version of Object.keys(data.versions ?? {})) versions[version] = data.versions[version]?.deprecated ? {deprecated: true} : {};
  return {name: data.name, "dist-tags": data["dist-tags"], versions, time: data.time, error: data.error};
}

export async function fetchNpmInfo(name: string, type: string, config: Config, args: Record<string, any>, ctx: ModeContext, dir?: string, version = ""): Promise<PackageInfo> {
  // corepack publishes yarn 2 and up as `@yarnpkg/cli`, only yarn 1 lives under `yarn`. renovate's rule.
  const packageName = selectorTypes.has(type) ? resolutionsBasePackage(name) :
    type === "packageManager" && name === "yarn" && (parse(version)?.major ?? 0) > 1 ? "@yarnpkg/cli" : name;
  // The published name, not the manifest key, is what a scoped `.npmrc` registry and its token key on.
  const {auth, registry} = resolveNpmRegistry(packageName, config, args, dir);
  const url = npmPackageUrl(registry, packageName);

  const cacheKey = docCacheKey(url, Boolean(args.needsDates));
  const data = await dedupe(npmDataByCtx, ctx, cacheKey, async () => {
    const opts = getFetchOpts(auth?.type, auth?.token);
    // The abbreviated doc is a fraction of the size but omits the `time` map that cooldown reads.
    if (!args.needsDates) {
      opts.headers = {...opts.headers as Record<string, string>, "accept": "application/vnd.npm.install-v1+json"};
    }
    const result = await fetchWithEtag(url, ctx, opts, reduceJson(reduceNpmDoc), cacheKey);
    if (!("body" in result)) throwFetchError(result.res, url, name, registry);
    return JSON.parse(result.body);
  });
  return [data, registry];
}

export type NpmVersionInfo = {repository?: PackageRepository, homepage?: string, date?: string};

export async function fetchNpmVersionInfo(name: string, version: string, config: Config, args: Record<string, any>, ctx: ModeContext, dir?: string): Promise<NpmVersionInfo> {
  const {auth, registry} = resolveNpmRegistry(name, config, args, dir);
  const url = npmPackageUrl(registry, name, version);

  return dedupe(npmVersionInfoByCtx, ctx, url, async (): Promise<NpmVersionInfo> => {
    try {
      const fetchOpts = getFetchOpts(auth?.type, auth?.token);
      // Per-version npm metadata is immutable — cache forever.
      // Undefined fields drop out at JSON.stringify time.
      const result = await fetchImmutable(url, ctx, fetchOpts, reduceJson(data => ({
        repository: data.repository,
        homepage: data.homepage,
        _npmOperationalInternal: data._npmOperationalInternal?.tmp ? {tmp: data._npmOperationalInternal.tmp} : undefined,
      })));
      if (!("body" in result)) return {};
      const data = JSON.parse(result.body);
      let date = "";
      const tmp: string | undefined = data?._npmOperationalInternal?.tmp;
      if (tmp) {
        const match = /(\d{13})/.exec(tmp);
        if (match) date = new Date(Number(match[1])).toISOString();
      }
      const fullUrl = npmPackageUrl(registry, name);
      // With a cooldown active the package doc was already fetched in full, under the dated key.
      if (!date && args.needsDates) date = (await npmDataByCtx.get(ctx)?.get(docCacheKey(fullUrl, true)))?.time?.[version] || "";
      if (!date) {
        // _npmOperationalInternal is absent on some registries, fetch full metadata
        const fullData = await tryOrNull(dedupe(npmFullDataByCtx, ctx, fullUrl, async () => {
          const res = await fetchWithRetry(ctx, fullUrl, fetchOpts);
          return res?.ok ? await res.json() : null;
        }));
        date = fullData?.time?.[version] || "";
      }
      return {repository: data.repository, homepage: data.homepage, date};
    } catch {
      return {};
    }
  });
}

export function isJsr(value: string): boolean {
  return value.startsWith("npm:@jsr/") || value.startsWith("jsr:");
}

export function isLocalDep(value: string): boolean {
  return value.startsWith("link:") || value.startsWith("file:");
}

// A pnpm catalog reference: `catalog:` for the default catalog, `catalog:<name>` for a named one.
export function isCatalogRef(value: string): boolean {
  return value.startsWith("catalog:");
}

// The `npm:@jsr/…` flavour is a jsr specifier and belongs to isJsr, which callers test first.
const npmAliasRe = /^npm:((?:@[^/@]+\/)?[^@/][^@]*)@(.+)$/;

// Null when the value is no alias this tool can resolve, e.g. one naming a dist-tag, not a range.
export function parseNpmAlias(value: string): {name: string, range: string} | null {
  const match = npmAliasRe.exec(value);
  return match && validRange(match[2]) ? {name: match[1], range: match[2]} : null;
}

// Both spellings carrying their own scope, name and version, anchored so they need no prefix check.
const jsrRefRes = [
  /^npm:@jsr\/([^_]+)__([^@]+)@(.+)$/, // npm:@jsr/std__semver@1.0.5
  /^jsr:@([^/]+)\/([^@]+)@(.+)$/, // jsr:@std/semver@1.0.5
];
const jsrScopedNameRe = /^@([^/]+)\/(.+)$/;

// - "npm:@jsr/std__semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:@std/semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:1.0.5" (when package name is known) -> { scope: null, name: null, version: "1.0.5" }
export function parseJsrDependency(value: string, packageName?: string): {scope: string | null, name: string | null, version: string} {
  for (const re of jsrRefRes) {
    const match = re.exec(value);
    if (match) return {scope: match[1], name: match[2], version: match[3]};
  }
  // A bare `jsr:1.0.5` takes scope and name from the dependency key instead. `jsr:@` is
  // excluded so a scoped ref without a version is not read as one.
  if (value.startsWith("jsr:") && !value.startsWith("jsr:@")) {
    const match = jsrScopedNameRe.exec(packageName ?? "");
    if (match) return {scope: match[1], name: match[2], version: value.substring(4)};
  }
  return {scope: null, name: null, version: ""};
}

export async function fetchJsrInfo(packageName: string, ctx: ModeContext): Promise<PackageInfo> {
  if (!jsrScopedNameRe.test(packageName)) {
    throw new Error(`Invalid JSR package name: ${packageName}`);
  }
  const url = `${ctx.jsrApiUrl}/${packageName}/meta.json`;

  const result = await fetchWithEtag(url, ctx, {
    headers: {"accept-encoding": "gzip, deflate, br"},
  }, reduceJson(data => ({
    latest: data.latest,
    versions: Object.fromEntries(Object.entries(data.versions ?? {}).map(([version, meta]) => [version, {createdAt: (meta as Record<string, any>)?.createdAt}])),
  })));
  if (!("body" in result)) throwFetchError(result.res, url, packageName, "JSR");

  const data = JSON.parse(result.body);
  // Transform JSR format to match npm-like format for compatibility
  const versions: Record<string, any> = {};
  const time: Record<string, string> = {};
  for (const [version, metadata] of Object.entries((data.versions ?? {}) as Record<string, any>)) {
    versions[version] = {version, time: metadata.createdAt};
    time[version] = metadata.createdAt;
  }
  return [{name: packageName, "dist-tags": {latest: data.latest}, versions, time}, ctx.jsrApiUrl];
}

const jsonSpace = new Set([0x20, 0x09, 0x0a, 0x0d]);

// The text span of every top-level pair, key included. A textual `content.indexOf('"overrides"')`
// would find a nested `pnpm.overrides` written above the top-level one, hence the structural scan.
function topLevelSpans(content: string): Map<string, {start: number, end: number}> {
  const spans = new Map<string, {start: number, end: number}>();
  let depth = 0;
  let key: string | null = null;
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code === 0x22) { // '"'
      const from = index;
      while (content.charCodeAt(++index) !== 0x22 && index < content.length) if (content.charCodeAt(index) === 0x5c) index++; // '\'
      if (depth === 1 && key === null) {
        key = content.slice(from + 1, index);
        start = from;
      }
    } else if (code === 0x7b || code === 0x5b) { // '{' '['
      depth++;
    } else if (code === 0x7d || code === 0x5d) { // '}' ']'
      if (--depth === 0 && key !== null) spans.set(key, {start, end: index});
      if (depth === 0) key = null;
    } else if (code === 0x2c && depth === 1 && key !== null) { // ','
      spans.set(key, {start, end: index});
      key = null;
    }
  }
  return spans;
}

// Matched as a `"key": "value"` pair, so two names sharing a value in one section are not confused.
function pairValueIndex(content: string, from: number, keyJson: string, valueJson: string): number {
  for (let index = content.indexOf(keyJson, from); index !== -1; index = content.indexOf(keyJson, index + 1)) {
    let pos = index + keyJson.length;
    while (jsonSpace.has(content.charCodeAt(pos))) pos++;
    if (content.charCodeAt(pos) !== 0x3a) continue; // ':'
    pos++;
    while (jsonSpace.has(content.charCodeAt(pos))) pos++;
    if (content.startsWith(valueJson, pos)) return pos;
  }
  return -1;
}

// A dep whose pair is nowhere in its own top-level span is left alone. Deps arrive in document
// order, so a per-section cursor keeps the sweep linear.
export function updatePackageJson(pkgStr: string, deps: Deps): string {
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(pkgStr);
  } catch {
    return pkgStr;
  }
  const spans = topLevelSpans(pkgStr);
  const cursors = new Map<string, number>();
  const edits: Array<{index: number, length: number, text: string}> = [];
  for (const [depKey, {old, oldOrig, new: newVal}] of Object.entries(deps)) {
    const [depType, name] = depKey.split(fieldSep);
    const section = doc[depType];
    // `packageManager` is the one dep type whose section is the value itself.
    const inline = typeof section === "string";
    const oldValue = inline ? `${name}@${oldOrig || old}` : oldOrig || old;
    const span = spans.get(depType);
    if (!span || (inline ? section : section?.[name]) !== oldValue) continue;
    const keyJson = JSON.stringify(inline ? depType : name);
    const valueJson = JSON.stringify(oldValue);
    let index = pairValueIndex(pkgStr, cursors.get(depType) ?? span.start, keyJson, valueJson);
    // url deps are re-inserted after the regular ones, so a cursor-relative hit can land later.
    if (index === -1 || index >= span.end) index = pairValueIndex(pkgStr, span.start, keyJson, valueJson);
    if (index === -1 || index >= span.end) continue;
    cursors.set(depType, index + valueJson.length);
    edits.push({index, length: valueJson.length, text: JSON.stringify(inline ? `${name}@${newVal}` : newVal)});
  }
  if (!edits.length) return pkgStr;

  edits.sort((a, b) => a.index - b.index);
  const parts: Array<string> = [];
  let pos = 0;
  for (const {index, length, text} of edits) {
    if (index < pos) continue; // two deps landed on one span, so this one was placed wrong
    parts.push(pkgStr.slice(pos, index), text);
    pos = index + length;
  }
  parts.push(pkgStr.slice(pos));
  return parts.join("");
}

const operators = String.raw`[<>]=?|[\^~=]`;
// operator (plus any space), an optional `v`, release parts with x-ranges, an optional prerelease
const comparatorRe = new RegExp(String.raw`^(${operators})?(\s*)(v?)((?:\d+|[xX*])(?:\.(?:\d+|[xX*]))*)(-[0-9A-Za-z.-]+)?$`);
const operatorRe = new RegExp(`^(?:${operators})$`);
const xPartRe = /^[xX*]$/;
// build metadata belongs to the version it was authored with, never to its successor
const buildMetaRe = /\+[0-9A-Za-z.-]+/g;
// a range is complex when it holds more than one comparator, `||` and hyphen ranges included
const complexRangeRe = /\|\||[\dxX*]\s+\S/;

// Keeps the space an operator may have before its version, leaving a hyphen range's `-` as a marker.
function comparators(range: string): Array<string> {
  const out: Array<string> = [];
  // `||` needs no surrounding space, so whitespace alone leaves `^1.0.0||^2.0.0` as one comparator.
  for (const token of range.trim().replaceAll("||", " || ").split(/\s+/)) {
    if (out.length && operatorRe.test(out[out.length - 1])) out[out.length - 1] += ` ${token}`;
    else out.push(token);
  }
  return out;
}

// Keeps the operator, the authored precision and any x-range placeholder: `^5.9` -> `^6.1`, `1.x` -> `2.x`.
function replaceComparator(comparator: string, newVersion: string): string {
  const match = comparatorRe.exec(comparator);
  if (!match) return comparator;
  const [, operator = "", space, vPrefix, digits, pre = ""] = match;
  const parts = digits.split(".");

  // An exclusive upper bound rewritten onto the new version excludes the very version being
  // installed, so `<2.0.0` has to clear it rather than land on it, and `<V.0.0-0`, what `^`/`~`
  // desugar to, clears the whole major since it excludes every prerelease of V. Renovate's rule.
  if (operator === "<" && !vPrefix && parts.length <= 3 && !/[xX*]/.test(digits) && (!pre || pre === "-0")) {
    const {major, minor, patch} = parse(newVersion)!;
    const bound = pre ? `${major + 1}.0.0-0` :
      parts.length === 1 ? `${major + 1}` :
        parts.length === 2 ? `${major}.${minor + 1}` :
          digits.endsWith(".0.0") ? `${major + 1}.0.0` :
            `${major}.${minor}.${patch + 1}`;
    return `${operator}${space}${bound}`;
  }
  // A `>` already admits it; a `<` the branch above could not read cannot move without landing under it.
  if (operator === ">" || operator === "<") return comparator;

  // A prerelease can't be spelled in fewer than 3 numeric parts, so it replaces the whole range.
  const newParts = newVersion.split("-")[0].split(".");
  if (newParts.join(".") !== newVersion) return `${operator}${space}${vPrefix}${newVersion}`;
  return `${operator}${space}${vPrefix}${parts.map((part, i) => xPartRe.test(part) ? part : newParts[i] ?? "0").join(".")}`;
}

// Renovate widens rather than replaces when a range must keep admitting what it already admits:
// peer ranges always, and any multi-comparator range, whose earlier comparators a replace would
// silently drop. lib/modules/manager/npm/range.ts
function widens(depType: string | undefined, range: string): boolean {
  return depType === "peerDependencies" || complexRangeRe.test(range);
}

// lib/modules/versioning/npm/range.ts, rangeStrategy=widen: an upper bound moves out to admit
// the new version, everything else gains an or-branch for it.
function widenRange(range: string, newVersion: string): string {
  if (satisfies(newVersion, range)) return range; // already admitted, nothing to widen
  const parts = comparators(range);
  const last = parts[parts.length - 1];
  if (!last.startsWith("<") && parts[parts.length - 2] !== "-") {
    // A complex range ending in a lower bound has no widening renovate will spell out.
    const branch = replaceComparator(last, newVersion);
    if (parts.length > 1 && last.startsWith(">") || branch === last) return range;
    return `${range} || ${branch}`;
  }
  parts[parts.length - 1] = replaceComparator(last, newVersion);
  return parts.join(" ");
}

export function updateVersionRange(oldRange: string, newVersion: string, oldOrig: string | undefined, depType?: string): string {
  // corepack refuses a `packageManager` whose integrity hash no longer matches its version, so
  // `9.0.0+sha512.…` has to become a plain `11.20.0` rather than keep 9.0.0's hash.
  const authored = (oldOrig || oldRange).replace(buildMetaRe, "");
  const updated = widens(depType, authored) ? widenRange(authored, newVersion) : replaceComparator(authored, newVersion);
  // A range that excludes the version it was rewritten for installs something other than what the
  // run reports, so it is left as authored and the caller drops the dependency. `^1.0.0 <1.5.0`
  // widened onto 2.0.0 is one: only the `<` moves, and the caret still caps below the new major.
  return satisfies(newVersion, updated) ? updated : authored;
}

export function normalizeRange(range: string): string {
  if (/[xX*]/.test(range)) return range;
  const versionMatches = range.match(npmVersionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(npmVersionRe, coerceToVersion(versionMatches[0]));
}

type CommitInfo = {
  hash: string,
  commit: Record<string, any>,
};

// A failed lookup throws, as getTags does: swallowing it read a rate-limited or broken forge as a
// dependency with no newer commit. A repository with no commits at all is the one genuine empty.
export async function getLatestCommit(user: string, repo: string, ctx: ModeContext): Promise<CommitInfo> {
  const url = `${ctx.forgeApiUrl}/repos/${user}/${repo}/commits`;
  // Only the newest commit's date-bearing fields are read; drop the rest before caching.
  const body = await fetchForgeEtag(url, ctx, async res => {
    const [latest] = JSON.parse(await res.text());
    return JSON.stringify(latest ? [{sha: latest.sha, commit: {committer: latest.commit?.committer, author: latest.commit?.author}}] : []);
  });
  const [latest] = body ? JSON.parse(body) : [];
  return latest ? {hash: latest.sha, commit: latest.commit} : {hash: "", commit: {}};
}

export async function getTags(user: string, repo: string, oldRef: string, ctx: ModeContext): Promise<Array<string>> {
  const entries = await fetchActionTags(ctx.forgeApiUrl, user, repo, ctx, [oldRef]);
  return entries.map(e => e.name);
}

export async function checkUrlDep(key: string, dep: Dep, ctx: ModeContext): Promise<CheckResult | null> {
  const stripped = dep.old.replace(stripRe, "");
  const [, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return null;

  // replace the trailing ref occurrence, not an earlier coincidental match in the URL
  const replaceRef = (ref: string) => {
    const idx = dep.old.lastIndexOf(oldRef);
    return dep.old.slice(0, idx) + ref + dep.old.slice(idx + oldRef.length);
  };

  if (hashRe.test(oldRef)) {
    const {hash, commit} = await getLatestCommit(user, repo, ctx);
    if (!hash) return null;

    const newDate = parseCommitDate(commit);
    const newRef = hash.substring(0, oldRef.length);
    if (oldRef.toLowerCase() !== newRef.toLowerCase()) {
      return {key, newRange: replaceRef(newRef), user, repo, oldRef, newRef, newDate};
    }
  } else {
    const tags = await getTags(user, repo, oldRef, ctx);
    const newTag = selectTag(tags, oldRef);
    if (newTag) {
      return {key, newRange: replaceRef(newTag), user, repo, oldRef, newRef: newTag};
    }
  }

  return null;
}

