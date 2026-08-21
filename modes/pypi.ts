import {
  type Deps, type ModeContext, type PackageInfo, fieldSep, fetchWithEtag, reduceJson, throwFetchError,
} from "./shared.ts";
import {type Pep440, comparePep440, parsePep440} from "../utils/semver.ts";
import {type Pep508Specifier, anchorSpecifier, esc, getOrSet, parsePep508, serializePep508} from "../utils/utils.ts";

type PypiFile = {upload_time_iso_8601?: string, yanked?: boolean};

function reducePypiReleases(data: Record<string, any>): Record<string, Array<PypiFile>> {
  const releases: Record<string, Array<PypiFile>> = {};
  for (const [version, files] of Object.entries(data ?? {})) {
    releases[version] = ((files as Array<Record<string, any>>) ?? []).map(file => ({
      ...(file.upload_time_iso_8601 && {upload_time_iso_8601: file.upload_time_iso_8601}),
      ...(file.yanked && {yanked: true}),
    }));
  }
  return releases;
}

export async function fetchPypiInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const url = `${ctx.pypiApiUrl}/pypi/${name.toLowerCase().replace(/[-_.]+/g, "-")}/json`;
  const result = await fetchWithEtag(url, ctx, {
    headers: {"accept-encoding": "gzip, deflate, br"},
  }, reduceJson(data => {
    const {name: reducedName, version, project_urls} = data.info ?? {};
    return {info: {name: reducedName, version, project_urls}, releases: reducePypiReleases(data.releases)};
  }));
  if ("body" in result) {
    const data = JSON.parse(result.body);
    return [{...data, releases: reducePypiReleases(data.releases), name}, null];
  }
  throwFetchError(result.res, url, name, ctx.pypiApiUrl);
}

function specifierAllows(version: Pep440, {op, version: text}: Pep508Specifier): boolean {
  if (op === "===") return text === version.version;
  if (text.endsWith(".*")) {
    const prefix = parsePep440(text.slice(0, -2));
    if (!prefix || op !== "==" && op !== "!=") return false;
    const matches = prefix.epoch === version.epoch &&
      prefix.release.every((part, idx) => (version.release[idx] ?? 0) === part);
    return op === "==" ? matches : !matches;
  }
  const parsed = parsePep440(text);
  if (!parsed) return false;
  if (parsed.local && op !== "==" && op !== "!=") return false;
  const publicVersion = version.local ? {...version, local: null} : version;
  const cmp = comparePep440(publicVersion, parsed);
  const equalityCmp = parsed.local ? comparePep440(version, parsed) : cmp;
  if (op === "==") return equalityCmp === 0;
  if (op === "!=") return equalityCmp !== 0;
  if (op === ">=") return cmp >= 0;
  const sameRelease = version.epoch === parsed.epoch &&
    Array.from({length: Math.max(version.release.length, parsed.release.length)})
      .every((_, idx) => (version.release[idx] ?? 0) === (parsed.release[idx] ?? 0));
  if (op === ">") return cmp > 0 && !(sameRelease && version.post !== null && parsed.post === null);
  if (op === "<=") return cmp <= 0;
  if (op === "<") return cmp < 0 && !(sameRelease && (version.pre || version.dev !== null) && !parsed.pre && parsed.dev === null);
  return cmp >= 0 && parsed.release.length > 1 && parsed.epoch === version.epoch &&
    parsed.release.slice(0, -1).every((part, idx) => (version.release[idx] ?? 0) === part);
}

function orderedVersion(version: Pep440, release = version.release): string {
  if (!version.local && release === version.release) return version.version;
  const epoch = version.epoch || /^[vV]?\d+!/.test(version.version) ? `${version.epoch}!` : "";
  const pre = version.pre ? `${version.pre[0]}${version.pre[1]}` : "";
  const post = version.post === null ? "" : `.post${version.post}`;
  const dev = version.dev === null ? "" : `.dev${version.dev}`;
  return `${epoch}${release.join(".")}${pre}${post}${dev}`;
}

function raisedUpperBound(cap: Pep440, lower: Pep440, version: Pep440): string {
  let precision = cap.release.findIndex((part, idx) => part > lower.release[idx]);
  if (precision === 0 && cap.release[1] === 0) precision = 1;
  else if (precision === -1) precision = cap.release.length - 1;
  const release = cap.release.map((_, idx) => idx > precision ? 0 : (version.release[idx] ?? 0) + Number(idx === precision));
  return `${version.epoch ? `${version.epoch}!` : ""}${release.join(".")}`;
}

export function pypiSatisfies(version: string, range: string): boolean {
  const parsed = parsePep440(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed) return true;
  if (parsePep440(trimmed)) {
    return specifierAllows(parsed, {lead: "", op: "==", sep: "", version: trimmed, trail: ""});
  }
  const requirement = parsePep508(`x${trimmed}`);
  const specifiers = requirement?.specifiers;
  if (!requirement || requirement.extras || requirement.marker || !specifiers?.length) return false;
  return specifiers.every(specifier => specifierAllows(parsed, specifier));
}

