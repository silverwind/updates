type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  version: string;
};

const semverRe = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)*))?(?:\+[a-zA-Z0-9._-]+)?$/;

const parseCache = new Map<string, SemVer | null>();

function parseVersion(v: string): SemVer | null {
  if (typeof v !== "string") return null;
  const cached = parseCache.get(v);
  if (cached !== undefined) return cached;
  const m = semverRe.exec(v.trim());
  if (!m) { parseCache.set(v, null); return null; }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease: Array<string | number> = m[4] ?
    m[4].split(".").map(p => /^\d+$/.test(p) ? Number(p) : p) :
    [];
  const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join(".")}` : ""}`;
  const result: SemVer = {major, minor, patch, prerelease, version};
  parseCache.set(v, result);
  return result;
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNum = typeof a === "number";
  const bNum = typeof b === "number";
  if (aNum && bNum) return (a) - (b);
  if (aNum) return -1; // numbers sort before strings
  if (bNum) return 1;
  return (a) < (b) ? -1 : (a) > (b) ? 1 : 0;
}

function compareMain(a: SemVer, b: SemVer): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function compareVersions(a: SemVer, b: SemVer): number {
  const main = compareMain(a, b);
  if (main !== 0) return main;
  // no prerelease on either => equal
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  // prerelease has lower precedence than release
  if (a.prerelease.length && !b.prerelease.length) return -1;
  if (!a.prerelease.length && b.prerelease.length) return 1;
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
  const cached = coerceCache.get(v);
  if (cached !== undefined) return cached;
  const m = coerceRe.exec(v);
  if (!m) { coerceCache.set(v, null); return null; }
  const major = m[1] || "0";
  const minor = m[2] || "0";
  const patch = m[3] || "0";
  const result = {version: `${major}.${minor}.${patch}`};
  coerceCache.set(v, result);
  return result;
}

export function diff(v1: string, v2: string): string | null {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return null;
  if (a.version === b.version) return null;

  const cmp = compareVersions(a, b);
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

export function gt(v1: string, v2: string): boolean {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

export function gte(v1: string, v2: string): boolean {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return false;
  return compareVersions(a, b) >= 0;
}

export function lt(v1: string, v2: string): boolean {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

export function neq(v1: string, v2: string): boolean {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  if (!a || !b) return true;
  return compareVersions(a, b) !== 0;
}

// --- Range parsing ---

type Comparator = {
  op: string; // >=, <=, >, <, = (empty means =)
  semver: SemVer;
};

function parseComparator(comp: string): Comparator | null {
  const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)*)?)$/.exec(comp.trim());
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
  const cmp = compareVersions(v, comp.semver);
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

function expandTilde(range: string): string {
  // ~1.2.3 := >=1.2.3 <1.3.0-0
  // ~1.2   := >=1.2.0 <1.3.0-0
  // ~1     := >=1.0.0 <2.0.0-0
  return range.replace(/~\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9._-]+)?)/g, (_, major, minor, patch, pre) => {
    const M = Number(major);
    if (minor === undefined) {
      return `>=${M}.0.0 <${upperBound(M + 1, 0, 0)}`;
    }
    const m = Number(minor);
    const p = patch !== undefined ? Number(patch) : 0;
    const preSuffix = pre || "";
    return `>=${M}.${m}.${p}${preSuffix} <${upperBound(M, m + 1, 0)}`;
  });
}

