import {env} from "node:process";
import {parse, coerce, compareMain, diff, diffParsed, gt, lt, neq, satisfies, valid} from "../utils/semver.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
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

export type CooldownOpts = {
  cooldownDays?: number,
  now?: number,
  // Returns ISO date string for a given version, or undefined if unknown.
  // When undefined is returned, the version is treated as eligible (we cannot
  // prove it is too new) — callers must not pass this for ecosystems where
  // missing data should mean "skip".
  getVersionDate?: (version: string) => string | undefined,
};

export type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  pinnedRange?: string,
} & CooldownOpts;

export type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
  pinnedRange?: string,
} & CooldownOpts;

// Returns true if the given ISO date is at least cooldownDays old (inclusive)
// relative to `now`. Missing date or inactive cooldown returns true.
export function passesCooldown(date: string | undefined, cooldownDays: number | undefined, now: number | undefined): boolean {
  if (!cooldownDays || !now || !date) return true;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return true;
  return (now - ms) / (24 * 3600 * 1000) >= cooldownDays;
}

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

export const stripv = (str: string): string => str[0] === "v" ? str.substring(1) : str;
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

// Read a Response body as text, falling back to JSON re-stringification for
// lightweight mocks in tests.
async function readBody(res: Response): Promise<string> {
  if (typeof res.text === "function") return res.text();
  return JSON.stringify(await res.json());
}

// Fetch with ETag revalidation against the persistent disk cache. The fetch
// timeout signal is created inside, after the cache read, so slow disks do
// not eat the network budget. Returns {body} on success, or {res} on error.
export async function fetchWithEtag(
  url: string, ctx: ModeContext, opts: RequestInit = {},
): Promise<{body: string, res?: Response} | {res: Response | undefined}> {
  const cached = ctx.noCache ? null : await getCache(url);
  const baseHeaders = opts.headers as Record<string, string> | undefined;
  const headers = cached ? {...baseHeaders, "if-none-match": cached.etag} : baseHeaders;
  const res = await ctx.doFetch(url, {...opts, headers, signal: AbortSignal.timeout(ctx.fetchTimeout)});
  if (!res) return {res: undefined};
  if (res.status === 304 && cached) return {body: cached.body, res};
  if (!res.ok) return {res};
  const body = await readBody(res);
  const etag = res.headers?.get?.("etag");
  if (etag && !ctx.noCache) await setCache(url, etag, body);
  return {body, res};
}

// Persistent cache for immutable URLs (e.g. per-version metadata, commit
// dates). No revalidation — once cached, reused forever.
export async function fetchImmutable(
  url: string, ctx: ModeContext, opts: RequestInit = {},
): Promise<{body: string, res?: Response} | {res: Response | undefined}> {
  if (!ctx.noCache) {
    const cached = await getCache(url);
    if (cached) return {body: cached.body};
  }
  const res = await ctx.doFetch(url, {...opts, signal: AbortSignal.timeout(ctx.fetchTimeout)});
  if (!res) return {res: undefined};
  if (!res.ok) return {res};
  const body = await readBody(res);
  if (!ctx.noCache) await setCache(url, "immutable", body);
  return {body, res};
}

export function isVersionPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}

