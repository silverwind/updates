import {env} from "node:process";
import {parse, coerce, compareParsed, diff, diffParsed, gt, gte, lt, satisfies, valid} from "../utils/semver.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {matchesAny} from "../utils/utils.ts";
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

export type FindNewVersionOpts = FindVersionOpts & {
  mode: string,
  allowDowngrade: Set<RegExp> | boolean,
};

// Returns true if the given ISO date is at least cooldownDays old (inclusive)
// relative to `now`. Missing date or inactive cooldown returns true.
export function passesCooldown(date: string | undefined, cooldownDays: number | undefined, now: number | undefined): boolean {
  if (!cooldownDays || !now || !date) return true;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return true;
  return (now - ms) / (24 * 3600 * 1000) >= cooldownDays;
}

// [data, registry]; registry is null for modes that have no per-package registry.
export type PackageInfo = [Record<string, any>, string | null];

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
export const maxSockets = 25;
// Cap pagination so a repo with hundreds of tag pages doesn't fan out hundreds
// of concurrent requests. Shared by the forge tag and Docker Hub tag walks.
export const maxTagPages = 10;

// GitHub serves its API from a hostname of its own, unlike Gitea and Forgejo which serve
// /api/v1 from the forge host itself. Also the default forge, hence forgeapi below.
export const githubApiUrl = "https://api.github.com";

// Default endpoint per API override flag, no trailing slash. The single source for the URLs
// requests are built from and for the origins prewarming opens sockets to, so the two cannot
// name different hosts.
export const defaultApiUrls = {
  registry: "https://registry.npmjs.org",
  jsrapi: "https://jsr.io",
  forgeapi: githubApiUrl,
  pypiapi: "https://pypi.org",
  cargoapi: "https://crates.io",
  dockerapi: "https://hub.docker.com",
  goproxy: "https://proxy.golang.org",
} as const;
const fetchRetries = 2;

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

// Retryable failures; deterministic ones (bad URL, NXDOMAIN, TLS) are not.
const transientErrorCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

function isTransientFetchError(err: any): boolean {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  // fetch wraps socket/DNS errors as a TypeError with the real error in `cause`.
  const code = err?.code ?? err?.cause?.code;
  return typeof code === "string" && transientErrorCodes.has(code);
}

export async function doFetch(url: string, opts?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, opts);
  } catch (err: any) {
    const error: any = new Error(`Failed to fetch ${url}${err?.message ? `: ${err.message}` : ""}`, {cause: err});
    error.transient = isTransientFetchError(err);
    throw error;
  }
}

// Retry only transient failures; a fresh AbortSignal is made per attempt since
// an aborted one can't be reused. Non-ok responses resolve normally, not retried.
export async function fetchWithRetry(
  ctx: ModeContext, url: string, opts: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.doFetch(url, {...opts, signal: AbortSignal.timeout(ctx.fetchTimeout)});
    } catch (err: any) {
      if (attempt >= fetchRetries || !err?.transient) throw err;
    }
  }
}

// Read a Response body as text, falling back to JSON re-stringification for
// lightweight mocks in tests.
async function readBody(res: Response): Promise<string> {
  if (typeof res.text === "function") return res.text();
  return JSON.stringify(await res.json());
}

// Shrink a JSON body to the subset of fields a mode actually reads before it
// is cached or returned. Must keep the original document shape so legacy cache
// entries holding full bodies stay readable. Registry docs can be megabytes
// (npm/pypi list every version with dist/file metadata), the used subset is
// usually a few KB. Bodies below the threshold are kept as-is: reducing them
// costs more than the re-parse it saves.
export type BodyReducer = (data: any) => any;
const reduceThreshold = 16384;

function reduceBody(body: string, reduce: BodyReducer | undefined): string {
  if (!reduce || body.length < reduceThreshold) return body;
  try {
    return JSON.stringify(reduce(JSON.parse(body)));
  } catch {
    return body; // non-JSON or unexpected shape: cache as-is
  }
}

