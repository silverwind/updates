import {env} from "node:process";
import {basename} from "node:path";
import rc from "../utils/rc.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {
  type Config, type CheckResult, type Dep, type Deps, type ModeContext, type PackageInfo, type PackageRepository,
  normalizeUrl, getFetchOpts, fieldSep, fetchForge, selectTag, fetchWithEtag, fetchImmutable,
  coerceToVersion, hashRe, fetchActionTags, throwFetchError,
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
const npmVersionRePre = /[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g;

const defaultRegistry = "https://registry.npmjs.org";
let npmrc: Npmrc | null = null;
const authCache = new Map<string, AuthAndRegistry>();

export function getNpmrc(): Npmrc {
  return npmrc ??= rc("npm", {registry: defaultRegistry}) as Npmrc;
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

function registryUrl(scope: string, npmrcConfig: Npmrc): string {
  const url: string = npmrcConfig[`${scope}:registry`] || npmrcConfig.registry;
  return url.endsWith("/") ? url : `${url}/`;
}

function getAuthAndRegistry(name: string, registry: string): AuthAndRegistry {
  if (!npmrc) npmrc = getNpmrc();

  const scope = name.startsWith("@") ? (/@[a-z0-9][\w.-]+/.exec(name) || [""])[0] : "";
  const cacheKey = `${scope}:${registry}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached;

  const fallback = (): AuthAndRegistry => ({auth: getRegistryAuthToken(registry, npmrc!), registry});
  let result: AuthAndRegistry;
  if (!name.startsWith("@")) {
    result = fallback();
  } else {
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = getRegistryAuthToken(url, npmrc);
        result = newAuth?.token ? {auth: newAuth, registry: url} : fallback();
      } catch {
        result = fallback();
      }
    } else {
      result = fallback();
    }
  }

  authCache.set(cacheKey, result);
  return result;
}

function resolveNpmRegistry(name: string, config: Config, args: Record<string, any>): AuthAndRegistry & {originalRegistry: string} {
  if (!npmrc) npmrc = getNpmrc();
  const originalRegistry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || npmrc.registry || defaultRegistry,
  );
  return {...getAuthAndRegistry(name, originalRegistry), originalRegistry};
}

function npmPackageUrl(registry: string, name: string, version?: string): string {
  const base = `${registry}/${name.replace(/\//g, "%2f")}`;
  return version ? `${base}/${version}` : base;
}

const npmDataCache = new Map<string, Promise<Record<string, any>>>();
const npmVersionInfoCache = new Map<string, Promise<NpmVersionInfo>>();
const npmFullDataCache = new Map<string, Promise<Record<string, any> | null>>();

export async function fetchNpmInfo(name: string, type: string, config: Config, args: Record<string, any>, ctx: ModeContext): Promise<PackageInfo> {
  const {auth, registry} = resolveNpmRegistry(name, config, args);
  const packageName = type === "resolutions" ? basename(name) : name;
  const url = npmPackageUrl(registry, packageName);

  let dataPromise = npmDataCache.get(url);
  if (!dataPromise) {
    const opts = getFetchOpts(auth?.type, auth?.token);
    const headers: Record<string, string> = {...opts.headers as Record<string, string>, "accept": "application/vnd.npm.install-v1+json"};
    opts.headers = headers;
    dataPromise = (async () => {
      const cached = ctx.noCache ? null : await getCache(url);
      if (cached) headers["if-none-match"] = cached.etag;
      const res = await ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.fetchTimeout), ...opts});
      if (res?.status === 304 && cached) return JSON.parse(cached.body);
      if (res?.ok) {
        const text = await res.text();
        const etag = res.headers.get("etag");
        if (etag && !ctx.noCache) await setCache(url, etag, text);
        return JSON.parse(text);
      }
      throwFetchError(res, url, name, registry);
    })().catch(err => { npmDataCache.delete(url); throw err; });
    npmDataCache.set(url, dataPromise);
  }
  return [await dataPromise, type, registry, name];
}

export type NpmVersionInfo = {repository?: PackageRepository, homepage?: string, date?: string};

export async function fetchNpmVersionInfo(name: string, version: string, config: Config, args: Record<string, any>, ctx: ModeContext): Promise<NpmVersionInfo> {
  const {auth, registry} = resolveNpmRegistry(name, config, args);
  const url = npmPackageUrl(registry, name, version);

  const cached = npmVersionInfoCache.get(url);
  if (cached) return cached;

  const promise = (async (): Promise<NpmVersionInfo> => {
    try {
      const fetchOpts = getFetchOpts(auth?.type, auth?.token);
      // Per-version npm metadata is immutable — cache forever.
      const result = await fetchImmutable(url, ctx, fetchOpts);
      if (!("body" in result)) return {};
      const data = JSON.parse(result.body);
      let date = "";
      const tmp: string | undefined = data?._npmOperationalInternal?.tmp;
      if (tmp) {
        const match = /(\d{13})/.exec(tmp);
        if (match) date = new Date(Number(match[1])).toISOString();
      }
      if (!date) {
        // _npmOperationalInternal is absent on some registries, fetch full metadata
        const fullUrl = npmPackageUrl(registry, name);
        let fullPromise = npmFullDataCache.get(fullUrl);
        if (!fullPromise) {
          fullPromise = ctx.doFetch(fullUrl, {...fetchOpts, signal: AbortSignal.timeout(ctx.fetchTimeout)}).then(res => {
            if (res?.ok) return res.json();
            return null;
          }).catch(() => { npmFullDataCache.delete(fullUrl); return null; });
          npmFullDataCache.set(fullUrl, fullPromise);
        }
        const fullData = await fullPromise;
        date = fullData?.time?.[version] || "";
      }
      return {repository: data.repository, homepage: data.homepage, date};
    } catch {
      return {};
    }
  })();
  npmVersionInfoCache.set(url, promise);
  return promise;
}

export function isJsr(value: string): boolean {
  return value.startsWith("npm:@jsr/") || value.startsWith("jsr:");
}

export function isLocalDep(value: string): boolean {
  return value.startsWith("link:") || value.startsWith("file:");
}

// - "npm:@jsr/std__semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:@std/semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:1.0.5" (when package name is known) -> { scope: null, name: null, version: "1.0.5" }
export function parseJsrDependency(value: string, packageName?: string): {scope: string | null, name: string | null, version: string} {
  if (value.startsWith("npm:@jsr/")) {
    // npm:@jsr/std__semver@1.0.5
    const match = /^npm:@jsr\/([^_]+)__([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:@")) {
    // jsr:@std/semver@1.0.5
    const match = /^jsr:@([^/]+)\/([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:")) {
    // jsr:1.0.5
    const version = value.substring(4);
    if (packageName?.startsWith("@")) {
      const match = /^@([^/]+)\/(.+)$/.exec(packageName);
      if (match) {
        return {scope: match[1], name: match[2], version};
      }
    }
  }
  return {scope: null, name: null, version: ""};
}

export async function fetchJsrInfo(packageName: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const match = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (!match) {
    throw new Error(`Invalid JSR package name: ${packageName}`);
  }
  const [, scope, name] = match;
  const url = `${ctx.jsrApiUrl}/@${scope}/${name}/meta.json`;

  const result = await fetchWithEtag(url, ctx, {
    headers: {"accept-encoding": "gzip, deflate, br"},
  });
  if ("body" in result) {
    const data = JSON.parse(result.body);
    // Transform JSR format to match npm-like format for compatibility
    const versions: Record<string, any> = {};
    const time: Record<string, string> = {};
    for (const [version, metadata] of Object.entries(data.versions as Record<string, any>)) {
      versions[version] = {
        version,
        time: metadata.createdAt,
      };
      time[version] = metadata.createdAt;
    }
    const transformedData = {
      name: packageName,
      "dist-tags": {
        latest: data.latest,
      },
      versions,
      time,
    };
    return [transformedData, type, ctx.jsrApiUrl, packageName];
  }
  throwFetchError(result.res, url, packageName, "JSR");
}

export function updatePackageJson(pkgStr: string, deps: Deps): string {
  const lookup = new Map<string, string>();
  for (const [key, {old, oldOrig, new: newVal}] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    if (depType === "packageManager") {
      lookup.set(`${depType}\0${name}@${oldValue}`, `"${depType}": "${name}@${newVal}"`);
    } else {
      lookup.set(`${name}\0${oldValue}`, `"${name}": "${newVal}"`);
    }
  }
  if (!lookup.size) return pkgStr;

  return pkgStr.replace(/"((?:[^"\\]|\\.)*)": *"((?:[^"\\]|\\.)*)"/g, (match, key, value) => {
    return lookup.get(`${key}\0${value}`) ?? match;
  });
}

export function updateVersionRange(oldRange: string, newVersion: string, oldOrig: string | undefined): string {
  let newRange = oldRange.replace(npmVersionRePre, newVersion);

  // if old version is a range like ^5 or ~5, retain number of version parts in new range
  if (oldOrig && oldOrig !== oldRange && /^[\^~]/.test(newRange)) {
    const oldParts = oldOrig.substring(1).split(".");
    const newParts = newRange.substring(1).split(".");
    if (oldParts.length !== newParts.length) {
      newRange = `${newRange[0]}${newParts.slice(0, oldParts.length).join(".")}`;
    }
  }

  // if old version is a range like >=5 or >= 5, retain number of version parts in new range
  if (oldOrig && oldOrig !== oldRange && newRange.startsWith(">=")) {
    const hasSpace = /^>=\s/.test(oldOrig);
    const prefix = hasSpace ? ">= " : ">=";
    const oldVersion = oldOrig.replace(/^>=\s*/, "");
    const newVersion = newRange.replace(/^>=\s*/, "");
    const oldParts = oldVersion.split(".");
    const newParts = newVersion.split(".");
    if (oldParts.length !== newParts.length) {
      newRange = `${prefix}${newParts.slice(0, oldParts.length).join(".")}`;
    }
  }

  return newRange;
}

export function normalizeRange(range: string): string {
  const versionMatches = range.match(npmVersionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(npmVersionRe, coerceToVersion(versionMatches[0]));
}

type CommitInfo = {
  hash: string,
  commit: Record<string, any>,
};

export async function getLatestCommit(user: string, repo: string, ctx: ModeContext): Promise<CommitInfo> {
  const url = `${ctx.forgeApiUrl}/repos/${user}/${repo}/commits`;
  try {
    const cached = ctx.noCache ? null : await getCache(url);
    const res = await fetchForge(url, ctx, cached ? {"if-none-match": cached.etag} : undefined);
    if (res?.status === 304 && cached) {
      const data = JSON.parse(cached.body);
      const {sha: hash, commit} = data[0];
      return {hash, commit};
    }
    if (!res?.ok) return {hash: "", commit: {}};
    const body = await res.text();
    const etag = res.headers.get("etag");
    if (etag && !ctx.noCache) await setCache(url, etag, body);
    const data = JSON.parse(body);
    const {sha: hash, commit} = data[0];
    return {hash, commit};
  } catch {
    return {hash: "", commit: {}};
  }
}

export async function getTags(user: string, repo: string, ctx: ModeContext): Promise<Array<string>> {
  const entries = await fetchActionTags(ctx.forgeApiUrl, user, repo, ctx);
  return entries.map(e => e.name);
}

export async function checkUrlDep(key: string, dep: Dep, useGreatest: boolean, ctx: ModeContext): Promise<CheckResult | null> {
  const stripped = dep.old.replace(stripRe, "");
  const [, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return null;

  if (hashRe.test(oldRef)) {
    const {hash, commit} = await getLatestCommit(user, repo, ctx);
    if (!hash) return null;

    const newDate = commit?.committer?.date ?? commit?.author?.date;
    const newRef = hash.substring(0, oldRef.length);
    if (oldRef !== newRef) {
      const newRange = dep.old.replace(oldRef, newRef);
      return {key, newRange, user, repo, oldRef, newRef, newDate};
    }
  } else {
    const tags = await getTags(user, repo, ctx);
    const newTag = selectTag(tags, oldRef, useGreatest);
    if (newTag) {
      return {key, newRange: newTag, user, repo, oldRef, newRef: newTag};
    }
  }

  return null;
}

