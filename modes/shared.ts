import {AsyncLocalStorage} from "node:async_hooks";
import {Buffer} from "node:buffer";
import {env} from "node:process";
import {setTimeout as delay} from "node:timers/promises";
import {
  type Versioning, coerce, diff, gt, satisfies, semverVersioning, pep440Versioning, valid,
} from "../utils/semver.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {commaSeparatedToArray, getOrSet} from "../utils/utils.ts";
import pkg from "../package.json" with {type: "json"};

export type {Config} from "../config.ts";

export type Dep = {
  old: string, new: string, oldPrint?: string, newPrint?: string, oldOrig?: string, info?: string, age?: string,
  date?: string, oldDigest?: string, newDigest?: string, digestOnly?: boolean,
};
export type Deps = {[name: string]: Dep};
export type DepsByMode = {[mode: string]: Deps};

export type Output = {
  results: {[mode: string]: {[type: string]: Deps}},
  message?: string,
};

export type CooldownOpts = {cooldownDays?: number, now?: number,
  getVersionDate?: (version: string) => string | undefined};

export type FindVersionOpts = {
  range: string, semvers: Set<string>, useGreatest: boolean, usePre: boolean, useRel: boolean, latest?: string,
  pinnedRange?: string, pinNoDowngrade?: boolean, allowDowngrade?: boolean, versioning?: Versioning,
} & CooldownOpts;

export type FindNewVersionOpts = Omit<FindVersionOpts, "latest"> & {mode: string};

export function passesCooldown(date: string | undefined, cooldownDays: number | undefined, now: number | undefined): boolean {
  if (!cooldownDays || !now) return true;
  const ms = date ? Date.parse(date) : NaN;
  if (Number.isNaN(ms)) return false;
  return (now - ms) / (24 * 3600 * 1000) >= cooldownDays;
}

export type PackageInfo = [Record<string, any>, string | null];

export type PackageRepository = string | {type: string, url: string, directory: string};

export type GoProxyEntry = {url: string, fallback: "," | "|"};

export type ModeContext = {
  fetchTimeout: number, goProbeTimeout: number, concurrency: number, forgeApiUrl: string, pypiApiUrl: string,
  jsrApiUrl: string, goProxyUrl: string, goProxyChain: Array<GoProxyEntry>, cratesIoUrl: string, dockerApiUrl: string,
  doFetch: typeof doFetch, execFile: ExecFile, noCache: boolean,
};

export type ExecFile = (file: string, args: Array<string>, opts: Record<string, any>) =>
Promise<{stdout: string, stderr: string}>;

export const packageVersion = pkg.version;
export const fieldSep = "\0";
export const fetchTimeout = 5000;
export const goProbeTimeout = 2500;
export const maxSockets = 50;
export const maxTagPages = 100;

export const githubApiUrl = "https://api.github.com";

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

const transientErrorCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

export function isTransientFetchError(err: any): boolean {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
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

export async function fetchWithRetry(
  ctx: ModeContext, url: string, opts: RequestInit = {},
): Promise<Response> {
  const limit = getLimiter(ctx);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await limit(() => ctx.doFetch(url, {...opts, signal: AbortSignal.timeout(ctx.fetchTimeout)}));
      const value = res?.headers?.get?.("retry-after")?.trim();
      const date = value && !/^\d+$/.test(value) ? Date.parse(value) : NaN;
      const retryAfter = !value ? null : /^\d+$/.test(value) ? Number(value) * 1000 :
        Number.isNaN(date) ? null : Math.max(date - Date.now(), 0);
      // Waiting longer for a retry than for the request itself never pays off in a one-shot run:
      // Docker Hub asks for 60s and answers the retry with the same rate limit.
      const maxRetryAfter = ctx.fetchTimeout;
      const retryDelay = res && res.status >= 500 && res.status < 600 ?
        (retryAfter !== null && retryAfter <= maxRetryAfter ? retryAfter : 0) : res &&
        (res.status === 429 || res.status === 403 && retryAfter !== null) &&
        (retryAfter === null || retryAfter <= maxRetryAfter) ? retryAfter ?? 0 : null;
      if (retryDelay === null || attempt >= fetchRetries) return res;
      if (res.body) await res.body.cancel();
      if (retryDelay) await delay(retryDelay);
    } catch (err: any) {
      if (attempt >= fetchRetries || !err?.transient) throw err;
    }
  }
}