// Read and reduce a response body, persisting it under `cacheTag` when caching
// is on. Never-revalidated URLs pass the literal "immutable" tag.
async function readAndCache(
  url: string, res: Response, ctx: ModeContext, reduce: BodyReducer | undefined, cacheTag: string | null | undefined,
): Promise<{body: string, res: Response}> {
  const body = reduceBody(await readBody(res), reduce);
  if (cacheTag && !ctx.noCache) setCache(url, cacheTag, body);
  return {body, res};
}

// Fetch with ETag revalidation against the persistent disk cache. The timeout
// signal is created after the cache read, so slow disks do not eat the network
// budget. Returns {body} on success, or {res} on error.
export async function fetchWithEtag(
  url: string, ctx: ModeContext, opts: RequestInit = {}, reduce?: BodyReducer,
): Promise<{body: string, res?: Response} | {res: Response | undefined}> {
  const cached = ctx.noCache ? null : await getCache(url);
  const baseHeaders = opts.headers as Record<string, string> | undefined;
  const headers = cached ? {...baseHeaders, "if-none-match": cached.etag} : baseHeaders;
  const res = await fetchWithRetry(ctx, url, {...opts, headers});
  if (!res) return {res: undefined};
  if (res.status === 304 && cached) return {body: cached.body, res};
  if (!res.ok) return {res};
  return readAndCache(url, res, ctx, reduce, res.headers?.get?.("etag"));
}

// Persistent cache for immutable URLs (e.g. per-version metadata, commit
// dates). No revalidation — once cached, reused forever.
export async function fetchImmutable(
  url: string, ctx: ModeContext, opts: RequestInit = {}, reduce?: BodyReducer,
): Promise<{body: string, res?: Response} | {res: Response | undefined}> {
  if (!ctx.noCache) {
    const cached = await getCache(url);
    if (cached) return {body: cached.body};
  }
  const res = await fetchWithRetry(ctx, url, opts);
  if (!res) return {res: undefined};
  if (!res.ok) return {res};
  return readAndCache(url, res, ctx, reduce, "immutable");
}

// Share one in-flight/completed promise per key so concurrent lookups for the
// same resource issue a single request. A rejected promise is evicted so the
// next caller retries rather than inheriting the failure forever.
export function dedupe<T>(cache: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  let promise = cache.get(key);
  if (!promise) {
    cache.set(key, promise = (async () => {
      try {
        return await fn();
      } catch (err) {
        cache.delete(key);
        throw err;
      }
    })());
  }
  return promise;
}

export function isVersionPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}

