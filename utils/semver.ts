import {getOrSet} from "./utils.ts";

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  version: string;
};

const semverRe = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?(?:\+[a-zA-Z0-9._-]+)?$/;

const parseCache = new Map<string, SemVer | null>();

function parseVersion(v: string): SemVer | null {
  if (typeof v !== "string") return null;
  return getOrSet(parseCache, v, () => {
    const m = semverRe.exec(v.trim());
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    const prerelease: Array<string | number> = m[4] ?
      m[4].split(".").map(p => /^\d+$/.test(p) ? Number(p) : p) :
      [];
    const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join(".")}` : ""}`;
    return {major, minor, patch, prerelease, version};
  });
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNum = typeof a === "number";
  const bNum = typeof b === "number";
  if (aNum && bNum) return a - b;
  if (aNum) return -1; // numbers sort before strings
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareMain(a: SemVer, b: SemVer): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

// Compare pre-parsed versions, letting hot loops skip the parse-cache lookups.
function compareParsed(a: SemVer, b: SemVer): number {
  const main = compareMain(a, b);
  if (main !== 0) return main;
  const aHasPre = a.prerelease.length > 0;
  const bHasPre = b.prerelease.length > 0;
  // no prerelease on either => equal
  if (!aHasPre && !bHasPre) return 0;
  // prerelease has lower precedence than release
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  // both have prerelease
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

// Lets hot loops pass already-parsed inputs and skip the parseVersion cache lookup.
function diffParsed(a: SemVer, b: SemVer): string | null {
  if (a.version === b.version) return null;

  const cmp = compareParsed(a, b);
  const highVersion = cmp > 0 ? a : b;
  const lowVersion = cmp > 0 ? b : a;
  const highHasPre = highVersion.prerelease.length > 0;
  const lowHasPre = lowVersion.prerelease.length > 0;

  // Special case: going from prerelease to release
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

// --- Range parsing ---

type Comparator = {
  op: string; // >=, <=, >, <, = (empty means =)
  semver: SemVer;
};

function parseComparator(comp: string): Comparator | null {
  const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)?)$/.exec(comp.trim());
  if (!m) return null;
  const major = m[2];
  const minor = m[3] ?? "0";
  const patch = m[4] ?? "0";
  const pre = m[5] || "";
  const sv = parseVersion(`${major}.${minor}.${patch}${pre}`);
  if (!sv) return null;
  return {op: m[1] || "=", semver: sv};
}

function testComparator(v: SemVer, comp: Comparator): boolean {
  const cmp = compareParsed(v, comp.semver);
  switch (comp.op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
    default: return cmp === 0;
  }
}

// Returns upper bound with -0 appended for exclusive upper bounds
function upperBound(major: number, minor: number, patch: number): string {
  return `${major}.${minor}.${patch}-0`;
}

// ~1.2.3 := >=1.2.3 <1.3.0-0    ^1.2.3 := >=1.2.3 <2.0.0-0
// ~1.2   := >=1.2.0 <1.3.0-0    ^0.2.3 := >=0.2.3 <0.3.0-0
// ~1     := >=1.0.0 <2.0.0-0    ^0.0.3 := >=0.0.3 <0.0.4-0
//                               ^0.0   := >=0.0.0 <0.1.0-0
//                               ^0     := >=0.0.0 <1.0.0-0
// Trailing wildcard segments (e.g. ~1.x, ^1.2.x) are consumed and treated as omitted.
function expandTildeCaret(range: string): string {
  return range.replace(/([~^])\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.[xX*])*((?:-[a-zA-Z0-9._-]+)?)/g, (_, op, rawMajor, rawMinor, rawPatch, rawPre) => {
    const major = Number(rawMajor);
    const minor = rawMinor !== undefined ? Number(rawMinor) : 0;
    const patch = rawPatch !== undefined ? Number(rawPatch) : 0;
    // The prerelease is kept only when the segment it belongs to was given: ~ needs a minor, ^ a patch.
    const pre = (op === "~" ? rawMinor : rawPatch) !== undefined ? rawPre : "";
    let upper: string;
    if (rawMinor === undefined) upper = upperBound(major + 1, 0, 0);
    else if (op === "~") upper = upperBound(major, minor + 1, 0);
    else if (major !== 0) upper = upperBound(major + 1, 0, 0);
    else if (rawPatch !== undefined && minor === 0) upper = upperBound(0, 0, patch + 1);
    else upper = upperBound(0, minor + 1, 0);
    return `>=${major}.${minor}.${patch}${pre} <${upper}`;
  });
}