export type BodyReducer = (body: string) => string;
const reduceThreshold = 16384;

export const reduceJson = (reduce: (data: any) => any): BodyReducer =>
  body => JSON.stringify(reduce(JSON.parse(body)));

type FetchResult = {body: string, res?: Response} | {res: Response | undefined};
const fetchesByCtx = new WeakMap<ModeContext, Map<string, Promise<FetchResult>>>();

function fetchCached(
  url: string, ctx: ModeContext, opts: RequestInit, reduce: BodyReducer | undefined, cacheKey: string, immutable: boolean,
): Promise<FetchResult> {
  const requestKey = JSON.stringify([url, cacheKey, immutable, opts.method ?? "GET",
    Array.from(new Headers(opts.headers).entries()).sort(), opts.body ?? null, reduce?.toString()]);
  const requests = getOrSet(fetchesByCtx, ctx, () => new Map<string, Promise<FetchResult>>());
  let request = requests.get(requestKey);
  if (!request) {
    request = (async () => {
      try {
        const cached = ctx.noCache ? null : await getCache(cacheKey);
        if (immutable && cached) return {body: cached.body};
        const baseHeaders = opts.headers as Record<string, string> | undefined;
        const headers = cached ? {...baseHeaders, "if-none-match": cached.etag} : baseHeaders;
        const res = await fetchWithRetry(ctx, url, {...opts, headers});
        if (res.status === 304 && cached) return {body: cached.body, res};
        if (!res.ok) return {res};
        let body = await res.text();
        if (reduce && body.length >= reduceThreshold) {
          try { body = reduce(body); } catch {}
        }
        const etag = immutable ? "immutable" : res.headers.get("etag");
        if (etag && !ctx.noCache) setCache(cacheKey, etag, body);
        return {body, res};
      } finally {
        requests.delete(requestKey);
      }
    })();
    requests.set(requestKey, request);
  }
  return request;
}

export function fetchWithEtag(
  url: string, ctx: ModeContext, opts: RequestInit = {}, reduce?: BodyReducer, cacheKey: string = url,
): Promise<FetchResult> {
  return fetchCached(url, ctx, opts, reduce, cacheKey, false);
}

export function fetchImmutable(
  url: string, ctx: ModeContext, opts: RequestInit = {}, reduce?: BodyReducer,
): Promise<FetchResult> {
  return fetchCached(url, ctx, opts, reduce, url, true);
}

