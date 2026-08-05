import {dirname} from "node:path";

export function highlightDiff(a: string, b: string, colorFn: (str: string) => string): string {
  if (a === b) return a;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // Back up to a version part boundary to avoid splitting numbers
  if (i > 0 && a[i - 1] !== "." && a[i - 1] !== "-") {
    let j = i - 1;
    while (j >= 0 && a[j] !== "." && a[j] !== "-") j--;
    if (j >= 0) {
      i = j + 1;
    } else {
      // No separator found, preserve non-digit prefix (v, ^, >=, ~)
      let d = 0;
      while (d < i) {
        const code = a.charCodeAt(d);
        if (code >= 48 && code <= 57) break;
        d++;
      }
      i = d;
    }
  }
  const diff = a.substring(i);
  return diff ? a.substring(0, i) + colorFn(diff) : a;
}

// Name, optional extras and everything up to the marker, spacing captured for re-serializing.
const pep508Re = /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\s*)((?:\[[^\]]*\])?)(\s*)(.*)$/;
const pep508ParenRe = /^(\s*\()([^)]*)(\)\s*)$/; // `packaging (==20.0.0)`
// The version is anything non-blank, so a cap or exclusion is recognized even as a wildcard.
const pep440SpecifierRe = /^(\s*)(===|==|!=|~=|<=|>=|<|>)(\s*)(\S+)(\s*)$/;
// Only a lower bound states the version the project is on. `<`, `<=`, `!=` and `>` exclude versions,
// so bumping one would change what the spec allows. Renovate leaves `>` as authored too, which
// makes a `>`-only requirement unbumpable.
const lowerBoundOps = new Set(["===", "==", ">=", "~="]);
// A wildcard (`==1.4.*`) or arbitrary equality on a non-version (`===foo`) has nothing to bump.
const plainVersionRe = /^v?\d[0-9a-z.!+_-]*$/i;

export type Pep508Specifier = {lead: string, op: string, sep: string, version: string, trail: string};

export type Pep508 = {
  name: string;
  extras: string;
  /** null when the set does not parse in full, so a writer never rewrites what it did not read. */
  specifiers: Array<Pep508Specifier> | null;
  marker: string; // the environment marker with its `;`, verbatim
  // Verbatim spacing, name, extras and parens, so serializePep508 reproduces an untouched requirement.
  head: string;
  open: string;
  close: string;
};

function parseSpecifiers(text: string): Array<Pep508Specifier> | null {
  const specifiers: Array<Pep508Specifier> = [];
  for (const part of text.split(",")) {
    const match = pep440SpecifierRe.exec(part);
    if (!match) return null;
    const [, lead, op, sep, version, trail] = match;
    specifiers.push({lead, op, sep, version, trail});
  }
  return specifiers;
}

/** Parse one PEP 508 requirement. https://peps.python.org/pep-0508/ */
export function parsePep508(text: string): Pep508 | null {
  const semi = text.indexOf(";");
  const match = pep508Re.exec(semi === -1 ? text : text.slice(0, semi));
  if (!match) return null;
  const [, lead, name, space, extras, gap, set] = match;
  const paren = pep508ParenRe.exec(set);
  return {
    name,
    extras,
    specifiers: parseSpecifiers(paren ? paren[2] : set),
    marker: semi === -1 ? "" : text.slice(semi),
    head: `${lead}${name}${space}${extras}${gap}`,
    open: paren?.[1] ?? "",
    close: paren?.[3] ?? "",
  };
}

export function serializePep508({head, open, close, marker}: Pep508, specifiers: Array<Pep508Specifier>): string {
  const set = specifiers.map(({lead, op, sep, version, trail}) => `${lead}${op}${sep}${version}${trail}`).join(",");
  return `${head}${open}${set}${close}${marker}`;
}

// The specifier a requirement's version is read from, and the only one a writer bumps: anchoring
// elsewhere would move a specifier the reported version never came from.
export function anchorSpecifier(specifiers: Array<Pep508Specifier>): Pep508Specifier | undefined {
  return specifiers.find(({op, version}) => lowerBoundOps.has(op) && plainVersionRe.test(version));
}

export function parseUvDependencies(specs: Array<unknown>) {
  const ret: Array<{name: string, version: string, spec: string}> = [];
  for (const spec of specs) {
    if (typeof spec !== "string") continue; // PEP 735 `{include-group = "..."}` and other tables
    const parsed = parsePep508(spec);
    if (!parsed?.specifiers) continue;
    const anchor = anchorSpecifier(parsed.specifiers);
    if (anchor) ret.push({name: parsed.name, version: anchor.version, spec});
  }
  return ret;
}

export const npmTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "resolutions",
  "packageManager",
];

export const nonPackageEngines = [
  "node",
  "deno",
  "bun",
];

// Forge config directories holding workflow files, in discovery order.
export const forgeDirs = [".github", ".gitea", ".forgejo"] as const;

// Manifest filenames that select a mode. Also drives which registry origins get
// a socket pre-warmed, so a new entry must be handled in prewarmOrigins too —
// utils/prewarm.test.ts fails if one is missed.
export const modeByFileName: Record<string, string> = {
  "pnpm-workspace.yaml": "npm",
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "go.work": "go",
  "go.mod": "go",
  "Cargo.toml": "cargo",
};

export const uvTypes = [
  "project.dependencies",
  "project.optional-dependencies.*",
  "dependency-groups.*",
];

export const goTypes = [
  "deps",
  "indirect",
  "replace",
  "tool",
];

export const cargoTypes = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "workspace.dependencies",
];