function expandHyphen(range: string): string {
  // A - B  :=  >=A <=B
  // 1.2.3 - 2.3.4 := >=1.2.3 <=2.3.4
  // 1.2 - 2.3.4 := >=1.2.0 <=2.3.4
  // 1.2.3 - 2.3 := >=1.2.3 <2.4.0-0
  // 1.2.3 - 2 := >=1.2.3 <3.0.0-0
  return range.replace(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9._-]+)?)\s+-\s+v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9._-]+)?)/g,
    (_, aM, am, ap, aPre, bM, bm, bp, bPre) => {
      const fromM = Number(aM);
      const fromm = am !== undefined ? Number(am) : 0;
      const fromp = ap !== undefined ? Number(ap) : 0;
      const fromPre = aPre || "";
      const toM = Number(bM);

      let upper: string;
      if (bp !== undefined) {
        const tom = Number(bm);
        const top = Number(bp);
        const toPre = bPre || "";
        upper = `<=${toM}.${tom}.${top}${toPre}`;
      } else if (bm !== undefined) {
        const tom = Number(bm);
        upper = `<${upperBound(toM, tom + 1, 0)}`;
      } else {
        upper = `<${upperBound(toM + 1, 0, 0)}`;
      }
      return `>=${fromM}.${fromm}.${fromp}${fromPre} ${upper}`;
    });
}

// Expands an x-range component (e.g. 1.2.x or 1.x), honoring a leading comparison operator the way
// node-semver does: a bare/`=` x-range becomes a `>=lo <hi` pair, while an operator-prefixed one
// collapses to a single bound (e.g. >=1.2.x := >=1.2.0, >1.2.x := >=1.3.0, <=1.2.x := <1.3.0-0).
function expandXRangeComparator(op: string | undefined, major: number, minor: number, wildMinor: boolean): string {
  if (!op || op === "=") {
    return wildMinor ?
      `>=${major}.0.0 <${upperBound(major + 1, 0, 0)}` :
      `>=${major}.${minor}.0 <${upperBound(major, minor + 1, 0)}`;
  }
  if (op === ">") {
    // >1 := >=2.0.0, >1.2 := >=1.3.0
    return wildMinor ? `>=${major + 1}.0.0` : `>=${major}.${minor + 1}.0`;
  }
  if (op === "<=") {
    // <=1.x := <2.0.0-0, <=1.2.x := <1.3.0-0 (any matching patch should pass)
    return wildMinor ? `<${upperBound(major + 1, 0, 0)}` : `<${upperBound(major, minor + 1, 0)}`;
  }
  if (op === "<") {
    return wildMinor ? `<${major}.0.0-0` : `<${major}.${minor}.0-0`;
  }
  // >=
  return wildMinor ? `>=${major}.0.0` : `>=${major}.${minor}.0`;
}

function expandXRanges(range: string): string {
  // *, x, X -> >=0.0.0
  // 1.x, 1.*, 1 -> >=1.0.0 <2.0.0-0
  // 1.2.x, 1.2.*, 1.2 -> >=1.2.0 <1.3.0-0

  // Handle standalone wildcard
  if (/^\s*[*xX]\s*$/.test(range)) {
    return ">=0.0.0";
  }

  // Handle patterns like 1.2.x, 1.2.* (before the 2-part rule below, which would otherwise mis-match these)
  // wildMinor=false: minor is fixed (1.2.x), so the implied range spans one minor. true: minor is wild (1.x).
  range = range.replace(/(>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.[xX*]/g, (_, op, major, minor) =>
    expandXRangeComparator(op, Number(major), Number(minor), false));

  // Handle patterns like 1.x, 1.*, 1.X, 1.x.x etc.
  range = range.replace(/(>=|<=|>|<|=)?\s*v?(\d+)\.[xX*](?:\.[xX*])?/g, (_, op, major) =>
    expandXRangeComparator(op, Number(major), 0, true));

  // Handle bare partials "1.2" and "1", honoring a leading comparison operator the same way
  // the x-range passes above do (e.g. >1.2 := >=1.3.0, <=1 := <2.0.0-0). A bare/`=` partial
  // collapses to the `>=lo <hi` pair via expandXRangeComparator's first branch.
  range = range.replace(/(^|[\s|])(>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)(?=\s|$)/g, (_, prefix, op, major, minor) =>
    `${prefix}${expandXRangeComparator(op, Number(major), Number(minor), false)}`);

  range = range.replace(/(^|[\s|])(>=|<=|>|<|=)?\s*v?(\d+)(?=\s|$)/g, (_, prefix, op, major) =>
    `${prefix}${expandXRangeComparator(op, Number(major), 0, true)}`);

  return range;
}

const rangeCache = new Map<string, Array<Array<Comparator>> | null>();

function parseRange(range: string): Array<Array<Comparator>> | null {
  return getOrSet(rangeCache, range, () => {
    const orGroups = range.split("||").map(g => g.trim());
    const result: Array<Array<Comparator>> = [];

    for (let group of orGroups) {
      if (!group) {
        // Empty group in || means match anything
        result.push([]);
        continue;
      }

      // Expand in order: hyphen -> caret/tilde -> x-range
      group = expandHyphen(group);
      group = expandTildeCaret(group);
      group = expandXRanges(group);

      // Merge operators with their following version (handle spaces like ">= 3.1").
      // Must run before the normalize pass below, else ">= 1.0.0" gets an "=" inserted.
      group = group.replace(/(>=|<=|>|<|=)\s+/g, "$1");

      // Normalize = prefix for exact versions
      group = group.replace(/(^|[\s])v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)?)\b/g,
        (_, prefix, version) => `${prefix}=${version}`);

      const comparators: Array<Comparator> = [];
      for (const part of group.split(/\s+/).filter(Boolean)) {
        const comp = parseComparator(part);
        if (!comp) return null;
        comparators.push(comp);
      }

      if (comparators.length === 0) return null;
      result.push(comparators);
    }

    return result.length ? result : null;
  });
}

