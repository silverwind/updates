import {env} from "node:process";
import {parse, coerce, diff, gt, gte, lt, neq, satisfies, valid} from "../utils/semver.ts";
import pkg from "../package.json" with {type: "json"};

export type Config = {
  /** Array of dependencies to include */
  include?: Array<string | RegExp>;
  /** Array of dependencies to exclude */
  exclude?: Array<string | RegExp>;
  /** Array of package types to use */
  types?: Array<string>;
  /** URL to npm registry */
  registry?: string;
  /** Minimum dependency age in days */
  cooldown?: number,
  /** Pin dependencies to semver ranges */
  pin?: Record<string, string>,
};

export type Dep = {
  old: string,
  new: string,
  oldPrint?: string,
  newPrint?: string,
  oldOrig?: string,
  info?: string,
  age?: string,
  date?: string,
};

export type Deps = {
  [name: string]: Dep,
};

export type DepsByMode = {
  [mode: string]: Deps,
};

export type Output = {
  results: {
    [mode: string]: {
      [type: string]: Deps,
    }
  }
};

export type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  pinnedRange?: string,
};

export type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
  pinnedRange?: string,
};

export type PackageInfo = [Record<string, any>, string, string | null, string];

export type PackageRepository = string | {
  type: string,
  url: string,
  directory: string,
};

export type ModeContext = {
  fetchTimeout: number,
  goProbeTimeout: number,
  forgeApiUrl: string,
  pypiApiUrl: string,
  jsrApiUrl: string,
  goProxyUrl: string,
  doFetch: typeof doFetch,
  verbose: boolean,
};

export const packageVersion = pkg.version;
export const fieldSep = "\0";
export const fetchTimeout = 5000;
export const goProbeTimeout = 2500;

export const stripv = (str: string): string => str.replace(/^v/, "");
export const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
export const normalizeUrl = (url: string) => url.endsWith("/") ? url.substring(0, url.length - 1) : url;

export function getFetchOpts(authType?: string, authToken?: string): RequestInit {
  return {
    headers: {
      "user-agent": `updates/${packageVersion}`,
      "accept-encoding": "gzip, deflate, br",
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
}

export async function doFetch(url: string, opts?: RequestInit, verbose?: boolean, logVerbose?: (msg: string) => void, magenta?: (s: string | number) => string, green?: (s: string | number) => string, red?: (s: string | number) => string): Promise<Response> {
  if (verbose && logVerbose && magenta) logVerbose(`${magenta("fetch")} ${url}`);
  const res = await fetch(url, opts);
  if (verbose && logVerbose && green && red) logVerbose(`${res.ok ? green(res.status) : red(res.status)} ${url}`);
  return res;
}

export function isVersionPrerelease(version: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

export function isRangePrerelease(range: string): boolean {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

export function coerceToVersion(rangeOrVersion: string): string {
  try {
    return coerce(rangeOrVersion)?.version ?? "";
  } catch {
    return "";
  }
}

export function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest, pinnedRange}: FindVersionOpts): string | null {
  const oldVersion = coerceToVersion(range);
  if (!oldVersion) return oldVersion;

  usePre = isRangePrerelease(range) || usePre;

  if (usePre) {
    semvers.add("prerelease");
    if (semvers.has("patch")) semvers.add("prepatch");
    if (semvers.has("minor")) semvers.add("preminor");
    if (semvers.has("major")) semvers.add("premajor");
  }

  let greatestDate = 0;
  let newVersion = oldVersion;

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed?.version || parsed.prerelease.length && (!usePre || useRel)) continue;
    const candidateVersion = parsed.version;

    // If a pinned range is specified, only consider versions that satisfy it
    if (pinnedRange && !satisfies(candidateVersion, pinnedRange)) continue;

    const d = diff(newVersion, candidateVersion);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(coerceToVersion(candidateVersion), newVersion)) {
        newVersion = candidateVersion;
      }
    } else {
      const date = Date.parse(data.time[version]);
      if (date >= 0 && date > greatestDate) {
        newVersion = candidateVersion;
        greatestDate = date;
      }
    }
  }

  return newVersion || null;
}

