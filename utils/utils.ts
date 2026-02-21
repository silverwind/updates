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
      while (d < i && !/\d/.test(a[d])) d++;
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
    const [name, version] = spec.replaceAll(/\s+/g, "").split(/[<>=~]+/);
    if (name && /^[0-9.a-z]+$/.test(version)) {
      ret.push({name, version});
    }
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

export const optionalNpmTypes = [
  "engines",
];

export const nonPackageEngines = [
  "node",
  "deno",
  "bun",
];

export const poetryTypes = [
  "tool.poetry.dependencies",
  "tool.poetry.dev-dependencies",
  "tool.poetry.test-dependencies",
  "tool.poetry.group.dev.dependencies",
  "tool.poetry.group.test.dependencies",
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
  "replace",
];

export function matchesAny(str: string, set: Set<RegExp> | boolean): boolean {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

export function getProperty(obj: Record<string, any>, path: string): Record<string, any> {
  return path.split(".").reduce((obj: Record<string, any>, prop: string) => obj?.[prop] ?? null, obj);
}

export function commaSeparatedToArray(str: string): Array<string> {
  return str.split(",").filter(Boolean);
}

export function canIncludeByDate(date: string | undefined, cooldownDays: number, now: number) {
  if (!date || !cooldownDays) return true;
  const diffDays = (now - Date.parse(date)) / (24 * 3600 * 1000);
  return diffDays >= cooldownDays;
}

export function timestamp(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    "-",
    String(date.getMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getDate()).padStart(2, "0"),
    " ",
    String(date.getHours()).padStart(2, "0"),
    ":",
    String(date.getMinutes()).padStart(2, "0"),
    ":",
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

export function textTable(rows: Array<Array<string>>, ansiLen: (str: string) => number, hsep = " "): string {
  let ret = "";
  const colSizes = new Array(rows[0].length).fill(0);
  for (const row of rows) {
    for (const [colIndex, col] of row.entries()) {
      const len = ansiLen(col);
      if (len > colSizes[colIndex]) {
        colSizes[colIndex] = len;
      }
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    for (const [colIndex, col] of row.entries()) {
      if (colIndex > 0) ret += hsep;
      const space = " ".repeat(colSizes[colIndex] - ansiLen(col));
      ret += col + (colIndex === row.length - 1 ? "" : space);
    }
    if (rowIndex < rows.length - 1) ret += "\n";
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
  const num = Number(str);
  if (!Number.isFinite(num)) throw new Error(`Invalid cooldown value: ${str}`);
  return num;
}
