import {type Deps, type ModeContext, type PackageInfo, esc, fieldSep, throwFetchError} from "./shared.ts";

export async function fetchPypiInfo(name: string, type: string, ctx: ModeContext): Promise<PackageInfo> {
  const url = `${ctx.pypiApiUrl}/pypi/${name}/json`;

  const res = await ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}});
  if (res?.ok) {
    return [await res.json(), type, null, name];
  }
  throwFetchError(res, url, name, ctx.pypiApiUrl);
}

export function updatePyprojectToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [_depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    newPkgStr = newPkgStr.replace( // poetry
      new RegExp(`${esc(name)} *= *"${esc(oldValue)}"`, "g"),
      `${name} = "${deps[key].new}"`,
    );
    newPkgStr = newPkgStr.replace( // uv
      new RegExp(`("${esc(name)} *[<>=~]+ *)${esc(oldValue)}(")`, "g"),
      (_, m1, m2) => `${m1}${deps[key].new}${m2}`,
    );
  }
  return newPkgStr;
}