function expandCaret(range: string): string {
  // ^1.2.3 := >=1.2.3 <2.0.0-0
  // ^0.2.3 := >=0.2.3 <0.3.0-0
  // ^0.0.3 := >=0.0.3 <0.0.4-0
  // ^0.0   := >=0.0.0 <0.1.0-0
  // ^0     := >=0.0.0 <1.0.0-0
  return range.replace(/\^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[a-zA-Z0-9._-]+)?)/g, (_, major, minor, patch, pre) => {
    const M = Number(major);
    const preSuffix = pre || "";
    if (minor === undefined) {
      // ^1 -> >=1.0.0 <2.0.0-0
      return `>=${M}.0.0 <${upperBound(M + 1, 0, 0)}`;
    }
    const m = Number(minor);
    if (patch === undefined) {
      if (M === 0) {
        // ^0.2 -> >=0.2.0 <0.3.0-0
        return `>=${M}.${m}.0 <${upperBound(M, m + 1, 0)}`;
      }
      return `>=${M}.${m}.0 <${upperBound(M + 1, 0, 0)}`;
    }
    const p = Number(patch);
    if (M === 0) {
      if (m === 0) {
        // ^0.0.3 -> >=0.0.3 <0.0.4-0
        return `>=${M}.${m}.${p}${preSuffix} <${upperBound(M, m, p + 1)}`;
      }
      // ^0.2.3 -> >=0.2.3 <0.3.0-0
      return `>=${M}.${m}.${p}${preSuffix} <${upperBound(M, m + 1, 0)}`;
    }
    return `>=${M}.${m}.${p}${preSuffix} <${upperBound(M + 1, 0, 0)}`;
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

function expandXRanges(range: string): string {
  // *, x, X -> >=0.0.0
  // 1.x, 1.*, 1 -> >=1.0.0 <2.0.0-0
  // 1.2.x, 1.2.*, 1.2 -> >=1.2.0 <1.3.0-0

  // Handle standalone wildcard
  if (/^\s*[*xX]\s*$/.test(range)) {
    return ">=0.0.0";
  }

  // Handle patterns like 1.x, 1.*, 1.X, 1.x.x etc.
  range = range.replace(/v?(\d+)\.[xX*](?:\.[xX*])?/g, (_, major) => {
    const M = Number(major);
    return `>=${M}.0.0 <${upperBound(M + 1, 0, 0)}`;
  });

  // Handle patterns like 1.2.x, 1.2.*
  range = range.replace(/v?(\d+)\.(\d+)\.[xX*]/g, (_, major, minor) => {
    const M = Number(major);
    const m = Number(minor);
    return `>=${M}.${m}.0 <${upperBound(M, m + 1, 0)}`;
  });

  // Handle bare partials: standalone "1" or "1.2" (not preceded by operator)
  // Use negative lookbehind to skip if preceded by comparison operators (with optional spaces)
  range = range.replace(/(^|[\s|])(\d+)\.(\d+)(?=\s|$)/g, (match, prefix, major, minor, offset) => {
    // Check if preceded by a comparison operator in the original string
    const before = range.substring(0, offset).trimEnd();
    if (/[<>=]$/.test(before)) return match;
    const M = Number(major);
    const m = Number(minor);
    return `${prefix}>=${M}.${m}.0 <${upperBound(M, m + 1, 0)}`;
  });

  range = range.replace(/(^|[\s|])(\d+)(?=\s|$)/g, (match, prefix, major, offset) => {
    // Check if preceded by a comparison operator
    const before = range.substring(0, offset).trimEnd();
    if (/[<>=]$/.test(before)) return match;
    const M = Number(major);
    return `${prefix}>=${M}.0.0 <${upperBound(M + 1, 0, 0)}`;
  });

  return range;
}

const rangeCache = new Map<string, Array<Array<Comparator>> | null>();

function parseRange(range: string): Array<Array<Comparator>> | null {
  const cached = rangeCache.get(range);
  if (cached !== undefined) return cached;
  const orGroups = range.split("||").map(g => g.trim());
  const result: Array<Array<Comparator>> = [];

  for (let group of orGroups) {
    if (!group) {
      // Empty group in || means match anything
      result.push([]);
      continue;
    }

    // Expand in order: hyphen -> caret -> tilde -> x-range
    group = expandHyphen(group);
    group = expandCaret(group);
    group = expandTilde(group);
    group = expandXRanges(group);

    // Normalize = prefix for exact versions
    group = group.replace(/(^|[\s])v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)*)?)\b/g, (match, prefix) => {
      if (/[<>=]/.test(prefix)) return match;
      return `${prefix}=${match.trim()}`;
    });

    // Merge operators with their following version (handle spaces like ">= 3.1")
    group = group.replace(/(>=|<=|>|<|=)\s+/g, "$1");

    const parts = group.split(/\s+/).filter(Boolean);
    const comparators: Array<Comparator> = [];

    for (const part of parts) {
      const comp = parseComparator(part);
      if (!comp) { rangeCache.set(range, null); return null; }
      comparators.push(comp);
    }

    if (comparators.length === 0) { rangeCache.set(range, null); return null; }
    result.push(comparators);
  }

  const final = result.length ? result : null;
  rangeCache.set(range, final);
  return final;
}

function testWithPrerelease(version: SemVer, comparators: Array<Comparator>): boolean {
  // All comparators in the AND group must pass
  for (const comp of comparators) {
    if (!testComparator(version, comp)) return false;
  }

  // Prerelease filtering: if version has prerelease tags,
  // at least one comparator must share the same [major, minor, patch]
  // and also have a prerelease tag
  if (version.prerelease.length > 0) {
    for (const comp of comparators) {
      if (comp.semver.prerelease.length > 0 &&
          comp.semver.major === version.major &&
          comp.semver.minor === version.minor &&
          comp.semver.patch === version.patch) {
        return true;
      }
    }
    return false;
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
  try {
    const parsed = parseRange(range);
    return parsed ? range : null;
  } catch {
    return null;
  }
}
