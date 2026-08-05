import {join} from "node:path";
import {readFile} from "node:fs/promises";
import {parseJsonish} from "./json5.ts";
import {validRange} from "./semver.ts";
import {walkUp, memoizeAsync, forgeDirs, getOrSet, patternToRegex} from "./utils.ts";
import {getCache, setCache} from "./fetchCache.ts";
import type {Config} from "../config.ts";

// Renovate also reads .gitlab, which has no workflow files and so is absent from the actions list.
const renovateDirs = [...forgeDirs, ".gitlab"];

const configFileNames = [
  "renovate.json",
  "renovate.jsonc",
  "renovate.json5",
  ...renovateDirs.flatMap(dir => [`${dir}/renovate.json`, `${dir}/renovate.jsonc`, `${dir}/renovate.json5`]),
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
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
  extends?: Array<string> | string;
  enabled?: boolean;
  minimumReleaseAge?: string;
  ignoreDeps?: Array<string>;
  packageRules?: Array<RenovatePackageRule>;
  [key: string]: unknown;
};

type RenovatePackageRule = {
  enabled?: boolean;
  allowedVersions?: string;
  [key: string]: unknown;
};

type Matcher = string | RegExp;

function warn(message: string): void {
  console.error(`renovate config: ${message}`);
}

// Deprecated spellings renovate still migrates into matchPackageNames. A prefix is minimatch
// `foo{/,}**`, which is updates' `foo*`.
const packageNameKeys: Record<string, (value: string) => string> = {
  matchPackageNames: name => name,
  packageNames: name => name,
  matchPackagePatterns: pattern => pattern === "*" ? "*" : `/${pattern}/`,
  packagePatterns: pattern => pattern === "*" ? "*" : `/${pattern}/`,
  matchPackagePrefixes: prefix => `${prefix}*`,
  excludePackageNames: name => `!${name}`,
  excludePackagePatterns: pattern => `!/${pattern}/`,
  excludePackagePrefixes: prefix => `!${prefix}*`,
};

// Matchers that migrate to something other than matchPackageNames and lack a match/exclude prefix.
const legacyMatcherKeys = ["updateTypes", "managers", "datasources", "depTypeList", "paths", "languages", "baseBranchList", "sourceUrlPrefixes"];

// Renovate's `*` matches everything (lib/util/string-match.ts), as does minimatch `**`.
const catchAllNames = new Set(["*", "**"]);

// The name patterns a packageRule matches on, `[]` when it has no matcher at all (renovate then
// applies it to every dependency), or the matcher key that cannot be mapped, either because it
// matches on something else or because its value is not a list of names.
function ruleNames(rule: RenovatePackageRule): Array<string> | string {
  const names: Array<string> = [];
  for (const [key, value] of Object.entries(rule)) {
    // Object.hasOwn, not `in`: `in` matches inherited keys like __proto__/constructor.
    const toName = Object.hasOwn(packageNameKeys, key) ? packageNameKeys[key] : undefined;
    if (!toName) {
      if (key.startsWith("match") || key.startsWith("exclude") || legacyMatcherKeys.includes(key)) return key;
      continue;
    }
    const list = typeof value === "string" ? [value] : value; // renovate allowString
    if (!Array.isArray(list)) return key;
    for (const entry of list) {
      if (typeof entry !== "string" || !entry) return key;
      names.push(toName(entry));
    }
  }
  return names;
}

// Renovate matchers negate with a leading `!`, and a rule applies when one positive and every
// negative matches.
function splitNames(names: Array<string>): {positive: Array<string>, negated: Array<string>} {
  const groups = Object.groupBy(names, name => name.startsWith("!") && name.length > 1 ? "negated" : "positive");
  return {positive: groups.positive ?? [], negated: groups.negated?.map(name => name.substring(1)) ?? []};
}

// Renovate compares matchers by value, so two identical /pattern/flags are the same matcher.
function sameMatcher(a: Matcher, b: Matcher): boolean {
  return a instanceof RegExp && b instanceof RegExp ? a.source === b.source && a.flags === b.flags : a === b;
}

