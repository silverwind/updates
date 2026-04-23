import {env} from "node:process";
import {execFile as execFileCb} from "node:child_process";
import {promisify} from "node:util";
import {parse, coerce, diff, gt, gte, lt, neq, satisfies, valid} from "../utils/semver.ts";
import pkg from "../package.json" with {type: "json"};

export type {Config} from "../config.ts";

export type Dep = {
  old: string,
  new: string,
  oldPrint?: string,
  newPrint?: string,
  oldOrig?: string,
  info?: string,
  age?: string,
  date?: string,
};

export type Deps = {
  [name: string]: Dep,
};

export type DepsByMode = {
  [mode: string]: Deps,
};

export type Output = {
  results: {
    [mode: string]: {
      [type: string]: Deps,
    }
  },
  message?: string,
};

export type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  pinnedRange?: string,
};

export type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
  pinnedRange?: string,
};

export type PackageInfo = [Record<string, any>, string, string | null, string];

export type PackageRepository = string | {
  type: string,
  url: string,
  directory: string,
};

export type ModeContext = {
  fetchTimeout: number,
  goProbeTimeout: number,
  forgeApiUrl: string,
  pypiApiUrl: string,
  jsrApiUrl: string,
  goProxyUrl: string,
  cratesIoUrl: string,
  dockerApiUrl: string,
  doFetch: typeof doFetch,
  noCache: boolean,
};

export const packageVersion = pkg.version;
export const fieldSep = "\0";
export const fetchTimeout = 5000;
export const goProbeTimeout = 2500;

export const stripv = (str: string): string => str.replace(/^v/, "");
export const normalizeUrl = (url: string) => url.endsWith("/") ? url.slice(0, -1) : url;

export function getFetchOpts(authType?: string, authToken?: string): RequestInit {
  return {
    headers: {
      "user-agent": `updates/${packageVersion}`,
      "accept-encoding": "gzip, deflate, br",
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
}

export async function doFetch(url: string, opts?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, opts);
  } catch (err: any) {
    throw new Error(`Failed to fetch ${url}${err?.message ? `: ${err.message}` : ""}`);
  }
}

export function isVersionPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}

export function isRangePrerelease(range: string): boolean {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

type DowngradeOpts = {
  useRel: boolean,
  allowDowngrade: Set<RegExp> | boolean,
  name: string,
  matchesAny: (str: string, set: Set<RegExp> | boolean) => boolean,
};

// Check if a version transition should be allowed. Prevents:
// - Pre-release to lower release (unless --release)
// - Release to lower release (unless --allow-downgrade)
export function isAllowedVersionTransition(oldVersion: string, newVersion: string, {useRel, allowDowngrade, name, matchesAny}: DowngradeOpts): boolean {
  const oldCoerced = coerceToVersion(oldVersion);
  const newCoerced = coerceToVersion(newVersion);
  if (!oldCoerced || !newCoerced) return true;

  const oldIsPre = isRangePrerelease(oldVersion) || isVersionPrerelease(oldVersion);
  const newIsPre = isVersionPrerelease(newVersion);

  // Pre-release to release: allow if upgrade, or with --release flag
  if (oldIsPre && !newIsPre) {
    return gt(newCoerced, oldCoerced) || useRel;
  }

  // General downgrade from release to lower release: only with --allow-downgrade
  if (!newIsPre && lt(newCoerced, oldCoerced)) {
    return allowDowngrade === true || matchesAny(name, allowDowngrade);
  }

  return true;
}

export function coerceToVersion(rangeOrVersion: string): string {
  return coerce(rangeOrVersion)?.version ?? "";
}

export function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest, pinnedRange}: FindVersionOpts): string | null {
  const oldVersion = coerceToVersion(range);
  if (!oldVersion) return oldVersion;

  usePre = isRangePrerelease(range) || usePre;

  if (usePre) {
    semvers.add("prerelease");
    if (semvers.has("patch")) semvers.add("prepatch");
    if (semvers.has("minor")) semvers.add("preminor");
    if (semvers.has("major")) semvers.add("premajor");
  }

  let greatestDate = 0;
  let newVersion = oldVersion;

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed?.version || parsed.prerelease.length && (!usePre || useRel)) continue;
    const candidateVersion = parsed.version;

    // If a pinned range is specified, only consider versions that satisfy it
    if (pinnedRange && !satisfies(candidateVersion, pinnedRange)) continue;

    const d = diff(newVersion, candidateVersion);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(coerceToVersion(candidateVersion), newVersion) ||
          (pinnedRange && !satisfies(newVersion, pinnedRange))) {
        newVersion = candidateVersion;
      }
    } else {
      const date = Date.parse(data.time[version]);
      if (date >= 0 && date > greatestDate) {
        newVersion = candidateVersion;
        greatestDate = date;
      }
    }
  }

  return newVersion || null;
}