export function isRangePrerelease(range: string): boolean {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

// Pulls the authored version out of a range, prerelease included.
const rangeVersionRe = /\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?/;

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

// Prerelease candidates are in play when the authored version already is one or --pre is set,
// and classifying against an uncoerced prerelease yields `pre*` diffs the raw set lacks.
function prereleaseOpts(range: string, usePre: boolean, semvers: Set<string>): {effectiveUsePre: boolean, effectiveSemvers: Set<string>} {
  const effectiveUsePre = isRangePrerelease(range) || usePre;
  return {effectiveUsePre, effectiveSemvers: effectiveUsePre ? withPrereleaseVariants(semvers) : semvers};
}

type DowngradeOpts = {
  useRel: boolean,
  allowDowngrade: Set<RegExp> | boolean,
  name: string,
};

// Check if a version transition should be allowed. Prevents:
// - Pre-release to lower release (unless --release)
// - Release to lower release (unless --allow-downgrade)
export function isAllowedVersionTransition(oldVersion: string, newVersion: string, {useRel, allowDowngrade, name}: DowngradeOpts): boolean {
  const oldCoerced = coerceToVersion(oldVersion);
  const newCoerced = coerceToVersion(newVersion);
  if (!oldCoerced || !newCoerced) return true;

  const oldIsPre = isRangePrerelease(oldVersion) || isVersionPrerelease(oldVersion);
  const newIsPre = isVersionPrerelease(newVersion);

  // Pre-release to release: allow if upgrade, or with --release flag
  if (oldIsPre && !newIsPre) {
    return gte(newCoerced, oldCoerced) || useRel;
  }

  // General downgrade from release to lower release: only with --allow-downgrade
  if (!newIsPre && lt(newCoerced, oldCoerced)) {
    return matchesAny(name, allowDowngrade);
  }

  return true;
}

export function coerceToVersion(rangeOrVersion: string): string {
  return coerce(rangeOrVersion)?.version ?? "";
}

export function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest, pinnedRange, cooldownDays, now, getVersionDate}: FindVersionOpts): string | null {
  const oldVersion = coerceToVersion(range);
  if (!oldVersion) return null;

  // Rank and classify against the authored version with its prerelease intact.
  // coerceToVersion() drops it, which would sort a prerelease pin above its own
  // release and, when nothing is picked, report that unpublished release as the
  // update. coerceToVersion always yields a 3-part number, so the fallback parses.
  const oldParsed = parse(rangeVersionRe.exec(range)?.[0] ?? "") ?? parse(oldVersion)!;

  const {effectiveUsePre, effectiveSemvers} = prereleaseOpts(range, usePre, semvers);

  const time = data?.time;
  const hasTime = Boolean(time);
  const useGreatestPath = useGreatest || !hasTime;
  const cooldownActive = Boolean(cooldownDays && now);
  // Two cases deliberately move down: a pin the authored version already violates has to
  // be free to move down into it, and --release leaves a prerelease train for the newest
  // real release even when that is lower (isAllowedVersionTransition vets it afterwards).
  const allowsDowngrade = (Boolean(pinnedRange) && !satisfies(oldParsed.version, pinnedRange!)) ||
    (useRel && oldParsed.prerelease.length > 0);

  let greatestDate = 0;
  let picked = false;
  let newVersionParsed = oldParsed;

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed?.version || parsed.prerelease.length && (!effectiveUsePre || useRel)) continue;

    // Candidates only ever move forward, matching renovate's release filter. Cheaper than
    // the range check below, so it runs first and rejects most of them.
    if (!allowsDowngrade && compareParsed(parsed, oldParsed) <= 0) continue;

    if (pinnedRange && !satisfies(parsed.version, pinnedRange)) continue;

    // Resolve date string at most once — reused below by greatestDate path.
    let dateStr: string | undefined;
    if (cooldownActive) {
      dateStr = getVersionDate ? getVersionDate(version) : (hasTime ? time[version] : undefined);
      if (!passesCooldown(dateStr, cooldownDays, now)) continue;
    }

    // Always classified against the authored version, never against a candidate
    // picked earlier, so a chain of small steps cannot add up past the semvers gate.
    const d = diffParsed(oldParsed, parsed);
    if (!d || !effectiveSemvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatestPath) {
      if (picked && compareParsed(parsed, newVersionParsed) <= 0) continue;
    } else {
      const dateMs = Date.parse(dateStr ?? time[version]);
      if (!(dateMs >= 0 && dateMs > greatestDate)) continue;
      greatestDate = dateMs;
    }
    newVersionParsed = parsed;
    picked = true;
  }

  return newVersionParsed.version;
}

// TODO: maybe include pseudo-versions with --prerelease
export function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

