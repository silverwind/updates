import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {access} from "node:fs/promises";
import type {ParseArgsOptionsConfig} from "node:util";
import {validRange} from "./utils/semver.ts";
import {commaSeparatedToArray, patternToRegex, walkUp, memoizeAsync} from "./utils/utils.ts";
import type {PresetFetchOptions, RenovateImportOptions} from "./utils/renovate.ts";

export type Config = {
  /** Array of dependencies to include */
  include?: Array<string | RegExp>;
  /** Array of dependencies to exclude */
  exclude?: Array<string | RegExp>;
  /** Array of package types to use */
  types?: Array<string>;
  /** URL to npm registry */
  registry?: string;
  /** Minimum dependency age, e.g. 7 (days), "1w", "2d", "6h" */
  cooldown?: number | string;
  /** Pin dependencies to semver ranges */
  pin?: Record<string, string>;
  /**
   * @internal Not a user option. Set by the renovate importer for the `pin` entries that came
   * from `allowedVersions`, which filter but never downgrade. The importer marks the whole map
   * with `true`, loadConfig narrows it to the names renovate still owns, and only the
   * per-directory config is ever read.
   */
  pinNoDowngrade?: boolean | Array<string>;
  /** File or directory paths to use */
  files?: Array<string>;
  /** Which modes to enable */
  modes?: Array<string>;
  /** Update versions and write dependency files */
  update?: boolean;
  /** Include indirect Go dependencies */
  indirect?: boolean;
  /** Output a JSON object */
  json?: boolean;
  /** Print verbose output to stderr */
  verbose?: boolean;
  /** Exit with code 2 when updates are available */
  errorOnOutdated?: boolean;
  /** Exit with code 0 when updates are available and 2 when not */
  errorOnUnchanged?: boolean;
  /** Force color output */
  color?: boolean;
  /** Disable color output */
  noColor?: boolean;
  /** Disable HTTP cache */
  noCache?: boolean;
  /** Network request timeout in ms */
  timeout?: number;
  /** Maximum number of parallel HTTP sockets */
  sockets?: number;
  /** Prefer greatest over latest version */
  greatest?: boolean | Array<string | RegExp>;
  /** Consider prerelease versions */
  prerelease?: boolean | Array<string | RegExp>;
  /** Only use release versions, may downgrade */
  release?: boolean | Array<string | RegExp>;
  /** Consider only up to semver-patch */
  patch?: boolean | Array<string | RegExp>;
  /** Consider only up to semver-minor */
  minor?: boolean | Array<string | RegExp>;
  /** Allow version downgrades when using latest version */
  allowDowngrade?: boolean | Array<string | RegExp>;
  /** Per-package option overrides, matched by name; last matching override wins */
  overrides?: Array<Override>;
  /** Opt-in to inheriting select fields from other tools' configs */
  inherit?: {renovate?: RenovateImportOptions};
};

/** Options applied to dependencies whose name matches an override's patterns. */
export type Override = {
  /** Name patterns this override applies to (glob or RegExp). Omit to match all. */
  include?: Array<string | RegExp>;
  /** Name patterns excluded from this override */
  exclude?: Array<string | RegExp>;
  /** Minimum dependency age, e.g. 7 (days), "1w", "2d", "6h"; 0 disables a global cooldown */
  cooldown?: number | string;
  /** Prefer greatest over latest version */
  greatest?: boolean;
  /** Consider prerelease versions */
  prerelease?: boolean;
  /** Only use release versions, may downgrade */
  release?: boolean;
  /** Consider only up to semver-patch */
  patch?: boolean;
  /** Consider only up to semver-minor */
  minor?: boolean;
  /** Allow version downgrades when using latest version */
  allowDowngrade?: boolean;
};

export type Arg = string | boolean | Array<string | boolean> | undefined;

export const options: ParseArgsOptionsConfig = {
  "allow-downgrade": {short: "d", type: "string", multiple: true},
  "error-on-outdated": {short: "E", type: "boolean"},
  "error-on-unchanged": {short: "U", type: "boolean"},
  "exclude": {short: "e", type: "string", multiple: true},
  "file": {short: "f", type: "string", multiple: true},
  "forgeapi": {type: "string"}, // undocumented, only for tests
  "goproxy": {type: "string"}, // undocumented, only for tests
  "cargoapi": {type: "string"}, // undocumented, only for tests
  "dockerapi": {type: "string"}, // undocumented, only for tests
  "greatest": {short: "g", type: "string", multiple: true},
  "help": {short: "h", type: "boolean"},
  "include": {short: "i", type: "string", multiple: true},
  "indirect": {short: "I", type: "boolean"},
  "json": {short: "j", type: "boolean"},
  "jsrapi": {type: "string"}, // undocumented, only for tests
  "cooldown": {short: "C", type: "string"},
  "minor": {short: "m", type: "string", multiple: true},
  "modes": {short: "M", type: "string", multiple: true},
  "color": {short: "c", type: "boolean"},
  "no-cache": {short: "x", type: "boolean"},
  "no-color": {short: "n", type: "boolean"},
  "patch": {short: "P", type: "string", multiple: true},
  "pin": {short: "l", type: "string", multiple: true},
  "prerelease": {short: "p", type: "string", multiple: true},
  "pypiapi": {type: "string"}, // undocumented, only for tests
  "registry": {short: "r", type: "string"},
  "release": {short: "R", type: "string", multiple: true},
  "sockets": {short: "s", type: "string"},
  "timeout": {short: "T", type: "string"},
  "types": {short: "t", type: "string", multiple: true},
  "update": {short: "u", type: "boolean"},
  "verbose": {short: "V", type: "boolean"},
  "version": {short: "v", type: "boolean"},
};