export function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers, pinnedRange}: FindNewVersionOpts, {allowDowngrade, matchesAny, isGoPseudoVersion}: {allowDowngrade: Set<RegExp> | boolean, matchesAny: (str: string, set: Set<RegExp> | boolean) => boolean, isGoPseudoVersion: (version: string) => boolean}): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains

  let versions: Array<string> = [];
  if (mode === "pypi") {
    versions = Object.keys(data.releases).filter(v => valid(v));
  } else if (mode === "npm" || mode === "cargo") {
    versions = Object.keys(data.versions).filter(v => valid(v));
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const effectiveUsePre = usePre || isRangePrerelease(range);
    const skipPrerelease = (v: string) => isVersionPrerelease(v) && (!effectiveUsePre || useRel);
    const transitionOpts = {useRel, allowDowngrade, name: data.name, matchesAny};
    // Use full original version for prerelease detection (range is shortened for Go)
    const originalOldVersion = data.old || range;

    // Check cross-major upgrade
    const crossVersion = coerceToVersion(data.new);
    if (crossVersion && !isGoPseudoVersion(data.new) && !skipPrerelease(data.new)) {
      const d = diff(oldVersion, crossVersion);
      if (d && semvers.has(d) && isAllowedVersionTransition(originalOldVersion, data.new, transitionOpts)) {
        return data.new;
      }
    }

    // Fall back to same-major upgrade
    const sameVersion = coerceToVersion(data.sameMajorNew);
    if (sameVersion && !isGoPseudoVersion(data.sameMajorNew) && !skipPrerelease(data.sameMajorNew)) {
      const d = diff(oldVersion, sameVersion);
      if (d && semvers.has(d) && isAllowedVersionTransition(originalOldVersion, data.sameMajorNew, transitionOpts)) {
        data.Time = data.sameMajorTime;
        delete data.newPath;
        return data.sameMajorNew;
      }
    }

    return null;
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest, pinnedRange});
  if (!version) return null;

  if (useGreatest) {
    return version;
  } else {
    let latestTag = "";
    let originalLatestTag = "";
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = coerceToVersion(data.info.version); // add .0 to 6.0 so semver eats it
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = coerceToVersion(range);
    const oldIsPre = isRangePrerelease(range);
    const newIsPre = isVersionPrerelease(version);
    const latestIsPre = isVersionPrerelease(latestTag);
    const transitionOpts = {useRel, allowDowngrade, name: data.name, matchesAny};

    // update to new prerelease
    if (!useRel && usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // pre-release to release transition
    if (oldIsPre && !newIsPre) {
      return isAllowedVersionTransition(range, version, transitionOpts) ? version : null;
    }

    // check if latestTag is allowed by semvers
    const d = diff(oldVersion, latestTag);
    if (d && d !== "prerelease" && !semvers.has(d.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (lt(latestTag, oldVersion) && !latestIsPre) {
      if (!isAllowedVersionTransition(range, latestTag, transitionOpts)) {
        return null;
      }
      return latestTag;
    }

    // prevent upgrading from non-prerelease to prerelease from latest dist-tag by default
    if (!oldIsPre && latestIsPre && !usePre) {
      return version;
    }

    // If a pinned range is specified and latestTag doesn't satisfy it, return version
    if (pinnedRange && !satisfies(latestTag, pinnedRange)) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return originalLatestTag || latestTag;
  }
}

const forgeTokensByHost = new Map<string, string>();
if (env.UPDATES_FORGE_TOKENS) {
  for (const entry of env.UPDATES_FORGE_TOKENS.split(",")) {
    const sep = entry.indexOf(":");
    if (sep > 0) {
      forgeTokensByHost.set(entry.substring(0, sep), entry.substring(sep + 1));
    }
  }
}

const envGithubTokens: string[] = Array.from(new Set(
  ["UPDATES_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"]
    .map(name => env[name]).filter(Boolean as unknown as (v: string | undefined) => v is string),
));

// Resolve lazily, async, and memoized: a sync execFileSync in a concurrent
// `fetchForge` flow blocks the event loop long enough on Windows that parallel
// fetches can hit their AbortSignal timeout. Skip entirely if an env token is
// already set.
const execFile = promisify(execFileCb);
let githubTokensPromise: Promise<string[]> | undefined;
function getGithubTokens(): Promise<string[]> {
  if (envGithubTokens.length) return Promise.resolve(envGithubTokens);
  return githubTokensPromise ??= (async () => {
    try {
      const {stdout} = await execFile("gh", ["auth", "token"], {encoding: "utf8", timeout: 5000});
      const token = stdout.trim();
      return token ? [token] : envGithubTokens;
    } catch {
      return envGithubTokens;
    }
  })();
}

const workingTokenCache = new Map<string, string>();

export async function getForgeTokens(url: string): Promise<string[]> {
  try {
    const hostToken = forgeTokensByHost.get(new URL(url).hostname);
    if (hostToken) return [hostToken];
  } catch {}
  return getGithubTokens();
}

export async function fetchForge(url: string, ctx: ModeContext): Promise<Response> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { hostname = ""; }

  // Resolve tokens before starting the AbortSignal timer so the lazy
  // `gh auth token` probe does not consume the fetch's timeout budget.
  const tokens = await (hostname ? getForgeTokens(url) : getGithubTokens());

  const signal = AbortSignal.timeout(ctx.fetchTimeout);
  const optsFor = (token?: string): RequestInit => ({...getFetchOpts("Bearer", token), signal});

  if (!tokens.length) return ctx.doFetch(url, optsFor());

  const cached = hostname ? workingTokenCache.get(hostname) : undefined;
  if (cached) return ctx.doFetch(url, optsFor(cached));

  for (const token of tokens) {
    const response = await ctx.doFetch(url, optsFor(token));
    if (response.status !== 401 && response.status !== 403) {
      if (hostname) workingTokenCache.set(hostname, token);
      return response;
    }
  }
  return ctx.doFetch(url, optsFor());
}

export function selectTag(tags: Array<string>, oldRef: string, useGreatest: boolean): string | null {
  const oldRefBare = stripv(oldRef);
  if (!valid(oldRefBare)) return null;

  if (!useGreatest) {
    const lastTag = tags.at(-1);
    if (!lastTag) return null;
    const lastTagBare = stripv(lastTag);
    if (!valid(lastTagBare)) return null;

    if (neq(oldRefBare, lastTagBare)) {
      return lastTag;
    }
  } else {
    let greatestTag = oldRef;
    let greatestTagBare = stripv(oldRef);

    for (const tag of tags) {
      const tagBare = stripv(tag);
      if (!valid(tagBare)) continue;
      if (!greatestTag || gt(tagBare, greatestTagBare)) {
        greatestTag = tag;
        greatestTagBare = tagBare;
      }
    }
    if (neq(oldRefBare, greatestTagBare)) {
      return greatestTag;
    }
  }

  return null;
}

export function resolvePackageJsonUrl(url: string): string {
  url = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // foo:user/repo
    return url.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  } else if (/^[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // user/repo
    return `https://github.com/${url}`;
  } else {
    return url;
  }
}

export const hashRe = /^[0-9a-f]{7,}$/i;

export type TagEntry = {
  name: string,
  commitSha: string,
};

export function parseTags(data: Array<any>): Array<TagEntry> {
  return data.map((tag: any) => ({name: tag.name, commitSha: tag.commit?.sha || ""}));
}

export async function fetchActionTags(apiUrl: string, owner: string, repo: string, ctx: ModeContext): Promise<Array<TagEntry>> {
  const tagsUrl = (page: number) => `${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`;
  try {
    // Speculate page 2 in parallel — saves a round-trip when there are 2+ pages.
    const [res, page2Res] = await Promise.all([
      fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100`, ctx),
      fetchForge(tagsUrl(2), ctx).catch(() => null),
    ]);
    if (!res?.ok) return [];
    const results = parseTags(await res.json());
    const link = res.headers.get("link") || "";
    const last = /<([^>]+)>;\s*rel="last"/.exec(link);
    if (!last) return results;

    const lastPage = Number(new URL(last[1]).searchParams.get("page"));
    if (lastPage >= 2 && page2Res?.ok) results.push(...parseTags(await page2Res.json()));
    if (lastPage > 2) {
      const pages = await Promise.all(
        Array.from({length: lastPage - 2}, (_, idx) => fetchForge(tagsUrl(idx + 3), ctx)),
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

export function throwFetchError(res: Response | undefined, url: string, name: string, source: string): never {
  if (res?.status && res?.statusText) {
    throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
  }
  throw new Error(`Unable to fetch ${name} from ${source}`);
}

export function formatVersionPrecision(newVersion: string, oldVersion: string, suffix = ""): string {
  const hadV = oldVersion.startsWith("v");
  const bare = stripv(newVersion);
  const numParts = stripv(oldVersion).split(".").length;
  const newParts = bare.split(".");
  let formatted: string;
  if (numParts === 1) formatted = newParts[0];
  else if (numParts === 2) formatted = `${newParts[0]}.${newParts[1] || "0"}`;
  else formatted = bare;
  return `${hadV ? "v" : ""}${formatted}${suffix}`;
}

export function getSubDir(url: string): string {
  if (url.startsWith("https://bitbucket.org")) {
    return "src/HEAD";
  } else {
    return "tree/HEAD";
  }
}

export function getInfoUrl({repository, homepage, info}: {repository?: PackageRepository, homepage?: string, info?: Record<string, any>}, registry: string | null, name: string): string {
  if (info) { // pypi
    const urls = info.project_urls;
    for (const key of ["repository", "Repository", "repo", "Repo", "source", "Source", "source code", "Source code", "Source Code", "homepage", "Homepage"]) {
      if (urls[key]) { repository = urls[key]; break; }
    }
    repository ??= `https://pypi.org/project/${name}/`;
  }

  let infoUrl = "";
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    infoUrl = resolvePackageJsonUrl(url);
    if (infoUrl && typeof repository !== "string" && repository.directory) {
      infoUrl = `${infoUrl}/${getSubDir(infoUrl)}/${repository.directory}`;
    }
  }

  return infoUrl || homepage || "";
}