export function isRangePrerelease(range: string): boolean {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

// Build the prerelease-augmented copy of a semvers set without mutating the
// input — getVersionOpts() caches its sets per-package, so mutating in place
// silently leaks state across packages. Cached by input Set so repeated calls
// for the same package's semvers set don't re-allocate.
const prereleaseVariantsCache = new WeakMap<Set<string>, Set<string>>();
function withPrereleaseVariants(semvers: Set<string>): Set<string> {
  const cached = prereleaseVariantsCache.get(semvers);
  if (cached) return cached;
  const out = new Set(semvers);
  out.add("prerelease");
  if (semvers.has("patch")) out.add("prepatch");
  if (semvers.has("minor")) out.add("preminor");
  if (semvers.has("major")) out.add("premajor");
  prereleaseVariantsCache.set(semvers, out);
  return out;
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

export function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest, pinnedRange, cooldownDays, now, getVersionDate}: FindVersionOpts): string | null {
  const oldVersion = coerceToVersion(range);
  if (!oldVersion) return oldVersion;

  const effectiveUsePre = isRangePrerelease(range) || usePre;
  const effectiveSemvers = effectiveUsePre ? withPrereleaseVariants(semvers) : semvers;

  const time = data?.time;
  const hasTime = Boolean(time);
  const useGreatestPath = useGreatest || !hasTime;
  const cooldownActive = Boolean(cooldownDays && now);

  let greatestDate = 0;
  let newVersion = oldVersion;
  // coerceToVersion always returns a 3-part numeric string, so parse cannot fail.
  let newVersionParsed = parse(oldVersion)!;

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed?.version || parsed.prerelease.length && (!effectiveUsePre || useRel)) continue;
    const candidateVersion = parsed.version;

    if (pinnedRange && !satisfies(candidateVersion, pinnedRange)) continue;

    // Resolve date string at most once — reused below by greatestDate path.
    let dateStr: string | undefined;
    if (cooldownActive) {
      dateStr = getVersionDate ? getVersionDate(version) : (hasTime ? time[version] : undefined);
      if (!passesCooldown(dateStr, cooldownDays, now)) continue;
    }

    const d = diffParsed(newVersionParsed, parsed);
    if (!d || !effectiveSemvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatestPath) {
      if (compareMain(parsed, newVersionParsed) >= 0 ||
          (pinnedRange && !satisfies(newVersion, pinnedRange))) {
        newVersion = candidateVersion;
        newVersionParsed = parsed;
      }
    } else {
      const dateMs = Date.parse(dateStr ?? time[version]);
      if (dateMs >= 0 && dateMs > greatestDate) {
        newVersion = candidateVersion;
        newVersionParsed = parsed;
        greatestDate = dateMs;
      }
    }
  }

  return newVersion || null;
}

