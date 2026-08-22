import {join} from "node:path";
import {readFile} from "node:fs/promises";
import {parseJsonish} from "./json5.ts";
import {validRange} from "./semver.ts";
import {walkUp, patternToRegex, esc, getOrSet} from "./utils.ts";
import type {Config} from "../config.ts";

const durationUnits: Record<string, number> = {
  y: 365, year: 365, years: 365,
  mo: 30, month: 30, months: 30,
  w: 7, week: 7, weeks: 7,
  d: 1, day: 1, days: 1,
  h: 1 / 24, hour: 1 / 24, hours: 1 / 24,
  min: 1 / 1440, minute: 1 / 1440, minutes: 1 / 1440,
  s: 1 / 86400, second: 1 / 86400, seconds: 1 / 86400,
};

function parseRenovateDuration(str: string): number | undefined {
  let total: number | undefined;
  for (const match of str.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const multiplier = durationUnits[match[2].toLowerCase()];
    if (multiplier === undefined) return undefined;
    total = (total ?? 0) + Number(match[1]) * multiplier;
  }
  return total;
}

type RenovateConfig = {
  enabled?: boolean;
  minimumReleaseAge?: string;
  ignoreDeps?: Array<string>;
  packageRules?: Array<RenovatePackageRule>;
  [key: string]: unknown;
};

type RenovatePackageRule = {
  enabled?: boolean;
  allowedVersions?: string;
  minimumReleaseAge?: string;
  [key: string]: unknown;
};

export type Matcher = string | RegExp;

type MatcherTarget = "package" | "dep";

const packageNameKeys: Record<string, {target: MatcherTarget, convert: (value: string) => string}> = {
  packageName: {target: "package", convert: name => name},
  packagePattern: {target: "package", convert: pattern => pattern === "*" ? "*" : `/${pattern}/`},
  matchPackageNames: {target: "package", convert: name => name},
  packageNames: {target: "package", convert: name => name},
  matchPackagePatterns: {target: "package", convert: pattern => pattern === "*" ? "*" : `/${pattern}/`},
  packagePatterns: {target: "package", convert: pattern => pattern === "*" ? "*" : `/${pattern}/`},
  matchPackagePrefixes: {target: "package", convert: prefix => `${prefix}{/,}**`},
  excludePackageNames: {target: "package", convert: name => `!${name}`},
  excludedPackageNames: {target: "package", convert: name => `!${name}`},
  excludePackagePatterns: {target: "package", convert: pattern => `!/${pattern}/`},
  excludePackagePrefixes: {target: "package", convert: prefix => `!${prefix}{/,}**`},
  matchDepNames: {target: "dep", convert: name => name},
  matchDepPatterns: {target: "dep", convert: pattern => `/${pattern}/`},
  matchDepPrefixes: {target: "dep", convert: prefix => `${prefix}{/,}**`},
  excludeDepNames: {target: "dep", convert: name => `!${name}`},
  excludeDepPatterns: {target: "dep", convert: pattern => `!/${pattern}/`},
  excludeDepPrefixes: {target: "dep", convert: prefix => `!${prefix}{/,}**`},
};

const legacyMatcherKeys = new Set([
  "updateTypes", "managers", "datasources", "depTypeList", "paths", "languages", "baseBranchList",
  "sourceUrlPrefixes", "matchFiles", "matchPaths",
]);

function compileRule(rule: RenovatePackageRule): {matchers: RenovateVersionRule, literals: Array<string>} | undefined {
  const names = {Package: [] as Array<string>, Dep: [] as Array<string>};
  for (const [key, value] of Object.entries(rule)) {
    const matcher = Object.hasOwn(packageNameKeys, key) ? packageNameKeys[key] : undefined;
    if (!matcher) {
      if (key.startsWith("match") || key.startsWith("exclude") || legacyMatcherKeys.has(key)) return undefined;
      continue;
    }
    const list = typeof value === "string" || key === "packageName" || key === "packagePattern" ? [value] : value;
    if (!Array.isArray(list)) return undefined;
    for (const entry of list) {
      if (typeof entry !== "string" || !entry) return undefined;
      names[matcher.target === "package" ? "Package" : "Dep"].push(matcher.convert(entry));
    }
  }
  const matchers: RenovateVersionRule = {};
  const literals: Array<string> = [];
  for (const [target, values] of Object.entries(names) as Array<["Package" | "Dep", Array<string>]>) {
    const include: Array<Matcher> = [];
    const exclude: Array<Matcher> = [];
    for (const name of values) {
      const list = name.startsWith("!") ? exclude : include;
      const value = list === exclude ? name.slice(1) : name;
      const regex = renovateRegex(value);
      list.push(regex ?? value);
      if (list === include && !/[*?[\]{}!()|+]/.test(value) && !regex) literals.push(value);
    }
    if (include.length) matchers[`match${target}Names`] = include;
    if (exclude.length) matchers[`exclude${target}Names`] = exclude;
  }
  return {matchers, literals};
}

function renovateRegex(value: string): RegExp | undefined {
  const match = /^!?\/(.*)\/(i?)$/.exec(value);
  if (!match) return undefined;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return undefined;
  }
}

export type RenovateImportOptions = {cooldown?: boolean};

export type RenovateVersionRule = {
  matchPackageNames?: Array<Matcher>;
  excludePackageNames?: Array<Matcher>;
  matchDepNames?: Array<Matcher>;
  excludeDepNames?: Array<Matcher>;
  allowedVersions?: string;
  cooldownDays?: number;
};

const matcherRegexes = new Map<Matcher, RegExp>();
const matcherRegex = (pattern: Matcher) => getOrSet(matcherRegexes, pattern, () => patternToRegex(pattern));

