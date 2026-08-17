import {type Deps, type ModeContext, type PackageInfo, fieldSep, fetchWithEtag, reduceJson, throwFetchError} from "./shared.ts";
import {type Pep440, comparePep440, parsePep440} from "../utils/semver.ts";
import {type Pep508Specifier, anchorSpecifier, esc, parsePep508, serializePep508} from "../utils/utils.ts";

function reducePypiDoc(data: Record<string, any>): Record<string, any> {
  const releases: Record<string, Array<{upload_time_iso_8601?: string, yanked?: boolean}>> = {};
  for (const [version, files] of Object.entries(data.releases ?? {})) {
    const list = (files as Array<Record<string, any>>) ?? [];
    releases[version] = list.slice(0, 1).map(file => ({
      ...(file.upload_time_iso_8601 && {upload_time_iso_8601: file.upload_time_iso_8601}),
      ...(list.some(entry => entry?.yanked) && {yanked: true}),
    }));
  }
  const {name, version, project_urls} = data.info ?? {};
  return {info: {name, version, project_urls}, releases};
}

export async function fetchPypiInfo(name: string, ctx: ModeContext): Promise<PackageInfo> {
  const url = `${ctx.pypiApiUrl}/pypi/${name}/json`;
  const result = await fetchWithEtag(url, ctx, {
    headers: {"accept-encoding": "gzip, deflate, br"},
  }, reduceJson(reducePypiDoc));
  if ("body" in result) return [JSON.parse(result.body), null];
  throwFetchError(result.res, url, name, ctx.pypiApiUrl);
}

// Only as much of PEP 440 as proving a rewrite safe needs, with comparisons in plain version order.
function specifierAllows(version: Pep440, {op, version: text}: Pep508Specifier): boolean {
  if (op === "===") return text === version.version; // arbitrary equality compares the string
  if (text.endsWith(".*")) {
    const prefix = parsePep440(text.slice(0, -2));
    if (!prefix || (op !== "==" && op !== "!=")) return false;
    const matches = prefix.epoch === version.epoch &&
      prefix.release.every((part, idx) => (version.release[idx] ?? 0) === part);
    return op === "==" ? matches : !matches;
  }
  const parsed = parsePep440(text);
  if (!parsed) return false;
  const cmp = comparePep440(version, parsed);
  if (op === "==") return cmp === 0;
  if (op === "!=") return cmp !== 0;
  if (op === ">=") return cmp >= 0;
  // PEP 440: an exclusive comparison excludes the bound's own release, so `<2.0` rejects
  // `2.0rc1` and `>2.0` rejects `2.0.post1`, unless the bound already says pre or post itself.
  const sameRelease = version.epoch === parsed.epoch &&
    Array.from({length: Math.max(version.release.length, parsed.release.length)})
      .every((_, idx) => (version.release[idx] ?? 0) === (parsed.release[idx] ?? 0));
  if (op === ">") return cmp > 0 && !(sameRelease && version.post !== null && parsed.post === null);
  if (op === "<=") return cmp <= 0;
  if (op === "<") return cmp < 0 && !(sameRelease && (version.pre || version.dev !== null) && !parsed.pre && parsed.dev === null);
  // `~=X.Y.Z` is `>=X.Y.Z` with only the last segment free to move.
  return cmp >= 0 && parsed.release.length > 1 &&
    parsed.release.slice(0, -1).every((part, idx) => (version.release[idx] ?? 0) === part);
}

// Renovate's getRangePrecision: a cap the new version reaches moves up by one at the segment where
// it first rises above the lower bound, one further down when the segment below that is a zero
// (`>=3.20.2,<5.0.0` is minor-wide), with the segments under it taken from the new version or zeroed.
function raisedUpperBound(cap: Pep440, lower: Pep440, version: Pep440): string {
  let precision = cap.release.findIndex((part, idx) => part > lower.release[idx]);
  if (precision === 0 && cap.release[1] === 0) precision = 1;
  else if (precision === -1) precision = cap.release.length - 1;
  return cap.release.map((_, idx) => idx > precision ? 0 : (version.release[idx] ?? 0) + Number(idx === precision)).join(".");
}

// Renovate's updateRangeValue for `~=`: its precision is the constraint the author stated, so the
// new version is trimmed or zero-padded to it rather than replacing it.
function fitCompatibleRelease(base: Pep440, version: Pep440): string {
  if (base.release.length === version.release.length) return version.version;
  return Array.from({length: base.release.length}, (_, idx) => version.release[idx] ?? 0).join(".");
}

// Bump the specifier the reported version was read from, leaving every other one satisfiable, or
// null to leave the requirement as authored. Selection calls this too, so a decline is never reported.
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
      specifier.version = specifier.op === "~=" ? fitCompatibleRelease(oldParsed, newParsed) : newValue;
      continue;
    }
    if (specifierAllows(newParsed, specifier)) continue;
    // A cap the new lower bound passes is raised rather than left unsatisfiable. An exclusion stays
    // as authored, as renovate takes one to be there for a reason, and the guard below then bails.
    const cap = parsePep440(specifier.version);
    if (specifier.op === "<" && cap) specifier.version = raisedUpperBound(cap, oldParsed, newParsed);
    else if (specifier.op === "<=") specifier.version = newValue;
  }
  if (specifiers.some(specifier => !specifierAllows(newParsed, specifier))) return null;
  return serializePep508(parsed, specifiers);
}

export function updatePyprojectToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig, new: newValue}] of Object.entries(deps)) {
    const name = key.split(fieldSep)[1];
    const oldValue = oldOrig || old;
    // The whole quoted PEP 508 requirement, ending at its own quote: a marker may hold the other one.
    const re = new RegExp(`(['"])( *${esc(name)}(?![\\w.-]).*?)(?=\\1)`, "g");
    newPkgStr = newPkgStr.replace(re, (_, quote, requirement) =>
      `${quote}${updateRequirement(requirement, oldValue, newValue) ?? requirement}`);
  }
  return newPkgStr;
}