export function parseMixedArg(arg: Arg): boolean | Set<string> {
  if (Array.isArray(arg) && arg.every(a => a === true)) {
    return true;
  } else if (Array.isArray(arg)) {
    return new Set(arg.filter(val => typeof val === "string").flatMap(commaSeparatedToArray));
  } else if (typeof arg === "string") {
    return new Set([arg]);
  } else if (typeof arg === "boolean") {
    return arg;
  } else {
    return false;
  }
}

export function getOptionKey(name: string): string {
  for (const [key, {short}] of Object.entries(options)) {
    if (key === name || short === name) return key;
  }
  return "";
}

export function patternsToRegexSet(patterns: Array<string | RegExp>): Set<RegExp> {
  return new Set(patterns.map(patternToRegex));
}

export function parseArgList(arg: Arg): Array<string> {
  if (Array.isArray(arg)) {
    return arg.filter(v => typeof v === "string").flatMap(commaSeparatedToArray);
  }
  return [];
}

// An unparsable range satisfies nothing, so dropping it would either discard the pin or freeze the
// dependency forever. Renovate likewise rejects an allowedVersions it cannot parse.
export function validatePin(pin: Config["pin"]): void {
  for (const [pkg, range] of Object.entries(pin ?? {})) {
    if (!validRange(range)) throw new Error(`Invalid pin range for ${pkg}: ${range}`);
  }
}

export function parsePinArg(arg: Arg): Record<string, string> {
  const result: Record<string, string> = {};
  for (const val of Array.isArray(arg) ? arg : [arg]) {
    if (typeof val !== "string") continue; // a flag recovered from a swallowed value arrives as `true`
    const eq = val.indexOf("=");
    if (eq < 1) throw new Error(`Invalid pin: ${val}, expected <dep>=<range>`);
    result[val.slice(0, eq)] = val.slice(eq + 1);
  }
  validatePin(result);
  return result;
}

export function configMixedToRegexes(val: boolean | Array<string | RegExp> | undefined): Set<RegExp> | boolean {
  if (typeof val === "boolean") return val;
  if (!Array.isArray(val) || !val.length) return false;
  return patternsToRegexSet(val);
}

type FoundConfig = {configDir: string, default: Config};

// Try to load any updates.config.* in dir. Returns the first that imports
// successfully. If none imports but at least one parsed-and-failed, throws
// the first parse error so a broken sibling next to a valid one does not
// block the valid one.
async function tryLoadInDir(dir: string): Promise<FoundConfig | null> {
  const exts = ["js", "ts", "mjs", "mts"];
  const results = await Promise.all(exts.map(async (ext): Promise<FoundConfig | Error | null> => {
    const filename = `updates.config.${ext}`;
    const fullPath = join(dir, filename);
    try {
      await access(fullPath);
    } catch {
      return null;
    }
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      return {configDir: dir, default: mod.default ?? {}};
    } catch (err: any) {
      return new Error(`Unable to parse config file ${filename}: ${err?.message ?? err}`);
    }
  }));
  for (const r of results) if (r && !(r instanceof Error)) return r;
  for (const r of results) if (r instanceof Error) throw r;
  return null;
}

const findConfigUp = memoizeAsync((startDir: string) => walkUp(startDir, tryLoadInDir));

export async function loadConfig(startDir: string, presetFetch: PresetFetchOptions = {}): Promise<Config> {
  const found = await findConfigUp(startDir);
  const raw: Config = found?.default ?? {};
  const {loadRenovateConfig, makePresetFetcher} = await import("./utils/renovate.ts");
  const fetchText = makePresetFetcher(presetFetch);
  const renovateConfig = await loadRenovateConfig(found?.configDir ?? startDir, raw.inherit?.renovate, fetchText);
  const config: Config = {...renovateConfig, ...raw};
  // `pin` merges per key, so an authored pin for one dependency keeps the ceilings inherited for
  // the others. An authored entry may downgrade, so the marker keeps only the names renovate owns.
  if (renovateConfig.pin) {
    config.pin = {...renovateConfig.pin, ...raw.pin};
    config.pinNoDowngrade = Object.keys(renovateConfig.pin).filter(name => !raw.pin?.[name]);
  }
  validatePin(config.pin);
  return config;
}
