import {type Deps, type ModeContext, type PackageInfo, fieldSep, fetchWithEtag, throwFetchError} from "./shared.ts";
import {esc} from "../utils/utils.ts";

// PyPI docs list every file of every release with digests and URLs; only the
// first file's upload time and a few info fields are read.
function reducePypiDoc(data: Record<string, any>): Record<string, any> {
  const releases: Record<string, Array<{upload_time_iso_8601?: string}>> = {};
  for (const [version, files] of Object.entries(data.releases ?? {})) {
    releases[version] = ((files as Array<Record<string, any>>) ?? []).slice(0, 1)
      .map(file => file.upload_time_iso_8601 ? {upload_time_iso_8601: file.upload_time_iso_8601} : {});
  }
  const {name, version, project_urls} = data.info ?? {};
  return {info: {name, version, project_urls}, releases};
}

export async function fetchPypiInfo(name: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const url = `${ctx.pypiApiUrl}/pypi/${name}/json`;
  const result = await fetchWithEtag(url, ctx, {
    headers: {"accept-encoding": "gzip, deflate, br"},
  }, reducePypiDoc);
  if ("body" in result) return [JSON.parse(result.body), type, null, name];
  throwFetchError(result.res, url, name, ctx.pypiApiUrl);
}

export function updatePyprojectToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const name = key.split(fieldSep)[1];
    const oldValue = oldOrig || old;
    newPkgStr = newPkgStr.replace(
      new RegExp(`(['"])(${esc(name)} *(?:\\[[^\\]]+\\])? *[<>=~]+ *)${esc(oldValue)}\\1`, "g"),
      (_, quote, prefix) => `${quote}${prefix}${deps[key].new}${quote}`,
    );
  }
  return newPkgStr;
}
