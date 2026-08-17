import {type Deps, type ModeContext, type PackageInfo, dedupe, fieldSep, fetchWithEtag, getFetchOpts, normalizeUrl, throwFetchError} from "./shared.ts";
import {esc, pushTo} from "../utils/utils.ts";
import {gt, parse, valid, satisfies} from "../utils/semver.ts";
import {updateVersionRange, normalizeRange} from "./npm.ts";

type SparseIndexRecord = {vers?: string; yanked?: boolean; pubtime?: string};

const cratesIoByCtx = new WeakMap<ModeContext, Map<string, Promise<Record<string, any>>>>();

// The index is sharded by lowercased name length: `1/a`, `2/ab`, `3/a/abc`, `se/rd/serde`.
function indexSuffix(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

// The HTTP API caps a page at 100 versions and carries no etag, the sparse index answers with the
// whole crate in one revalidatable request. Only crates.io splits the two, so an override is an
// index root.
function indexUrl(cratesIoUrl: string, name: string): string {
  const base = normalizeUrl(cratesIoUrl);
  return `${base === "https://crates.io" ? "https://index.crates.io" : base}/${indexSuffix(name)}`;
}

// Index records carry the crate's whole dependency list, features and checksum, none of which is
// read. A line that is not a record is kept verbatim, so a body of nothing but those still reads
// as the malformed response it is.
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

  // dedup in-flight/completed requests per run; disk-cache staleness is gated by ctx.noCache inside fetchWithEtag
  const data = await dedupe(cratesIoByCtx, ctx, url, async () => {
    const result = await fetchWithEtag(url, ctx, getFetchOpts(), reduceSparseIndex);
    if (!("body" in result)) throwFetchError(result.res, url, name, ctx.cratesIoUrl);
    const versions: Record<string, Record<string, never>> = {};
    const time: Record<string, string> = {};
    // crates.io has no maintainer-set tag, so its "max stable version" stands in: the highest
    // release, prereleases counting only for a crate that has published nothing else.
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
      // Build metadata (`0.14.7+wasi-0.2.4`) is no part of a range, and renovate's crate datasource drops it too.
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

// Cargo treats bare version strings as caret ranges (e.g. "1.0" = "^1.0").
const startsWithDigitRe = /^\d/;
// A wildcard requirement is not one of those: `1.0.*` caps at 1.0.x where `^1.0` would not.
// Cargo normalizes `1.x` and `1.*.*` to `1.*`, so both spellings have to be recognized.
const wildcardRe = /^(\d+(?:\.\d+)*)((?:\.[*xX])+)$/;
const commaRe = /\s*,\s*/g;
const commaSplitRe = /(\s*,\s*)/;

// npm range syntax has no comma, so a comparator list travels whitespace-separated and gets its
// authored separators back in updateCargoRange.
export const cargoToNpmRange = (range: string): string => range.includes(",") ? range.replace(commaRe, " ") : range;

const toNpmRange = (range: string): string =>
  cargoToNpmRange(startsWithDigitRe.test(range) && !wildcardRe.test(range) ? `^${range}` : range);

function updateComparator(comparator: string, newVersion: string): string {
  // An upper bound the new version already clears stays as authored, as renovate leaves a matching range alone.
  if (comparator.startsWith("<") && satisfies(newVersion, comparator)) return comparator;

  const wildcard = wildcardRe.exec(comparator);
  if (wildcard) {
    const [, digits, stars] = wildcard;
    return `${newVersion.split(/[-+]/)[0].split(".").slice(0, digits.split(".").length).join(".")}${stars}`;
  }
  if (startsWithDigitRe.test(comparator)) {
    return updateVersionRange(normalizeRange(`^${comparator}`), newVersion, `^${comparator}`).replace(/^\^/, "");
  }
  return updateVersionRange(normalizeRange(comparator), newVersion, comparator);
}

export function updateCargoRange(oldOrig: string, newVersion: string): string {
  if (!oldOrig.includes(",")) return updateComparator(oldOrig, newVersion);
  // Splitting on a capturing separator keeps the authored spacing for the rejoin.
  const parts = oldOrig.split(commaSplitRe);
  for (let i = 0; i < parts.length; i += 2) parts[i] = updateComparator(parts[i], newVersion);
  return parts.join("");
}

export function findLockedVersion(allVersions: Map<string, string[]>, name: string, range: string): string | undefined {
  const versions = allVersions.get(name);
  if (!versions) return undefined;
  const npmRange = toNpmRange(range);
  let best: string | undefined;
  for (const version of versions) {
    if (satisfies(version, npmRange) && (!best || gt(version, best))) {
      best = version;
    }
  }
  return best;
}

// A TOML key may be written bare, "quoted" or 'quoted' and the parser hands back the bare name, so
// a key matched back in the source has to accept all three spellings.
const tomlKey = (key: string) => `(?:${esc(key)}|"${esc(key)}"|'${esc(key)}')`;

// `[x]` or `[[x]]`, with the indentation and trailing comment TOML permits around it.
const tableHeaderRe = /^[ \t]*\[(\[?)[ \t]*([^[\]]+?)[ \t]*\]\1[ \t]*(?:#.*)?[ \t\r]*$/;

// An odd count opens a multi-line string, inside which a bracketed line is text, not a header.
function multilineDelim(line: string): string {
  for (const delim of [`"""`, `'''`]) {
    if (line.split(delim).length % 2 === 0) return delim;
  }
  return "";
}

// The span each table occupies, its header line included. An array of tables holds no dependency
// but still ends the table before it, so it takes part with a path nothing matches.
function tableSpans(str: string): Array<{path: string, start: number, end: number}> {
  const spans: Array<{path: string, start: number, end: number}> = [];
  let delim = "";
  let pos = 0;
  for (const line of str.split("\n")) {
    if (delim) {
      if (line.includes(delim)) delim = "";
    } else {
      const header = tableHeaderRe.exec(line);
      if (header) {
        const previous = spans.at(-1);
        if (previous) previous.end = pos;
        spans.push({path: header[1] ? "" : header[2], start: pos, end: str.length});
      } else {
        delim = multilineDelim(line);
      }
    }
    pos += line.length + 1;
  }
  return spans;
}

export function updateCargoToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, dep] of Object.entries(deps)) {
    const [typeKey, name] = key.split(fieldSep);
    const oldValue = dep.oldOrig || dep.old;
    const newValue = dep.new;
    const nameEsc = tomlKey(name);
    const oldEsc = esc(oldValue);
    // Built from the dep's own type so `[target.'cfg(unix)'.dependencies]` and any other configured
    // section work. Workspace members carry a `|path` suffix on the type.
    const sectionEsc = typeKey.split("|")[0].split(".").map(tomlKey).join("\\.");

    // The forms that name no table of their own stay inside the table the dependency was read from,
    // as the same name at the same version may well sit in another one too. Its own `[section.name]`
    // wins, or the bare `[section]` above it would claim the rewrite, and a table neither pattern
    // finds leaves the whole file as the scope rather than losing the rewrite.
    const ownRe = new RegExp(`^${sectionEsc}\\.${nameEsc}$`);
    const sectionRe = new RegExp(`^${sectionEsc}$`);
    const rewrite = (scope: string) => scope
      // Simple form: name = "version" or name = 'version'
      .replace(new RegExp(`^(\\s*${nameEsc}\\s*=\\s*["'])${oldEsc}(["'].*)$`, "gm"), `$1${newValue}$2`)
      // Inline table: name = { ..., version = "x.y.z", ... } (version need not be the first key)
      .replace(new RegExp(`^(\\s*${nameEsc}\\s*=\\s*\\{(?:"[^"\\n]*"|'[^'\\n]*'|[^"'}\\n])*?\\bversion\\s*=\\s*["'])${oldEsc}(["'])`, "gm"), `$1${newValue}$2`)
      // Extended table: [section.name] with version = "x.y.z", which the scope above is that table
      .replace(new RegExp(`(\\[${sectionEsc}\\.${nameEsc}\\](?:(?!\\n\\[)[\\s\\S])*?version\\s*=\\s*["'])${oldEsc}(["'])`, "g"), `$1${newValue}$2`);
    const spans = tableSpans(newPkgStr);
    const span = spans.find(entry => ownRe.test(entry.path)) ?? spans.find(entry => sectionRe.test(entry.path));
    newPkgStr = span ?
      newPkgStr.slice(0, span.start) + rewrite(newPkgStr.slice(span.start, span.end)) + newPkgStr.slice(span.end) :
      rewrite(newPkgStr);
  }
  return newPkgStr;
}
