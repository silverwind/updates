import {getOrSet} from "./utils.ts";

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  build: ReadonlyArray<string>;
  raw: string;
  version: string;
};

const numericIdentifier = "0|[1-9]\\d*";
const numericIdentifierRe = /^(?:0|[1-9]\d*)$/;
const prereleaseIdentifier = "0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*";
const semverRe = new RegExp(`^v?(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})(?:-((?:${prereleaseIdentifier})(?:\\.(?:${prereleaseIdentifier}))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`);

const parseCache = new Map<string, SemVer | null>();

function parseVersion(v: string): SemVer | null {
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
    const build = m[5]?.split(".") ?? [];
    const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join(".")}` : ""}`;
    return {major, minor, patch, prerelease, build, raw: v, version};
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
  const aHasPre = a.prerelease.length > 0;
  const bHasPre = b.prerelease.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const cmp = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function valid(v: string): string | null {
  return parseVersion(v)?.version ?? null;
}

export function parse(v: string): SemVer | null {
  return parseVersion(v);
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
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return null;
  return diffParsed(a, b);
}

function diffParsed(a: SemVer, b: SemVer): string | null {
  if (a.version === b.version) return null;

  const cmp = compareParsed(a, b);
  const highVersion = cmp > 0 ? a : b;
  const lowVersion = cmp > 0 ? b : a;
  const highHasPre = highVersion.prerelease.length > 0;
  const lowHasPre = lowVersion.prerelease.length > 0;

  if (lowHasPre && !highHasPre) {
    if (!lowVersion.patch && !lowVersion.minor) return "major";
    if (compareMain(lowVersion, highVersion) === 0) {
      if (lowVersion.minor && !lowVersion.patch) return "minor";
      return "patch";
    }
  }

  const prefix = highHasPre ? "pre" : "";
  if (a.major !== b.major) return `${prefix}major`;
  if (a.minor !== b.minor) return `${prefix}minor`;
  if (a.patch !== b.patch) return `${prefix}patch`;
  return "prerelease";
}

function compare(v1: string, v2: string): number | null {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  return a && b ? compareParsed(a, b) : null;
}

export function gt(v1: string, v2: string): boolean {
  return (compare(v1, v2) ?? -1) > 0;
}

type Comparator = {
  op: string;
  semver: SemVer;
};

type PartialVersion = {
  major: number | null;
  minor: number | null;
  patch: number | null;
  suffix: string;
};

function parsePartial(value: string): PartialVersion | null {
  const match = /^v?([^.+-]+(?:\.[^.+-]+){0,2})(-[0-9a-zA-Z.-]+)?(\+[0-9a-zA-Z.-]+)?$/.exec(value);
  if (!match) return null;
  const parts = match[1].split(".");
  const parsed: Array<number | null> = [];
  let wildcard = false;
  for (const part of parts) {
    if (/^[xX*]$/.test(part)) {
      wildcard = true;
      parsed.push(null);
    } else {
      if (wildcard || !numericIdentifierRe.test(part)) return null;
      const number = Number(part);
      if (!Number.isSafeInteger(number)) return null;
      parsed.push(number);
    }
  }
  while (parsed.length < 3) parsed.push(null);
  if ((match[2] || match[3]) && parsed.some(part => part === null)) return null;
  if (match[2] || match[3]) {
    const complete = `${parsed.join(".")}${match[2] ?? ""}${match[3] ?? ""}`;
    if (!parseVersion(complete)) return null;
  }
  return {major: parsed[0], minor: parsed[1], patch: parsed[2], suffix: `${match[2] ?? ""}${match[3] ?? ""}`};
}

function comparator(op: string, major: number, minor: number, patch: number, suffix = ""): Comparator | null {
  const semver = parseVersion(`${major}.${minor}.${patch}${suffix}`);
  return semver ? {op, semver} : null;
}

