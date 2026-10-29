import {
  type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, reduceJson, throwFetchError,
} from "./shared.ts";
import {type Pep440, comparePep440, parsePep440} from "../utils/semver.ts";
import {parseValue, unquotedIndex} from "../utils/toml.ts";
import {anchorSpecifier, getOrSet, parsePep508, serializePep508, type Pep508Specifier} from "../utils/utils.ts";

const pypiNameSeparatorRe = /[-_.]+/g;

type PypiFile = {upload_time_iso_8601?: string, yanked?: boolean};

const pypiDataByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();

function reducePypiReleases(data: Record<string, any>): Record<string, Array<PypiFile>> {
  return Object.fromEntries(Object.entries(data ?? {}).map(([version, files]) => [
    version, ((files as Array<Record<string, any>>) ?? []).map(file => ({
      ...(file.upload_time_iso_8601 && {upload_time_iso_8601: file.upload_time_iso_8601}),
      ...(file.yanked && {yanked: true}),
    })),
  ]));
}

export async function fetchPypiInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const url = `${ctx.pypiApiUrl}/pypi/${name.toLowerCase().replace(pypiNameSeparatorRe, "-")}/json`;
  const data = await dedupe(pypiDataByCtx, ctx, url, async () => {
    const result = await fetchWithEtag(url, ctx, {
      headers: {"accept-encoding": "gzip, deflate, br"},
    }, reduceJson(data => {
      const {name: reducedName, version, project_urls} = data.info ?? {};
      return {info: {name: reducedName, version, project_urls}, releases: reducePypiReleases(data.releases)};
    }));
    if (!("body" in result)) throwFetchError(result.res, url, name, ctx.pypiApiUrl);
    const responseData = JSON.parse(result.body);
    return {...responseData, releases: reducePypiReleases(responseData.releases)};
  });
  return [{...data, name}, null];
}

function specifierAllows(version: Pep440, {op, version: text}: Pep508Specifier): boolean {
  if (op === "===") return text === version.version;
  if (text.endsWith(".*")) {
    const prefix = parsePep440(text.slice(0, -2));
    if (!prefix || prefix.dev !== null || prefix.local || op !== "==" && op !== "!=") return false;
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
  if (op === "<=") return cmp <= 0;
  const sameRelease = version.epoch === parsed.epoch &&
    Array.from({length: Math.max(version.release.length, parsed.release.length)})
      .every((_, idx) => (version.release[idx] ?? 0) === (parsed.release[idx] ?? 0));
  if (op === ">") return cmp > 0 && !(sameRelease && version.post !== null && parsed.post === null);
  if (op === "<") return cmp < 0 && !(sameRelease && (version.pre || version.dev !== null) && !parsed.pre && parsed.dev === null);
  return cmp >= 0 && parsed.release.length > 1 && parsed.epoch === version.epoch &&
    parsed.release.slice(0, -1).every((part, idx) => (version.release[idx] ?? 0) === part);
}

function orderedVersion(version: Pep440, length = version.release.length): string {
  if (!version.local && length === version.release.length) return version.version;
  const release = Array.from({length}, (_, idx) => version.release[idx] ?? 0);
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

export function isPypiRange(range: string): boolean {
  const requirement = parsePep508(`x${range.trim()}`);
  return Boolean(parsePep440(range.trim()) || requirement?.specifiers?.length && !requirement.extras && !requirement.marker &&
    requirement.specifiers.every(({op, version}) => {
      const parsed = parsePep440(version.replace(/\.\*$/, ""));
      if (!parsed) return false;
      if (version.endsWith(".*")) return (op === "==" || op === "!=") && parsed.dev === null && !parsed.local;
      return (op !== "~=" || parsed.release.length > 1) && (!parsed.local || ["==", "!=", "==="].includes(op));
    }));
}

export function pypiSatisfies(version: string, range: string): boolean {
  const parsed = parsePep440(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed) return true;
  const bareVersion = parsePep440(trimmed);
  if (bareVersion) return comparePep440(parsed, bareVersion) === 0;
  const requirement = parsePep508(`x${trimmed}`);
  if (!requirement?.specifiers?.length || requirement.extras || requirement.marker) return false;
  return requirement.specifiers.every(specifier => specifierAllows(parsed, specifier));
}

export function updateRequirement(text: string, oldValue: string, newValue: string): string | null {
  const parsed = parsePep508(text);
  const oldParsed = parsePep440(oldValue);
  const newParsed = parsePep440(newValue);
  if (!parsed?.specifiers || !oldParsed || !newParsed) return null;
  const specifiers = parsed.specifiers;
  const anchor = anchorSpecifier(specifiers);
  if (anchor?.version !== oldValue) return null;
  for (const specifier of specifiers) {
    if (specifier === anchor) {
      const releaseLength = specifier.op === "~=" ? oldParsed.release.length : newParsed.release.length;
      specifier.version = specifier.op === "==" || specifier.op === "===" ? newValue : orderedVersion(newParsed, releaseLength);
    } else if (specifierAllows(newParsed, specifier)) {
      continue;
    } else {
      const cap = parsePep440(specifier.version);
      if (specifier.op === "<" && cap) specifier.version = raisedUpperBound(cap, oldParsed, newParsed);
      else if (specifier.op === "<=") specifier.version = orderedVersion(newParsed);
      else if (specifier.op === "~=" && cap?.epoch === newParsed.epoch) specifier.version = orderedVersion(newParsed, cap.release.length);
      else return null;
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

function arrayEnd(text: string, start: number): number {
  const open = text.indexOf("[", start);
  if (open === -1 || text.slice(start, open).trim()) return -1;
  let depth = 0;
  let quote = "";
  let comment = false;
  for (let idx = open; idx < text.length; idx++) {
    const char = text[idx];
    if (comment) {
      if (char === "\n") comment = false;
    } else if (quote) {
      if (quote === `"` && char === `\\`) idx++;
      else if (char === quote) quote = "";
    } else if (char === `"` || char === `'`) quote = char;
    else if (char === "#") comment = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return idx + 1;
  }
  return -1;
}

function dependencyArrays(text: string, depTypes: Map<string, unknown>): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let section: Array<string> = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const table = /^\[([^\]]+)\](?:\s*#.*)?$/.exec(line.trim());
    if (table) section = splitTomlPath(table[1]);
    else {
      const eq = unquotedIndex(line, "=", "#");
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
    const fields = key.split(fieldSep);
    getOrSet(depsByType, fields[0], () => new Map()).set(fields[2], dep);
  }
  const spans = dependencyArrays(pkgStr, depsByType);
  let newPkgStr = pkgStr;
  for (const [depType, span] of Array.from(spans).reverse()) {
    const byRequirement = depsByType.get(depType)!;
    const value = newPkgStr.slice(...span).replace(
      /#.*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*'/g,
      text => {
        if (text.startsWith("#")) return text;
        const requirement = parseValue(text) as string;
        const dep = byRequirement.get(requirement);
        if (!dep) return text;
        const updated = updateRequirement(requirement, dep.oldOrig || dep.old, dep.new);
        return updated ? text[0] === `"` && text.includes("\\") ? JSON.stringify(updated) : text.replace(requirement, () => updated) : text;
      },
    );
    newPkgStr = `${newPkgStr.slice(0, span[0])}${value}${newPkgStr.slice(span[1])}`;
  }
  return newPkgStr;
}
