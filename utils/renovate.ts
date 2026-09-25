import {join} from "node:path";
import {readFile} from "node:fs/promises";
import {parseJsonish} from "./json5.ts";
import {validRange} from "./semver.ts";
import {walkUp, patternToRegex, esc, getOrSet, tryOrNull} from "./utils.ts";
import type {Config} from "../config.ts";

const daysPerUnit: Record<string, number> = {y: 365.25, w: 7, d: 1, h: 1 / 24, m: 1 / 1440, s: 1 / 86400, ms: 1 / 86400000};

function parseRenovateDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(/(.*?[a-z]+)/).map(part => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  let total = 0;
  for (const part of parts) {
    const spec = part.replace(/^(\d+)\s*(?:months?|M)$/, (_match, months) => `${Number(months) * 30} days`);
    if (spec.length > 100) return undefined;
    const match = /^(-?\d*\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(spec);
    if (!match) return undefined;
    const unit = (match[2] ?? "ms").toLowerCase();
    total += Number(match[1]) * daysPerUnit[/^m(?:s|il)/.test(unit) ? "ms" : unit[0]];
  }
  return total;
}

type Matcher = string | RegExp;

const nameMatcherKeyRe = /^(?:(?:match|exclude)(?:Package|Dep)(?:Names|Patterns|Prefixes)|package(?:Name|Pattern)s?|excludedPackageNames)$/;

function convertNameMatcher(key: string, value: string): string { // renovate's packageRules migration
  const negation = key.startsWith("exclude") ? "!" : "";
  if (key.endsWith("Prefixes")) return `${negation}${value}{/,}**`;
  if (!/Patterns?$/.test(key)) return `${negation}${value}`;
  return value === "*" && !negation && !key.includes("Dep") ? "*" : `${negation}/${value}/`;
}

const legacyMatcherKeys = new Set([
  "updateTypes", "managers", "datasources", "depTypeList", "paths", "languages", "baseBranchList",
  "sourceUrlPrefixes", "matchFiles", "matchPaths",
]);

function compileRule(rule: Record<string, unknown>): {matchers: RenovateVersionRule, literals: Array<string>} | undefined {
  const names: {Package?: Array<string>, Dep?: Array<string>} = {};
  for (const [key, value] of Object.entries(rule)) {
    if (!nameMatcherKeyRe.test(key)) {
      if (key.startsWith("match") || key.startsWith("exclude") || legacyMatcherKeys.has(key)) return undefined;
      continue;
    }
    const list = typeof value === "string" || key === "packageName" || key === "packagePattern" ? [value] : value;
    if (!Array.isArray(list)) return undefined;
    const targetNames = names[key.includes("Dep") ? "Dep" : "Package"] ??= [];
    for (const entry of list) {
      if (typeof entry !== "string" || !entry) return undefined;
      targetNames.push(convertNameMatcher(key, entry));
    }
  }
  const matchers: RenovateVersionRule = {};
  const literals: Array<string> = [];
  for (const target of ["Package", "Dep"] as const) {
    if (names[target]?.length === 0) return undefined;
    const include: Array<Matcher> = [];
    const exclude: Array<Matcher> = [];
    for (const name of names[target] ?? []) {
      const negated = name.startsWith("!");
      const value = negated ? name.slice(1) : name;
      const regex = renovateRegex(value);
      (negated ? exclude : include).push(regex ?? value);
      if (!negated && !regex && !/[*?[\]{}!()|+]/.test(value)) literals.push(value);
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

class RenovateNameMatcher extends RegExp {
  #predicate: (packageName: string, depName: string) => boolean;
  constructor(source: string, predicate: (packageName: string, depName: string) => boolean) {
    super(source);
    this.#predicate = predicate;
  }

  testNames(packageName: string, depName: string): boolean {
    return this.#predicate(packageName, depName);
  }

  override test(name: string): boolean {
    return this.testNames(name, name);
  }
}

export function testRenovateMatcher(matcher: RegExp, value: string, packageName: string, depName: string): boolean {
  return matcher instanceof RenovateNameMatcher ? matcher.testNames(packageName, depName) : matcher.test(value);
}

function applyRules(rules: Array<Record<string, unknown>>, inheritCooldown: boolean) {
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

    const days = inheritCooldown ? parseRenovateDuration(rule.minimumReleaseAge) : undefined;
    if (days !== undefined) versionRule.cooldownDays = days;

    if (typeof rule.allowedVersions === "string") {
      const allowedRange = validRange(rule.allowedVersions);
      if (!allowedRange && !renovateRegex(rule.allowedVersions)) throw new Error(`Invalid renovate allowedVersions: ${rule.allowedVersions}`);
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

  const disabled = enabledRules.some(rule => !rule.enabled) ? new RenovateNameMatcher("renovate-package-rules", (packageName, depName) =>
    enabledRules.findLast(rule => matchesRenovateRule(rule.matchers, packageName, depName))?.enabled === false) : undefined;
  return {disabled, pin, versionRules};
}

function normalize(raw: Record<string, unknown>, opts: RenovateImportOptions): Partial<Config> {
  if (raw.enabled === false) return {exclude: ["*"]};

  const out: Partial<Config> & {renovateVersionRules?: Array<RenovateVersionRule>} = {};

  const cooldown = opts.cooldown ? parseRenovateDuration(raw.minimumReleaseAge) : undefined;
  if (cooldown && cooldown > 0) out.cooldown = cooldown;

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
  if (versionRules.length) out.renovateVersionRules = versionRules;

  return out;
}

export async function loadRenovateConfig(
  rootDir: string, opts: RenovateImportOptions = {},
): Promise<Partial<Config>> {
  const found = await walkUp(rootDir, async dir => {
    for (const filename of ["renovate.json", "renovate.jsonc", "renovate.json5"]) {
      const path = join(dir, filename);
      const text = await tryOrNull(readFile(path, "utf8"));
      if (text === null) continue;
      let parsed: unknown;
      try {
        parsed = parseJsonish(text);
      } catch (err: any) {
        throw new Error(`Unable to parse renovate config ${path}: ${err.message}`);
      }
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    }
    return null;
  });
  return found ? normalize(found, opts) : {};
}