// Target names are arbitrary (`cfg(unix)`, `x86_64-pc-windows-msvc`), so these need a manifest.
export const cargoTargetTypes = [
  "target.*.dependencies",
  "target.*.dev-dependencies",
  "target.*.build-dependencies",
];

// Resolve dep type paths against a parsed manifest, so `*` segments take group and target names
// from the document. Each path comes back with the table it resolved to, so a key that legally
// contains a dot (`[project.optional-dependencies."extra.one"]`) is never re-split and lost.
export function expandDepTypes(types: Array<string>, doc: Record<string, any>): Array<[string, any]> {
  const ret: Array<[string, any]> = [];
  const walk = (segments: Array<string>, index: number, path: string, value: any) => {
    if (index === segments.length) {
      if (value !== undefined) ret.push([path, value]);
      return;
    }
    if (!value || typeof value !== "object") return;
    const segment = segments[index];
    const keys = segment !== "*" ? [segment] : Array.isArray(value) ? [] : Object.keys(value);
    for (const key of keys) walk(segments, index + 1, path ? `${path}.${key}` : key, value[key]);
  };
  for (const type of types) walk(type.split("."), 0, "", doc);
  return ret;
}

export function matchesAny(str: string, set: Set<RegExp> | boolean): boolean {
  if (set === true) return true;
  if (!(set instanceof Set)) return false;
  for (const re of set) if (re.test(str)) return true;
  return false;
}

export function commaSeparatedToArray(str: string): Array<string> {
  return str.split(",").filter(Boolean);
}

export function timestamp(): string {
  const now = new Date();
  // Shifting by the offset makes the UTC fields of toISOString read as local time.
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, -1);
}

export function textTable(rows: Array<Array<string>>, ansiLen: (str: string) => number, hsep = " "): string {
  const colSizes = new Array(rows[0].length).fill(0);
  const lens = new Array<Array<number>>(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowLens = new Array(row.length);
    for (let c = 0; c < row.length; c++) {
      const len = ansiLen(row[c]);
      rowLens[c] = len;
      if (len > colSizes[c]) colSizes[c] = len;
    }
    lens[r] = rowLens;
  }
  let ret = "";
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const lastCol = row.length - 1;
    for (let c = 0; c <= lastCol; c++) {
      if (c > 0) ret += hsep;
      ret += row[c];
      if (c !== lastCol) {
        const pad = colSizes[c] - lens[r][c];
        if (pad > 0) ret += " ".repeat(pad);
      }
    }
    if (r < rows.length - 1) ret += "\n";
  }
  return ret;
}

const durationUnits: Record<string, number> = {y: 365, m: 30, w: 7, d: 1, h: 1 / 24, s: 1 / 86400};

/** Parse a duration string (e.g. "7d", "2w", "1y") into days. Without unit, the value is treated as days. */
export function parseDuration(str: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z])$/i.exec(str);
  if (match) {
    const [, num, unit] = match;
    const multiplier = durationUnits[unit.toLowerCase()];
    if (multiplier) return Number(num) * multiplier;
  }
  if (!/^\d+(?:\.\d+)?$/.test(str)) throw new Error(`Invalid cooldown value: ${str}`);
  return Number(str);
}

export function parsePositiveInt(value: string | number, label: string): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded) || rounded < 1) throw new Error(`Invalid ${label}: ${value}`);
  return rounded;
}

export async function pMap<T, R>(iterable: Iterable<T>, mapper: (item: T) => Promise<R>, {concurrency = Infinity}: {concurrency?: number} = {}): Promise<Array<R>> {
  const items = Array.from(iterable);
  if (!Number.isFinite(concurrency)) return Promise.all(items.map(mapper));
  const results = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(Math.max(concurrency, 1), items.length)}, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await mapper(items[idx]);
    }
  }));
  return results;
}

// Resolve a promise to its value, or null if it rejects.
export async function tryOrNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

// RegExp.escape needs Node 24; fall back to a manual escape on Node 22. The
// feature check runs once, not on every call.
export const esc: (str: string) => string = RegExp.escape ?
  (str) => RegExp.escape(str) :
  (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest first, so a key that is a prefix of another cannot shadow it. One alternation also
// keeps a rewrite to a single pass, where per-key passes would re-match what a key just wrote.
export function longestFirstAlternation(keys: Iterable<string>): string {
  return Array.from(keys).sort((a, b) => b.length - a.length).map(esc).join("|");
}

// A string pattern is a case-insensitive glob, a RegExp is taken as authored. CLI `/regex/` strings
// are already RegExp objects by the time they arrive here.
export function patternToRegex(pattern: string | RegExp): RegExp {
  if (!(pattern instanceof RegExp)) return new RegExp(`^${esc(pattern).replaceAll("\\*", ".*")}$`, "i");
  // strip g/y: these matchers are only used with .test(), where a stateful lastIndex flakes
  return /[gy]/.test(pattern.flags) ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
}

export async function walkUp<T>(startDir: string, probe: (dir: string) => Promise<T | null>): Promise<T | null> {
  let dir = startDir;
  while (true) {
    const found = await probe(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Append to a Map-of-arrays, creating the bucket on first use.
export function pushTo<K, V>(map: Map<K, Array<V>>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

type MapLike<K, V> = {has: (key: K) => boolean, get: (key: K) => V | undefined, set: (key: K, value: V) => unknown};

// Read through a memo, filling it on first use. `has`, not a truthy get, so a cached null counts.
export function getOrSet<K, V>(map: MapLike<K, V>, key: K, make: () => V): V {
  if (!map.has(key)) map.set(key, make());
  return map.get(key)!;
}

export function memoizeAsync<K, V>(fn: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (k) => getOrSet(cache, k, () => fn(k));
}
