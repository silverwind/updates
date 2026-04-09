import {type Deps, type ModeContext, type PackageInfo, fieldSep, getFetchOpts, normalizeUrl, throwFetchError} from "./shared.ts";
import {cargoTypes, esc} from "../utils/utils.ts";

type CratesIoVersion = {num: string; created_at: string; yanked: boolean};
type CratesIoVersionsResponse = {versions: Array<CratesIoVersion>};

export async function fetchCratesIoInfo(name: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const base = normalizeUrl(ctx.cratesIoUrl);
  const url = `${base}/api/v1/crates/${encodeURIComponent(name)}/versions?per_page=100`;

  const res = await ctx.doFetch(url, {
    signal: AbortSignal.timeout(ctx.fetchTimeout),
    ...getFetchOpts(),
  });
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
  const data = {
    name,
    versions: versionsObj,
    time,
    "dist-tags": {latest},
  };
  return [data, type, null, name];
}

const sectionAlts = cargoTypes.map(t => esc(t)).join("|");

export function updateCargoToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, dep] of Object.entries(deps)) {
    const [_depType, name] = key.split(fieldSep);
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
