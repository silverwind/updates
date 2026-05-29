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

// https://peps.python.org/pep-0508/
export function parseUvDependencies(specs: Array<string>) {
  const ret: Array<{name: string, version: string}> = [];
  for (const spec of specs) {
    const match = /^([^<>=~!]+)(?:==|>=?|<=?|~=)([0-9.a-z]+)$/.exec(spec.replaceAll(/\s+/g, ""));
    if (!match) continue;
    const name = match[1].replace(/\[.*?\]$/, "");
    if (name) ret.push({name, version: match[2]});
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

export const uvTypes = [
  "project.dependencies",
  "project.optional-dependencies",
  "dependency-groups.dev",
  "dependency-groups.lint",
  "dependency-groups.test",
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

export function matchesAny(str: string, set: Set<RegExp> | boolean): boolean {
  if (set === true) return true;
  if (!(set instanceof Set)) return false;
  for (const re of set) if (re.test(str)) return true;
  return false;
}

export function getProperty(obj: Record<string, any>, path: string): Record<string, any> {
  return path.split(".").reduce((obj: Record<string, any>, prop: string) => obj?.[prop] ?? null, obj);
}

export function commaSeparatedToArray(str: string): Array<string> {
  return str.split(",").filter(Boolean);
}

export function timestamp(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${mo}-${da} ${h}:${mi}:${s}.${ms}`;
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

export const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");

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

export function memoizeAsync<K, V>(fn: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (k) => {
    let p = cache.get(k);
    if (!p) {
      p = fn(k);
      cache.set(k, p);
    }
    return p;
  };
}