function testWithPrerelease(version: SemVer, comparators: Array<Comparator>): boolean {
  // All comparators in the AND group must pass
  if (comparators.some(comp => !testComparator(version, comp))) return false;

  // Prerelease filtering: if version has prerelease tags,
  // at least one comparator must share the same [major, minor, patch]
  // and also have a prerelease tag
  if (version.prerelease.length > 0) {
    return comparators.some(comp =>
      comp.semver.prerelease.length > 0 &&
      comp.semver.major === version.major &&
      comp.semver.minor === version.minor &&
      comp.semver.patch === version.patch);
  }

  return true;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const parsed = parseRange(range);
  if (!parsed) return false;

  for (const group of parsed) {
    if (group.length === 0) return true; // empty group matches all
    if (testWithPrerelease(v, group)) return true;
  }
  return false;
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

// https://peps.python.org/pep-0440/#appendix-b-parsing-version-strings-with-regular-expressions
// 1 epoch, 2 release, 3-4 pre letter/number, 5 implicit post number, 6-7 post letter/number,
// 8-9 dev marker/number, 10 local.
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

// A pypi range is authored as a bare version, but a comparator may still be glued to it.
function parsePep440Range(range: string): Pep440 | null {
  return parsePep440(range) ?? parsePep440(pep440SearchRe.exec(range)?.[0] ?? "");
}

const isPep440Prerelease = (v: Pep440): boolean => Boolean(v.pre || v.dev);

// Alphanumeric local segments sort before numeric ones, shorter before longer.
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
  // Trailing zeros are insignificant, so 1.0 and 1.0.0 are the same version.
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    const cmp = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (cmp) return cmp;
  }
  // A bare dev release precedes every pre-release of the same version, which precede the release.
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

// Release segments beyond the third are the pypi norm (2.32.0.20250602), and renovate buckets
// every change below the minor as a patch, so the fourth segment does not get its own level.
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

// The scheme-specific operations version selection needs, mirroring renovate's VersioningApi.
export type Versioning<T extends {version: string} = any> = {
  parse: (version: string) => T | null;
  // Pulls the authored version out of a range, prerelease included.
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
  // can not use coerce here because it ignores prerelease tags
  isRangePrerelease: range => /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range),
  satisfiesRange: (parsed, range) => satisfies(parsed.version, range),
};

// Actions are tagged with floating majors and minors (`v3`, `v3.19`) as often as with full
// versions, and plain semver rejects both. Ported from renovate's github-actions versioning.
const actionsParseCache = new Map<string, SemVer | null>();

function parseActionsVersion(v: string): SemVer | null {
  return getOrSet(actionsParseCache, v, () => {
    const stripped = v.trim().replace(/^v/i, "");
    // `major.minor-prerelease` (`2.2-rc.1`) normalizes onto `major.minor.0-prerelease`
    const parsed = parse(stripped) ?? parse(stripped.replace(/^(\d+\.\d+)(-.+)$/, "$1.0$2"));
    if (parsed) return parsed;
    // without the guard, coerce reads a foreign tag scheme like `codeql-bundle-v2.20.3` as a version
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
  // --pin takes a semver range, so match it against the first three release segments.
  satisfiesRange: ({release}, range) => satisfies(`${release[0] ?? 0}.${release[1] ?? 0}.${release[2] ?? 0}`, range),
};