// Candidates are read concurrently rather than one await at a time — the common
// case is a directory holding none of them, and `find` still honors the priority
// order of configFileNames.
async function readFirstExisting(rootDir: string): Promise<{path: string, text: string} | undefined> {
  const reads = await Promise.all(configFileNames.map(async name => {
    const path = join(rootDir, ...name.split("/"));
    try {
      return {path, text: await readFile(path, "utf8")};
    } catch {
      return null;
    }
  }));
  const found = reads.find(read => read !== null);
  if (found) return found;

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

// Apply the packageRules in order, as renovate does: a matching rule disables or re-enables what it
// matches and the last match wins. `allowed` becomes non-null once a rule disables everything,
// turning the remainder into an allow-list. A rule needing an and-not is skipped, not approximated.
function applyRules(rules: Array<RenovatePackageRule>): {allowed: Array<Matcher> | null, disabled: Array<Matcher>, pin: Record<string, string>} {
  let allowed: Array<Matcher> | null = null;
  let disabled: Array<Matcher> = [];
  const pin: Record<string, string> = {};

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const names = ruleNames(rule);
    if (!Array.isArray(names)) {
      // only worth naming a rule updates would otherwise have imported something from
      if (rule.enabled !== undefined || typeof rule.allowedVersions === "string") {
        warn(`skipping packageRule with unsupported matcher ${names}`);
      }
      continue;
    }
    const {positive, negated} = splitNames(names);

    if (rule.enabled === false) {
      if (positive.length && negated.length) {
        warn(`skipping packageRule mixing matchers and negations: ${names.join(", ")}`);
      } else if (!names.length || positive.some(name => catchAllNames.has(name))) {
        allowed = []; // disables everything, until a later rule re-enables names
      } else if (!positive.length) {
        if (allowed === null) allowed = negated.map(toMatcher); // all-negated leaves an allow-list
        else if (allowed.length) warn(`skipping packageRule narrowing an allow-list: ${names.join(", ")}`);
      } else {
        for (const name of positive) disabled.push(toMatcher(name));
      }
    } else if (rule.enabled === true && (allowed !== null || disabled.length)) {
      if (!names.length) {
        allowed = null; // re-enables every dependency
        disabled = [];
      } else if (negated.length || !positive.length) {
        warn(`skipping packageRule re-enabling by negation: ${names.join(", ")}`);
      } else {
        for (const name of positive) {
          const matcher = toMatcher(name);
          const kept = disabled.filter(entry => !sameMatcher(entry, matcher));
          // an exclude the name only partly overlaps cannot be punched a hole in
          if (kept.length === disabled.length && disabled.some(entry => patternToRegex(entry).test(name))) {
            warn(`packageRule re-enables ${name}, which a wider exclude keeps disabled`);
          }
          disabled = kept;
          allowed?.push(matcher);
        }
      }
    }

    if (typeof rule.allowedVersions === "string" && validRange(rule.allowedVersions)) {
      // Renovate applies allowedVersions as a ceiling on releases already newer than the current
      // one, so it never rolls a dependency back, unlike a pin the authored version violates
      // (findVersion in modes/shared.ts). Only literal names can pin.
      for (const name of positive) {
        if (!isGlob(name) && typeof toMatcher(name) === "string") pin[name] = rule.allowedVersions;
      }
    }
  }

  return {allowed, disabled, pin};
}

function normalize(raw: RenovateConfig, opts: RenovateImportOptions): Partial<Config> {
  // renovate skips a repository whose config disables it (lib/workers/repository/configured.ts)
  if (raw.enabled === false) {
    warn("enabled is false, skipping all dependencies");
    return {exclude: ["*"]};
  }

  const out: Partial<Config> = {};

  if (opts.cooldown && typeof raw.minimumReleaseAge === "string") {
    const days = parseRenovateDuration(raw.minimumReleaseAge);
    if (days !== undefined && days > 0) out.cooldown = days;
  }

  // no `enabled: true` rule clears ignoreDeps, so it stays out of applyRules and merges at the end
  const ignored: Array<Matcher> = Array.isArray(raw.ignoreDeps) ?
    raw.ignoreDeps.filter(dep => typeof dep === "string" && Boolean(dep)) : [];
  const {allowed, disabled, pin} = applyRules(Array.isArray(raw.packageRules) ? raw.packageRules : []);

  const exclude = [...ignored, ...disabled];
  if (allowed?.length) out.include = allowed;
  if (allowed && !allowed.length) exclude.push("*"); // everything disabled, nothing re-enabled
  if (exclude.length) out.exclude = exclude;
  if (Object.keys(pin).length) {
    out.pin = pin;
    out.pinNoDowngrade = true;
  }

  return out;
}

// Fetch a preset file as text, or null if it does not exist. Throws when the host cannot be reached,
// which renovate also treats as fatal rather than as an empty preset. Injectable for tests.
export type PresetFetcher = (url: string) => Promise<string | null>;

