import {type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, getFetchOpts, normalizeUrl, throwFetchError} from "./shared.ts";
import {esc, pushTo} from "../utils/utils.ts";
import {gt, parse, valid, satisfies} from "../utils/semver.ts";
import {updateVersionRange, normalizeRange} from "./npm.ts";

type SparseIndexRecord = {vers?: string; yanked?: boolean; pubtime?: string};

const cratesIoByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();

function indexSuffix(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

function indexUrl(cratesIoUrl: string, name: string): string {
  const base = normalizeUrl(cratesIoUrl);
  return `${base === "https://crates.io" ? "https://index.crates.io" : base}/${indexSuffix(name)}`;
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
  const url = indexUrl(ctx.cratesIoUrl, name);

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
    if (!nameMatch || !versionMatch) continue;
    const name = nameMatch[1];
    const version = versionMatch[1];
    if (!valid(version)) continue;
    pushTo(map, name, version);
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
  const [, leading, value, trailing] = trimRe.exec(comparator)!;
  if (value.startsWith("<") && satisfies(newVersion, value)) return comparator;

  const wildcard = wildcardRe.exec(value);
  let updated: string;
  if (wildcard) {
    if (parse(newVersion)?.prerelease.length) {
      updated = newVersion;
    } else {
      const [, digits, stars] = wildcard;
      updated = `${newVersion.split(/[-+]/)[0].split(".").slice(0, digits.split(".").length).join(".")}${stars}`;
    }
  } else if (startsWithDigitRe.test(value)) {
    updated = updateVersionRange(normalizeRange(`^${value}`), newVersion, `^${value}`).replace(/^\^/, "");
  } else {
    updated = updateVersionRange(normalizeRange(value), newVersion, value);
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
    if (satisfies(version, npmRange) && (!best || gt(version, best))) {
      best = version;
    }
  }
  return best;
}

const tomlKey = (key: string) => `(?:${esc(key)}|"${esc(key)}"|'${esc(key)}')`;
const jsonStringArrayRe = /^\[(?:"(?:\\.|[^"\\])*"(?:,"(?:\\.|[^"\\])*")*)?\]/;

const tableHeaderRe = /^[ \t]*\[(\[?)[ \t]*([^[\]]+?)[ \t]*\]\1[ \t]*(?:#.*)?[ \t\r]*$/;

function multilineDelim(line: string, delimiter: string): string {
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (delimiter.length === 3) {
      let backslashes = 0;
      while (line[index - backslashes - 1] === `\\`) backslashes++;
      if (line.startsWith(delimiter, index) && !(delimiter === `"""` && backslashes % 2)) {
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

type CargoRewrite = {simpleRe: RegExp, inlineRe: RegExp, versionRe?: RegExp, newValue: string};
type CargoTable = {path: string, start: number, end: number, rewrites: Array<CargoRewrite>};

function tableSpans(str: string): Array<CargoTable> {
  const spans: Array<CargoTable> = [];
  let delimiter = "";
  let pos = 0;
  for (const line of str.split("\n")) {
    const header = delimiter ? null : tableHeaderRe.exec(line);
    if (header) {
      if (spans.length) spans.at(-1)!.end = pos;
      spans.push({path: header[1] ? "" : header[2], start: pos, end: str.length, rewrites: []});
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
    const oldValue = dep.oldOrig || dep.old;
    const newValue = dep.new;
    const nameEsc = tomlKey(name);
    const oldEsc = esc(oldValue);
    const typePath: Array<string> = typeKey.startsWith("[") ? JSON.parse(jsonStringArrayRe.exec(typeKey)![0]) :
      typeKey.split("|", 1)[0].split(".");
    const sectionEsc = typePath.map(tomlKey).join("\\.");
    const ownRe = new RegExp(`^${sectionEsc}\\.${nameEsc}$`);
    const sectionRe = new RegExp(`^${sectionEsc}$`);
    const ownSpan = spans.find(entry => ownRe.test(entry.path));
    const span = ownSpan ?? spans.find(entry => sectionRe.test(entry.path));
    if (!span) throw new Error(`Unable to locate Cargo table for ${typeKey}.${name}`);
    span.rewrites.push({
      simpleRe: new RegExp(`^(\\s*${nameEsc}\\s*=\\s*["'])${oldEsc}(["'].*)$`),
      inlineRe: new RegExp(`^(\\s*${nameEsc}\\s*=\\s*\\{(?:"[^"\\n]*"|'[^'\\n]*'|[^"'}\\n])*?\\bversion\\s*=\\s*["'])${oldEsc}(["'])`),
      ...(ownSpan && {versionRe: new RegExp(`^(\\s*version\\s*=\\s*["'])${oldEsc}(["'].*)$`)}),
      newValue,
    });
  }
  let result = pkgStr;
  for (const span of spans.reverse()) {
    if (!span.rewrites.length) continue;
    let delimiter = "";
    const scope = pkgStr.slice(span.start, span.end).replace(/^.*$/gm, originalLine => {
      let line = originalLine;
      if (!delimiter) {
        for (const rewrite of span.rewrites) {
          line = line.replace(rewrite.simpleRe, `$1${rewrite.newValue}$2`)
            .replace(rewrite.inlineRe, `$1${rewrite.newValue}$2`);
          if (rewrite.versionRe) line = line.replace(rewrite.versionRe, `$1${rewrite.newValue}$2`);
        }
      }
      delimiter = multilineDelim(line, delimiter);
      return line;
    });
    result = result.slice(0, span.start) + scope + result.slice(span.end);
  }
  return result;
}