export function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers, pinnedRange, cooldownDays, now, allowDowngrade}: FindNewVersionOpts): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains
  if (/\d\s/.test(range)) return null; // ignore compound ranges (">=1 <2", "1 - 2")

  let versions: Array<string> = [];
  let getVersionDate: ((v: string) => string | undefined) | undefined;
  if (mode === "pypi") {
    const releases = data.releases;
    versions = Object.keys(releases);
    getVersionDate = (v: string) => releases?.[v]?.[0]?.upload_time_iso_8601;
  } else if (mode === "npm" || mode === "cargo") {
    versions = Object.keys(data.versions);
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const {effectiveUsePre, effectiveSemvers} = prereleaseOpts(range, usePre, semvers);
    const skipPrerelease = (v: string) => isVersionPrerelease(v) && (!effectiveUsePre || useRel);
    const transitionOpts = {useRel, allowDowngrade, name: data.name};
    // Use full original version for prerelease detection (range is shortened for Go)
    const originalOldVersion = data.old || range;

    // A candidate is taken only if it is a real, allowed upgrade under the active
    // semver, transition, cooldown and pin constraints.
    const accepts = (candidate: string, time: string | undefined): boolean => {
      const coerced = coerceToVersion(candidate);
      if (!coerced || isGoPseudoVersion(candidate) || skipPrerelease(candidate)) return false;
      // Classify against the authored version first: coercing strips the prerelease, so
      // a `-rc.1` or pseudo-version pin would compare equal to its own release and stall.
      const d = diff(originalOldVersion, candidate) ?? diff(oldVersion, coerced);
      if (!d || !effectiveSemvers.has(d)) return false;
      if (!isAllowedVersionTransition(originalOldVersion, candidate, transitionOpts)) return false;
      if (!passesCooldown(time, cooldownDays, now)) return false;
      return !pinnedRange || satisfies(coerced, pinnedRange);
    };

    // Cross-major upgrade, else fall back to same-major.
    if (accepts(data.new, data.Time)) return data.new;
    if (accepts(data.sameMajorNew, data.sameMajorTime)) {
      data.Time = data.sameMajorTime;
      delete data.newPath;
      return data.sameMajorNew;
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
    let latestIsPre = false;
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = coerceToVersion(data.info.version); // add .0 to 6.0 so semver eats it
      latestIsPre = isVersionPrerelease(originalLatestTag); // coercion strips the prerelease tag, so detect on the raw value
    } else {
      latestTag = data["dist-tags"].latest;
      latestIsPre = isVersionPrerelease(latestTag);
    }

    const oldVersion = coerceToVersion(range);
    const oldIsPre = isRangePrerelease(range);
    const newIsPre = isVersionPrerelease(version);
    const transitionOpts = {useRel, allowDowngrade, name: data.name};

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
    if (useRel && latestIsPre) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (lt(latestTag, oldVersion) && !latestIsPre) {
      if (!isAllowedVersionTransition(range, latestTag, transitionOpts)) {
        // latest dist-tag is a disallowed downgrade — fall back to the in-range
        // `version` like the sibling branches, but only if it is a real upgrade.
        return gt(version, oldVersion) ? version : null;
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

let execFilePromise: ReturnType<typeof loadExecFile> | undefined;
async function loadExecFile() {
  const [{execFile}, {promisify}] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
  ]);
  return promisify(execFile);
}
export function getExecFile() {
  return execFilePromise ??= loadExecFile();
}

const githubTokenEnvNames = ["UPDATES_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];

function envGithubTokens(): string[] {
  return Array.from(new Set(
    githubTokenEnvNames.map(name => env[name]).filter((value): value is string => Boolean(value)),
  ));
}

// Env is read per call rather than snapshotted at import, so the token set at
// request time always wins. Only the `gh auth token` probe is memoized: a sync
// execFileSync in a concurrent `fetchForge` flow blocks the event loop long
// enough on Windows that parallel fetches can hit their AbortSignal timeout. It
// is skipped entirely when an env token is already set.
let githubTokensPromise: Promise<string[]> | undefined;
export function getGithubTokens(): Promise<string[]> {
  const tokens = envGithubTokens();
  if (tokens.length) return Promise.resolve(tokens);
  return githubTokensPromise ??= (async () => {
    try {
      const execFile = await getExecFile();
      const {stdout} = await execFile("gh", ["auth", "token"], {encoding: "utf8", timeout: 5000});
      const token = stdout.trim();
      return token ? [token] : [];
    } catch {
      return [];
    }
  })();
}

const workingTokenCache = new Map<string, string>();

// GitHub credentials (env tokens and `gh auth token`) are only ever sent to
// GitHub itself or to the configured default forge endpoint. A host taken from
// a workflow `uses:` ref must never receive them — it gets a token only when
// one is explicitly configured for it via UPDATES_FORGE_TOKENS.
export async function getForgeTokens(hostname: string, forgeApiUrl: string): Promise<string[]> {
  if (!hostname) return [];

  const hostToken = forgeTokensByHost.get(hostname);
  if (hostToken) return [hostToken];

  let forgeApiHost = "";
  try { forgeApiHost = new URL(forgeApiUrl).hostname; } catch {}
  const isGithubHost = hostname === "api.github.com" || hostname === "github.com" || hostname === forgeApiHost;
  return isGithubHost ? getGithubTokens() : [];
}

export async function fetchForge(url: string, ctx: ModeContext, extraHeaders?: Record<string, string>): Promise<Response> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { hostname = ""; }

  // Resolve tokens before starting the AbortSignal timer so the lazy
  // `gh auth token` probe does not consume the fetch's timeout budget.
  const tokens = await getForgeTokens(hostname, ctx.forgeApiUrl);

  const optsFor = (token?: string): RequestInit => {
    const opts = getFetchOpts("Bearer", token);
    if (extraHeaders) opts.headers = {...opts.headers as Record<string, string>, ...extraHeaders};
    return opts;
  };

  if (!tokens.length) return fetchWithRetry(ctx, url, optsFor());

  const cached = hostname ? workingTokenCache.get(hostname) : undefined;
  if (cached) return fetchWithRetry(ctx, url, optsFor(cached));

  for (const token of tokens) {
    const response = await fetchWithRetry(ctx, url, optsFor(token));
    if (response.status !== 401 && response.status !== 403) {
      if (hostname) workingTokenCache.set(hostname, token);
      return response;
    }
  }
  return fetchWithRetry(ctx, url, optsFor());
}

// Picks the highest valid semver tag. GitHub does not guarantee a particular
// ordering for the /tags endpoint, so relying on array position (`tags.at(-1)`)
// silently picks the wrong tag.
export function selectTag(tags: Array<string>, oldRef: string): string | null {
  const oldRefBare = stripv(oldRef);
  if (!valid(oldRefBare)) return null;

  let bestTag = "";
  let bestBare = "";
  for (const tag of tags) {
    const tagBare = stripv(tag);
    if (!valid(tagBare)) continue;
    if (!bestTag || gt(tagBare, bestBare)) {
      bestTag = tag;
      bestBare = tagBare;
    }
  }
  if (bestTag && gt(bestBare, oldRefBare)) return bestTag;
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

// Requires a hex letter so an all-numeric tag like `20240115` is read as a version rather
// than a commit, and accepts 6 characters, which git and renovate both treat as a short sha.
export const hashRe = /^(?=.*[a-f])[0-9a-f]{6,}$/i;

// A ref that names a version, as opposed to a branch (`release/v1`) or another tag scheme
// (`codeql-bundle-v2.20.3`). Those must keep their text, never be replaced by a version tag.
export function isVersionLikeRef(ref: string): boolean {
  return /^v?\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/.test(ref);
}

export type TagEntry = {
  name: string,
  commitSha: string,
};

// GitHub puts the dates at the top level of a commit, Gitea nests them under `commit`.
export function parseCommitDate(data: any): string {
  const commit = data?.commit ?? data;
  return commit?.committer?.date || commit?.author?.date || "";
}

export function parseTags(data: Array<any>): Array<TagEntry> {
  return data.map((tag: any) => ({name: tag.name, commitSha: tag.commit?.sha || ""}));
}

// Fetch a forge URL with ETag revalidation, returning the cached body verbatim on 304 and
// otherwise the string `reduce` distills the response into, which is what gets cached.
// `reduce` takes the Response so each caller picks its own read method.
export async function fetchForgeEtag(url: string, ctx: ModeContext, reduce: (res: Response) => Promise<string>): Promise<string | null> {
  const cached = ctx.noCache ? null : await getCache(url);
  const res = await fetchForge(url, ctx, cached ? {"if-none-match": cached.etag} : undefined);
  if (res?.status === 304 && cached) return cached.body;
  if (!res?.ok) return null;
  const body = await reduce(res);
  const etag = res.headers.get("etag");
  if (etag && !ctx.noCache) setCache(url, etag, body);
  return body;
}

// GitHub strips the Link header on 304 responses, so cache it alongside the body.
async function fetchTagsPage(url: string, ctx: ModeContext): Promise<{tags: Array<TagEntry>, link: string} | null> {
  const body = await fetchForgeEtag(url, ctx, async res => JSON.stringify({
    link: res.headers.get("link") || "", tags: parseTags(await res.json()),
  }));
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return {tags: parsed.tags || [], link: parsed.link || ""};
  } catch { return null; }
}

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
  if (res?.status && res.statusText) {
    throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
  }
  throw new Error(`Unable to fetch ${name} from ${source}`);
}