function comparators(...values: Array<Comparator | null>): Array<Comparator> | null {
  const result = values.filter((value): value is Comparator => value !== null);
  return result.length === values.length ? result : null;
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
  if (partial.major === null) return partial.minor === null && partial.patch === null ? [] : null;
  const major = partial.major;
  const minor = partial.minor ?? 0;
  const patch = partial.patch ?? 0;
  if (op === "^" || op === "~") {
    const lower = comparator(">=", major, minor, patch, partial.suffix);
    if (partial.minor === null) return comparators(lower, upperComparator(major + 1, 0, 0));
    if (op === "~") return comparators(lower, upperComparator(major, minor + 1, 0));
    if (major !== 0) return comparators(lower, upperComparator(major + 1, 0, 0));
    if (partial.patch !== null && minor === 0) return comparators(lower, upperComparator(0, 0, patch + 1));
    return comparators(lower, upperComparator(0, minor + 1, 0));
  }
  if (partial.minor !== null && partial.patch !== null) return comparators(comparator(op || "=", major, minor, patch, partial.suffix));
  if (!op || op === "=") {
    return partial.minor === null ?
      comparators(comparator(">=", major, 0, 0), upperComparator(major + 1, 0, 0)) :
      comparators(comparator(">=", major, minor, 0), upperComparator(major, minor + 1, 0));
  }
  if (op === ">") return partial.minor === null ? comparators(comparator(">=", major + 1, 0, 0)) : comparators(comparator(">=", major, minor + 1, 0));
  if (op === "<=") return partial.minor === null ? comparators(upperComparator(major + 1, 0, 0)) : comparators(upperComparator(major, minor + 1, 0));
  if (op === "<") return partial.minor === null ? comparators(upperComparator(major, 0, 0)) : comparators(upperComparator(major, minor, 0));
  return comparators(comparator(">=", major, minor, 0));
}

function parseHyphen(fromValue: string, toValue: string): Array<Comparator> | null {
  const from = parsePartial(fromValue);
  const to = parsePartial(toValue);
  if (!from || !to) return null;
  const result: Array<Comparator> = [];
  if (from.major !== null) {
    const lower = comparator(">=", from.major, from.minor ?? 0, from.patch ?? 0, from.suffix);
    if (!lower) return null;
    result.push(lower);
  }
  if (to.major === null) return result;
  const upper = to.minor === null ? upperComparator(to.major + 1, 0, 0) :
    to.patch === null ? upperComparator(to.major, to.minor + 1, 0) :
      comparator("<=", to.major, to.minor, to.patch, to.suffix);
  if (!upper) return null;
  result.push(upper);
  return result;
}

function parseComparatorSet(group: string): Array<Comparator> | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(group);
  if (hyphen) return parseHyphen(hyphen[1], hyphen[2]);
  const normalized = group.replace(/~\s*>\s*/g, "~").replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
  const result: Array<Comparator> = [];
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(token);
    const partial = match && parsePartial(match[2]);
    const bounds = partial ? partialBounds(partial, match?.[1] ?? "") : null;
    if (!bounds) return null;
    result.push(...bounds);
  }
  return result;
}

const rangeCache = new Map<string, Array<Array<Comparator>> | null>();

function parseRange(range: string): Array<Array<Comparator>> | null {
  return getOrSet(rangeCache, range, () => {
    const groups = range.split("||").map(group => parseComparatorSet(group.trim()));
    return groups.some(group => group === null) ? null : groups as Array<Array<Comparator>>;
  });
}

function testWithPrerelease(version: SemVer, comparators: Array<Comparator>): boolean {
  if (comparators.some(comp => !testComparator(version, comp))) return false;
  return !version.prerelease.length || comparators.some(comp => comp.semver.prerelease.length > 0 &&
    comp.semver.major === version.major && comp.semver.minor === version.minor && comp.semver.patch === version.patch);
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const parsed = parseRange(range);
  return Boolean(parsed?.some(group => testWithPrerelease(v, group)));
}

export function validRange(range: string): string | null {
  if (typeof range !== "string") return null;
  return parseRange(range) ? range : null;
}

export type Pep440 = {
  epoch: number;
  release: Array<number>;
  pre: [string, number] | null;
  post: number | null;
  dev: number | null;
  local: Array<string | number> | null;
  version: string;
};

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

const isPep440Prerelease = (v: Pep440): boolean => Boolean(v.pre || v.dev);

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
  satisfiesRange: (parsed, range) => satisfies(parsed.version, range),
};

const actionsParseCache = new Map<string, SemVer | null>();

function parseActionsVersion(v: string): SemVer | null {
  return getOrSet(actionsParseCache, v, () => {
    const stripped = v.trim().replace(/^v/i, "");
    const parsed = parse(stripped) ?? parse(stripped.replace(/^(\d+\.\d+)(-.+)$/, "$1.0$2"));
    if (parsed) return parsed;
    if (!/^\d/.test(stripped)) return null;
    return parse(coerce(stripped)?.version ?? "");
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
