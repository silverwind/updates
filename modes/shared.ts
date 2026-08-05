import {AsyncLocalStorage} from "node:async_hooks";
import {Buffer} from "node:buffer";
import {env} from "node:process";
import {type Versioning, coerce, diff, gt, satisfies, semverVersioning, pep440Versioning, valid} from "../utils/semver.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {commaSeparatedToArray, matchesAny} from "../utils/utils.ts";
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
  // A version whose date is unknown never passes an active cooldown, so only return published dates.
  getVersionDate?: (version: string) => string | undefined,
};

export type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  pinnedRange?: string,
  pinNoDowngrade?: boolean,
  versioning?: Versioning,
} & CooldownOpts;

export type FindNewVersionOpts = FindVersionOpts & {
  mode: string,
  useGreatest: boolean,
  allowDowngrade: Set<RegExp> | boolean,
};

// An active cooldown requires a timestamp, as renovate's minimumReleaseAgeBehaviour default does:
// a mirror omitting the newest release's date would let through the release it exists to hold back.
export function passesCooldown(date: string | undefined, cooldownDays: number | undefined, now: number | undefined): boolean {
  if (!cooldownDays || !now) return true;
  const ms = date ? Date.parse(date) : NaN;
  if (Number.isNaN(ms)) return false;
  return (now - ms) / (24 * 3600 * 1000) >= cooldownDays;
}

// [data, registry]; registry is null for modes that have no per-package registry.
export type PackageInfo = [Record<string, any>, string | null];

export type PackageRepository = string | {
  type: string,
  url: string,
  directory: string,
};

// Lives here rather than in the go mode so ModeContext can name it without a cycle.
export type GoProxyEntry = {url: string, fallback: "," | "|"};