export function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers, pinnedRange}: FindNewVersionOpts, {allowDowngrade, matchesAny, isGoPseudoVersion}: {allowDowngrade: Set<RegExp> | boolean, matchesAny: (str: string, set: Set<RegExp> | boolean) => boolean, isGoPseudoVersion: (version: string) => boolean}): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains

  let versions: Array<string> = [];
  if (mode === "pypi") {
    versions = Object.keys(data.releases).filter((version: string) => valid(version));
  } else if (mode === "npm") {
    versions = Object.keys(data.versions).filter((version: string) => valid(version));
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const effectiveUsePre = usePre || isRangePrerelease(range);
    const skipPrerelease = (v: string) => isVersionPrerelease(v) && (!effectiveUsePre || useRel);

    // Check cross-major upgrade
    const crossVersion = coerceToVersion(data.new);
    if (crossVersion && !isGoPseudoVersion(data.new) && !skipPrerelease(data.new)) {
      const d = diff(oldVersion, crossVersion);
      if (d && semvers.has(d)) {
        return data.new;
      }
    }

    // Fall back to same-major upgrade
    const sameVersion = coerceToVersion(data.sameMajorNew);
    if (sameVersion && !isGoPseudoVersion(data.sameMajorNew) && !skipPrerelease(data.sameMajorNew)) {
      const d = diff(oldVersion, sameVersion);
      if (d && semvers.has(d)) {
        data.Time = data.sameMajorTime;
        delete data.newPath;
        return data.sameMajorNew;
      }
    }

    return null;
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest, pinnedRange});
  if (!version) return null;

  if (useGreatest) {
    return version;
  } else {
    let latestTag = "";
    let originalLatestTag = "";
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = coerceToVersion(data.info.version); // add .0 to 6.0 so semver eats it
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = coerceToVersion(range);
    const oldIsPre = isRangePrerelease(range);
    const newIsPre = isVersionPrerelease(version);
    const latestIsPre = isVersionPrerelease(latestTag);
    const isGreater = gt(version, oldVersion);

    // update to new prerelease
    if (!useRel && usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // downgrade from prerelease to release on --release-only
    if (useRel && !isGreater && oldIsPre && !newIsPre) {
      return version;
    }

    // update from prerelease to release
    if (oldIsPre && !newIsPre && isGreater) {
      return version;
    }

    // do not downgrade from prerelease to release
    if (oldIsPre && !newIsPre && !isGreater) {
      return null;
    }

    // check if latestTag is allowed by semvers
    const d = diff(oldVersion, latestTag);
    if (d && d !== "prerelease" && !semvers.has(d.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (lt(latestTag, oldVersion) && !latestIsPre) {
      if (allowDowngrade === true || matchesAny(data.name, allowDowngrade)) {
        return latestTag;
      } else {
        return null;
      }
    }

    // prevent upgrading from non-prerelease to prerelease from latest dist-tag by default
    if (!oldIsPre && latestIsPre && !usePre) {
      return version;
    }

    // If a pinned range is specified and latestTag doesn't satisfy it, return version
    if (pinnedRange && !satisfies(latestTag, pinnedRange)) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return originalLatestTag || latestTag;
  }
}

const forgeTokensByHost = new Map<string, string>();
if (env.UPDATES_FORGE_TOKENS) {
  for (const entry of env.UPDATES_FORGE_TOKENS.split(",")) {
    const sep = entry.indexOf(":");
    if (sep > 0) {
      forgeTokensByHost.set(entry.substring(0, sep), entry.substring(sep + 1));
    }
  }
}

export function getForgeToken(url: string): string | undefined {
  try {
    const hostToken = forgeTokensByHost.get(new URL(url).hostname);
    if (hostToken) return hostToken;
  } catch {}
  return env.UPDATES_GITHUB_API_TOKEN || env.GITHUB_API_TOKEN ||
    env.GH_TOKEN || env.GITHUB_TOKEN || env.HOMEBREW_GITHUB_API_TOKEN;
}

export function fetchForge(url: string, ctx: ModeContext): Promise<Response> {
  const opts: RequestInit = {signal: AbortSignal.timeout(ctx.fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}};
  const token = getForgeToken(url);
  if (token) {
    opts.headers = {...opts.headers, Authorization: `Bearer ${token}`};
  }
  return ctx.doFetch(url, opts);
}

export function selectTag(tags: Array<string>, oldRef: string, useGreatest: boolean): string | null {
  const oldRefBare = stripv(oldRef);
  if (!valid(oldRefBare)) return null;

  if (!useGreatest) {
    const lastTag = tags.at(-1);
    if (!lastTag) return null;
    const lastTagBare = stripv(lastTag);
    if (!valid(lastTagBare)) return null;

    if (neq(oldRefBare, lastTagBare)) {
      return lastTag;
    }
  } else {
    let greatestTag = oldRef;
    let greatestTagBare = stripv(oldRef);

    for (const tag of tags) {
      const tagBare = stripv(tag);
      if (!valid(tagBare)) continue;
      if (!greatestTag || gt(tagBare, greatestTagBare)) {
        greatestTag = tag;
        greatestTagBare = tagBare;
      }
    }
    if (neq(oldRefBare, greatestTagBare)) {
      return greatestTag;
    }
  }

  return null;
}

export function resolvePackageJsonUrl(url: string): string {
  url = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // foo:user/repo
    return url.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  } else if (/^[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // user/repo
    return `https://github.com/${url}`;
  } else {
    return url;
  }
}

export function getSubDir(url: string): string {
  if (url.startsWith("https://bitbucket.org")) {
    return "src/HEAD";
  } else {
    return "tree/HEAD";
  }
}

export function getInfoUrl({repository, homepage, info}: {repository: PackageRepository, homepage: string, info: Record<string, any>}, registry: string | null, name: string): string {
  if (info) { // pypi
    repository =
      info.project_urls.repository ||
      info.project_urls.Repository ||
      info.project_urls.repo ||
      info.project_urls.Repo ||
      info.project_urls.source ||
      info.project_urls.Source ||
      info.project_urls["source code"] ||
      info.project_urls["Source code"] ||
      info.project_urls["Source Code"] ||
      info.project_urls.homepage ||
      info.project_urls.Homepage ||
      `https://pypi.org/project/${name}/`;
  }

  let infoUrl = "";
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    infoUrl = resolvePackageJsonUrl(url);
    if (infoUrl && typeof repository !== "string" && repository.directory) {
      infoUrl = `${infoUrl}/${getSubDir(infoUrl)}/${repository.directory}`;
    }
  }

  return infoUrl || homepage || "";
}

