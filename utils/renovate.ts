import {join} from "node:path";
import {readFile} from "node:fs/promises";
import {parseJsonish} from "./json5.ts";
import {validRange} from "./semver.ts";
import {walkUp, memoizeAsync} from "./utils.ts";
import {getCache, setCache} from "./fetchCache.ts";
import type {Config} from "../config.ts";

const forgeDirs = [".github", ".gitea", ".forgejo", ".gitlab"];

const configFileNames = [
  "renovate.json",
  "renovate.json5",
  ...forgeDirs.flatMap(dir => [`${dir}/renovate.json`, `${dir}/renovate.json5`]),
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
];

const durationUnits: Record<string, number> = {
  y: 365, year: 365, years: 365,
  mo: 30, month: 30, months: 30,
  w: 7, week: 7, weeks: 7,
  d: 1, day: 1, days: 1,
  h: 1 / 24, hour: 1 / 24, hours: 1 / 24,
  min: 1 / 1440, minute: 1 / 1440, minutes: 1 / 1440,
  s: 1 / 86400, second: 1 / 86400, seconds: 1 / 86400,
};

/** Parse a renovate duration string ("3 days", "1 week", "12 hours") into days. */
function parseRenovateDuration(str: string): number | undefined {
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const mult = durationUnits[m[2].toLowerCase()];
    if (mult === undefined) return undefined;
    total += Number(m[1]) * mult;
    matched = true;
  }
  return matched ? total : undefined;
}

type RenovateConfig = {
  extends?: Array<string>;
  minimumReleaseAge?: string;
  ignoreDeps?: Array<string>;
  packageRules?: Array<RenovatePackageRule>;
  presets?: Record<string, RenovateConfig>;
  [key: string]: unknown;
};

type RenovatePackageRule = {
  matchPackageNames?: Array<string>;
  enabled?: boolean;
  allowedVersions?: string;
  [key: string]: unknown;
};

/**
 * A packageRule is "simple" if its only matcher is matchPackageNames. Rules
 * with other matchers (matchUpdateTypes, matchManagers, matchFileNames, etc.)
 * cannot be cleanly mapped to updates' config.
 */
function isSimpleRule(rule: RenovatePackageRule): boolean {
  if (!Array.isArray(rule.matchPackageNames) || !rule.matchPackageNames.length) return false;
  return Object.keys(rule).every(key => !key.startsWith("match") || key === "matchPackageNames");
}

async function readFirstExisting(rootDir: string): Promise<{path: string, text: string} | undefined> {
  for (const name of configFileNames) {
    const path = join(rootDir, ...name.split("/"));
    try {
      return {path, text: await readFile(path, "utf8")};
    } catch {}
  }
  try {
    const pkgPath = join(rootDir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    if (pkg && typeof pkg === "object" && pkg.renovate && typeof pkg.renovate === "object") {
      return {path: pkgPath, text: JSON.stringify(pkg.renovate)};
    }
  } catch {}
  return undefined;
}

/** Renovate uses /pattern/ or /pattern/flags for regex matchers. */
function toMatcher(name: string): string | RegExp {
  const m = /^\/(.+)\/([a-z]*)$/.exec(name);
  if (!m) return name;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return name;
  }
}

// Renovate matchPackageNames entries may be minimatch globs (e.g. "@babel/*"),
// whose characters are never valid in a package identifier across ecosystems.
function isGlob(name: string): boolean {
  return /[*?[\]{}!()|+]/.test(name);
}

export type RenovateImportOptions = {
  /** Import minimumReleaseAge as cooldown. Off by default. */
  cooldown?: boolean;
};

function normalize(raw: RenovateConfig, opts: RenovateImportOptions): Partial<Config> {
  const out: Partial<Config> = {};

  if (opts.cooldown && typeof raw.minimumReleaseAge === "string") {
    const days = parseRenovateDuration(raw.minimumReleaseAge);
    if (days !== undefined && days > 0) out.cooldown = days;
  }

  const exclude: Array<string | RegExp> = [];
  const pin: Record<string, string> = {};

  if (Array.isArray(raw.ignoreDeps)) {
    for (const dep of raw.ignoreDeps) {
      if (typeof dep === "string" && dep) exclude.push(dep);
    }
  }

  if (Array.isArray(raw.packageRules)) {
    for (const rule of raw.packageRules) {
      if (!rule || typeof rule !== "object" || !isSimpleRule(rule)) continue;
      const names = rule.matchPackageNames!.filter((n): n is string => typeof n === "string" && Boolean(n));
      if (rule.enabled === false) {
        for (const name of names) exclude.push(toMatcher(name));
      }
      if (typeof rule.allowedVersions === "string" && validRange(rule.allowedVersions)) {
        // pin is keyed by literal package name; regex and glob matchers can't be honored, so skip them
        for (const name of names) {
          if (!isGlob(name) && typeof toMatcher(name) === "string") pin[name] = rule.allowedVersions;
        }
      }
    }
  }

  if (exclude.length) out.exclude = exclude;
  if (Object.keys(pin).length) out.pin = pin;

  return out;
}