// Renovate caps date-like versions at this in its doNotUpgradeFromAlpineStableToEdge preset.
const dateVersionMin = 20000000;
const isDateVersion = (fields: Array<string>) => Number(fields[0]) >= dateVersionMin;

// Whether a candidate is versioned the same way as the authored version. Alpine publishes
// `20260127` snapshot tags next to its `3.24` releases, and those coerce so high they win
// every comparison, so both the field count and the magnitude have to line up.
export function isSameVersionScheme(candidate: string, oldVersion: string): boolean {
  const candidateFields = stripv(candidate).split(".");
  const oldFields = stripv(oldVersion).split(".");
  // More fields stay allowed so a short authored version can still upgrade off a registry
  // that only publishes full versions; fewer means another scheme.
  if (candidateFields.length < oldFields.length) return false;
  // A YYYYMMDD snapshot outranks every real release, so only ever reach one from another.
  return !isDateVersion(candidateFields) || isDateVersion(oldFields);
}

export function formatVersionPrecision(newVersion: string, oldVersion: string, suffix = ""): string {
  const bare = stripv(newVersion);
  const numParts = stripv(oldVersion).split(".").length;
  const newParts = bare.split(".");
  // A shorter authored version keeps its precision, padding missing fields with 0.
  const formatted = numParts >= 3 ? bare : Array.from({length: numParts}, (_, idx) => newParts[idx] || "0").join(".");
  return `${oldVersion.startsWith("v") ? "v" : ""}${formatted}${suffix}`;
}

export function getSubDir(url: string): string {
  if (url.startsWith("https://bitbucket.org")) {
    return "src/HEAD";
  } else {
    return "tree/HEAD";
  }
}

// pypi project_urls keys holding a repository link, in preference order
const pypiRepoKeys = ["repository", "Repository", "repo", "Repo", "source", "Source", "source code", "Source code", "Source Code", "homepage", "Homepage"];

export function getInfoUrl({repository, homepage, info}: {repository?: PackageRepository, homepage?: string, info?: Record<string, any>}, registry: string | null, name: string): string {
  if (info) { // pypi
    const urls = info.project_urls;
    for (const key of pypiRepoKeys) {
      if (!urls?.[key]) continue;
      repository = urls[key];
      break;
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
      infoUrl += `/${getSubDir(infoUrl)}/${repository.directory}`;
    }
  }

  return infoUrl || homepage || "";
}

