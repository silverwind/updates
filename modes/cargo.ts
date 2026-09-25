import {type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, getFetchOpts, normalizeUrl, throwFetchError} from "./shared.ts";
import {pushTo} from "../utils/utils.ts";
import {gt, parse, valid, satisfies} from "../utils/semver.ts";
import {splitDottedKey} from "../utils/toml.ts";
import {updateVersionRange} from "./npm.ts";

type SparseIndexRecord = {vers?: string; yanked?: boolean; pubtime?: string};

const cratesIoByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();

function indexSuffix(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

function reduceSparseIndex(body: string): string {
  return body.split("\n").map(line => {
    if (!line) return line;
    try {
      const {vers, yanked, pubtime} = JSON.parse(line) as SparseIndexRecord;
      return JSON.stringify({vers, yanked, pubtime});
    } catch {
      return line;
    }
  }).join("\n");
}

export async function fetchCratesIoInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const base = normalizeUrl(ctx.cratesIoUrl);
  const url = `${base === "https://crates.io" ? "https://index.crates.io" : base}/${indexSuffix(name)}`;

  const data = await dedupe(cratesIoByCtx, ctx, url, async () => {
    const result = await fetchWithEtag(url, ctx, getFetchOpts(), reduceSparseIndex);
    if (!("body" in result)) throwFetchError(result.res, url, name, ctx.cratesIoUrl);
    const versions: Record<string, Record<string, never>> = {};
    const time: Record<string, string> = {};
    let latest = "";
    let latestPre = "";
    let parsedLines = 0;
    for (const line of result.body.split("\n")) {
      if (!line) continue;
      let record: SparseIndexRecord | null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      parsedLines++;
      if (!record?.vers || record.yanked) continue;
      const version = record.vers.split("+")[0];
      versions[version] = {};
      if (record.pubtime) time[version] = record.pubtime;
      const parsed = parse(version);
      if (!parsed) continue;
      if (parsed.prerelease.length) {
        if (!latestPre || gt(version, latestPre)) latestPre = version;
      } else if (!latest || gt(version, latest)) {
        latest = version;
      }
    }
    if (!parsedLines && result.body.trim()) throw new Error(`Invalid JSON from ${url}`);
    return {name, versions, time, "dist-tags": {latest: latest || latestPre}};
  });
  return [data, null];
}

export function parseCargoLock(lockStr: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const block of lockStr.split("[[package]]")) {
    const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(block);
    const versionMatch = /\bversion\s*=\s*"([^"]+)"/.exec(block);
    if (nameMatch && versionMatch && valid(versionMatch[1])) pushTo(map, nameMatch[1], versionMatch[1]);
  }
  return map;
}

const startsWithDigitRe = /^\d/;
const wildcardRe = /^(\d+(?:\.\d+)*)((?:\.[*xX])+)$/;
const trimRe = /^(\s*)(.*?)(\s*)$/s;

export const cargoToNpmRange = (range: string): string => range.split(/\s*,\s*/)
  .map(part => {
    const value = part.trim();
    return startsWithDigitRe.test(value) && !wildcardRe.test(value) ? `^${value}` : value;
  })
  .join(" ");

function updateComparator(comparator: string, newVersion: string): string {
  const [_full, leading, value, trailing] = trimRe.exec(comparator)!;
  if (value.startsWith("<") && satisfies(newVersion, value)) return comparator;

  const wildcard = wildcardRe.exec(value);
  let updated: string;
  if (wildcard && parse(newVersion)?.prerelease.length) {
    updated = newVersion;
  } else if (wildcard) {
    const [_full, digits, stars] = wildcard;
    updated = `${newVersion.split(/[-+]/)[0].split(".").slice(0, digits.split(".").length).join(".")}${stars}`;
  } else if (startsWithDigitRe.test(value)) {
    updated = updateVersionRange(`^${value}`, newVersion, `^${value}`).replace(/^\^/, "");
  } else {
    updated = updateVersionRange(value, newVersion, value);
  }
  return `${leading}${updated}${trailing}`;
}

export function updateCargoRange(oldOrig: string, newVersion: string): string {
  return oldOrig.split(/(\s*,\s*)/).map((part, idx) => idx % 2 ? part : updateComparator(part, newVersion)).join("");
}