export function updateRequirement(text: string, oldValue: string, newValue: string): string | null {
  const parsed = parsePep508(text);
  const specifiers = parsed?.specifiers;
  const oldParsed = parsePep440(oldValue);
  const newParsed = parsePep440(newValue);
  if (!parsed || !specifiers || !oldParsed || !newParsed) return null;
  const anchor = anchorSpecifier(specifiers);
  if (anchor?.version !== oldValue) return null;
  for (const specifier of specifiers) {
    if (specifier === anchor) {
      specifier.version = specifier.op === "~=" ? oldParsed.release.length === newParsed.release.length ? orderedVersion(newParsed) :
        orderedVersion(newParsed, Array.from({length: oldParsed.release.length}, (_, idx) => newParsed.release[idx] ?? 0)) :
        specifier.op === "==" || specifier.op === "===" ? newValue : orderedVersion(newParsed);
    } else if (!specifierAllows(newParsed, specifier)) {
      const cap = parsePep440(specifier.version);
      if (specifier.op === "<" && cap) specifier.version = raisedUpperBound(cap, oldParsed, newParsed);
      else if (specifier.op === "<=") specifier.version = orderedVersion(newParsed);
    }
    if (!specifierAllows(newParsed, specifier)) return null;
  }
  return serializePep508(parsed, specifiers);
}

function splitTomlPath(text: string): Array<string> {
  const parts: Array<string> = [];
  const partRe = /\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([\w-]+))\s*(?:\.|$)/gy;
  try {
    while (partRe.lastIndex < text.length) {
      const match = partRe.exec(text);
      if (!match) return [];
      parts.push(match[1] === undefined ? match[2] ?? match[3] : JSON.parse(`"${match[1]}"`));
    }
  } catch {
    return [];
  }
  return parts;
}

function assignmentIndex(line: string): number {
  let quote = "";
  let escaped = false;
  for (let idx = 0; idx < line.length; idx++) {
    const char = line[idx];
    if (quote) {
      if (quote === `"` && char === `\\` && !escaped) escaped = true;
      else {
        if (char === quote && !escaped) quote = "";
        escaped = false;
      }
    } else if (char === `"` || char === `'`) quote = char;
    else if (char === "=") return idx;
    else if (char === "#") return -1;
  }
  return -1;
}

function arrayEnd(text: string, start: number): number {
  const open = text.indexOf("[", start);
  if (open === -1 || text.slice(start, open).trim()) return -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let comment = false;
  for (let idx = open; idx < text.length; idx++) {
    const char = text[idx];
    if (comment) {
      if (char === "\n") comment = false;
    } else if (quote) {
      if (quote === `"` && char === `\\` && !escaped) escaped = true;
      else {
        if (char === quote && !escaped) quote = "";
        escaped = false;
      }
    } else if (char === `"` || char === `'`) quote = char;
    else if (char === "#") comment = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return idx + 1;
  }
  return -1;
}

function dependencyArrays(text: string, depTypes: Set<string>): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let section: Array<string> = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const table = /^\[([^\]]+)\](?:\s*#.*)?$/.exec(line.trim());
    if (table) section = splitTomlPath(table[1]);
    else {
      const eq = assignmentIndex(line);
      const depType = eq === -1 ? "" : [...section, ...splitTomlPath(line.slice(0, eq))].join(".");
      if (depTypes.has(depType) && !spans.has(depType)) {
        const start = offset + eq + 1;
        const end = arrayEnd(text, start);
        if (end !== -1) spans.set(depType, [start, end]);
      }
    }
    offset += line.length;
  }
  return spans;
}

export function updatePyprojectToml(pkgStr: string, deps: Deps): string {
  const depsByType = new Map<string, Map<string, Deps[string]>>();
  for (const [key, dep] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
    getOrSet(depsByType, depType, () => new Map()).set(name, dep);
  }
  const spans = dependencyArrays(pkgStr, new Set(depsByType.keys()));
  let newPkgStr = pkgStr;
  for (const [depType, span] of Array.from(spans).sort((left, right) => right[1][0] - left[1][0])) {
    const byName = depsByType.get(depType)!;
    const names = Array.from(byName.keys()).sort((left, right) => right.length - left.length).map(esc).join("|");
    const value = newPkgStr.slice(...span).replace(
      new RegExp(`(['"])( *(${names})(?![\\w.-]).*?)(?=\\1)`, "g"),
      (_, quote, requirement, name) => {
        const {old, oldOrig, new: newValue} = byName.get(name)!;
        return `${quote}${updateRequirement(requirement, oldOrig || old, newValue) ?? requirement}`;
      },
    );
    newPkgStr = `${newPkgStr.slice(0, span[0])}${value}${newPkgStr.slice(span[1])}`;
  }
  return newPkgStr;
}