/** Fetch a preset file as text, or null if missing/unreachable. Injectable for tests. */
export type PresetFetcher = (url: string) => Promise<string | null>;

// Only git-forge presets with a known public host are resolvable. gitea>/forgejo>
// need a self-hosted endpoint and local> needs the running platform, neither of
// which exists here; built-in presets (config:, :x, helpers:, group:, …) are
// bundled inside Renovate itself and have no URL. All of those are skipped.
const forgeRawUrl: Record<string, (slug: string, ref: string, file: string) => string> = {
  github: (slug, ref, file) => `https://raw.githubusercontent.com/${slug}/${ref}/${file}`,
  gitlab: (slug, ref, file) => `https://gitlab.com/${slug}/-/raw/${ref}/${file}`,
};

const maxPresetDepth = 10;

type PresetLocation = {forge: string, slug: string, ref: string, name?: string, subpath?: string};

/**
 * Parse a Renovate preset reference into a fetchable location, or null if it is
 * a built-in or otherwise unresolvable preset. Handles `forge>owner/repo`,
 * `:preset` names, `//path` subpaths, `#ref` refs and `(params)` (params ignored).
 */
function parsePreset(preset: string): PresetLocation | null {
  const gt = preset.indexOf(">");
  if (gt === -1) return null; // built-in preset, no URL
  const forge = preset.slice(0, gt);
  // Object.hasOwn, not `in`: `in` matches inherited keys like __proto__/constructor.
  if (!Object.hasOwn(forgeRawUrl, forge)) return null; // local>, gitea>, forgejo>, unknown host
  let rest = preset.slice(gt + 1).replace(/\([^)]*\)\s*$/, ""); // drop params, unsupported
  let ref = "HEAD";
  const hash = rest.indexOf("#");
  if (hash !== -1) { ref = rest.slice(hash + 1) || "HEAD"; rest = rest.slice(0, hash); }
  let subpath: string | undefined;
  let name: string | undefined;
  const dslash = rest.indexOf("//");
  if (dslash !== -1) {
    subpath = rest.slice(dslash + 2);
    rest = rest.slice(0, dslash);
  } else {
    const colon = rest.indexOf(":");
    if (colon !== -1) { name = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  }
  const slug = rest.replace(/\/+$/, "");
  if (!slug.includes("/")) return null;
  return {forge, slug, ref, name, subpath};
}

// Repo config files Renovate probes, in order, to locate a preset's source.
const presetConfigFiles = ["default.json", "default.json5", "renovate.json", "renovate.json5", ".renovaterc.json", ".renovaterc"];

// Candidate paths for an explicit `//subpath` preset, appending .json/.json5 when extensionless.
function subpathFiles(subpath: string): Array<string> {
  return /\.json5?$/.test(subpath) ? [subpath] : [`${subpath}.json`, `${subpath}.json5`];
}

// A null body (missing/unreachable) or unparseable body is skipped, never fatal.
function tryParse(body: string | null): RenovateConfig | null {
  if (body === null) return null;
  try {
    const parsed = parseJsonish(body);
    return parsed && typeof parsed === "object" ? parsed as RenovateConfig : null;
  } catch {
    return null;
  }
}

async function fetchPresetConfig(loc: PresetLocation, fetchText: PresetFetcher): Promise<RenovateConfig | null> {
  const build = forgeRawUrl[loc.forge];
  const fetchParsed = async (file: string) => tryParse(await fetchText(build(loc.slug, loc.ref, file)));

  // An explicit `//path` points straight at a file.
  if (loc.subpath) {
    for (const file of subpathFiles(loc.subpath)) {
      const parsed = await fetchParsed(file);
      if (parsed) return parsed;
    }
    return null;
  }
  // Otherwise Renovate reads the repo's first existing config file, then selects
  // the preset out of it: `presets[name]`, or the whole config for the default preset.
  for (const file of presetConfigFiles) {
    const parsed = await fetchParsed(file);
    if (!parsed) continue;
    const name = loc.name ?? "default";
    const sub = parsed.presets?.[name];
    if (sub && typeof sub === "object") return sub;
    return loc.name ? null : parsed; // named-but-missing → skip; default → whole config
  }
  return null;
}