export function findLockedVersion(allVersions: Map<string, string[]>, name: string, range: string): string | undefined {
  const versions = allVersions.get(name);
  if (!versions) return undefined;
  const npmRange = cargoToNpmRange(range);
  let best: string | undefined;
  for (const version of versions) {
    if (satisfies(version, npmRange) && (!best || gt(version, best))) best = version;
  }
  return best;
}

const jsonStringArrayRe = /^\[(?:"(?:\\.|[^"\\])*"(?:,"(?:\\.|[^"\\])*")*)?\]/;
const tableHeaderRe = /^[ \t]*\[(\[?)[ \t]*([^[\]]+?)[ \t]*\]\1[ \t]*(?:#.*)?[ \t\r]*$/;
const versionLineRe = /^(\s*("(?:\\.|[^"\\])*"|'[^']*'|[\w-]+)\s*=\s*(?:\{(?:"[^"\n]*"|'[^'\n]*'|[^"'}\n])*?\bversion\s*=\s*)?["'])([^"'\n]*)(["'])/;

function multilineDelim(line: string, delimiter: string): string {
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (delimiter.length === 3) {
      if (!line.startsWith(delimiter, index)) continue;
      let backslashes = 0;
      while (line[index - backslashes - 1] === `\\`) backslashes++;
      if (!(delimiter === `"""` && backslashes % 2)) {
        index += 2;
        delimiter = "";
      }
    } else if (delimiter) {
      if (delimiter === `"` && char === `\\`) index++;
      else if (char === delimiter) delimiter = "";
    } else if (char === "#") {
      break;
    } else if ((char === `"` || char === `'`) && line.startsWith(char.repeat(3), index)) {
      delimiter = char.repeat(3); index += 2;
    } else if (char === `"` || char === `'`) { delimiter = char; }
  }
  return delimiter.length === 3 ? delimiter : "";
}

type CargoTable = {path: string, start: number, end: number, rewrites: Map<string, Deps[string]>};

function tableSpans(str: string): Array<CargoTable> {
  const spans: Array<CargoTable> = [];
  let delimiter = "";
  let pos = 0;
  for (const line of str.split("\n")) {
    const header = delimiter ? null : tableHeaderRe.exec(line);
    if (header) {
      if (spans.length) spans.at(-1)!.end = pos;
      spans.push({path: header[1] ? "" : JSON.stringify(splitDottedKey(header[2])), start: pos, end: str.length, rewrites: new Map()});
    } else {
      delimiter = multilineDelim(line, delimiter);
    }
    pos += line.length + 1;
  }
  return spans;
}

export function updateCargoToml(pkgStr: string, deps: Deps): string {
  const spans = tableSpans(pkgStr);
  for (const [key, dep] of Object.entries(deps)) {
    const [typeKey, name] = key.split(fieldSep);
    const typePath: Array<string> = typeKey.startsWith("[") ? JSON.parse(jsonStringArrayRe.exec(typeKey)![0]) :
      typeKey.split("|", 1)[0].split(".");
    const ownPath = JSON.stringify([...typePath, name]);
    const sectionPath = JSON.stringify(typePath);
    const ownSpan = spans.find(entry => entry.path === ownPath);
    const span = ownSpan ?? spans.find(entry => entry.path === sectionPath);
    if (!span) throw new Error(`Unable to locate Cargo table for ${typeKey}.${name}`);
    span.rewrites.set(ownSpan ? "version" : name, dep);
  }
  let result = pkgStr;
  for (const span of spans.reverse()) {
    if (!span.rewrites.size) continue;
    let delimiter = "";
    const scope = pkgStr.slice(span.start, span.end).replace(/^.*$/gm, originalLine => {
      const line = delimiter ? originalLine : originalLine.replace(versionLineRe, (match, prefix, rawKey, value, suffix) => {
        const dep = span.rewrites.get(splitDottedKey(rawKey)[0]);
        return dep && value === (dep.oldOrig || dep.old) ? `${prefix}${dep.new}${suffix}` : match;
      });
      delimiter = multilineDelim(line, delimiter);
      return line;
    });
    result = result.slice(0, span.start) + scope + result.slice(span.end);
  }
  return result;
}
