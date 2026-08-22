import {env} from "node:process";
import {parse, satisfies, valid, validRange} from "../utils/semver.ts";
import rc from "../utils/rc.ts";
import {getOrSet, tryOrNull} from "../utils/utils.ts";
import {resolveNativeNpmRegistry} from "../utils/workspace.ts";
import {
  type Config, type CheckResult, type Dep, type Deps, type ModeContext, type PackageInfo, type PackageRepository,
  normalizeUrl, getFetchOpts, fieldSep, fetchForgeEtag, selectTag, fetchWithEtag, fetchImmutable, dedupe,
  coerceToVersion, hashRe, fetchForgeTags, throwFetchError, fetchWithRetry, defaultApiUrls, parseCommitDate,
  reduceJson,
} from "./shared.ts";

type Npmrc = Record<string, any> & {registry: string};
type AuthAndRegistry = {auth: {token: string, type: string} | undefined, registry: string};

const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;

export const selectorTypes = new Set(["resolutions", "overrides"]);

export function resolutionsBasePackage(name: string): string {
  return /(?:^|\/)((?:@[^/]+\/)?[^/@]+)(?:@[^/]*)?$/.exec(name)?.[1] ?? name;
}

const defaultRegistry = defaultApiUrls.registry;
const npmrcCache = new Map<string, Npmrc>();
const authCache = new Map<string, AuthAndRegistry>();

const replaceEnvVar = (token: string): string => token.replace(/^\$\{?([^}]*)\}?$/, (_, envVar) => env[envVar] || "");

function getRegistryAuthToken(registryUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  const parsed = new URL(registryUrl.startsWith("//") ? `http:${registryUrl}` : registryUrl);
  let pathname: string | undefined;

  while (pathname !== "/" && parsed.pathname !== pathname) {
    pathname = parsed.pathname || "/";
    const regUrl = `//${parsed.host}${pathname.replace(/\/$/, "")}`;
    const get = (key: string) => config[`${regUrl}:${key}`] || config[`${regUrl}/:${key}`];
    const bearerToken = get("_authToken");
    if (bearerToken) return {token: replaceEnvVar(bearerToken), type: "Bearer"};
    const username = get("username");
    const password = get("_password");
    if (username && password) {
      const pass = Buffer.from(replaceEnvVar(password), "base64").toString("utf8");
      return {token: Buffer.from(`${username}:${pass}`).toString("base64"), type: "Basic"};
    }
    const legacyToken = get("_auth");
    if (legacyToken) return {token: replaceEnvVar(legacyToken), type: "Basic"};
    parsed.pathname = new URL("..", new URL(pathname.endsWith("/") ? pathname : `${pathname}/`, "http://x")).pathname;
  }

  if (registryUrl === defaultRegistry && config["_auth"]) return {token: replaceEnvVar(config["_auth"]), type: "Basic"};
  return undefined;
}

function resolveNpmRegistry(name: string, config: Config, args: Record<string, any>, dir: string | undefined): AuthAndRegistry {
  const npmrcConfig = getOrSet(npmrcCache, dir ?? "", () => rc("npm", {registry: defaultRegistry}, dir) as Npmrc);
  const registry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || npmrcConfig.registry || defaultRegistry);
  const scope = name.startsWith("@") ? name.split("/")[0] : "";
  const nativeRegistry = dir ? resolveNativeNpmRegistry(name, dir) : null;
  const nativeDefaultRegistry = scope && dir ? resolveNativeNpmRegistry("", dir) : null;
  return getOrSet(authCache, `${dir ?? ""}${fieldSep}${scope}:${registry}:${nativeRegistry ?? ""}:${nativeDefaultRegistry ?? ""}`, () => {
    let resolvedRegistry = nativeRegistry ? normalizeUrl(nativeRegistry) : registry;
    const scoped = nativeRegistry === nativeDefaultRegistry && scope && npmrcConfig[`${scope}:registry`]; // Specificity wins across sources.
    if (scoped) {
      try {
        const url = normalizeUrl(scoped);
        if (url !== resolvedRegistry) resolvedRegistry = url;
      } catch {}
    }
    return {auth: getRegistryAuthToken(resolvedRegistry, npmrcConfig), registry: resolvedRegistry};
  });
}

const npmPackageUrl = (registry: string, name: string, version?: string): string => {
  const base = `${registry}/${name.replace(/\//g, "%2f")}`;
  return version ? `${base}/${version}` : base;
};

const npmDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();
const npmVersionInfoByCtx = new WeakMap<ModeContext, Map<string, Promise<NpmVersionInfo>>>();
const npmFullDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any> | null>>>();
const jsrDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();

