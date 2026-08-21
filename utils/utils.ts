import {dirname} from "node:path";

export function highlightDiff(a: string, b: string, colorFn: (str: string) => string): string {
  if (a === b) return a;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i > 0 && a[i - 1] !== "." && a[i - 1] !== "-") {
    let j = i - 1;
    while (j >= 0 && a[j] !== "." && a[j] !== "-") j--;
    if (j >= 0) {
      i = j + 1;
    } else {
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

const pep508Re = /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\s*)((?:\[[^\]]*\])?)(\s*)(.*)$/;
const pep508ParenRe = /^(\s*\()([^)]*)(\)\s*)$/;
const pep440SpecifierRe = /^(\s*)(===|==|!=|~=|<=|>=|<|>)(\s*)(\S+)(\s*)$/;
const lowerBoundOps = new Set(["===", "==", ">=", "~="]);
const plainVersionRe = /^v?\d[0-9a-z.!+_-]*$/i;

export type Pep508Specifier = {lead: string, op: string, sep: string, version: string, trail: string};

export type Pep508 = {
  name: string;
  extras: string;
  specifiers: Array<Pep508Specifier> | null;
  marker: string;
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

export function anchorSpecifier(specifiers: Array<Pep508Specifier>): Pep508Specifier | undefined {
  return specifiers.find(({op, version}) => lowerBoundOps.has(op) && plainVersionRe.test(version));
}

export function parseUvDependencies(specs: Array<unknown>) {
  const ret: Array<{name: string, version: string, spec: string}> = [];
  for (const spec of specs) {
    if (typeof spec !== "string") continue;
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
  "overrides",
  "pnpm.overrides",
  "packageManager",
];

export const nonPackageEngines = [
  "node",
  "deno",
  "bun",
];

export const forgeDirs = [".github", ".gitea", ".forgejo"] as const;

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

export const cargoTargetTypes = [
  "target.*.dependencies",
  "target.*.dev-dependencies",
  "target.*.build-dependencies",
];

export function expandDepTypes(types: Array<string>, doc: Record<string, any>): Array<[string, any]> {
  const ret: Array<[string, any]> = [];
  const walk = (segments: Array<string>, index: number, path: Array<string>, value: any, structured: boolean) => {
    if (index === segments.length) {
      if (value !== undefined) ret.push([structured ? JSON.stringify(path) : path.join("."), value]);
      return;
    }
    if (!value || typeof value !== "object") return;
    const segment = segments[index];
    const keys = segment !== "*" ? [segment] : Array.isArray(value) ? [] : Object.keys(value);
    for (const key of keys) walk(segments, index + 1, [...path, key], value[key], structured);
  };
  for (const type of types) walk(type.split("."), 0, [], doc, type.startsWith("target.*."));
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
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, -1);
}

export function textTable(rows: Array<Array<string>>, ansiLen: (str: string) => number): string {
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
      if (c > 0) ret += " ";
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

export async function tryOrNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export const esc: (str: string) => string = RegExp.escape ?
  (str) => RegExp.escape(str) :
  (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function longestFirstAlternation(keys: Iterable<string>): string {
  return Array.from(keys).sort((a, b) => b.length - a.length).map(esc).join("|");
}

const predicateTests = new WeakMap<RegExp, (value: string) => boolean>();

class PredicateRegExp extends RegExp {
  constructor(source: string, predicate: (value: string) => boolean, flags?: string) {
    super(source, flags);
    predicateTests.set(this, predicate);
  }

  override test(value: string): boolean {
    return predicateTests.get(this)!(value);
  }
}

function splitGlobAlternatives(value: string): Array<string> {
  const alternatives: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(" || value[i] === "{") depth++;
    else if (value[i] === ")" || value[i] === "}") depth--;
    else if ((value[i] === "|" || value[i] === ",") && depth === 0) {
      alternatives.push(value.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(value.slice(start));
  return alternatives;
}

function closingIndex(value: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    if (value[i] === open) depth++;
    else if (value[i] === close && --depth === 0) return i;
  }
  return -1;
}

function braceAlternatives(value: string): Array<string> {
  const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(value);
  if (!range) return splitGlobAlternatives(value);
  const numeric = /^-?\d+$/.test(range[1]) && /^-?\d+$/.test(range[2]);
  let current = numeric ? Number(range[1]) : range[1].codePointAt(0)!;
  const end = numeric ? Number(range[2]) : range[2].codePointAt(0)!;
  const step = Math.abs(Number(range[3]) || 1) * (current <= end ? 1 : -1);
  const alternatives: Array<string> = [];
  while ((step > 0 ? current <= end : current >= end) && alternatives.length < 1000) {
    alternatives.push(numeric ? String(current) : String.fromCodePoint(current));
    current += step;
  }
  return alternatives;
}

type GlobToken =
  {kind: "char", matcher: RegExp} |
  {kind: "span", slash: boolean} |
  {kind: "globstarSlash"} |
  {kind: "alternatives", alternatives: Array<Array<GlobToken>>, minimum: 0 | 1, repeat: boolean} |
  {kind: "negative", alternatives: Array<Array<GlobToken>>};

function parseGlob(pattern: string): {source: string, tokens: Array<GlobToken>} {
  let source = "";
  const tokens: Array<GlobToken> = [];
  const addChar = (charSource: string) => {
    source += charSource;
    tokens.push({kind: "char", matcher: new RegExp(`^(?:${charSource})$`, "i")});
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      addChar(esc(pattern[++i]));
    } else if (char === "*" && pattern[i + 1] !== "(") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          source += "(?:.*/)?";
          tokens.push({kind: "globstarSlash"});
          i++;
        } else {
          source += ".*";
          tokens.push({kind: "span", slash: true});
        }
      } else {
        source += ".*";
        tokens.push({kind: "span", slash: true});
      }
    } else if (char === "?" && pattern[i + 1] !== "(") {
      addChar("[^/]");
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) addChar("\\[");
      else {
        let content = pattern.slice(i + 1, end);
        if (content.startsWith("!")) content = `^${content.slice(1)}`;
        addChar(`[${content.replaceAll("\\", "\\\\")}]`);
        i = end;
      }
    } else if (char === "{") {
      const end = closingIndex(pattern, i, "{", "}");
      if (end === -1) addChar("\\{");
      else {
        const alternatives = braceAlternatives(pattern.slice(i + 1, end)).map(parseGlob);
        source += `(?:${alternatives.map(alternative => alternative.source).join("|")})`;
        tokens.push({
          kind: "alternatives",
          alternatives: alternatives.map(alternative => alternative.tokens),
          minimum: 1,
          repeat: false,
        });
        i = end;
      }
    } else if ("@+?*!".includes(char) && pattern[i + 1] === "(") {
      const end = closingIndex(pattern, i + 1, "(", ")");
      if (end === -1) addChar(esc(char));
      else {
        const alternatives = splitGlobAlternatives(pattern.slice(i + 2, end)).map(parseGlob);
        const alternativeSource = alternatives.map(alternative => alternative.source).join("|");
        source += char === "!" ? `(?!(?:${alternativeSource})(?:/|$))[^/]*` :
          `(?:${alternativeSource})${char === "@" ? "" : char}`;
        const alternativeTokens = alternatives.map(alternative => alternative.tokens);
        tokens.push(char === "!" ? {kind: "negative", alternatives: alternativeTokens} : {
          kind: "alternatives", alternatives: alternativeTokens, minimum: char === "?" || char === "*" ? 0 : 1,
          repeat: char === "+" || char === "*",
        });
        i = end;
      }
    } else {
      addChar(esc(char));
    }
  }
  return {source, tokens};
}

function matchGlob(tokens: Array<GlobToken>, value: string): boolean {
  const memo = new WeakMap<Array<GlobToken>, Map<number, Set<number>>>();
  const addSpan = (positions: Set<number>, start: number, slash: boolean) => {
    for (let end = start; ; end++) {
      positions.add(end);
      if (end === value.length || !slash && value[end] === "/") break;
    }
  };
  const matchSequence = (sequence: Array<GlobToken>, start: number): Set<number> => {
    let byStart = memo.get(sequence);
    if (!byStart) {
      byStart = new Map();
      memo.set(sequence, byStart);
    }
    const cached = byStart.get(start);
    if (cached) return cached;
    let positions = new Set([start]);
    byStart.set(start, positions);
    for (const token of sequence) {
      const next = new Set<number>();
      for (const position of positions) {
        if (token.kind === "char") {
          if (position < value.length && token.matcher.test(value[position])) next.add(position + 1);
        } else if (token.kind === "span") {
          addSpan(next, position, token.slash);
        } else if (token.kind === "globstarSlash") {
          next.add(position);
          for (let end = position; end < value.length; end++) if (value[end] === "/") next.add(end + 1);
        } else if (token.kind === "negative") {
          const excluded = token.alternatives.some(alternative =>
            [...matchSequence(alternative, position)].some(end => end === value.length || value[end] === "/"));
          if (!excluded) addSpan(next, position, false);
        } else {
          if (token.minimum === 0) next.add(position);
          const first = new Set(token.alternatives.flatMap(alternative => [...matchSequence(alternative, position)]));
          for (const end of first) next.add(end);
          if (token.repeat) {
            for (const end of next) {
              for (const alternative of token.alternatives) {
                for (const repeatedEnd of matchSequence(alternative, end)) next.add(repeatedEnd);
              }
            }
          }
        }
      }
      positions = next;
      if (!positions.size) break;
    }
    byStart.set(start, positions);
    return positions;
  };
  return matchSequence(tokens, 0).has(value.length);
}

export function patternToRegex(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) {
    return /[gy]/.test(pattern.flags) ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
  }
  const match = /^(!?)\/(.*)\/(i?)$/.exec(pattern);
  if (match) {
    try {
      const compiled = new RegExp(match[2], match[3]);
      return match[1] ? new PredicateRegExp(pattern, value => !compiled.test(value)) : compiled;
    } catch {}
  }
  let negateCount = 0;
  while (pattern[negateCount] === "!" && pattern[negateCount + 1] !== "(") negateCount++;
  const negated = negateCount % 2 === 1;
  const glob = pattern.slice(negateCount);
  const {source, tokens} = parseGlob(glob);
  const compiled = new RegExp(`^${source}$`, "i");
  const predicate = (value: string) => matchGlob(tokens, value);
  return negated ? new PredicateRegExp(pattern, value => !predicate(value)) :
    new PredicateRegExp(compiled.source, predicate, compiled.flags);
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

export function walkUpSync<T>(startDir: string, probe: (dir: string) => T | null): T | null {
  let dir = startDir;
  while (true) {
    const found = probe(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function pushTo<K, V>(map: Map<K, Array<V>>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

type MapLike<K, V> = {has: (key: K) => boolean, get: (key: K) => V | undefined, set: (key: K, value: V) => unknown};

export function getOrSet<K, V>(map: MapLike<K, V>, key: K, make: () => V): V {
  const cached = map.get(key);
  if (cached !== undefined || map.has(key)) return cached!;
  const value = make();
  map.set(key, value);
  return value;
}

export function memoizeAsync<K, V>(fn: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (k) => getOrSet(cache, k, () => fn(k));
}