// Forge presets resolve against a fixed public endpoint (as Renovate does): the
// host is never part of the `forge>` string. gitea>/forgejo> point at gitea.com /
// code.forgejo.org, matching Renovate's default endpoints. A self-hosted instance
// is reached instead via an `http` preset (a full raw URL). local> needs the
// running platform and built-in presets (config:, :x, helpers:, …) have no URL;
// both are skipped.
const forgeRawUrl: Record<string, (slug: string, ref: string, file: string) => string> = {
  github: (slug, ref, file) => `https://raw.githubusercontent.com/${slug}/${ref}/${file}`,
  gitlab: (slug, ref, file) => `https://gitlab.com/${slug}/-/raw/${ref}/${file}`,
  gitea: (slug, ref, file) => `https://gitea.com/api/v1/repos/${slug}/raw/${file}?ref=${ref}`,
  forgejo: (slug, ref, file) => `https://code.forgejo.org/api/v1/repos/${slug}/raw/${file}?ref=${ref}`,
};

const maxPresetDepth = 10;

type PresetLocation =
  {kind: "forge", forge: string, slug: string, ref: string, name?: string, subpath?: string} |
  {kind: "http", url: string};

/**
 * Parse a Renovate preset reference into a fetchable location, or null if it is
 * a built-in or otherwise unresolvable preset. Handles a full `http(s)://` URL,
 * `forge>owner/repo`, `:preset` names, `//path` subpaths, `#ref` refs and
 * `(params)` (params ignored).
 */
function parsePreset(preset: string): PresetLocation | null {
  if (/^https?:\/\//i.test(preset)) return {kind: "http", url: preset}; // custom-FQDN raw preset file
  const gt = preset.indexOf(">");
  if (gt === -1) return null; // built-in preset, no URL
  const forge = preset.slice(0, gt);
  // Object.hasOwn, not `in`: `in` matches inherited keys like __proto__/constructor.
  if (!Object.hasOwn(forgeRawUrl, forge)) return null; // local>, unknown forge
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
  return {kind: "forge", forge, slug, ref, name, subpath};
}

// Repo config files Renovate probes, in order, to locate a preset's source.
const presetConfigFiles = ["default.json", "default.json5", "renovate.json", "renovate.json5", ".renovaterc.json", ".renovaterc"];

// Renovate takes .json, .json5 and .jsonc as explicit extensions and appends .json otherwise.
// .json5 is probed too, as the repo config file list already does.
function presetFiles(file: string): Array<string> {
  return /\.json[5c]?$/.test(file) ? [file] : [`${file}.json`, `${file}.json5`];
}

// A missing file is null and left to the caller, an unparseable one is fatal as renovate's PRESET_INVALID_JSON.
function parsePresetBody(body: string | null, url: string): RenovateConfig | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonish(body);
  } catch {
    throw new Error(`invalid JSON in ${url}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid preset in ${url}`);
  return parsed as RenovateConfig;
}

async function fetchPresetConfig(loc: PresetLocation, fetchText: PresetFetcher): Promise<RenovateConfig | null> {
  // An `http` preset is a full URL to a single file; the whole document is the preset.
  if (loc.kind === "http") return parsePresetBody(await fetchText(loc.url), loc.url);

  const build = forgeRawUrl[loc.forge];
  const firstExisting = async (files: Array<string>) => {
    for (const file of files) {
      const url = build(loc.slug, loc.ref, file);
      const parsed = parsePresetBody(await fetchText(url), url);
      if (parsed) return parsed;
    }
    return null;
  };

  // An explicit `//path` points straight at a file.
  if (loc.subpath) return firstExisting(presetFiles(loc.subpath));
  if (!loc.name) return firstExisting(presetConfigFiles);

  // A named preset is `file[/key[/subkey]]` inside the repo, so `:npm` is npm.json and `:file/key`
  // is that key of file.json. There is no `presets` map for forge presets, that is npm-preset only.
  const [file, ...keys] = loc.name.split("/");
  let preset = await firstExisting(presetFiles(file));
  for (const key of keys) {
    const sub = preset && Object.hasOwn(preset, key) ? preset[key] : undefined;
    if (!sub || typeof sub !== "object") throw new Error(`no preset ${key} in ${file}`);
    preset = sub as RenovateConfig;
  }
  return preset;
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
 * Recursively resolve `extends` presets and merge them ahead of the config's own fields (which
 * take precedence), mirroring Renovate. A preset that cannot be resolved is fatal, like
 * Renovate's CONFIG_VALIDATION, so an unreachable or private preset never silently drops the
 * restrictions it carries. `seen` is the current resolution path (cloned per branch) so cycles
 * are caught while diamonds still resolve on each path, matching Renovate's path-scoped recursion.
 */