const docCacheKey = (url: string, needsDates: boolean) => `${url}\0v2${needsDates ? "-dates" : ""}`;

function reduceNpmDoc(data: Record<string, any>): Record<string, any> {
  const versions: Record<string, {deprecated?: true}> = {};
  for (const version of Object.keys(data.versions ?? {})) versions[version] = data.versions[version]?.deprecated ? {deprecated: true} : {};
  return {name: data.name, "dist-tags": data["dist-tags"], versions, time: data.time, error: data.error};
}

export async function fetchNpmInfo(name: string, type: string, config: Config, args: Record<string, any>, ctx: ModeContext, dir?: string, version = ""): Promise<PackageInfo> {
  const packageName = selectorTypes.has(type) ? resolutionsBasePackage(name) :
    type === "packageManager" && name === "yarn" && (parse(version)?.major ?? 0) > 1 ? "@yarnpkg/cli" : name;
  const {auth, registry} = resolveNpmRegistry(packageName, config, args, dir);
  const url = npmPackageUrl(registry, packageName);

  const cacheKey = docCacheKey(url, Boolean(args.needsDates));
  const data = await dedupe(npmDataByCtx, ctx, cacheKey, async () => {
    const opts = getFetchOpts(auth?.type, auth?.token);
    if (!args.needsDates) opts.headers = {...opts.headers as Record<string, string>,
      "accept": "application/vnd.npm.install-v1+json"};
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
      const result = await fetchImmutable(url, ctx, fetchOpts, reduceJson(data => ({
        repository: data.repository,
        homepage: data.homepage,
        _npmOperationalInternal: data._npmOperationalInternal?.tmp ? {tmp: data._npmOperationalInternal.tmp} : undefined,
      })));
      if (!("body" in result)) return {};
      const data = JSON.parse(result.body);
      let date = "";
      const match = /(\d{13})/.exec(data?._npmOperationalInternal?.tmp ?? "");
      if (match) date = new Date(Number(match[1])).toISOString();
      const fullUrl = npmPackageUrl(registry, name);
      if (!date && args.needsDates) date = (await npmDataByCtx.get(ctx)?.get(docCacheKey(fullUrl, true)))?.time?.[version] || "";
      if (!date) {
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

export function isCatalogRef(value: string): boolean {
  return value.startsWith("catalog:");
}

const npmAliasRe = /^npm:((?:@[^/@]+\/)?[^@/][^@]*)@(.+)$/;

export function parseNpmAlias(value: string): {name: string, range: string} | null {
  const match = npmAliasRe.exec(value);
  return match && validRange(match[2]) ? {name: match[1], range: match[2]} : null;
}

const jsrRefRe = /^(?:npm:@jsr\/([^_]+)__([^@]+)|jsr:@([^/]+)\/([^@]+))@(.+)$/;
const jsrScopedNameRe = /^@([^/]+)\/(.+)$/;

export function parseJsrDependency(value: string, packageName?: string): {scope: string | null, name: string | null, version: string} {
  const ref = jsrRefRe.exec(value);
  if (ref) return {scope: ref[1] || ref[3], name: ref[2] || ref[4], version: ref[5]};
  if (value.startsWith("jsr:") && !value.startsWith("jsr:@")) {
    const match = jsrScopedNameRe.exec(packageName ?? "");
    if (match) return {scope: match[1], name: match[2], version: value.substring(4)};
  }
  return {scope: null, name: null, version: ""};
}

export async function fetchJsrInfo(packageName: string, ctx: ModeContext): Promise<PackageInfo> {
  if (!jsrScopedNameRe.test(packageName)) throw new Error(`Invalid JSR package name: ${packageName}`);
  const url = `${ctx.jsrApiUrl}/${packageName}/meta.json`;

  const data = await dedupe(jsrDataByCtx, ctx, url, async () => {
    const result = await fetchWithEtag(url, ctx, {
      headers: {"accept-encoding": "gzip, deflate, br"},
    }, reduceJson(data => ({
      latest: data.latest,
      versions: Object.fromEntries(Object.entries(data.versions ?? {}).map(([version, meta]) => [version, {createdAt: (meta as Record<string, any>)?.createdAt}])),
    })));
    if (!("body" in result)) throwFetchError(result.res, url, packageName, "JSR");

    const responseData = JSON.parse(result.body);
    const versions: Record<string, any> = {};
    const time: Record<string, string> = {};
    for (const [version, metadata] of Object.entries((responseData.versions ?? {}) as Record<string, any>)) {
      versions[version] = {version, time: metadata.createdAt};
      time[version] = metadata.createdAt;
    }
    return {name: packageName, "dist-tags": {latest: responseData.latest}, versions, time};
  });
  return [data, ctx.jsrApiUrl];
}

export function updatePackageJson(pkgStr: string, deps: Deps): string {
  try { JSON.parse(pkgStr); } catch { return pkgStr; }
  const spans = new Map<string, {start: number, end: number, value: string}>();
  let position = 0;
  const whitespace = () => { while (/\s/.test(pkgStr[position] ?? "")) position++; };
  const string = () => {
    const start = position++;
    while (position < pkgStr.length) {
      if (pkgStr[position] === "\\") position += 2;
      else if (pkgStr[position++] === '"') break;
    }
    return {start, end: position, value: JSON.parse(pkgStr.slice(start, position)) as string};
  };
  const value = (path: Array<string | number>) => {
    whitespace();
    if (pkgStr[position] === '"') {
      spans.set(JSON.stringify(path), string());
    } else if (pkgStr[position] === "{") {
      position++;
      whitespace();
      while (pkgStr[position] !== "}" && position < pkgStr.length) {
        const key = string().value;
        whitespace();
        if (pkgStr[position++] !== ":") return;
        value([...path, key]);
        whitespace();
        if (pkgStr[position] === ",") { position++; whitespace(); } else break;
      }
      if (pkgStr[position] === "}") position++;
    } else if (pkgStr[position] === "[") {
      position++;
      let index = 0;
      whitespace();
      while (pkgStr[position] !== "]" && position < pkgStr.length) {
        value([...path, index++]);
        whitespace();
        if (pkgStr[position] === ",") { position++; whitespace(); } else break;
      }
      if (pkgStr[position] === "]") position++;
    } else {
      while (position < pkgStr.length && !/[,}\]]/.test(pkgStr[position])) position++;
    }
  };
  value([]);
  const edits: Array<{start: number, end: number, value: string}> = [];
  for (const [key, dep] of Object.entries(deps)) {
    const [depType, name, identity] = key.split(fieldSep);
    let oldValue = dep.oldOrig || dep.old;
    let span = spans.get(JSON.stringify(identity ? JSON.parse(identity) : [depType, name]));
    let newValue = dep.new;
    if (!span) {
      span = spans.get(JSON.stringify([depType]));
      oldValue = `${name}@${oldValue}`;
      newValue = `${name}@${newValue}`;
    }
    if (span?.value === oldValue) edits.push({...span, value: JSON.stringify(newValue)});
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    pkgStr = `${pkgStr.slice(0, edit.start)}${edit.value}${pkgStr.slice(edit.end)}`;
  }
  return pkgStr;
}

const operators = String.raw`[<>]=?|~>|[\^~=]`;
const comparatorRe = new RegExp(String.raw`^(${operators})?(\s*)(v?)((?:\d+|[xX*])(?:\.(?:\d+|[xX*]))*)(-[0-9A-Za-z.-]+)?$`);
const operatorRe = new RegExp(`^(?:${operators})$`);
const xPartRe = /^[xX*]$/;
const buildMetaRe = /\+[0-9A-Za-z.-]+/g;
const complexRangeRe = /\|\||[\dxX*]\s+\S/;

function comparators(range: string): Array<string> {
  const out: Array<string> = [];
  for (const token of range.trim().replaceAll("||", " || ").split(/\s+/)) {
    if (out.length && operatorRe.test(out[out.length - 1])) out[out.length - 1] += ` ${token}`;
    else out.push(token);
  }
  return out;
}

function replaceComparator(comparator: string, newVersion: string): string {
  const match = comparatorRe.exec(comparator);
  if (!match) return comparator;
  const [, operator = "", space, vPrefix, digits, pre = ""] = match;
  const parts = digits.split(".");

  if (operator === "<" && parts.length <= 3 && !/[xX*]/.test(digits)) {
    const {major, minor, patch} = parse(newVersion)!;
    const bound = parts.length === 1 ? `${major + 1}` :
      parts.length === 2 ? `${major}.${minor + 1}` :
        !pre && digits.endsWith(".0.0") ? `${major + 1}.0.0` :
          !pre && digits.endsWith(".0") ? `${major}.${minor + 1}.0` :
            `${major}.${minor}.${patch + 1}`;
    return `${operator}${space}${bound}`;
  }
  if (operator === ">" || operator === "<") return comparator;

  const newParts = newVersion.split("-")[0].split(".");
  if (newParts.join(".") !== newVersion) return `${operator}${space}${vPrefix}${newVersion}`;
  return `${operator}${space}${vPrefix}${parts.map((part, i) => xPartRe.test(part) ? part : newParts[i] ?? "0").join(".")}`;
}

function widenRange(range: string, newVersion: string): string {
  if (satisfies(newVersion, range)) return range;
  const parts = comparators(range);
  const last = parts[parts.length - 1];
  if (!last.startsWith("<") && parts[parts.length - 2] !== "-") {
    const branch = replaceComparator(last, newVersion);
    if (parts.length > 1 && last.startsWith(">") || branch === last) return range;
    return `${range} || ${branch}`;
  }
  parts[parts.length - 1] = replaceComparator(last, newVersion);
  return parts.join(" ");
}

export function updateVersionRange(oldRange: string, newVersion: string, oldOrig: string | undefined, depType?: string): string {
  const authored = (oldOrig || oldRange).replace(buildMetaRe, "");
  const updated = depType === "peerDependencies" || complexRangeRe.test(authored) ?
    widenRange(authored, newVersion) : replaceComparator(authored, newVersion);
  return satisfies(newVersion, updated) ? updated : authored;
}

export function normalizeRange(range: string): string {
  if (/[xX*]/.test(range)) return range;
  const versionMatches = range.match(npmVersionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(npmVersionRe, coerceToVersion(versionMatches[0]));
}

type CommitInfo = {hash: string, commit: Record<string, any>};

export async function getLatestCommit(user: string, repo: string, ctx: ModeContext): Promise<CommitInfo> {
  const url = `${ctx.forgeApiUrl}/repos/${user}/${repo}/commits`;
  const body = await fetchForgeEtag(url, ctx, "commits", async res => {
    const [latest] = JSON.parse(await res.text());
    return JSON.stringify(latest ? [{sha: latest.sha, commit: {committer: latest.commit?.committer, author: latest.commit?.author}}] : []);
  });
  const [latest] = body ? JSON.parse(body) : [];
  return latest ? {hash: latest.sha, commit: latest.commit} : {hash: "", commit: {}};
}

export async function getTags(user: string, repo: string, oldRef: string, ctx: ModeContext): Promise<Array<string>> {
  const entries = await fetchForgeTags(ctx.forgeApiUrl, user, repo, ctx, [oldRef]);
  return entries.map(entry => entry.name);
}

type GitHubSpec = {user: string, repo: string, ref: string, selector: string | null};

function parseGitHubSpec(value: string): GitHubSpec | null {
  const hash = value.lastIndexOf("#");
  if (hash === value.length - 1) return null;
  let source = value.slice(0, hash === -1 ? value.length : hash).replace(/^git\+/i, "");
  let fragment = hash === -1 ? "" : value.slice(hash + 1);
  if (/^github:/i.test(source)) source = source.slice(7);
  else if (/^git@github\.com:/i.test(source)) source = source.replace(/^git@github\.com:/i, "");
  else if (/^(?:https?|git|ssh):/i.test(source)) {
    const match = /^(?:https?|git|ssh):\/\/(?:[^/@]+@)?github\.com[/:](.+)$/i.exec(source);
    if (!match) return null;
    source = match[1];
  } else if (source.includes(":")) {
    return null;
  }
  if (!fragment) {
    const match = /^([^/]+\/[^/]+)\/(?:.*\/)?([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i.exec(source);
    if (!match) return null;
    source = match[1];
    fragment = match[2];
  }
  source = source.replace(/\.git$/i, "");
  const parts = source.split("/");
  if (parts.length !== 2 || !/^[a-z\d](?:-?[a-z\d]){0,38}$/i.test(parts[0]) || !/^[a-z\d._-]{1,100}$/i.test(parts[1])) return null;
  const selector = fragment.startsWith("semver:") && validRange(fragment.slice(7)) ? fragment.slice(7) : null;
  if (!selector && !hashRe.test(fragment) && !valid(fragment)) return null;
  return {user: parts[0], repo: parts[1], ref: selector ?? fragment, selector};
}

export async function checkUrlDep(key: string, dep: Dep, ctx: ModeContext): Promise<CheckResult | null> {
  const parsed = parseGitHubSpec(dep.old);
  if (!parsed) return null;
  const {user, repo, ref: oldRef, selector} = parsed;

  const replaceRef = (ref: string) => {
    const index = dep.old.lastIndexOf(oldRef);
    return `${dep.old.slice(0, index)}${ref}${dep.old.slice(index + oldRef.length)}`;
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
    const newTag = selectTag(tags, selector ? coerceToVersion(selector) : oldRef);
    if (newTag) {
      const newRef = selector ? updateVersionRange(selector, newTag.replace(/^v/, ""), selector) : newTag;
      if (newRef !== oldRef) return {key, newRange: replaceRef(newRef), user, repo, oldRef, newRef};
    }
  }

  return null;
}
