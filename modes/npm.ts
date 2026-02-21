import {env} from "node:process";
import {basename} from "node:path";
import rc from "../utils/rc.ts";
import {
  type Config, type Dep, type Deps, type ModeContext, type PackageInfo,
  esc, normalizeUrl, getFetchOpts, fieldSep, fetchForge, selectTag,
  coerceToVersion,
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
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
export const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const npmVersionRePre = /[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g;

const defaultRegistry = "https://registry.npmjs.org";
let npmrc: Npmrc | null = null;
const authCache = new Map<string, AuthAndRegistry>();

export function getNpmrc(): Npmrc {
  if (npmrc) return npmrc;
  return rc("npm", {registry: defaultRegistry}) as Npmrc;
}

function replaceEnvVar(token: string): string {
  return token.replace(/^\$\{?([^}]*)\}?$/, (_, envVar) => env[envVar] || "");
}

function getAuthInfoForUrl(regUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  // Bearer token
  const bearerToken = config[`${regUrl}:_authToken`] || config[`${regUrl}/:_authToken`];
  if (bearerToken) return {token: replaceEnvVar(bearerToken), type: "Bearer"};

  // Basic auth (username + password)
  const username = config[`${regUrl}:username`] || config[`${regUrl}/:username`];
  const password = config[`${regUrl}:_password`] || config[`${regUrl}/:_password`];
  if (username && password) {
    const pass = Buffer.from(replaceEnvVar(password), "base64").toString("utf8");
    return {token: Buffer.from(`${username}:${pass}`).toString("base64"), type: "Basic", username, password: pass};
  }

  // Legacy auth token
  const legacyToken = config[`${regUrl}:_auth`] || config[`${regUrl}/:_auth`];
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

  const scope = name.startsWith("@") ? (/@[a-z0-9][\w-.]+/.exec(name) || [""])[0] : "";
  const cacheKey = `${scope}:${registry}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached;

  let result: AuthAndRegistry;
  if (!name.startsWith("@")) {
    result = {auth: getRegistryAuthToken(registry, npmrc), registry};
  } else {
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = getRegistryAuthToken(url, npmrc);
        result = newAuth?.token ? {auth: newAuth, registry: url} : {auth: getRegistryAuthToken(registry, npmrc), registry};
      } catch {
        result = {auth: getRegistryAuthToken(registry, npmrc), registry};
      }
    } else {
      result = {auth: getRegistryAuthToken(registry, npmrc), registry};
    }
  }

  authCache.set(cacheKey, result);
  return result;
}

export async function fetchNpmInfo(name: string, type: string, config: Config, args: Record<string, any>, ctx: ModeContext): Promise<PackageInfo> {
  if (!npmrc) npmrc = getNpmrc();
  const originalRegistry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || npmrc.registry || defaultRegistry,
  );

  const {auth, registry} = getAuthAndRegistry(name, originalRegistry);
  const packageName = type === "resolutions" ? basename(name) : name;
  const url = `${registry}/${packageName.replace(/\//g, "%2f")}`;

  const res = await ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.fetchTimeout), ...getFetchOpts(auth?.type, auth?.token)});
  if (res?.ok) {
    return [await res.json(), type, registry, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${registry}`);
    }
  }
}

export function isJsr(value: string): boolean {
  return value.startsWith("npm:@jsr/") || value.startsWith("jsr:");
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

  const res = await ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}});
  if (res?.ok) {
    const data = await res.json();
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
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${packageName} from JSR`);
    }
  }
}

export function updatePackageJson(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    if (depType === "packageManager") {
      const re = new RegExp(`"${esc(depType)}": *"${name}@${esc(oldValue)}"`, "g");
      newPkgStr = newPkgStr.replace(re, `"${depType}": "${name}@${deps[key].new}"`);
    } else {
      const re = new RegExp(`"${esc(name)}": *"${esc(oldValue)}"`, "g");
      newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
    }
  }
  return newPkgStr;
}

export function updateNpmRange(oldRange: string, newVersion: string, oldOrig: string | undefined): string {
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

export async function getLastestCommit(user: string, repo: string, ctx: ModeContext): Promise<CommitInfo> {
  try {
    const res = await fetchForge(`${ctx.forgeApiUrl}/repos/${user}/${repo}/commits`, ctx);
    if (!res?.ok) return {hash: "", commit: {}};
    const data = await res.json();
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

type TagEntry = {
  name: string,
  commitSha: string,
};

function parseTags(data: Array<any>): Array<TagEntry> {
  return data.map((tag: any) => ({name: tag.name, commitSha: tag.commit?.sha || ""}));
}

async function fetchActionTags(apiUrl: string, owner: string, repo: string, ctx: ModeContext): Promise<Array<TagEntry>> {
  try {
    const res = await fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100`, ctx);
    if (!res?.ok) return [];
    const results = parseTags(await res.json());
    const link = res.headers.get("link") || "";
    const last = /<([^>]+)>;\s*rel="last"/.exec(link);
    if (last) {
      const lastPage = Number(new URL(last[1]).searchParams.get("page"));
      const pages = await Promise.all(
        Array.from({length: lastPage - 1}, (_, i) => fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${i + 2}`, ctx)),
      );
      for (const pageRes of pages) {
        if (pageRes?.ok) results.push(...parseTags(await pageRes.json()));
      }
    }
    return results;
  } catch {
    return [];
  }
}

export type CheckResult = {
  key: string,
  newRange: string,
  user: string,
  repo: string,
  oldRef: string,
  newRef: string,
  newDate?: string,
  newTag?: string,
};

export async function checkUrlDep(key: string, dep: Dep, useGreatest: boolean, ctx: ModeContext): Promise<CheckResult | null> {
  const stripped = dep.old.replace(stripRe, "");
  const [_, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return null;

  if (hashRe.test(oldRef)) {
    const {hash, commit} = await getLastestCommit(user, repo, ctx);
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

export {hashRe};