async function resolveExtends(
  cfg: RenovateConfig, fetchText: PresetFetcher, seen: Set<string>, depth: number,
): Promise<RenovateConfig> {
  let merged: RenovateConfig = {};
  // renovate declares extends as allowString and massages it into an array (lib/config/massage.ts)
  const presets = typeof cfg.extends === "string" ? [cfg.extends] : Array.isArray(cfg.extends) ? cfg.extends : [];
  for (const preset of presets) {
    if (typeof preset !== "string" || depth >= maxPresetDepth || seen.has(preset)) continue;
    const loc = parsePreset(preset);
    if (!loc) continue;
    let raw: RenovateConfig | null;
    try {
      raw = await fetchPresetConfig(loc, fetchText);
    } catch (err: any) {
      throw new Error(`Unable to resolve renovate preset ${preset}: ${err.message}`);
    }
    if (!raw) throw new Error(`Unable to resolve renovate preset ${preset}: not found`);
    merged = mergeRenovate(merged, await resolveExtends(raw, fetchText, new Set(seen).add(preset), depth + 1));
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

// Build request headers (shared user-agent/encoding via getFetchOpts) plus a host
// token for private presets, matching Renovate's hostRules model. Reuses updates'
// token resolution (UPDATES_FORGE_TOKENS per host, plus GitHub env/`gh` tokens),
// imported lazily so config loads without presets pull in nothing.
async function presetHeaders(url: string, etag?: string): Promise<Record<string, string>> {
  const {getForgeTokens, getFetchOpts, githubApiUrl, urlHost} = await import("../modes/shared.ts");
  const host = urlHost(url);
  const [token] = host ? await getForgeTokens(host, githubApiUrl) : [];
  const headers = {...getFetchOpts("Bearer", token).headers} as Record<string, string>;
  if (etag) headers["if-none-match"] = etag;
  return headers;
}

/**
 * Build the production preset fetcher: ETag-revalidated, honoring `noCache` and `timeout`,
 * sending a host token when one is configured. Only a 404 is a missing file; a cached copy
 * answers anything else that goes wrong, and without one the failure is thrown so a preset
 * outage cannot pass for an empty preset.
 */
export function makePresetFetcher({noCache = false, timeout = defaultPresetTimeout}: PresetFetchOptions = {}): PresetFetcher {
  return async (url) => {
    const cached = noCache ? null : await getCache(url);
    const headers = await presetHeaders(url, cached?.etag);
    let res: Response;
    try {
      res = await fetch(url, {headers, signal: AbortSignal.timeout(timeout)});
    } catch (err: any) {
      if (cached) return cached.body;
      throw new Error(`${url}: ${err.message}`); // offline / connect failure / timeout
    }
    if (res.status === 304 && cached) return cached.body;
    if (res.status === 404) return null; // file is absent, the caller may have another candidate
    if (!res.ok) {
      if (cached) return cached.body;
      throw new Error(`${url}: HTTP ${res.status}`); // server error / rate-limit / private repo
    }
    let body: string;
    try {
      body = await res.text();
    } catch (err: any) {
      if (cached) return cached.body;
      throw new Error(`${url}: ${err.message}`); // mid-stream abort/reset
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

// Both keyed by config-file path, as loadRenovateConfig runs once per manifest directory and a
// monorepo shares one config across them, where resolving `extends` is network I/O and normalizing
// warns once per rule it cannot import. Callers spread the result rather than mutate it.
const resolvedExtendsCache = new Map<string, Promise<RenovateConfig>>();
const normalizedCache = new Map<string, Promise<Partial<Config>>>();

export async function loadRenovateConfig(
  rootDir: string, opts: RenovateImportOptions = {}, fetchText: PresetFetcher = makePresetFetcher(),
): Promise<Partial<Config>> {
  const found = await findRenovateUp(rootDir);
  if (!found) return {};
  const resolved = getOrSet(resolvedExtendsCache, found.path, () => resolveExtends(found.parsed, fetchText, new Set(), 0));
  return getOrSet(normalizedCache, `${opts.cooldown ? 1 : 0}${found.path}`, async () => normalize(await resolved, opts));
}
