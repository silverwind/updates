import {getOrSet} from "./utils.ts";

type SemVer = {major: number, minor: number, patch: number, prerelease: ReadonlyArray<string | number>, raw: string, version: string};

const numericIdentifier = "0|[1-9]\\d*";
const numericIdentifierRe = /^(?:0|[1-9]\d*)$/;
const prereleaseIdentifier = "0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*";
const semverRe = new RegExp(`^v?(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})(?:-((?:${prereleaseIdentifier})(?:\\.(?:${prereleaseIdentifier}))*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

const parseCache = new Map<string, SemVer | null>();

export function parse(v: string): SemVer | null {
  if (typeof v !== "string") return null;
  return getOrSet(parseCache, v, () => {
    const m = semverRe.exec(v.trim());
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
    const prerelease: Array<string | number> = m[4] ?
      m[4].split(".").map(part => /^\d+$/.test(part) && Number(part) < Number.MAX_SAFE_INTEGER ? Number(part) : part) :
      [];
    const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join(".")}` : ""}`;
    return {major, minor, patch, prerelease, raw: v, version};
  });
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNumeric = typeof a === "number" || /^\d+$/.test(a);
  const bNumeric = typeof b === "number" || /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const aString = String(a);
    const bString = String(b);
    return aString.length - bString.length || (aString < bString ? -1 : aString > bString ? 1 : 0);
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareMain(a: SemVer, b: SemVer): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function compareParsed(a: SemVer, b: SemVer): number {
  const main = compareMain(a, b);
  if (main !== 0) return main;
  const aLength = a.prerelease.length;
  const bLength = b.prerelease.length;
  if (!aLength || !bLength) return bLength - aLength;
  for (let i = 0; i < aLength && i < bLength; i++) {
    const cmp = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  return aLength - bLength;
}

export function valid(v: string): string | null {
  return parse(v)?.version ?? null;
}

const coerceCache = new Map<string, {version: string} | null>();
const coerceRe = /(?:^|[^.\d])(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

export function coerce(v: string): {version: string} | null {
  if (typeof v !== "string") return null;
  return getOrSet(coerceCache, v, () => {
    const m = coerceRe.exec(v);
    return m ? {version: `${m[1]}.${m[2] || "0"}.${m[3] || "0"}`} : null;
  });
}

export function diff(v1: string, v2: string): string | null {
  const a = parse(v1);
  const b = parse(v2);
  return a && b ? diffParsed(a, b) : null;
}

function diffParsed(a: SemVer, b: SemVer): string | null {
  const cmp = compareParsed(a, b);
  if (cmp === 0) return null;
  const highVersion = cmp > 0 ? a : b;
  const lowVersion = cmp > 0 ? b : a;
  const highHasPre = highVersion.prerelease.length > 0;
  if (lowVersion.prerelease.length > 0 && !highHasPre) {
    if (!lowVersion.patch && !lowVersion.minor) return "major";
    if (compareMain(lowVersion, highVersion) === 0) return lowVersion.minor && !lowVersion.patch ? "minor" : "patch";
  }
  const prefix = highHasPre ? "pre" : "";
  if (a.major !== b.major) return `${prefix}major`;
  if (a.minor !== b.minor) return `${prefix}minor`;
  if (a.patch !== b.patch) return `${prefix}patch`;
  return "prerelease";
}

export function gt(v1: string, v2: string): boolean {
  const a = parse(v1);
  const b = parse(v2);
  return Boolean(a && b && compareParsed(a, b) > 0);
}

type Comparator = {op: string, semver: SemVer};
type PartialVersion = {major: number | null, minor: number | null, patch: number | null, suffix: string};

function parsePartial(value: string): PartialVersion | null {
  const match = /^v?([^.+-]+(?:\.[^.+-]+){0,2})(-[0-9a-zA-Z.-]+)?(\+[0-9a-zA-Z.-]+)?$/.exec(value);
  if (!match) return null;
  const parsed: Array<number | null> = [];
  for (const part of match[1].split(".")) {
    if (/^[xX*]$/.test(part)) parsed.push(null);
    else if (parsed.includes(null) || !numericIdentifierRe.test(part) || !Number.isSafeInteger(Number(part))) return null;
    else parsed.push(Number(part));
  }
  while (parsed.length < 3) parsed.push(null);
  const suffix = `${match[2] ?? ""}${match[3] ?? ""}`;
  if (suffix && (parsed.includes(null) || !parse(`${parsed.join(".")}${suffix}`))) return null;
  return {major: parsed[0], minor: parsed[1], patch: parsed[2], suffix};
}

function comparator(op: string, major: number, minor: number, patch: number, suffix = ""): Comparator | null {
  const semver = parse(`${major}.${minor}.${patch}${suffix}`);
  return semver ? {op, semver} : null;
}

function comparators(...values: Array<Comparator | null>): Array<Comparator> | null {
  return values.every(value => value !== null) ? values : null;
}

function testComparator(v: SemVer, comp: Comparator): boolean {
  const cmp = compareParsed(v, comp.semver);
  switch (comp.op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
    default: return false;
  }
}

function upperComparator(major: number, minor: number, patch: number): Comparator | null {
  return comparator("<", major, minor, patch, "-0");
}

function partialBounds(partial: PartialVersion, op: string): Array<Comparator> | null {
  if (partial.major === null) return op === ">" || op === "<" ? comparators(upperComparator(0, 0, 0)) : [];
  const {major, suffix} = partial;
  const minor = partial.minor ?? 0;
  const patch = partial.patch ?? 0;
  const [nextMajor, nextMinor] = partial.minor === null ? [major + 1, 0] : [major, minor + 1];
  if (op === "^" || op === "~") {
    const lower = comparator(">=", major, minor, patch, suffix);
    if (op === "^" && major !== 0) return comparators(lower, upperComparator(major + 1, 0, 0));
    if (op === "^" && partial.patch !== null && minor === 0) return comparators(lower, upperComparator(0, 0, patch + 1));
    return comparators(lower, upperComparator(nextMajor, nextMinor, 0));
  }
  if (partial.patch !== null) return comparators(comparator(op || "=", major, minor, patch, suffix));
  if (!op || op === "=") return comparators(comparator(">=", major, minor, 0), upperComparator(nextMajor, nextMinor, 0));
  if (op === ">") return comparators(comparator(">=", nextMajor, nextMinor, 0));
  if (op === "<=") return comparators(upperComparator(nextMajor, nextMinor, 0));
  if (op === "<") return comparators(upperComparator(major, minor, 0));
  return comparators(comparator(">=", major, minor, 0));
}

function parseComparatorSet(group: string): Array<Comparator> | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(group);
  if (hyphen) {
    const from = parsePartial(hyphen[1]);
    const to = parsePartial(hyphen[2]);
    const lower = from && partialBounds(from, ">=");
    const upper = to && partialBounds(to, "<=");
    return lower && upper ? [...lower, ...upper] : null;
  }
  const normalized = group.replace(/~\s*>\s*/g, "~").replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
  const result: Array<Comparator> = [];
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(token);
    const partial = match && parsePartial(match[2]);
    const bounds = partial ? partialBounds(partial, match[1] ?? "") : null;
    if (!bounds) return null;
    result.push(...bounds);
  }
  return result;
}

const rangeCache = new Map<string, Array<Array<Comparator>> | null>();

function parseRange(range: string): Array<Array<Comparator>> | null {
  return getOrSet(rangeCache, range, () => {
    const groups = range.split("||").map(group => parseComparatorSet(group.trim()));
    return groups.every(group => group !== null) ? groups : null;
  });
}

function testWithPrerelease(version: SemVer, comparators: Array<Comparator>): boolean {
  if (comparators.some(comp => !testComparator(version, comp))) return false;
  return !version.prerelease.length || comparators.some(comp => comp.semver.prerelease.length > 0 &&
    comp.semver.major === version.major && comp.semver.minor === version.minor && comp.semver.patch === version.patch);
}

function satisfiesParsed(v: SemVer, range: string): boolean {
  return Boolean(parseRange(range)?.some(group => testWithPrerelease(v, group)));
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return Boolean(v && satisfiesParsed(v, range));
}

export function validRange(range: string): string | null {
  return typeof range === "string" && parseRange(range) ? range : null;
}

export type Pep440 = {epoch: number, release: Array<number>, pre: [string, number] | null, post: number | null, dev: number | null,
  local: Array<string | number> | null, version: string};

const pep440Pattern = "v?(?:(\\d+)!)?(\\d+(?:\\.\\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\\d+)?)?(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?(?:[-_.]?(dev)[-_.]?(\\d+)?)?(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?";
const pep440Re = new RegExp(`^${pep440Pattern}$`, "i");
const pep440SearchRe = new RegExp(pep440Pattern, "i");
const preSpellings: Record<string, string> = {alpha: "a", beta: "b", c: "rc", pre: "rc", preview: "rc"};

const pep440Cache = new Map<string, Pep440 | null>();

export function parsePep440(v: string): Pep440 | null {
  if (typeof v !== "string") return null;
  return getOrSet(pep440Cache, v, () => {
    const m = pep440Re.exec(v.trim());
    if (!m) return null;
    const preLetter = m[3]?.toLowerCase();
    return {
      epoch: m[1] ? Number(m[1]) : 0,
      release: m[2].split(".").map(Number),
      pre: preLetter ? [preSpellings[preLetter] ?? preLetter, Number(m[4] ?? 0)] : null,
      post: m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? Number(m[7] ?? 0) : null,
      dev: m[8] !== undefined ? Number(m[9] ?? 0) : null,
      local: m[10] ? m[10].toLowerCase().split(/[._-]/).map(p => /^\d+$/.test(p) ? Number(p) : p) : null,
      version: v.trim(),
    };
  });
}

function parsePep440Range(range: string): Pep440 | null {
  return parsePep440(range) ?? parsePep440(pep440SearchRe.exec(range)?.[0] ?? "");
}

const isPep440Prerelease = (v: Pep440): boolean => Boolean(v.pre) || v.dev !== null;

function compareLocal(a: Array<string | number> | null, b: Array<string | number> | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aIsNum = typeof a[i] === "number";
    if (aIsNum !== (typeof b[i] === "number")) return aIsNum ? 1 : -1;
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function comparePep440(a: Pep440, b: Pep440): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    const cmp = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (cmp) return cmp;
  }
  const aRank = a.pre ? 0 : a.post === null && a.dev !== null ? -1 : 1;
  const bRank = b.pre ? 0 : b.post === null && b.dev !== null ? -1 : 1;
  if (aRank !== bRank) return aRank - bRank;
  if (a.pre && b.pre) {
    if (a.pre[0] !== b.pre[0]) return a.pre[0] < b.pre[0] ? -1 : 1;
    if (a.pre[1] !== b.pre[1]) return a.pre[1] - b.pre[1];
  }
  if ((a.post ?? -1) !== (b.post ?? -1)) return (a.post ?? -1) - (b.post ?? -1);
  const aDev = a.dev ?? Infinity;
  const bDev = b.dev ?? Infinity;
  if (aDev !== bDev) return aDev < bDev ? -1 : 1;
  return compareLocal(a.local, b.local);
}

function releaseLevel(a: Pep440, b: Pep440): string | null {
  if (a.epoch !== b.epoch) return "major";
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    if ((a.release[i] ?? 0) !== (b.release[i] ?? 0)) return i === 0 ? "major" : i === 1 ? "minor" : "patch";
  }
  return null;
}

export function diffPep440(a: Pep440, b: Pep440): string | null {
  const cmp = comparePep440(a, b);
  if (cmp === 0) return null;
  const level = releaseLevel(a, b);
  if (isPep440Prerelease(cmp > 0 ? a : b)) return level ? `pre${level}` : "prerelease";
  return level ?? "patch";
}

export type Versioning<T extends {version: string} = any> = {
  parse: (version: string) => T | null;
  parseRange: (range: string) => T | null;
  compare: (a: T, b: T) => number;
  diff: (a: T, b: T) => string | null;
  isPrerelease: (parsed: T) => boolean;
  isRangePrerelease: (range: string) => boolean;
  satisfiesRange: (parsed: T, range: string) => boolean;
};

const rangeVersionRe = /\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?/;

export const semverVersioning: Versioning<SemVer> = {
  parse,
  parseRange: range => parse(rangeVersionRe.exec(range)?.[0] ?? "") ?? parse(coerce(range)?.version ?? ""),
  compare: compareParsed,
  diff: diffParsed,
  isPrerelease: parsed => parsed.prerelease.length > 0,
  isRangePrerelease: range => /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range),
  satisfiesRange: satisfiesParsed,
};

const actionsParseCache = new Map<string, SemVer | null>();

function parseActionsVersion(v: string): SemVer | null {
  return getOrSet(actionsParseCache, v, () => {
    const stripped = v.trim().replace(/^v/i, "");
    return parse(stripped) ?? parse(stripped.replace(/^(\d+\.\d+)(-.+)$/, "$1.0$2")) ??
      (/^\d/.test(stripped) ? parse(coerce(stripped)?.version ?? "") : null);
  });
}

export const githubActionsVersioning: Versioning<SemVer> = {
  ...semverVersioning,
  parse: parseActionsVersion,
  parseRange: parseActionsVersion,
  isRangePrerelease: range => Boolean(parseActionsVersion(range)?.prerelease.length),
};

export const pep440Versioning: Versioning<Pep440> = {
  parse: parsePep440,
  parseRange: parsePep440Range,
  compare: comparePep440,
  diff: diffPep440,
  isPrerelease: isPep440Prerelease,
  isRangePrerelease: range => {
    const parsed = parsePep440Range(range);
    return Boolean(parsed && isPep440Prerelease(parsed));
  },
  satisfiesRange: ({release}, range) => satisfies(`${release[0] ?? 0}.${release[1] ?? 0}.${release[2] ?? 0}`, range),
};