export function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers, pinnedRange, cooldownDays, now}: FindNewVersionOpts, {allowDowngrade, matchesAny, isGoPseudoVersion}: {allowDowngrade: Set<RegExp> | boolean, matchesAny: (str: string, set: Set<RegExp> | boolean) => boolean, isGoPseudoVersion: (version: string) => boolean}): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains
  if (/\d\s/.test(range)) return null; // ignore compound ranges (">=1 <2", "1 - 2")

  let versions: Array<string> = [];
  let getVersionDate: ((v: string) => string | undefined) | undefined;
  if (mode === "pypi") {
    const releases = data.releases;
    versions = [];
    for (const v of Object.keys(releases)) if (valid(v)) versions.push(v);
    getVersionDate = (v: string) => releases?.[v]?.[0]?.upload_time_iso_8601;
  } else if (mode === "npm" || mode === "cargo") {
    versions = [];
    for (const v of Object.keys(data.versions)) if (valid(v)) versions.push(v);
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
      if (d && semvers.has(d) && isAllowedVersionTransition(originalOldVersion, data.new, transitionOpts) &&
          passesCooldown(data.Time, cooldownDays, now) &&
          (!pinnedRange || satisfies(crossVersion, pinnedRange))) {
        return data.new;
      }
    }

    // Fall back to same-major upgrade
    const sameVersion = coerceToVersion(data.sameMajorNew);
    if (sameVersion && !isGoPseudoVersion(data.sameMajorNew) && !skipPrerelease(data.sameMajorNew)) {
      const d = diff(oldVersion, sameVersion);
      if (d && semvers.has(d) && isAllowedVersionTransition(originalOldVersion, data.sameMajorNew, transitionOpts) &&
          passesCooldown(data.sameMajorTime, cooldownDays, now) &&
          (!pinnedRange || satisfies(sameVersion, pinnedRange))) {
        data.Time = data.sameMajorTime;
        delete data.newPath;
        return data.sameMajorNew;
      }
    }

    // If cooldown gated the resolved versions, fall back to a proxy walk to
    // find an older eligible version. Otherwise no upgrade is available.
    if (cooldownDays && now && data.olderEligible && !skipPrerelease(data.olderEligible.version)) {
      const v = coerceToVersion(data.olderEligible.version);
      if (v) {
        const d = diff(oldVersion, v);
        if (d && semvers.has(d) && isAllowedVersionTransition(originalOldVersion, data.olderEligible.version, transitionOpts) &&
            (!pinnedRange || satisfies(v, pinnedRange))) {
          data.Time = data.olderEligible.time;
          delete data.newPath;
          return data.olderEligible.version;
        }
      }
    }

    return null;
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest, pinnedRange, cooldownDays, now, getVersionDate});
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

    // latestTag may be too new under cooldown — fall back to the
    // already-filtered `version` selected by findVersion.
    if (cooldownDays && now) {
      const latestDate = mode === "pypi" ?
        data.releases?.[originalLatestTag || latestTag]?.[0]?.upload_time_iso_8601 :
        data.time?.[latestTag];
      if (!passesCooldown(latestDate, cooldownDays, now)) {
        return version;
      }
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
let githubTokensPromise: Promise<string[]> | undefined;
export function getGithubTokens(): Promise<string[]> {
  if (envGithubTokens.length) return Promise.resolve(envGithubTokens);
  return githubTokensPromise ??= (async () => {
    try {
      const [{execFile: execFileCb}, {promisify}] = await Promise.all([
        import("node:child_process"),
        import("node:util"),
      ]);
      const {stdout} = await promisify(execFileCb)("gh", ["auth", "token"], {encoding: "utf8", timeout: 5000});
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

export async function fetchForge(url: string, ctx: ModeContext, extraHeaders?: Record<string, string>): Promise<Response> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { hostname = ""; }

  // Resolve tokens before starting the AbortSignal timer so the lazy
  // `gh auth token` probe does not consume the fetch's timeout budget.
  const tokens = await (hostname ? getForgeTokens(url) : getGithubTokens());

  const signal = AbortSignal.timeout(ctx.fetchTimeout);
  const optsFor = (token?: string): RequestInit => {
    const opts = getFetchOpts("Bearer", token);
    if (extraHeaders) opts.headers = {...opts.headers as Record<string, string>, ...extraHeaders};
    opts.signal = signal;
    return opts;
  };

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

// Picks the highest valid semver tag. GitHub does not guarantee a particular
// ordering for the /tags endpoint, so relying on array position (`tags.at(-1)`)
// silently picks the wrong tag.
export function selectTag(tags: Array<string>, oldRef: string): string | null {
  const oldRefBare = stripv(oldRef);
  if (!valid(oldRefBare)) return null;

  let bestTag = "";
  let bestBare = oldRefBare;
  for (const tag of tags) {
    const tagBare = stripv(tag);
    if (!valid(tagBare)) continue;
    if (!bestTag || gt(tagBare, bestBare)) {
      bestTag = tag;
      bestBare = tagBare;
    }
  }
  if (bestTag && neq(oldRefBare, bestBare)) return bestTag;
  return null;
}

export function resolvePackageJsonUrl(url: string): string {
  const cleaned = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]+\/[a-z0-9-]+$/.test(cleaned)) { // foo:user/repo
    return cleaned.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  } else if (/^[a-z0-9-]+\/[a-z0-9-]+$/.test(cleaned)) { // user/repo
    return `https://github.com/${cleaned}`;
  } else {
    return cleaned;
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

// GitHub strips the Link header on 304 responses, so cache it alongside the body.
async function fetchTagsPage(url: string, ctx: ModeContext): Promise<{tags: Array<TagEntry>, link: string} | null> {
  const cached = ctx.noCache ? null : await getCache(url);
  const res = await fetchForge(url, ctx, cached ? {"if-none-match": cached.etag} : undefined);
  if (res?.status === 304 && cached) {
    try {
      const parsed = JSON.parse(cached.body);
      return {tags: parsed.tags || [], link: parsed.link || ""};
    } catch { return null; }
  }
  if (!res?.ok) return null;
  const tags = parseTags(await res.json());
  const link = res.headers.get("link") || "";
  const etag = res.headers.get("etag");
  if (etag && !ctx.noCache) await setCache(url, etag, JSON.stringify({link, tags}));
  return {tags, link};
}

// Cap pagination so a repo with hundreds of tag pages doesn't fan out
// hundreds of concurrent requests. Matches fetchDockerHubTags's cap.
const maxTagPages = 10;

export async function fetchActionTags(apiUrl: string, owner: string, repo: string, ctx: ModeContext): Promise<Array<TagEntry>> {
  const tagsUrl = (page: number) => `${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`;
  try {
    const page1 = await fetchTagsPage(tagsUrl(1), ctx);
    if (!page1) return [];
    const tags = page1.tags;
    const last = /<([^>]+)>;\s*rel="last"/.exec(page1.link);
    if (!last) return tags;
    const lastPage = Math.min(Number(new URL(last[1]).searchParams.get("page")), maxTagPages);
    if (lastPage < 2) return tags;
    const pages = await Promise.all(
      Array.from({length: lastPage - 1}, (_, idx) => fetchTagsPage(tagsUrl(idx + 2), ctx)),
    );
    for (const p of pages) if (p) tags.push(...p.tags);
    return tags;
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
      if (urls?.[key]) { repository = urls[key]; break; }
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