const matchesRuleList = (value: string, include?: Array<Matcher>, exclude?: Array<Matcher>) =>
  (!include?.length || include.some(pattern => matcherRegex(pattern).test(value))) &&
  (!exclude?.length || exclude.every(pattern => !matcherRegex(pattern).test(value)));

export function matchesRenovateRule(rule: RenovateVersionRule, packageName: string, depName: string): boolean {
  return matchesRuleList(packageName, rule.matchPackageNames, rule.excludePackageNames) &&
    matchesRuleList(depName, rule.matchDepNames, rule.excludeDepNames);
}

const nameMatcherTests = new WeakMap<RegExp, (packageName: string, depName: string) => boolean>();

class RenovateNameMatcher extends RegExp {
  constructor(source: string, predicate: (packageName: string, depName: string) => boolean) {
    super(source);
    nameMatcherTests.set(this, predicate);
  }

  testNames(packageName: string, depName: string): boolean {
    return nameMatcherTests.get(this)!(packageName, depName);
  }

  override test(name: string): boolean {
    return this.testNames(name, name);
  }
}

export function testRenovateMatcher(matcher: RegExp, value: string, packageName: string, depName: string): boolean {
  return matcher instanceof RenovateNameMatcher ? matcher.testNames(packageName, depName) : matcher.test(value);
}

function applyRules(rules: Array<RenovatePackageRule>, inheritCooldown: boolean): {
  disabled?: RegExp, pin: Record<string, string>, versionRules: Array<RenovateVersionRule>
} {
  const enabledRules: Array<{enabled: boolean, matchers: RenovateVersionRule}> = [];
  const pin: Record<string, string> = {};
  const pinCandidates = new Set<string>();
  const versionRules: Array<RenovateVersionRule> = [];

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const compiled = compileRule(rule);
    if (!compiled) continue;
    const {matchers, literals} = compiled;
    if (typeof rule.enabled === "boolean") enabledRules.push({enabled: rule.enabled, matchers});
    const versionRule: RenovateVersionRule = {...matchers};

    if (inheritCooldown && typeof rule.minimumReleaseAge === "string") {
      const days = parseRenovateDuration(rule.minimumReleaseAge);
      if (days !== undefined) versionRule.cooldownDays = days;
    }

    if (typeof rule.allowedVersions === "string") {
      const allowedRange = validRange(rule.allowedVersions);
      if (!allowedRange && !renovateRegex(rule.allowedVersions)) {
        throw new Error(`Invalid renovate allowedVersions: ${rule.allowedVersions}`);
      }
      versionRule.allowedVersions = rule.allowedVersions;
      if (allowedRange) for (const name of literals) pinCandidates.add(name);
    }
    if (versionRule.allowedVersions || versionRule.cooldownDays !== undefined) versionRules.push(versionRule);
  }

  for (const name of pinCandidates) {
    const allowedVersions = versionRules.findLast(rule =>
      rule.allowedVersions !== undefined && matchesRenovateRule(rule, name, name))?.allowedVersions;
    if (allowedVersions && validRange(allowedVersions)) pin[name] = allowedVersions;
  }

  let disabled: RegExp | undefined;
  if (enabledRules.some(rule => !rule.enabled)) {
    disabled = new RenovateNameMatcher("renovate-package-rules", (packageName, depName) => {
      let enabled = true;
      for (const rule of enabledRules) {
        if (matchesRenovateRule(rule.matchers, packageName, depName)) enabled = rule.enabled;
      }
      return !enabled;
    });
  }
  return {disabled, pin, versionRules};
}

function normalize(raw: RenovateConfig, opts: RenovateImportOptions): Partial<Config> {
  if (raw.enabled === false) return {exclude: ["*"]};

  const out: Partial<Config> = {};

  if (opts.cooldown && typeof raw.minimumReleaseAge === "string") {
    const days = parseRenovateDuration(raw.minimumReleaseAge);
    if (days !== undefined && days > 0) out.cooldown = days;
  }

  const ignored: Array<Matcher> = Array.isArray(raw.ignoreDeps) ? raw.ignoreDeps
    .filter(dep => typeof dep === "string" && Boolean(dep))
    .map(dep => new RenovateNameMatcher(`^${esc(dep)}$`, (_packageName, depName) => depName === dep)) : [];
  const {disabled, pin, versionRules} = applyRules(Array.isArray(raw.packageRules) ? raw.packageRules : [], Boolean(opts.cooldown));

  const exclude = disabled ? [...ignored, disabled] : ignored;
  if (exclude.length) out.exclude = exclude;
  if (Object.keys(pin).length) {
    out.pin = pin;
    out.pinNoDowngrade = true;
  }
  if (versionRules.length) (out as Partial<Config> & {renovateVersionRules: Array<RenovateVersionRule>}).renovateVersionRules = versionRules;

  return out;
}

const renovateConfigFilenames = ["renovate.json", "renovate.jsonc", "renovate.json5"];

export async function loadRenovateConfig(
  rootDir: string, opts: RenovateImportOptions = {},
): Promise<Partial<Config>> {
  const found = await walkUp(rootDir, async dir => {
    for (const filename of renovateConfigFilenames) {
      const path = join(dir, filename);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseJsonish(text);
      } catch (err: any) {
        throw new Error(`Unable to parse renovate config ${path}: ${err.message}`);
      }
      if (parsed && typeof parsed === "object") return {parsed: parsed as RenovateConfig, path};
    }
    return null;
  });
  if (!found) return {};
  return normalize(found.parsed, opts);
}