export async function dedupe<T>(byCtx: WeakMap<ModeContext, Map<string, Promise<T>>>, ctx: ModeContext, key: string, fn: () => Promise<T>): Promise<T> {
  const cache = getOrSet(byCtx, ctx, () => new Map<string, Promise<T>>());
  const promise = cache.get(key);
  if (promise) return promise;
  const request = fn();
  cache.set(key, request);
  try {
    return await request;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

const inSlot = new AsyncLocalStorage<boolean>();

export const effectiveConcurrency = (ctx: ModeContext): number => Math.max(ctx.concurrency || maxSockets, 1);

const limiterByCtx = new WeakMap<ModeContext, Limiter>();

export function getLimiter(ctx: ModeContext): Limiter {
  let limiter = limiterByCtx.get(ctx);
  if (!limiter) {
    const concurrency = effectiveConcurrency(ctx);
    let active = 0;
    let head = 0;
    let waiting: Array<() => void> = [];
    limiter = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (inSlot.getStore()) return fn();
      if (active < concurrency) active++;
      else await new Promise<void>(resolve => { waiting.push(resolve); });
      try {
        return await inSlot.run(true, fn);
      } finally {
        if (head < waiting.length) {
          waiting[head++]();
          if (head === waiting.length) { waiting = []; head = 0; }
        } else active--;
      }
    };
    limiterByCtx.set(ctx, limiter);
  }
  return limiter;
}

export function isVersionPrerelease(version: string, versioning: Versioning = semverVersioning): boolean {
  const parsed = versioning.parse(version);
  return Boolean(parsed && versioning.isPrerelease(parsed));
}

const allPrereleaseCache = new WeakMap<Set<string>, Set<string>>();
const sameReleasePrereleaseCache = new WeakMap<Set<string>, Set<string>>();

export function prereleaseOpts(range: string, usePre: boolean, useRel: boolean, semvers: Set<string>, versioning: Versioning = semverVersioning) {
  const anyPrerelease = usePre || versioning.isRangePrerelease(range);
  let effectiveSemvers = semvers;
  if (anyPrerelease) {
    const cache = usePre ? allPrereleaseCache : sameReleasePrereleaseCache;
    effectiveSemvers = cache.get(semvers) ?? new Set(semvers).add("prerelease");
    if (usePre) {
      if (semvers.has("patch")) effectiveSemvers.add("prepatch");
      if (semvers.has("minor")) effectiveSemvers.add("preminor");
      if (semvers.has("major")) effectiveSemvers.add("premajor");
    }
    cache.set(semvers, effectiveSemvers);
  }
  const skipsPrerelease = (parsed: any) => (!anyPrerelease || useRel) && Boolean(parsed) && versioning.isPrerelease(parsed);
  return {effectiveSemvers, skipsPrerelease};
}

export function coerceToVersion(rangeOrVersion: string): string {
  return coerce(rangeOrVersion)?.version ?? "";
}

export function findVersion(data: any, versions: Array<string>, {range, semvers, useGreatest, usePre, useRel, latest, pinnedRange, pinNoDowngrade, allowDowngrade, cooldownDays, now, getVersionDate, versioning = semverVersioning}: FindVersionOpts): string | null {
  const oldParsed = versioning.parseRange(range);
  if (!oldParsed) return null;

  const {effectiveSemvers, skipsPrerelease} = prereleaseOpts(range, usePre, useRel, semvers, versioning);

  const latestParsed = latest ? versioning.parse(latest) : null;
  const ceiling = useGreatest || (usePre && !useRel) ||
    (latestParsed && pinnedRange && !versioning.satisfiesRange(latestParsed, pinnedRange)) ? null : latestParsed;
  const pastCeiling = Boolean(ceiling && versioning.compare(oldParsed, ceiling) > 0);

  const intoPin = Boolean(pinnedRange) && !pinNoDowngrade && !versioning.satisfiesRange(oldParsed, pinnedRange!);
  const ontoTag = Boolean(allowDowngrade) && (Boolean(ceiling) || versioning.isPrerelease(oldParsed));

  const time = data?.time;
  const cooldownActive = Boolean(cooldownDays && now);

  let newVersionParsed: {raw?: string, version: string} | null = null;

  for (const version of versions) {
    const parsed = versioning.parse(version);
    if (!parsed || skipsPrerelease(parsed)) continue;

    const stepDown = versioning.compare(parsed, oldParsed) <= 0;
    if (stepDown && !intoPin && !ontoTag) continue;
    if (newVersionParsed && versioning.compare(parsed, newVersionParsed) <= 0) continue;
    if (stepDown && !intoPin && ceiling && versioning.compare(parsed, ceiling) !== 0) continue;
    if (!stepDown && ceiling && !pastCeiling && versioning.compare(parsed, ceiling) > 0) continue;

    if (pinnedRange && !versioning.satisfiesRange(parsed, pinnedRange)) continue;
    if (cooldownActive && !passesCooldown(getVersionDate ? getVersionDate(version) : time?.[version], cooldownDays, now)) continue;

    const d = versioning.diff(oldParsed, parsed);
    const level = d && !versioning.isPrerelease(parsed) ? d.replace(/^pre/, "") : d;
    if (!level || !effectiveSemvers.has(level)) continue;

    newVersionParsed = parsed;
  }

  return newVersionParsed?.raw ?? newVersionParsed?.version ?? null;
}

export function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

export function findNewVersion(data: any, {mode, range: authoredRange, useGreatest, usePre, useRel, semvers, pinnedRange, pinNoDowngrade, cooldownDays, now, allowDowngrade}: FindNewVersionOpts): string | null {
  if (authoredRange === "*") return null;

  const versioning: Versioning = mode === "pypi" ? pep440Versioning : semverVersioning;
  const range = authoredRange.includes("||") ? authoredRange.split("||").pop()!.trim() : authoredRange;
  let versions: Array<string> = [];
  let latestTag = "";
  let getVersionDate: ((v: string) => string | undefined) | undefined;
  if (mode === "pypi") {
    const releases = data?.releases;
    if (!releases) return null;
    versions = Object.keys(releases).filter(version =>
      Array.isArray(releases[version]) && releases[version].some((file: any) => file && !file.yanked));
    getVersionDate = (version: string) => releases[version].reduce(
      (earliest: {date?: string, time: number}, file: any) => {
        const date = file?.upload_time_iso_8601;
        const time = typeof date === "string" ? Date.parse(date) : NaN;
        return !Number.isNaN(time) && time < earliest.time ? {date, time} : earliest;
      }, {time: Infinity},
    ).date;
    latestTag = data.info?.version ?? "";
  } else if (mode === "npm" || mode === "cargo") {
    if (!data?.versions) return null;
    versions = Object.keys(data.versions);
    latestTag = data["dist-tags"]?.latest ?? "";
    if (mode === "npm" && !data.versions[coerceToVersion(range)]?.deprecated) {
      const live = versions.filter(version => !data.versions[version]?.deprecated);
      versions = live.length ? live : versions;
    }
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const {effectiveSemvers, skipsPrerelease} = prereleaseOpts(range, usePre, useRel, semvers, versioning);
    const originalOldVersion = data.old || range;
    const oldParsed = versioning.parseRange(originalOldVersion);
    const mayStepDown = Boolean(allowDowngrade) ||
      (Boolean(pinnedRange) && !pinNoDowngrade && Boolean(oldParsed) && !versioning.satisfiesRange(oldParsed, pinnedRange!));

    const accepts = (candidate: string, time: string | undefined): boolean => {
      const coerced = coerceToVersion(candidate);
      const parsed = versioning.parse(candidate);
      const pseudo = isGoPseudoVersion(candidate);
      if (!coerced || !pseudo && skipsPrerelease(parsed)) return false;
      const d = diff(originalOldVersion, candidate) ?? diff(oldVersion, coerced);
      const level = pseudo ? d?.replace(/^pre/, "") : d;
      if (!level || !effectiveSemvers.has(level)) return false;
      if (!mayStepDown && parsed && oldParsed && versioning.compare(parsed, oldParsed) < 0) return false;
      if (!passesCooldown(time, cooldownDays, now)) return false;
      return !pinnedRange || satisfies(coerced, pinnedRange);
    };

    if (accepts(data.new, data.Time)) return data.new;
    if (accepts(data.sameMajorNew, data.sameMajorTime)) {
      data.Time = data.sameMajorTime;
      delete data.newPath;
      return data.sameMajorNew;
    }
    return null;
  }
  return findVersion(data, versions, {range, semvers, useGreatest, usePre, useRel, latest: latestTag,
    pinnedRange, pinNoDowngrade, allowDowngrade, cooldownDays, now, getVersionDate, versioning});
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pairToken(host: string): string | null {
  const entry = commaSeparatedToArray(env.UPDATES_FORGE_TOKENS ?? "").find(entry => {
    const sep = entry.lastIndexOf(":");
    return sep > 0 && entry.slice(0, sep) === host;
  });
  return entry ? entry.slice(entry.lastIndexOf(":") + 1) : null;
}

let execFilePromise: Promise<ExecFile> | undefined;
export function getExecFile(): Promise<ExecFile> {
  if (!execFilePromise) execFilePromise = (async () => {
    const [{execFile}, {promisify}] = await Promise.all([import("node:child_process"), import("node:util")]);
    return promisify(execFile) as ExecFile;
  })();
  return execFilePromise;
}

const githubTokenEnvNames = ["UPDATES_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];

let githubTokensPromise: Promise<string[]> | undefined;
export function getGithubTokens(): Promise<string[]> {
  const tokens = Array.from(new Set(githubTokenEnvNames
    .map(name => env[name]).filter((value): value is string => Boolean(value))));
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

export function parseExtraheaders(config: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    const match = reExtraheader.exec(line);
    if (!match) continue;
    const host = urlHost(match[1]);
    const decoded = Buffer.from(match[2], "base64").toString("utf8");
    const token = decoded.slice(decoded.indexOf(":") + 1);
    if (host && token && !tokens.has(host)) tokens.set(host, token);
  }
  return tokens;
}

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

export async function getForgeTokens(host: string, forgeApiUrl: string): Promise<string[]> {
  if (!host) return [];

  const hostToken = pairToken(host);
  if (hostToken) return [hostToken];

  const forgeHost = host === "api.github.com" ? "github.com" : host;
  const isGithubHost = forgeHost === "github.com" || host === urlHost(forgeApiUrl);

  const [tokens, headers] = await Promise.all([
    isGithubHost ? getGithubTokens() : [],
    getExtraheaderTokens(),
  ]);
  const header = headers.get(forgeHost);
  return Array.from(new Set(header ? [...tokens, header] : tokens));
}

export type ForgeErrorKind = "rateLimit" | "server" | "network";

export class ForgeError extends Error {
  override readonly name = "ForgeError";
  readonly kind: ForgeErrorKind;
  readonly host: string;
  readonly status: number;
  readonly reset: number;

  constructor(kind: ForgeErrorKind, host: string, message: string, {status = 0, reset = 0, cause}: {status?: number, reset?: number, cause?: unknown} = {}) {
    super(message, {cause});
    this.kind = kind;
    this.host = host;
    this.status = status;
    this.reset = reset;
  }
}

async function rateLimitReset(res: Response): Promise<number | null> {
  if (res.status !== 403 && res.status !== 429) return null;
  const reset = Number(res.headers?.get?.("x-ratelimit-reset")) || 0;
  if (res.headers?.get?.("x-ratelimit-remaining") === "0" || res.headers?.get?.("retry-after")) return reset;
  try {
    const {message} = await (typeof res.clone === "function" ? res.clone() : res).json();
    if (typeof message !== "string") return null;
    if (message.includes("rate limit exceeded") || message.includes("abuse detection mechanism") ||
      message.startsWith("You have exceeded a secondary rate limit")) return reset;
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
  const tokens = await getForgeTokens(host, ctx.forgeApiUrl);
  const attempt = async (token?: string) => {
    const opts = getFetchOpts("Bearer", token);
    opts.headers = {...opts.headers as Record<string, string>, ...extraHeaders};
    return checkForgeResponse(await fetchWithRetry(ctx, url, opts), url, host, Boolean(tokens.length));
  };

  try {
    if (!tokens.length) return await attempt();

    const cached = workingTokenCache.get(host);
    for (const token of cached && tokens.includes(cached) ? [cached, ...tokens.filter(token => token !== cached)] : tokens) {
      const response = await attempt(token);
      if (response.status !== 401 && response.status !== 403) {
        workingTokenCache.set(host, token);
        return response;
      }
      if (token === cached) workingTokenCache.delete(host);
    }
    return await attempt();
  } catch (err: any) {
    if (err instanceof ForgeError) throw err;
    throw new ForgeError("network", host, err?.message ?? String(err), {cause: err});
  }
}

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
  return bestTag && gt(bestBare, oldRefBare) ? bestTag : null;
}

export function resolvePackageJsonUrl(url: string): string {
  const cleaned = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]+\/[a-z0-9-]+$/.test(cleaned)) {
    return cleaned.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  }
  return /^[a-z0-9-]+\/[a-z0-9-]+$/.test(cleaned) ? `https://github.com/${cleaned}` : cleaned;
}

const commitHashPattern = "(?:[0-9a-f]{6,7}|[0-9a-f]{40}|[0-9a-f]{64})";
export const commitHashRe = new RegExp(`^${commitHashPattern}$`, "i");
export const hashRe = /^(?=.*[a-f])[0-9a-f]{7,40}$/i;

export function isVersionLikeRef(ref: string): boolean {
  return /^v?\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/.test(ref);
}

export type TagEntry = {name: string, commitSha: string, isStable?: boolean};

export function parseCommitDate(data: any): string {
  const commit = data?.commit ?? data;
  return commit?.committer?.date || commit?.author?.date || "";
}

export function parseTags(data: Array<any>): Array<TagEntry> {
  if (!Array.isArray(data)) throw new TypeError("Invalid Forge tags response");
  return data.map((tag: any) => {
    if (typeof tag?.name !== "string" || tag.commit?.sha !== undefined && typeof tag.commit.sha !== "string") {
      throw new TypeError("Invalid Forge tag entry");
    }
    return {name: tag.name, commitSha: tag.commit?.sha || ""};
  });
}

const parseTagPage = (data: any, cached: boolean): Array<TagEntry> => {
  if (!cached) return parseTags(data);
  if (!Array.isArray(data)) throw new TypeError("Invalid cached Forge tags response");
  return data.map(tag => {
    if (typeof tag?.name !== "string" || typeof tag.commitSha !== "string" ||
      tag.isStable !== undefined && typeof tag.isStable !== "boolean") throw new TypeError("Invalid cached Forge tag entry");
    return {...tag};
  });
};

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

type Release = {name: string, isStable: boolean};

function parseReleases(data: any, cached = false): Array<Release> {
  if (!Array.isArray(data)) throw new TypeError(`Invalid ${cached ? "cached " : ""}Forge releases response`);
  return data.map(release => {
    const name = cached ? release?.name : release?.tag_name;
    const isStable = cached ? release?.isStable : !release?.prerelease && release?.draft !== true;
    if (typeof name !== "string" || (cached ? typeof isStable !== "boolean" :
      typeof release?.prerelease !== "boolean" || release.draft !== undefined && typeof release.draft !== "boolean")) {
      throw new TypeError(`Invalid ${cached ? "cached " : ""}Forge release entry`);
    }
    return {name, isStable};
  });
}

type ForgePage<T> = {entries: Array<T>, link: string};

async function fetchForgePage<T>(
  url: string, ctx: ModeContext, key: "tags" | "releases", parse: (data: any, cached: boolean) => Array<T>,
): Promise<ForgePage<T> | null> {
  const body = await fetchForgeEtag(url, ctx, async res => JSON.stringify({
    link: res.headers.get("link") || "",
    [key]: parse(await res.json(), false),
  }));
  if (!body) return null;
  const parsed = JSON.parse(body);
  if (typeof parsed?.link !== "string") throw new TypeError(`Invalid cached Forge ${key} response`);
  return {entries: parse(parsed[key], true), link: parsed.link};
}

function lastPageFromLink(link: string): number {
  const last = /<([^>]+)>;\s*rel="last"/.exec(link);
  if (!last) return 0;
  const page = Number(new URL(last[1]).searchParams.get("page"));
  if (!Number.isSafeInteger(page) || page < 1) throw new TypeError("Invalid Forge pagination URL");
  return Math.min(page, maxTagPages);
}

async function fetchForgePages<T>(
  url: (page: number) => string, ctx: ModeContext, key: "tags" | "releases",
  parse: (data: any, cached: boolean) => Array<T>, take: (entries: Array<T>) => boolean,
): Promise<void> {
  const page1 = await fetchForgePage(url(1), ctx, key, parse);
  if (!page1) return;
  const lastPage = lastPageFromLink(page1.link);
  const maxWave = effectiveConcurrency(ctx);
  for (let next = 2, wave = 1, done = take(page1.entries); next <= lastPage && !done; next += wave, wave = Math.min(wave * 2, maxWave)) {
    const pages = await Promise.all(
      Array.from({length: Math.min(wave, lastPage - next + 1)}, (_, idx) =>
        fetchForgePage(url(next + idx), ctx, key, parse)),
    );
    for (const page of pages) done = take(page?.entries ?? []);
  }
}

async function fetchReleaseStability(
  owner: string, repo: string, ctx: ModeContext, oldRefs: Array<string>,
): Promise<Map<string, boolean>> {
  const stability = new Map<string, boolean>();
  // Newest first, so the same bound as the tags: everything still selectable is seen before the
  // release naming a current ref, and anything past it could only be picked as a downgrade.
  const unresolved = new Set(oldRefs.filter(Boolean));
  const bounded = unresolved.size > 0;
  await fetchForgePages(
    page => `${githubApiUrl}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
    ctx, "releases", parseReleases, entries => {
      for (const release of entries) {
        unresolved.delete(release.name);
        stability.set(release.name, release.isStable);
      }
      return bounded && !unresolved.size;
    },
  );
  return stability;
}

export async function fetchForgeTags(
  apiUrl: string, owner: string, repo: string, ctx: ModeContext, oldRefs: Array<string> = [],
): Promise<Array<TagEntry>> {
  const tags: Array<TagEntry> = [];
  const unresolved = new Set(oldRefs.filter(Boolean));
  const bounded = unresolved.size > 0;
  await fetchForgePages(
    page => `${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`,
    ctx, "tags", parseTagPage, entries => {
      for (const entry of entries) {
        for (const ref of unresolved) if (ref === entry.name || entry.commitSha.startsWith(ref)) unresolved.delete(ref);
        tags.push(entry);
      }
      return bounded && !unresolved.size;
    },
  );
  return tags;
}

export async function fetchActionTags(
  apiUrl: string, owner: string, repo: string, ctx: ModeContext, oldRefs: Array<string> = [], includeStability = true,
): Promise<Array<TagEntry>> {
  if (apiUrl !== githubApiUrl || !includeStability) return fetchForgeTags(apiUrl, owner, repo, ctx, oldRefs);
  const [tagsResult, stability] = await Promise.allSettled([
    fetchForgeTags(apiUrl, owner, repo, ctx, oldRefs),
    fetchReleaseStability(owner, repo, ctx, oldRefs),
  ]);
  if (tagsResult.status === "rejected") throw tagsResult.reason;
  if (stability.status === "rejected" && !(stability.reason instanceof ForgeError)) throw stability.reason;
  if (stability.status === "fulfilled") {
    for (const tag of tagsResult.value) if (stability.value.has(tag.name)) tag.isStable = stability.value.get(tag.name);
  }
  return tagsResult.value;
}

export type CheckResult = {key: string, newRange: string, user: string, repo: string, oldRef: string, newRef: string,
  newDate?: string};

export function throwFetchError(res: Response | undefined, url: string, name: string, source: string): never {
  if (res?.status && res.statusText) {
    throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
  }
  throw new Error(`Unable to fetch ${name} from ${source}`);
}

const dateVersionMin = 20000000;
export function isSameVersionScheme(candidate: string, oldVersion: string): boolean {
  const candidateFields = stripv(candidate).split(".");
  const oldFields = stripv(oldVersion).split(".");
  if (candidateFields.length < oldFields.length) return false;
  return Number(candidateFields[0]) < dateVersionMin || Number(oldFields[0]) >= dateVersionMin;
}

export function formatVersionPrecision(newVersion: string, oldVersion: string, suffix = ""): string {
  const bare = stripv(newVersion);
  const numParts = stripv(oldVersion).split(".").length;
  const newParts = bare.split(".");
  const formatted = numParts >= 3 ? bare : Array.from({length: numParts}, (_, idx) => newParts[idx] || "0").join(".");
  return `${oldVersion.startsWith("v") ? "v" : ""}${formatted}${suffix}`;
}

export function getSubDir(url: string): string {
  return url.startsWith("https://bitbucket.org") ? "src/HEAD" : "tree/HEAD";
}

const pypiRepoKeys = ["repository", "Repository", "repo", "Repo", "source", "Source", "source code", "Source code", "Source Code", "homepage", "Homepage"];

export function getInfoUrl({repository, homepage, info}: {repository?: PackageRepository, homepage?: string, info?: Record<string, any>}, registry: string | null, name: string): string {
  if (info) {
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
  }
  if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    infoUrl = resolvePackageJsonUrl(url);
    if (infoUrl && typeof repository !== "string" && repository.directory) {
      infoUrl += `/${getSubDir(infoUrl)}/${repository.directory}`;
    }
  }

  return infoUrl || homepage || "";
}