export type ModeContext = {
  fetchTimeout: number,
  goProbeTimeout: number,
  /** The run's socket budget, `--sockets` or `maxSockets` */
  concurrency: number,
  forgeApiUrl: string,
  pypiApiUrl: string,
  jsrApiUrl: string,
  /** The single endpoint a caller that can only address one uses, `goProxyChain`'s first entry */
  goProxyUrl: string,
  goProxyChain: Array<GoProxyEntry>,
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
// Tag lists are walked to the end: a truncated walk loses the tag a pinned sha resolves to, and on
// Docker Hub hides a same-precision tag past the window. Renovate likewise stops only at this cap.
export const maxTagPages = 100;

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
export const fetchRetries = 2;

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

export function isTransientFetchError(err: any): boolean {
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
// The slot is taken around the signal so queueing behind the budget is not charged to the timeout,
// and per attempt so acquisitions stay sequential and cannot self-deadlock.
export async function fetchWithRetry(
  ctx: ModeContext, url: string, opts: RequestInit = {},
): Promise<Response> {
  const limit = getLimiter(ctx);
  for (let attempt = 0; ; attempt++) {
    try {
      return await limit(() => ctx.doFetch(url, {...opts, signal: AbortSignal.timeout(ctx.fetchTimeout)}));
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

// Shrink a body to the subset of fields a mode actually reads before it is
// cached or returned. Must keep the original document shape so legacy cache
// entries holding full bodies stay readable. Bodies below the threshold are
// kept as-is: reducing them costs more than the re-parse it saves.
export type BodyReducer = (body: string) => string;
const reduceThreshold = 16384;

export const reduceJson = (reduce: (data: any) => any): BodyReducer =>
  body => JSON.stringify(reduce(JSON.parse(body)));

function reduceBody(body: string, reduce: BodyReducer | undefined): string {
  if (!reduce || body.length < reduceThreshold) return body;
  try {
    return reduce(body);
  } catch {
    return body; // non-JSON or unexpected shape: cache as-is
  }
}

// Read and reduce a response body, persisting it under `cacheTag` when caching
// is on. Never-revalidated URLs pass the literal "immutable" tag.
async function readAndCache(
  cacheKey: string, res: Response, ctx: ModeContext, reduce: BodyReducer | undefined, cacheTag: string | null | undefined,
): Promise<{body: string, res: Response}> {
  const body = reduceBody(await readBody(res), reduce);
  if (cacheTag && !ctx.noCache) setCache(cacheKey, cacheTag, body);
  return {body, res};
}

// Fetch with ETag revalidation against the persistent disk cache. The timeout
// signal is created after the cache read, so slow disks do not eat the network
// budget. Returns {body} on success, or {res} on error.
// `cacheKey` separates responses that share a url but vary by request header, which a registry
// that etags per url alone would revalidate into one another.
export async function fetchWithEtag(
  url: string, ctx: ModeContext, opts: RequestInit = {}, reduce?: BodyReducer, cacheKey: string = url,
): Promise<{body: string, res?: Response} | {res: Response | undefined}> {
  const cached = ctx.noCache ? null : await getCache(cacheKey);
  const baseHeaders = opts.headers as Record<string, string> | undefined;
  const headers = cached ? {...baseHeaders, "if-none-match": cached.etag} : baseHeaders;
  const res = await fetchWithRetry(ctx, url, {...opts, headers});
  if (!res) return {res: undefined};
  if (res.status === 304 && cached) return {body: cached.body, res};
  if (!res.ok) return {res};
  return readAndCache(cacheKey, res, ctx, reduce, res.headers?.get?.("etag"));
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

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

// Set for the duration of a slot. Acquiring the same budget twice for one request deadlocks at
// saturation, so a limiter reached from inside a slot passes straight through.
const inSlot = new AsyncLocalStorage<boolean>();

function createLimiter(concurrency: number): Limiter {
  let active = 0;
  let head = 0;
  let waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (inSlot.getStore()) return fn();
    if (active < concurrency) active++;
    else await new Promise<void>(resolve => { waiting.push(resolve); });
    try {
      return await inSlot.run(true, fn);
    } finally {
      // A cursor, not `shift`, so releasing a slot is O(1) with a large `--sockets` queue.
      if (head < waiting.length) {
        waiting[head++]();
        if (head === waiting.length) {
          waiting = [];
          head = 0;
        }
      } else {
        active--;
      }
    }
  };
}

export const effectiveConcurrency = (ctx: ModeContext): number => Math.max(ctx.concurrency || maxSockets, 1);

const limiterByCtx = new WeakMap<ModeContext, Limiter>();

export function getLimiter(ctx: ModeContext): Limiter {
  let limiter = limiterByCtx.get(ctx);
  if (!limiter) limiterByCtx.set(ctx, limiter = createLimiter(effectiveConcurrency(ctx)));
  return limiter;
}

export function isVersionPrerelease(version: string, versioning: Versioning = semverVersioning): boolean {
  const parsed = versioning.parse(version);
  return Boolean(parsed && versioning.isPrerelease(parsed));
}

// Build a prerelease-augmented copy of a semvers set without mutating the
// input — getVersionOpts() caches its sets per-package, so mutating in place
// silently leaks state across packages.
function cachedVariants(cache: WeakMap<Set<string>, Set<string>>, semvers: Set<string>, add: (out: Set<string>) => void): Set<string> {
  const cached = cache.get(semvers);
  if (cached) return cached;
  const out = new Set(semvers);
  add(out);
  cache.set(semvers, out);
  return out;
}

const allPrereleaseCache = new WeakMap<Set<string>, Set<string>>();
const sameReleasePrereleaseCache = new WeakMap<Set<string>, Set<string>>();

// Prerelease candidates are in play when --pre is set or the authored version already is one,
// and classifying against an uncoerced prerelease yields `pre*` diffs the raw set lacks.
// An authored prerelease alone only reaches prereleases of its own release, as renovate keeps an
// unstable candidate only when major, minor and patch match, so a `17.0.0-rc.0` pin must not
// follow an unreleased 18.x canary train. --pre opts into every one, as ignoreUnstable=false does.
function prereleaseOpts(range: string, usePre: boolean, semvers: Set<string>, versioning: Versioning): {effectiveUsePre: boolean, effectiveSemvers: Set<string>} {
  if (usePre) {
    return {effectiveUsePre: true, effectiveSemvers: cachedVariants(allPrereleaseCache, semvers, out => {
      out.add("prerelease");
      if (semvers.has("patch")) out.add("prepatch");
      if (semvers.has("minor")) out.add("preminor");
      if (semvers.has("major")) out.add("premajor");
    })};
  }
  if (versioning.isRangePrerelease(range)) {
    return {effectiveUsePre: true, effectiveSemvers: cachedVariants(sameReleasePrereleaseCache, semvers, out => out.add("prerelease"))};
  }
  return {effectiveUsePre: false, effectiveSemvers: semvers};
}

type DowngradeOpts = {
  useRel: boolean,
  allowDowngrade: Set<RegExp> | boolean,
  name: string,
};

// Check if a version transition should be allowed. Prevents:
// - Pre-release to lower release (unless --release)
// - Release to lower release (unless --allow-downgrade)
export function isAllowedVersionTransition(oldVersion: string, newVersion: string, {useRel, allowDowngrade, name}: DowngradeOpts, versioning: Versioning = semverVersioning): boolean {
  const oldParsed = versioning.parseRange(oldVersion);
  const newParsed = versioning.parse(newVersion);
  if (!oldParsed || !newParsed) return true;

  const oldIsPre = versioning.isRangePrerelease(oldVersion) || versioning.isPrerelease(oldParsed);
  const newIsPre = versioning.isPrerelease(newParsed);

  // Pre-release to release: allow if upgrade, or with --release flag
  if (oldIsPre && !newIsPre) {
    return versioning.compare(newParsed, oldParsed) >= 0 || useRel;
  }

  // General downgrade from release to lower release: only with --allow-downgrade
  if (!newIsPre && versioning.compare(newParsed, oldParsed) < 0) {
    return matchesAny(name, allowDowngrade);
  }

  return true;
}

export function coerceToVersion(rangeOrVersion: string): string {
  return coerce(rangeOrVersion)?.version ?? "";
}

export function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, pinnedRange, pinNoDowngrade, cooldownDays, now, getVersionDate, versioning = semverVersioning}: FindVersionOpts): string | null {
  // Rank and classify against the authored version with its prerelease intact. Coercing
  // drops it, which would sort a prerelease pin above its own release.
  const oldParsed = versioning.parseRange(range);
  if (!oldParsed) return null;

  const {effectiveUsePre, effectiveSemvers} = prereleaseOpts(range, usePre, semvers, versioning);

  const time = data?.time;
  const cooldownActive = Boolean(cooldownDays && now);
  // Two cases deliberately move down: a pin the authored version already violates has to
  // be free to move down into it, and --release leaves a prerelease train for the newest
  // real release even when that is lower (isAllowedVersionTransition vets it afterwards).
  // A renovate-derived pin is exempt from the first: it is a ceiling, not a target.
  const allowsDowngrade = (Boolean(pinnedRange) && !pinNoDowngrade && !versioning.satisfiesRange(oldParsed, pinnedRange!)) ||
    (useRel && versioning.isPrerelease(oldParsed));

  // Highest candidate that passes every check, as renovate takes the first walking high to low.
  // A publish date never outranks a version, so a backport released later cannot win.
  let newVersionParsed: {version: string} | null = null;

  for (const version of versions) {
    const parsed = versioning.parse(version);
    if (!parsed || versioning.isPrerelease(parsed) && (!effectiveUsePre || useRel)) continue;

    // Candidates only ever move forward, matching renovate's release filter. Cheaper than
    // the range check below, so it runs first and rejects most of them.
    if (!allowsDowngrade && versioning.compare(parsed, oldParsed) <= 0) continue;
    if (newVersionParsed && versioning.compare(parsed, newVersionParsed) <= 0) continue;

    if (pinnedRange && !versioning.satisfiesRange(parsed, pinnedRange)) continue;
    if (cooldownActive && !passesCooldown(getVersionDate ? getVersionDate(version) : time?.[version], cooldownDays, now)) continue;

    // Always classified against the authored version, never against a candidate
    // picked earlier, so a chain of small steps cannot add up past the semvers gate.
    // A stable candidate is classified by its own level, as the `pre` prefix a diff carries when
    // the authored prerelease is the higher of the pair says nothing about it.
    const d = versioning.diff(oldParsed, parsed);
    const level = d && !versioning.isPrerelease(parsed) ? d.replace(/^pre/, "") : d;
    if (!level || !effectiveSemvers.has(level)) continue;

    newVersionParsed = parsed;
  }

  return newVersionParsed?.version ?? null;
}

// TODO: maybe include pseudo-versions with --prerelease
export function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

export function findNewVersion(data: any, {mode, range: authoredRange, useGreatest, useRel, usePre, semvers, pinnedRange, pinNoDowngrade, cooldownDays, now, allowDowngrade}: FindNewVersionOpts): string | null {
  if (authoredRange === "*") return null; // ignore wildcard

  const versioning: Versioning = mode === "pypi" ? pep440Versioning : semverVersioning;
  // Selection runs against an or-chain's last branch, as renovate reads a range's last comparator:
  // `^17.0.0 || ^18.0.0` is an 18. The full range still decides how the update is written back.
  const range = authoredRange.includes("||") ? authoredRange.split("||").pop()!.trim() : authoredRange;
  let versions: Array<string> = [];
  let latestTag = "";
  let getVersionDate: ((v: string) => string | undefined) | undefined;
  if (mode === "pypi") {
    const releases = data?.releases;
    if (!releases) return null;
    versions = Object.keys(releases).filter(version => !releases[version]?.some((file: any) => file?.yanked));
    getVersionDate = (version: string) => releases[version]?.[0]?.upload_time_iso_8601;
    latestTag = data.info?.version ?? "";
  } else if (mode === "npm" || mode === "cargo") {
    if (!data?.versions) return null;
    versions = Object.keys(data.versions);
    latestTag = data["dist-tags"]?.latest ?? "";
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const {effectiveUsePre, effectiveSemvers} = prereleaseOpts(range, usePre, semvers, versioning);
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
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, pinnedRange, pinNoDowngrade, cooldownDays, now, getVersionDate, versioning});

  if (useGreatest) {
    return version;
  } else {
    const latestParsed = versions.includes(latestTag) ? versioning.parse(latestTag) : null;
    const oldParsed = versioning.parseRange(range);
    if (!latestParsed || !oldParsed) return version;

    const newParsed = version ? versioning.parse(version) : null;
    const latestIsPre = versioning.isPrerelease(latestParsed);
    const oldIsPre = versioning.isRangePrerelease(range);
    const newIsPre = Boolean(newParsed && versioning.isPrerelease(newParsed));
    const transitionOpts = {useRel, allowDowngrade, name: data.name};

    // update to new prerelease
    if (!useRel && usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // pre-release to release transition
    if (oldIsPre && !newIsPre) {
      return version && isAllowedVersionTransition(range, version, transitionOpts, versioning) ? version : null;
    }

    // check if latestTag is allowed by semvers
    const d = versioning.diff(oldParsed, latestParsed);
    if (d && d !== "prerelease" && !semvers.has(d.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (useRel && latestIsPre) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (versioning.compare(latestParsed, oldParsed) < 0 && !latestIsPre) {
      if (!isAllowedVersionTransition(range, latestTag, transitionOpts, versioning)) {
        // latest dist-tag is a disallowed downgrade — fall back to the in-range
        // `version` like the sibling branches, but only if it is a real upgrade.
        return newParsed && versioning.compare(newParsed, oldParsed) > 0 ? version : null;
      }
      return latestTag;
    }

    // prevent upgrading from non-prerelease to prerelease from latest dist-tag by default
    if (!oldIsPre && latestIsPre && !usePre) {
      return version;
    }

    // If a pinned range is specified and latestTag doesn't satisfy it, return version
    if (pinnedRange && !versioning.satisfiesRange(latestParsed, pinnedRange)) {
      return version;
    }

    // latestTag may be too new under cooldown — fall back to the
    // already-filtered `version` selected by findVersion.
    if (cooldownDays && now && !passesCooldown(getVersionDate ? getVersionDate(latestTag) : data.time?.[latestTag], cooldownDays, now)) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return latestTag;
  }
}

// A forge host includes its port: two instances on one hostname are different endpoints.
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Entries are `host:token` and the host may carry a port, so the last colon separates the two.
// Splitting at the first one read `localhost:3500:tok` as host `localhost` with token
// `3500:tok`, so a token may not itself contain a colon.
function pairToken(host: string): string | null {
  for (const entry of commaSeparatedToArray(env.UPDATES_FORGE_TOKENS ?? "")) {
    const sep = entry.lastIndexOf(":");
    if (sep > 0 && entry.slice(0, sep) === host) return entry.slice(sep + 1);
  }
  return null;
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

const reExtraheader = /^http\.(\S+)\/\.extraheader AUTHORIZATION:\s*basic\s+(\S+)$/i;

// actions/checkout and its Gitea and Forgejo forks leave the job token in git config as
// `http.<origin>/.extraheader`, base64 of `x-access-token:<token>`, keyed by GITHUB_SERVER_URL.
export function parseExtraheaders(config: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    const match = reExtraheader.exec(line);
    if (!match) continue;
    const host = urlHost(match[1]);
    const decoded = Buffer.from(match[2], "base64").toString("utf8");
    const token = decoded.slice(decoded.indexOf(":") + 1);
    if (host && token && !tokens.has(host)) tokens.set(host, token); // first wins, as git resolves it
  }
  return tokens;
}

// Read once, one subprocess serves every host in a run. `--local` would miss it, the
// credentials file arrives via includeIf.
let extraheaderTokensPromise: Promise<Map<string, string>> | undefined;
function getExtraheaderTokens(): Promise<Map<string, string>> {
  return extraheaderTokensPromise ??= (async () => {
    try {
      const execFile = await getExecFile();
      const {stdout} = await execFile("git", ["config", "--get-regexp", "^http\\..*\\.extraheader$"], {encoding: "utf8", timeout: 5000});
      return parseExtraheaders(stdout);
    } catch {
      return new Map();
    }
  })();
}

const workingTokenCache = new Map<string, string>();

// GitHub credentials (env tokens and `gh auth token`) are only ever sent to
// GitHub itself or to the configured default forge endpoint. A host taken from
// a workflow `uses:` ref must never receive them — it gets a token only when
// one is explicitly configured for it via UPDATES_FORGE_TOKENS.
export async function getForgeTokens(host: string, forgeApiUrl: string): Promise<string[]> {
  if (!host) return [];

  const hostToken = pairToken(host);
  if (hostToken) return [hostToken];

  // credentials are keyed by forge host, and GitHub alone serves its API from another hostname
  const forgeHost = host === "api.github.com" ? "github.com" : host;
  const isGithubHost = forgeHost === "github.com" || host === urlHost(forgeApiUrl);

  const [tokens, headers] = await Promise.all([
    isGithubHost ? getGithubTokens() : [],
    getExtraheaderTokens(),
  ]);
  const header = headers.get(forgeHost);
  return Array.from(new Set(header ? [...tokens, header] : tokens));
}

// A forge failure the run must report rather than read as "no update". Renovate draws the same
// line with PLATFORM_RATE_LIMIT_EXCEEDED and ExternalHostError.
export type ForgeErrorKind = "rateLimit" | "server" | "network";

export class ForgeError extends Error {
  override readonly name = "ForgeError";
  readonly kind: ForgeErrorKind;
  readonly host: string;
  readonly status: number;
  readonly reset: number; // `x-ratelimit-reset` in epoch seconds, 0 when the forge sent none

  constructor(kind: ForgeErrorKind, host: string, message: string, {status = 0, reset = 0, cause}: {status?: number, reset?: number, cause?: unknown} = {}) {
    super(message, {cause});
    this.kind = kind;
    this.host = host;
    this.status = status;
    this.reset = reset;
  }
}

// A rate limit is a 403 or 429 the headers or the body identify as one. A plain 403 is a
// credential problem and still falls through to the next token.
async function rateLimitReset(res: Response): Promise<number | null> {
  if (res.status !== 403 && res.status !== 429) return null;
  const reset = () => Number(res.headers?.get?.("x-ratelimit-reset")) || 0;
  if (res.headers?.get?.("x-ratelimit-remaining") === "0" || res.headers?.get?.("retry-after")) return reset();
  try {
    // Cloned so a caller that reads the body of a non-rate-limited 403 still can.
    const {message} = await (typeof res.clone === "function" ? res.clone() : res).json();
    if (typeof message !== "string") return null;
    if (message.includes("rate limit exceeded") || message.includes("abuse detection mechanism") ||
      message.startsWith("You have exceeded a secondary rate limit")) return reset();
  } catch {}
  return null;
}

async function checkForgeResponse(res: Response, url: string, host: string, hasToken: boolean): Promise<Response> {
  if (res.status >= 500) {
    throw new ForgeError("server", host, `Received ${res.status}${res.statusText ? ` ${res.statusText}` : ""} from ${url}`, {status: res.status});
  }
  const reset = await rateLimitReset(res);
  if (reset === null) return res;
  const hint = hasToken ? " even though a token was sent" : ", set one for this host in UPDATES_FORGE_TOKENS";
  const until = reset ? `, resets at ${new Date(reset * 1000).toISOString()}` : "";
  throw new ForgeError("rateLimit", host, `Rate limit exceeded for ${host}${hint}${until}`, {status: res.status, reset});
}

export async function fetchForge(url: string, ctx: ModeContext, extraHeaders?: Record<string, string>): Promise<Response> {
  const host = urlHost(url);

  // Resolve tokens before starting the AbortSignal timer so the lazy
  // `gh auth token` probe does not consume the fetch's timeout budget.
  const tokens = await getForgeTokens(host, ctx.forgeApiUrl);

  const optsFor = (token?: string): RequestInit => {
    const opts = getFetchOpts("Bearer", token);
    if (extraHeaders) opts.headers = {...opts.headers as Record<string, string>, ...extraHeaders};
    return opts;
  };

  const attempt = async (token?: string) =>
    checkForgeResponse(await fetchWithRetry(ctx, url, optsFor(token)), url, host, tokens.length > 0);

  try {
    if (!tokens.length) return await attempt();

    const cached = workingTokenCache.get(host);
    if (cached) return await attempt(cached);

    for (const token of tokens) {
      const response = await attempt(token);
      if (response.status !== 401 && response.status !== 403) {
        workingTokenCache.set(host, token);
        return response;
      }
    }
    return await attempt();
  } catch (err: any) {
    if (err instanceof ForgeError) throw err;
    throw new ForgeError("network", host, err?.message ?? String(err), {cause: err});
  }
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

// `oldRefs` are the refs the caller has to resolve, a sha pin's commit or a tag's own name. GitHub
// serves tags newest-first, so the walk stops once every one has been seen. Naming none reads all.
export async function fetchActionTags(apiUrl: string, owner: string, repo: string, ctx: ModeContext, oldRefs: Array<string> = []): Promise<Array<TagEntry>> {
  const tagsUrl = (page: number) => `${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`;
  const tags: Array<TagEntry> = [];
  const unresolved = new Set(oldRefs.filter(Boolean));
  const bounded = unresolved.size > 0;
  const take = (page: {tags: Array<TagEntry>} | null): boolean => {
    for (const entry of page?.tags ?? []) {
      for (const ref of unresolved) if (ref === entry.name || entry.commitSha.startsWith(ref)) unresolved.delete(ref);
      tags.push(entry);
    }
    return bounded && !unresolved.size;
  };
  try {
    const page1 = await fetchTagsPage(tagsUrl(1), ctx);
    if (!page1) return tags;
    const last = /<([^>]+)>;\s*rel="last"/.exec(page1.link);
    const lastPage = last ? Math.min(Number(new URL(last[1]).searchParams.get("page")), maxTagPages) : 0;
    // Each wave is one round trip and doubles up to the socket budget, the limiter caps the flight.
    const maxWave = effectiveConcurrency(ctx);
    for (let next = 2, wave = 1, done = take(page1); next <= lastPage && !done; next += wave, wave = Math.min(wave * 2, maxWave)) {
      const pages = await Promise.all(
        Array.from({length: Math.min(wave, lastPage - next + 1)}, (_, idx) => fetchTagsPage(tagsUrl(next + idx), ctx)),
      );
      for (const page of pages) done = take(page);
    }
    return tags;
  } catch (err) {
    // A classified failure is the dependency's result, unlike a malformed page worth degrading over.
    if (err instanceof ForgeError) throw err;
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