// Concatenate arrays (packageRules, ignoreDeps), let scalars from `over` win.
function mergeRenovate(base: RenovateConfig, over: RenovateConfig): RenovateConfig {
  const out: RenovateConfig = {...base};
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = Array.isArray(value) && Array.isArray(prev) ? [...prev, ...value] : value;
  }
  return out;
}

/**
 * Recursively resolve `extends` presets and merge them ahead of the config's own
 * fields (which take precedence), mirroring Renovate. Fetch failures are skipped
 * so an unreachable preset never blocks a build. `seen` is the current resolution
 * path (cloned per branch) so cycles are caught while diamonds still resolve on
 * each path, matching Renovate's path-scoped recursion.
 */
async function resolveExtends(
  cfg: RenovateConfig, fetchText: PresetFetcher, seen: Set<string>, depth: number,
): Promise<RenovateConfig> {
  let merged: RenovateConfig = {};
  const presets = Array.isArray(cfg.extends) ? cfg.extends : [];
  for (const preset of presets) {
    if (typeof preset !== "string" || depth >= maxPresetDepth || seen.has(preset)) continue;
    const loc = parsePreset(preset);
    if (!loc) continue;
    const raw = await fetchPresetConfig(loc, fetchText);
    if (raw) merged = mergeRenovate(merged, await resolveExtends(raw, fetchText, new Set(seen).add(preset), depth + 1));
  }
  const {extends: _extends, ...own} = cfg;
  return mergeRenovate(merged, own);
}

/** Options controlling the production preset fetcher, mirroring the CLI's cache/timeout flags. */
export type PresetFetchOptions = {noCache?: boolean, timeout?: number};

// Fallback only for direct API callers; the CLI always passes the resolved
// config.timeout (default 5000). Kept bounded so a hanging preset host can never
// stall startup the way a fixed 30s per candidate file did.
const defaultPresetTimeout = 10000;

/**
 * Build the production preset fetcher: ETag-revalidated, honoring `noCache` and
 * `timeout`. Any network or body-read failure falls back to the cached copy (or
 * null), so a preset fetch never throws into config loading.
 */
export function makePresetFetcher({noCache = false, timeout = defaultPresetTimeout}: PresetFetchOptions = {}): PresetFetcher {
  return async (url) => {
    const cached = noCache ? null : await getCache(url);
    const headers: Record<string, string> = {"user-agent": "updates"};
    if (cached) headers["if-none-match"] = cached.etag;
    let res: Response;
    try {
      res = await fetch(url, {headers, signal: AbortSignal.timeout(timeout)});
    } catch {
      return cached?.body ?? null; // offline / connect failure
    }
    if (res.status === 304 && cached) return cached.body;
    if (!res.ok) return cached?.body ?? null; // server error / rate-limit: prefer cache over dropping
    let body: string;
    try {
      body = await res.text();
    } catch {
      return cached?.body ?? null; // mid-stream abort/reset
    }
    const etag = res.headers.get("etag");
    if (etag && !noCache) setCache(url, etag, body);
    return body;
  };
}

type RenovateRaw = {parsed: RenovateConfig, path: string};

const findRenovateUp = memoizeAsync((startDir: string) => walkUp(startDir, async (dir): Promise<RenovateRaw | null> => {
  const found = await readFirstExisting(dir);
  if (!found) return null;
  let raw: unknown;
  try {
    raw = parseJsonish(found.text);
  } catch (err: any) {
    throw new Error(`Unable to parse renovate config ${found.path}: ${err.message}`);
  }
  if (!raw || typeof raw !== "object") return null;
  return {parsed: raw as RenovateConfig, path: found.path};
}));

// Resolving `extends` is network I/O, so memoize per config-file path: a monorepo
// whose packages share one renovate config resolves its presets once per process,
// mirroring findRenovateUp. `opts` (cooldown) is applied per call after the cache.
const resolvedExtendsCache = new Map<string, Promise<RenovateConfig>>();

export async function loadRenovateConfig(
  rootDir: string, opts: RenovateImportOptions = {}, fetchText: PresetFetcher = makePresetFetcher(),
): Promise<Partial<Config>> {
  const found = await findRenovateUp(rootDir);
  if (!found) return {};
  let resolved = resolvedExtendsCache.get(found.path);
  if (!resolved) {
    resolved = resolveExtends(found.parsed, fetchText, new Set(), 0);
    resolvedExtendsCache.set(found.path, resolved);
  }
  return normalize(await resolved, opts);
}
