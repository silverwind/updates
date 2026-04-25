import {join} from "node:path";
import {readFile} from "node:fs/promises";
import {parseJsonish} from "./json5.ts";
import {validRange} from "./semver.ts";
import type {Config} from "../config.ts";

const forgeDirs = [".github", ".gitea", ".gitlab"];

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
  minimumReleaseAge?: string;
  ignoreDeps?: Array<string>;
  packageRules?: Array<RenovatePackageRule>;
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
  for (const key of Object.keys(rule)) {
    if (key.startsWith("match") && key !== "matchPackageNames") return false;
  }
  return true;
}

async function readFirstExisting(rootDir: string): Promise<{path: string, text: string} | undefined> {
  for (const name of configFileNames) {
    const path = join(rootDir, ...name.split("/"));
    try {
      const text = await readFile(path, "utf8");
      return {path, text};
    } catch {}
  }
  try {
    const text = await readFile(join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    if (pkg && typeof pkg === "object" && pkg.renovate && typeof pkg.renovate === "object") {
      return {path: "package.json", text: JSON.stringify(pkg.renovate)};
    }
  } catch {}
  return undefined;
}

function normalize(raw: RenovateConfig): Partial<Config> {
  const out: Partial<Config> = {};

  if (typeof raw.minimumReleaseAge === "string") {
    const days = parseRenovateDuration(raw.minimumReleaseAge);
    if (days !== undefined && days > 0) out.cooldown = days;
  }

  const exclude: Array<string> = [];
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
        for (const name of names) exclude.push(name);
      }
      if (typeof rule.allowedVersions === "string" && validRange(rule.allowedVersions)) {
        for (const name of names) pin[name] = rule.allowedVersions;
      }
    }
  }

  if (exclude.length) out.exclude = exclude;
  if (Object.keys(pin).length) out.pin = pin;

  return out;
}

export async function loadRenovateConfig(rootDir: string): Promise<Partial<Config>> {
  const found = await readFirstExisting(rootDir);
  if (!found) return {};
  let raw: unknown;
  try {
    raw = parseJsonish(found.text);
  } catch (err: any) {
    throw new Error(`Unable to parse renovate config ${found.path}: ${err.message}`);
  }
  if (!raw || typeof raw !== "object") return {};
  return normalize(raw as RenovateConfig);
}
