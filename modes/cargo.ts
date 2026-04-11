import {type Deps, type ModeContext, type PackageInfo, fieldSep, getFetchOpts, normalizeUrl, throwFetchError} from "./shared.ts";
import {cargoTypes, esc} from "../utils/utils.ts";
import {gt, valid, satisfies} from "../utils/semver.ts";
import {updateVersionRange, normalizeRange} from "./npm.ts";

type CratesIoVersion = {num: string; created_at: string; yanked: boolean};
type CratesIoVersionsResponse = {versions: Array<CratesIoVersion>};

const cratesIoCache = new Map<string, Promise<Record<string, any>>>();

export async function fetchCratesIoInfo(name: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const base = normalizeUrl(ctx.cratesIoUrl);
  const url = `${base}/api/v1/crates/${encodeURIComponent(name)}/versions?per_page=100`;

  let dataPromise = ctx.noCache ? undefined : cratesIoCache.get(url);
  if (!dataPromise) {
    dataPromise = ctx.doFetch(url, {
      signal: AbortSignal.timeout(ctx.fetchTimeout),
      ...getFetchOpts(),
    }).then(async res => {
      if (!res?.ok) throwFetchError(res, url, name, ctx.cratesIoUrl);
      let body: CratesIoVersionsResponse;
      try {
        body = await res.json();
      } catch {
        throw new Error(`Invalid JSON from ${url}`);
      }
      const versions = (body.versions || []).filter((v: CratesIoVersion) => !v.yanked);
      const versionsObj: Record<string, Record<string, never>> = {};
      const time: Record<string, string> = {};
      for (const v of versions) {
        if (v.num) {
          versionsObj[v.num] = {};
          time[v.num] = v.created_at || "";
        }
      }
      const latest = versions[0]?.num ?? "";
      return {name, versions: versionsObj, time, "dist-tags": {latest}};
    }).catch(err => { cratesIoCache.delete(url); throw err; });
    cratesIoCache.set(url, dataPromise);
  }
  return [await dataPromise, type, null, name];
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
    const versions = map.get(name) || [];
    versions.push(version);
    map.set(name, versions);
  }
  return map;
}

// Cargo treats bare version strings as caret ranges (e.g. "1.0" = "^1.0").
export const startsWithDigitRe = /^\d/;

// Update a Cargo version range, handling bare versions as implicit caret ranges
export function updateCargoRange(oldOrig: string, newVersion: string): string {
  if (startsWithDigitRe.test(oldOrig)) {
    return updateVersionRange(normalizeRange(`^${oldOrig}`), newVersion, `^${oldOrig}`).replace(/^\^/, "");
  }
  return updateVersionRange(normalizeRange(oldOrig), newVersion, oldOrig);
}
export function findLockedVersion(allVersions: Map<string, string[]>, name: string, range: string): string | undefined {
  const versions = allVersions.get(name);
  if (!versions) return undefined;
  const npmRange = startsWithDigitRe.test(range) ? `^${range}` : range;
  let best: string | undefined;
  for (const version of versions) {
    if (satisfies(version, npmRange) && (!best || gt(version, best))) {
      best = version;
    }
  }
  return best;
}

const sectionAlts = cargoTypes.map(t => esc(t)).join("|");

export function updateCargoToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, dep] of Object.entries(deps)) {
    const [, name] = key.split(fieldSep);
    const oldValue = dep.oldOrig || dep.old;
    const newValue = dep.new;
    const nameEsc = esc(name);
    const oldEsc = esc(oldValue);

    // Simple form: name = "version" or name = 'version'
    newPkgStr = newPkgStr.replace(
      new RegExp(`^(\\s*${nameEsc}\\s*=\\s*["'])${oldEsc}(["'].*)$`, "gm"),
      `$1${newValue}$2`,
    );
    // Inline table: name = { version = "x.y.z", ... }
    newPkgStr = newPkgStr.replace(
      new RegExp(`(\\s*${nameEsc}\\s*=\\s*\\{\\s*version\\s*=\\s*["'])${oldEsc}(["'])`, "g"),
      `$1${newValue}$2`,
    );
    // Extended table: [section.name] with version = "x.y.z"
    newPkgStr = newPkgStr.replace(
      new RegExp(`(\\[(?:${sectionAlts})\\.${nameEsc}\\][^\\[]*?version\\s*=\\s*["'])${oldEsc}(["'])`, "g"),
      `$1${newValue}$2`,
    );
  }
  return newPkgStr;
}
