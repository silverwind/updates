import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {accessSync} from "node:fs";
import type {ParseArgsOptionsConfig} from "node:util";
import {validRange} from "./utils/semver.ts";
import {commaSeparatedToArray, esc} from "./utils/utils.ts";
import {loadRenovateConfig} from "./utils/renovate.ts";

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

function globToRegex(glob: string, insensitive: boolean): RegExp {
  return new RegExp(`^${esc(glob).replaceAll("\\*", ".*")}$`, insensitive ? "i" : "");
}

function argToRegex(arg: string | RegExp, cli: boolean, insensitive: boolean): RegExp {
  if (cli && typeof arg === "string") {
    return /^\/.+\/$/.test(arg) ? new RegExp(arg.slice(1, -1)) : globToRegex(arg, insensitive);
  } else {
    return arg instanceof RegExp ? arg : globToRegex(arg, insensitive);
  }
}

export function parseMixedArg(arg: Arg): boolean | Set<string> {
  if (Array.isArray(arg) && arg.every(a => a === true)) {
    return true;
  } else if (Array.isArray(arg)) {
    return new Set(arg.flatMap(val => {
      return typeof val === "string" ? commaSeparatedToArray(val) : "";
    }).filter(Boolean));
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
    if (key === name) return key;
    if (short === name) return key;
  }
  return "";
}

export function patternsToRegexSet(patterns: Array<string | RegExp>): Set<RegExp> {
  return new Set(patterns.map(p => argToRegex(p, false, true)));
}

export function parseArgList(arg: Arg): Array<string> {
  if (Array.isArray(arg)) {
    return arg.filter(v => typeof v === "string").flatMap(item => commaSeparatedToArray(item));
  }
  return [];
}

export function parsePinArg(arg: Arg): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(arg)) {
    for (const val of arg) {
      if (typeof val === "string") {
        const [pkg, range] = val.split("=", 2);
        if (pkg && range && validRange(range)) {
          result[pkg] = range;
        }
      }
    }
  } else if (typeof arg === "string") {
    const [pkg, range] = arg.split("=", 2);
    if (pkg && range && validRange(range)) {
      result[pkg] = range;
    }
  }
  return result;
}

export function configMixedToRegexes(val: boolean | Array<string | RegExp> | undefined): Set<RegExp> | boolean {
  if (typeof val === "boolean") return val;
  if (!Array.isArray(val) || !val.length) return false;
  const ret = new Set<RegExp>();
  for (const entry of val) {
    ret.add(argToRegex(entry, false, false));
  }
  return ret;
}

export async function loadConfig(rootDir: string): Promise<Config> {
  const filenames: Array<string> = [];
  for (const ext of ["js", "ts", "mjs", "mts"]) {
    filenames.push(`updates.config.${ext}`);
  }
  const renovateConfig = await loadRenovateConfig(rootDir);
  let config: Config = {};

  try {
    ({default: config} = await Promise.any(filenames.map(async (filename) => {
      const fullPath = join(rootDir, ...filename.split("/"));
      const fileUrl = pathToFileURL(fullPath);

      try {
        accessSync(fullPath);
      } catch {
        throw new Error(`File not found: ${filename}`);
      }

      try {
        return await import(fileUrl.href);
      } catch (err: any) {
        throw new Error(`Unable to parse config file ${filename}: ${err.message}`);
      }
    })));
  } catch (err) {
    if (err instanceof AggregateError) {
      const parseErrors = err.errors.filter((e: Error) => e.message.startsWith("Unable to parse"));
      if (parseErrors.length > 0) {
        throw parseErrors[0];
      }
    }
  }

  return {...renovateConfig, ...config};
}
