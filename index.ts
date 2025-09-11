#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import {cwd, stdout, stderr, argv, env, exit, platform, versions} from "node:process";
import {join, dirname, basename, resolve} from "node:path";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync} from "node:fs";
import {stripVTControlCharacters, styleText} from "node:util";
import {execFileSync} from "node:child_process";
import minimist from "minimist";
import pAll from "p-all";
import pkg from "./package.json" with {type: "json"};
import rc from "rc";
import registryAuthToken from "registry-auth-token";
import {parse as parseToml} from "smol-toml";
import {parse, coerce, diff, gt, gte, lt, neq, valid, validRange} from "semver";
import {rootCertificates} from "node:tls";
import {timerel} from "timerel";
import {npmTypes, poetryTypes, uvTypes, goTypes, parseUvDependencies} from "./utils.ts";
import type {AgentOptions} from "node:https";
import type {Stats} from "node:fs";
import type {AuthOptions} from "registry-auth-token";
import type {TimerelAnyDate} from "timerel";

export type Config = {
  include?: Array<string | RegExp>;
  exclude?: Array<string | RegExp>;
  types?: Array<string>;
  registry?: string;
}

type Npmrc = {
  registry?: string,
  ca?: string,
  cafile?: string,
  cert?: string,
  certfile?: string,
  key?: string,
  keyfile?: string,
  [other: string]: any,
}

type Dep = {
  old: string,
  new: string,
  oldPrint?: string,
  newPrint?: string,
  oldOriginal?: string,
  info?: string,
  age?: string,
}

type Deps = {
  [name: string]: Dep,
}

type DepsByMode = {
  [mode: string]: Deps,
}

type Output = {
  results: {
    [mode: string]: {
      [type: string]: Deps,
    }
  }
}

type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
}

type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
}

type GoVersionInfo = {
  Version: string, // 'v70.0.0'
  Time: string, // '2025-03-17T23:43:28Z'
  Origin: {
    VCS: string, // 'git'
    URL: string, // 'https://github.com/google/go-github'
    Hash: string // '134f6b47e5470e34d3721845627a1938090c5cd7'
    Ref: string // 'refs/tags/v70.0.0'
  }
}

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const npmVersionRePre = /[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g;
const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const normalizeUrl = (url: string) => url.endsWith("/") ? url.substring(0, url.length - 1) : url;
const packageVersion = pkg.version || "0.0.0";
const sep = "\0";

const modeByFileName = {
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "go.mod": "go",
};

const args = minimist(argv.slice(2), {
  boolean: [
    "E", "error-on-outdated",
    "U", "error-on-unchanged",
    "h", "help",
    "j", "json",
    "n", "no-color",
    "u", "update",
    "v", "version",
    "V", "verbose",
  ],
  string: [
    "d", "allow-downgrade",
    "f", "file",
    "g", "greatest",
    "m", "minor",
    "M", "modes",
    "P", "patch",
    "p", "prerelease",
    "R", "release",
    "r", "registry",
    "t", "types",
    "githubapi", // undocumented, only for tests
    "pypiapi", // undocumented, only for tests
    "goproxy", // undocumented, only for tests
  ],
  alias: {
    d: "allow-downgrade",
    E: "error-on-outdated",
    U: "error-on-unchanged",
    e: "exclude",
    f: "file",
    g: "greatest",
    h: "help",
    i: "include",
    j: "json",
    m: "minor",
    M: "modes",
    n: "no-color",
    P: "patch",
    p: "prerelease",
    r: "registry",
    R: "release",
    s: "semver",
    S: "sockets",
    t: "types",
    u: "update",
    v: "version",
    V: "verbose",
  },
});

const [magenta, red, green] = (["magenta", "red", "green"] as const)
  .map(color => args["no-color"] ? String : (text: string | number) => styleText(color, String(text)));

type PackageArg = Set<RegExp> | boolean;

const greatest = argSetToRegexes(parseMixedArg(args.greatest)) as PackageArg;
const prerelease = argSetToRegexes(parseMixedArg(args.prerelease)) as PackageArg;
const release = argSetToRegexes(parseMixedArg(args.release)) as PackageArg;
const patch = argSetToRegexes(parseMixedArg(args.patch)) as PackageArg;
const minor = argSetToRegexes(parseMixedArg(args.minor)) as PackageArg;
const allowDowngrade = parseMixedArg(args["allow-downgrade"]) as PackageArg;
const enabledModes = parseMixedArg(args.modes) as Set<string> || new Set(["npm", "pypi"]);
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";
const pypiApiUrl = args.pypiapi ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const defaultGoProxy = "https://proxy.golang.org";
const goProxies = args.goproxy ? [normalizeUrl(args.goproxy)] : makeGoProxies();

const stripV = (str: string) => str.replace(/^v/, "");

function matchesAny(str: string, set: PackageArg) {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

function registryUrl(scope: string, npmrc: Npmrc) {
  const url = npmrc[`${scope}:registry`] || npmrc.registry;
  return url.endsWith("/") ? url : `${url}/`;
}

function makeGoProxies(): Array<string> {
  if (env.GOPROXY) {
    return env.GOPROXY.split(/[,|]/).map(s => s.trim()).filter(s => (Boolean(s) && s !== "direct"));
  } else {
    return [defaultGoProxy];
  }
}

function getProperty(obj: Record<string, any>, path: string) {
  return path.split(".").reduce((obj: Record<string, any>, prop: string) => obj?.[prop] ?? null, obj);
}

function commaSeparatedToArray(str: string) {
  return str.split(",").filter(Boolean);
}

function findUpSync(filename: string, dir: string): string | null {
  const path = join(dir, filename);
  try { accessSync(path); return path; } catch {}
  const parent = dirname(dir);
  return parent === dir ? null : findUpSync(filename, parent);
}

function getAuthAndRegistry(name: string, registry: string, authTokenOpts: AuthOptions, npmrc: Npmrc) {
  if (!name.startsWith("@")) {
    return {auth: registryAuthToken(registry, authTokenOpts), registry};
  } else {
    const scope = (/@[a-z0-9][\w-.]+/.exec(name) || [""])[0];
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = registryAuthToken(url, authTokenOpts);
        if (newAuth?.token) return {auth: newAuth, registry: url};
      } catch {}
    }
    return {auth: registryAuthToken(registry, authTokenOpts), registry};
  }
}

function getFetchOpts(agentOpts: AgentOptions, authType?: string, authToken?: string) {
  return {
    ...(Object.keys(agentOpts).length && {agentOpts}),
    headers: {
      "user-agent": `updates/${packageVersion}`,
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
}

function timestamp() {
  const date = new Date();
  return [
    date.getFullYear(),
    "-",
    String(date.getMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getDate()).padStart(2, "0"),
    " ",
    String(date.getHours()).padStart(2, "0"),
    ":",
    String(date.getMinutes()).padStart(2, "0"),
    ":",
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function logVerbose(message: string) {
  console.error(`${timestamp()} ${message}`);
}

async function doFetch(url: string, opts: RequestInit) {
  if (args.verbose) logVerbose(`${magenta("fetch")} ${url}`);
  const res = await fetch(url, opts);
  if (args.verbose) logVerbose(`${res.ok ? green(res.status) : red(res.status)} ${url}`);
  return res;
}

async function fetchNpmInfo(name: string, type: string, originalRegistry: string, agentOpts: AgentOptions, authTokenOpts: AuthOptions, npmrc: Npmrc) {
  const {auth, registry} = getAuthAndRegistry(name, originalRegistry, authTokenOpts, npmrc);
  const packageName = type === "resolutions" ? basename(name) : name;
  const url = `${registry}/${packageName.replace(/\//g, "%2f")}`;

  const res = await doFetch(url, getFetchOpts(agentOpts, auth?.type, auth?.token));
  if (res?.ok) {
    return [await res.json(), type, registry, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${registry}`);
    }
  }
}

async function fetchPypiInfo(name: string, type: string, agentOpts: AgentOptions) {
  const url = `${pypiApiUrl}/pypi/${name}/json`;

  const res = await doFetch(url, getFetchOpts(agentOpts));
  if (res?.ok) {
    return [await res.json(), type, null, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${pypiApiUrl}`);
    }
  }
}

function splitPlainText(str: string): Array<string> {
  return str.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function fetchGoVersionInfo(modulePath: string, version: string, agentOpts: AgentOptions, proxies: Array<string>): Promise<GoVersionInfo> {
  const proxyUrl = proxies.shift();
  if (!proxyUrl) {
    throw new Error("No more go proxies available");
  }

  const url = `${proxyUrl}/${modulePath.toLowerCase()}/${version === "latest" ? "@latest" : `@v/${version}.info`}`;

  let res: Response | null = null;
  let tryNext = false;
  try {
    res = await doFetch(url, {
      ...getFetchOpts(agentOpts),
      // proxy.golang.org takes 5+ seconds to answer requests for unknown packages with an error. If it
      // takes longer, it's likely going to fail. Subsequent requests are faster apparently as it caches.
      signal: AbortSignal.timeout(10000),
    });

    if (res?.ok) {
      return (await res.json()) as GoVersionInfo;
    }

    tryNext = [404, 410].includes(res.status) && Boolean(proxies.length);
  } catch (err: any) {
    if (err.name === "TimeoutError") {
      tryNext = Boolean(proxies.length);
    }
  }

  if (tryNext) {
    return fetchGoVersionInfo(modulePath, version, agentOpts, proxies);
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${modulePath} from ${proxyUrl}`);
    }
  }
}

async function findHighestGoMajor(name: string, agentOpts: AgentOptions): Promise<GoVersionInfo | null> {
  let lastInfo: GoVersionInfo | null = null;
  let next = name;
  while (true) {
    if (/\/v[0-9]+$/.test(next)) {
      const nextMajor = Number((next.split("/").at(-1) as string).substring(1)) + 1;
      next = next.replace(/\/v[0-9]+$/, `/${`v${nextMajor}`}`);
    } else {
      next = `${next}/v2`;
    }

    try {
      const info = await fetchGoVersionInfo(next, "latest", agentOpts, Array.from(goProxies));
      if (info === null) {
        break;
      } else if (info?.Version) {
        lastInfo = info;
        continue;
      }
    } catch {
      break;
    }
  }
  return lastInfo;
}

type PackageRepository = string | {
  type: string,
  url: string,
  directory: string,
}

function resolvePackageJsonUrl(url: string) {
  url = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // foo:user/repo
    return url.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  } else if (/^[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // user/repo
    return `https://github.com/${url}`;
  } else {
    return url;
  }
}

function getSubDir(url: string) {
  if (url.startsWith("https://bitbucket.org")) {
    return "src/HEAD";
  } else {
    return "tree/HEAD";
  }
}

function getInfoUrl({repository, homepage, info}: {repository: PackageRepository, homepage: string, info: Record<string, any>}, registry: string, name: string): string {
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

async function finishWithMessage(message: string) {
  console.info(args.json ? JSON.stringify({message}) : message);
  await doExit();
}

async function doExit(err?: Error | void, exitCode?: number) {
  if (err) {
    const error = err.stack ?? err.message;
    const cause = err.cause as any;
    if (args.json) {
      console.info(JSON.stringify({error, cause}));
    } else {
      console.info(red(error));
      if (cause) console.info(red(`Caused by: ${cause}`));
    }
  }

  // workaround https://github.com/nodejs/node/issues/56645
  if (platform === "win32" && Number(versions?.node?.split(".")[0]) >= 23) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  exit(exitCode || err ? 1 : 0);
}

function outputDeps(deps: DepsByMode = {}) {
  for (const mode of Object.keys(deps)) {
    for (const value of Object.values(deps[mode])) {
      if (typeof value.oldPrint === "string") {
        value.old = value.oldPrint;
        delete value.oldPrint;
      }
      if (typeof value.newPrint === "string") {
        value.new = value.newPrint;
        delete value.newPrint;
      }
      if (typeof value.oldOriginal === "string") {
        value.old = value.oldOriginal;
        delete value.oldOriginal;
      }
    }
  }

  let num = 0;
  for (const mode of Object.keys(deps)) {
    num += Object.keys(deps[mode]).length;
  }

  if (args.json) {
    const output: Output = {results: {}};
    for (const mode of Object.keys(deps)) {
      for (const [key, value] of Object.entries(deps[mode])) {
        const [type, name] = key.split(sep);
        if (!output.results[mode]) output.results[mode] = {};
        if (!output.results[mode][type]) output.results[mode][type] = {};
        output.results[mode][type][name] = value;
      }
    }
    console.info(JSON.stringify(output));
  } else if (num) {
    console.info(formatDeps(deps));
  }

  if (args["error-on-outdated"]) {
    return num ? 2 : 0;
  } else if (args["error-on-unchanged"]) {
    return num ? 0 : 2;
  } else {
    return 0;
  }
}

// preserve file metadata on windows
function write(file: string, content: string) {
  if (platform === "win32") truncateSync(file, 0);
  writeFileSync(file, content, platform === "win32" ? {flag: "r+"} : undefined);
}

function highlightDiff(a: string, b: string, colorFn: (str: string) => string) {
  if (a === b) return a;
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;

  let res = "";
  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += colorFn(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? colorFn(char) : char;
        }).join("") + colorFn(`.${aParts.slice(i + 1).join(".")}`.replace(/\.$/, ""));
      }
      break;
    } else {
      res += `${aParts[i]}.`;
    }
  }
  return res.replace(/\.$/, "");
}

const ansiLen = (str: string): number => stripVTControlCharacters(str).length;

function textTable(rows: Array<Array<string>>, hsep = " "): string {
  let ret = "";
  const colSizes = new Array(rows[0].length).fill(0);
  for (const row of rows) {
    for (const [colIndex, col] of row.entries()) {
      const len = ansiLen(col);
      if (len > colSizes[colIndex]) {
        colSizes[colIndex] = len;
      }
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    for (const [colIndex, col] of row.entries()) {
      if (colIndex > 0) ret += hsep;
      const space = " ".repeat(colSizes[colIndex] - ansiLen(col));
      ret += col + (colIndex === row.length - 1 ? "" : space);
    }
    if (rowIndex < rows.length - 1) ret += "\n";
  }
  return ret;
}

function shortenGoName(moduleName: string) {
  if (/\/v[0-9]$/.test(moduleName)) {
    moduleName = dirname(moduleName);
  }
  return moduleName;
}

function formatDeps(deps: DepsByMode) {
  const arr = [["NAME", "OLD", "NEW", "AGE", "INFO"]];
  const seen = new Set<string>();

  for (const mode of Object.keys(deps)) {
    for (const [key, data] of Object.entries(deps[mode])) {
      const name = key.split(sep)[1];
      const id = `${mode}|${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      arr.push([
        mode === "go" ? shortenGoName(name) : name,
        highlightDiff(data.old, data.new, red),
        highlightDiff(data.new, data.old, green),
        data.age || "",
        data.info || "",
      ]);
    }
  }

  return textTable(arr);
}

function updatePackageJson(pkgStr: string, deps: Deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    const re = new RegExp(`"${esc(name)}": *"${esc(old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
  }
  return newPkgStr;
}

function updatePyprojectToml(pkgStr: string, deps: Deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    newPkgStr = newPkgStr.replace( // poetry
      new RegExp(`${esc(name)} *= *"${esc(old)}"`, "g"),
      `${name} = "${deps[key].new}"`,
    );
    newPkgStr = newPkgStr.replace( // uv
      new RegExp(`("${esc(name)} *[<>=~]+ *)${esc(old)}(")`, "g"),
      (_, m1, m2) => `${m1}${deps[key].new}${m2}`,
    );
  }
  return newPkgStr;
}

function updateNpmRange(oldRange: string, newVersion: string, oldOriginal: string | undefined) {
  let newRange = oldRange.replace(npmVersionRePre, newVersion);

  // if old version is a range like ^5 or ~5, retain number of version parts in new range
  if (oldOriginal && oldOriginal !== oldRange && /^[\^~]/.test(newRange)) {
    const oldParts = oldOriginal.substring(1).split(".");
    const newParts = newRange.substring(1).split(".");
    if (oldParts.length !== newParts.length) {
      newRange = `${newRange[0]}${newParts.slice(0, oldParts.length).join(".")}`;
    }
  }

  return newRange;
}

function isVersionPrerelease(version: string) {
  const parsed = parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

function isRangePrerelease(range: string) {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function rangeToVersion(range: string) {
  try {
    return coerce(range)?.version ?? "";
  } catch {
    return "";
  }
}

function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest}: FindVersionOpts) {
  let tempVersion = rangeToVersion(range);
  let tempDate = 0;
  usePre = isRangePrerelease(range) || usePre;

  if (usePre) {
    semvers.add("prerelease");
    if (semvers.has("patch")) semvers.add("prepatch");
    if (semvers.has("minor")) semvers.add("preminor");
    if (semvers.has("major")) semvers.add("premajor");
  }

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed || !tempVersion || parsed.prerelease.length && (!usePre || useRel)) continue;

    const d = diff(tempVersion, parsed.version);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(rangeToVersion(parsed?.version), tempVersion)) {
        tempVersion = parsed.version;
      }
    } else {
      const date = (new Date(data.time[version])).getTime();
      if (date >= 0 && date > tempDate) {
        tempVersion = parsed.version;
        tempDate = date;
      }
    }
  }

  return tempVersion || null;
}

function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers}: FindNewVersionOpts): string | null {
  if (mode === "go") {
    if (gt(stripV(data.Version), stripV(range))) {
      return data.Version;
    } else {
      return null;
    }
  }
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains

  let versions: Array<string> = [];
  if (mode === "pypi") {
    versions = Object.keys(data.releases).filter((version: string) => valid(version));
  } else if (mode === "npm") {
    versions = Object.keys(data.versions).filter((version: string) => valid(version));
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest});
  if (!version) return null;

  if (useGreatest) {
    return version;
  } else {
    let latestTag = "";
    let originalLatestTag = "";
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = rangeToVersion(data.info.version); // add .0 to 6.0 so semver eats it
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = rangeToVersion(range);
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

    // in all other cases, return latest dist-tag
    return originalLatestTag || latestTag;
  }
}

function fetchGitHub(url: string) {
  const opts: RequestInit = {};
  const token = env.UPDATES_GITHUB_API_TOKEN || env.GITHUB_API_TOKEN || env.GH_TOKEN || env.HOMEBREW_GITHUB_API_TOKEN;
  if (token) {
    opts.headers = {Authorization: `Bearer ${token}`};
  }
  return doFetch(url, opts);
}

async function getLastestCommit(user: string, repo: string): Promise<{hash: string, commit: Record<string, any>}> {
  const url = `${githubApiUrl}/repos/${user}/${repo}/commits`;
  const res = await fetchGitHub(url);
  if (!res?.ok) return {hash: "", commit: {}};
  const data = await res.json();
  const {sha: hash, commit} = data[0];
  return {hash, commit};
}

// return list of tags sorted old to new
// TODO: newDate support, semver matching
async function getTags(user: string, repo: string): Promise<Array<string>> {
  const res = await fetchGitHub(`${githubApiUrl}/repos/${user}/${repo}/git/refs/tags`);
  if (!res?.ok) return [];
  const data = await res.json();
  const tags = data.map((entry: {ref: string}) => entry.ref.replace(/^refs\/tags\//, ""));
  return tags;
}

function selectTag(tags: Array<string>, oldRef: string, useGreatest: boolean) {
  const oldRefBare = stripV(oldRef);
  if (!valid(oldRefBare)) return;

  if (!useGreatest) {
    const lastTag = tags.at(-1);
    if (!lastTag) return;
    const lastTagBare = stripV(lastTag);
    if (!valid(lastTagBare)) return;

    if (neq(oldRefBare, lastTagBare)) {
      return lastTag;
    }
  } else {
    let greatestTag = oldRef;
    let greatestTagBare = stripV(oldRef);

    for (const tag of tags) {
      const tagBare = stripV(tag);
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
}

type CheckResult = {
  key: string,
  newRange: string,
  user: string,
  repo: string,
  oldRef: string,
  newRef: string,
  newDate?: string,
  newTag?: string,
};

async function checkUrlDep(key: string, dep: Dep, useGreatest: boolean): Promise<CheckResult | undefined> {
  const stripped = dep.old.replace(stripRe, "");
  const [_, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return;

  if (hashRe.test(oldRef)) {
    const {hash, commit} = await getLastestCommit(user, repo);
    if (!hash) return;

    const newDate = commit?.committer?.date ?? commit?.author?.date;
    const newRef = hash.substring(0, oldRef.length);
    if (oldRef !== newRef) {
      const newRange = dep.old.replace(oldRef, newRef);
      return {key, newRange, user, repo, oldRef, newRef, newDate};
    }
  } else {
    const tags = await getTags(user, repo);
    const newTag = selectTag(tags, oldRef, useGreatest);
    if (newTag) {
      return {key, newRange: newTag, user, repo, oldRef, newRef: newTag};
    }
  }
}

// turn "v1.3.2-0.20230802210424-5b0b94c5c0d3" into "v1.3.2"
function shortenGoVersion(version: string) {
  return version.replace(/-.*/, "");
}

function normalizeRange(range: string) {
  const versionMatches = range.match(npmVersionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(npmVersionRe, rangeToVersion(versionMatches[0]));
}

function parseMixedArg(arg: any): boolean | Set<string> {
  if (arg === undefined) {
    return false;
  } else if (arg === "") {
    return true;
  } else if (typeof arg === "string") {
    return arg.includes(",") ? new Set(commaSeparatedToArray(arg)) : new Set([arg]);
  } else if (Array.isArray(arg)) {
    return new Set(arg);
  } else {
    return false;
  }
}

function extractCerts(str: string): Array<string> {
  return Array.from(str.matchAll(/(----BEGIN CERT[^]+?IFICATE----)/g), (m: Array<string>) => m[0]);
}

function extractKey(str: string): Array<string> {
  return Array.from(str.matchAll(/(----BEGIN [^]+?PRIVATE KEY----)/g), (m: Array<string>) => m[0]);
}

function globToRegex(glob: string, insensitive: boolean): RegExp {
  return new RegExp(`^${esc(glob).replaceAll("\\*", ".*")}$`, insensitive ? "i" : "");
}

// convert arg from cli or config to regex
function argToRegex(arg: string | RegExp, cli: boolean, insensitive: boolean): RegExp {
  if (cli && typeof arg === "string") {
    return /\/.+\//.test(arg) ? new RegExp(arg.slice(1, -1)) : globToRegex(arg, insensitive);
  } else {
    return arg instanceof RegExp ? arg : globToRegex(arg, insensitive);
  }
}

// parse cli arg into regex set
function argSetToRegexes(arg: any): Set<RegExp> {
  if (arg instanceof Set) {
    const ret = new Set<RegExp>();
    for (const entry of arg) {
      ret.add(argToRegex(entry, true, false));
    }
    return ret;
  }
  return arg;
}

// parse include/exclude into a Set of regexes
function matchersToRegexSet(cliArgs: Array<string>, configArgs: Array<string | RegExp>): Set<RegExp> {
  const ret = new Set();
  for (const arg of cliArgs || []) {
    ret.add(argToRegex(arg, true, true));
  }
  for (const arg of configArgs || []) {
    ret.add(argToRegex(arg, false, true));
  }
  return ret as Set<RegExp>;
}

function canInclude(name: string, mode: string, include: Set<RegExp>, exclude: Set<RegExp>) {
  if (mode === "pypi" && name === "python") return false;
  if (!include.size && !exclude.size) return true;
  for (const re of exclude) {
    if (re.test(name)) return false;
  }
  for (const re of include) {
    if (re.test(name)) return true;
  }
  return include.size ? false : true;
}

function resolveFiles(filesArg: Set<string>): [Set<string>, Set<string>] {
  const resolvedFiles = new Set<string>();
  const explicitFiles = new Set<string>();

  if (filesArg) { // check passed files
    for (const file of filesArg) {
      let stat: Stats;
      try {
        stat = lstatSync(file);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }

      if (stat?.isFile()) {
        const resolved = resolve(file);
        resolvedFiles.add(resolved);
        explicitFiles.add(resolved);
      } else if (stat?.isDirectory()) {
        for (const filename of Object.keys(modeByFileName)) {
          const f = join(file, filename);
          let stat: Stats | null = null;
          try {
            stat = lstatSync(f);
          } catch {}
          if (stat?.isFile()) {
            resolvedFiles.add(resolve(f));
          }
        }
      } else {
        throw new Error(`${file} is neither a file nor directory`);
      }
    }
  } else { // search for files
    for (const filename of Object.keys(modeByFileName)) {
      const file = findUpSync(filename, cwd());
      if (file) resolvedFiles.add(resolve(file));
    }
  }
  return [resolvedFiles, explicitFiles];
}

async function loadConfig(rootDir: string): Promise<Config> {
  const filenames: Array<string> = [];
  for (const prefix of ["", ".config/"]) {
    for (const ext of ["js", "ts", "mjs", "mts"]) {
      filenames.push(`${prefix}updates${prefix ? "" : ".config"}.${ext}`);
    }
  }
  let config: Config = {};
  try {
    ({default: config} = await Promise.any(filenames.map(str => {
      return import(join(rootDir, ...str.split("/")));
    })));
  } catch {}
  return config;
}

async function main() {
  // Node.js does not guarantee that stdio streams are flushed when calling process.exit(). Prevent Node
  // from cutting off long output by setting those streams into blocking mode.
  // Ref: https://github.com/nodejs/node/issues/6379
  for (const stream of [stdout, stderr]) {
    // @ts-expect-error -- _handle is missing in @types/node
    stream?._handle?.setBlocking?.(true);
  }

  const maxSockets = 96;
  const concurrency = typeof args.sockets === "number" ? args.sockets : maxSockets;
  const {help, version, file: filesArg, types, update} = args;

  if (help) {
    stdout.write(`usage: updates [options]

  Options:
    -u, --update                       Update versions and write package file
    -f, --file <path,...>              File or directory to use, defaults to current directory
    -i, --include <pkg,...>            Include only given packages
    -e, --exclude <pkg,...>            Exclude given packages
    -p, --prerelease [<pkg,...>]       Consider prerelease versions
    -R, --release [<pkg,...>]          Only use release versions, may downgrade
    -g, --greatest [<pkg,...>]         Prefer greatest over latest version
    -t, --types <type,...>             Check only given dependency types
    -P, --patch [<pkg,...>]            Consider only up to semver-patch
    -m, --minor [<pkg,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<pkg,...>]  Allow version downgrades when using latest version
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
    -M, --modes <mode,...>             Which modes to enable. Either npm,pypi,go. Default: npm,pypi
    -j, --json                         Output a JSON object
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -e '@vitejs/*'
    $ updates -e '/^react-(dom)?/'
    $ updates -f package.json
    $ updates -f pyproject.toml
`);
    await doExit();
  }

  if (version) {
    console.info(packageVersion);
    await doExit();
  }

  // output vars
  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const pkgStrs: Record<string, string> = {};
  const filePerMode: Record<string, string> = {};
  let numDependencies = 0;

  const [files, explicitFiles] = resolveFiles(parseMixedArg(filesArg) as Set<string>);

  for (const file of files) {
    const projectDir = dirname(resolve(file));
    const filename = basename(file) as keyof typeof modeByFileName;
    const mode = modeByFileName[filename];
    if (!enabledModes.has(mode) && !explicitFiles.has(file)) continue;
    filePerMode[mode] = file;
    if (!deps[mode]) deps[mode] = {};

    const config = await loadConfig(projectDir);
    let includeCli: Array<string> = [];
    let excludeCli: Array<string> = [];
    if (args.include && args.include !== true) { // cli
      includeCli = (Array.isArray(args.include) ? args.include : [args.include])
        .flatMap(item => commaSeparatedToArray(item));
    }
    if (args.exclude && args.exclude !== true) {
      excludeCli = (Array.isArray(args.exclude) ? args.exclude : [args.exclude])
        .flatMap(item => commaSeparatedToArray(item));
    }
    const include = matchersToRegexSet(includeCli, config?.include ?? []);
    const exclude = matchersToRegexSet(excludeCli, config?.exclude ?? []);

    const agentOpts: AgentOptions = {};
    const npmrc: Npmrc = rc("npm", {registry: "https://registry.npmjs.org"}) || {};
    const authTokenOpts = {npmrc, recursive: true};
    if (mode === "npm") {
      // TODO: support these per-scope
      if (npmrc["strict-ssl"] === false) {
        agentOpts.rejectUnauthorized = false;
      }
      for (const opt of ["cert", "ca", "key"] as const) {
        const extract = (opt === "key") ? extractKey : extractCerts;
        let certs: Array<string> = [];
        if (npmrc[opt]) {
          certs = (Array.isArray(npmrc[opt]) ? npmrc[opt] : [npmrc[opt]]).flatMap((str: string) => extract(str));
        }
        if (npmrc[`${opt}file`]) {
          certs = Array.from(extract(readFileSync(npmrc[`opt${file}`], "utf8")));
        }
        if (certs.length) {
          agentOpts[opt] = opt === "ca" ? [...rootCertificates, ...certs] : certs;
        }
      }
    }

    let dependencyTypes: Array<string> = [];
    if (types) {
      dependencyTypes = Array.isArray(types) ? types : commaSeparatedToArray(types);
    } else if ("types" in config && Array.isArray(config.types)) {
      dependencyTypes = config.types;
    } else {
      if (mode === "npm") {
        dependencyTypes = npmTypes;
      } else if (mode === "pypi") {
        dependencyTypes = [...uvTypes, ...poetryTypes];
      } else if (mode === "go") {
        dependencyTypes = [...goTypes];
      }
    }

    let pkg: Record<string, any> = {};
    if (mode === "go") {
      pkgStrs[mode] = execFileSync("go", [
        "list", "-m", "-f", "{{if not .Indirect}}{{.Path}}@{{.Version}}{{end}}", "all",
      ], {stdio: "pipe", encoding: "utf8", cwd: projectDir});
    } else {
      try {
        pkgStrs[mode] = readFileSync(file, "utf8");
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }
    }

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else if (mode === "pypi") {
        pkg = parseToml(pkgStrs[mode]);
      } else {
        pkg.deps = {};
        for (const modulePathAndVersion of splitPlainText(pkgStrs[mode])) {
          const [modulePath, version] = modulePathAndVersion.split("@");
          if (version) { // current module has no version
            pkg.deps[modulePath] = version;
          }
        }
      }
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }

    for (const depType of dependencyTypes) {
      let obj: Record<string, string> | Array<string>;
      if (mode === "npm" || mode === "go") {
        obj = pkg[depType] || {};
      } else {
        obj = getProperty(pkg, depType) || {};
      }

      if (Array.isArray(obj) && mode === "pypi") { // array for uv
        for (const {name, version} of parseUvDependencies(obj)) {
          if (canInclude(name, mode, include, exclude)) {
            deps[mode][`${depType}${sep}${name}`] = {
              old: normalizeRange(version),
              oldOriginal: version,
            } as Dep;
          }
        }
      } else { // object for non-uv
        for (const [name, value] of Object.entries(obj)) {
          if (mode !== "go" && validRange(value) && canInclude(name, mode, include, exclude)) {
            deps[mode][`${depType}${sep}${name}`] = {
              old: normalizeRange(value),
              oldOriginal: value,
            } as Dep;
          } else if (mode === "npm" && canInclude(name, mode, include, exclude)) {
            maybeUrlDeps[`${depType}${sep}${name}`] = {
              old: value,
            } as Dep;
          } else if (mode === "go") {
            deps[mode][`${depType}${sep}${name}`] = {
              old: shortenGoVersion(value),
              oldOriginal: value,
            } as Dep;
          }
        }
      }
    }

    numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
    if (!numDependencies) continue;

    let registry: string;
    if (mode === "npm") {
      registry = normalizeUrl(args.registry || config.registry || npmrc.registry);
    }

    const entries = await pAll(Object.keys(deps[mode]).map(key => async () => {
      const [type, name] = key.split(sep);
      if (mode === "npm") {
        return fetchNpmInfo(name, type, registry, agentOpts, authTokenOpts, npmrc);
      } else if (mode === "pypi") {
        return fetchPypiInfo(name, type, agentOpts);
      } else {
        let info = await fetchGoVersionInfo(name, "latest", agentOpts, Array.from(goProxies));
        const highest = await findHighestGoMajor(name, agentOpts);

        if (highest && info && gt(highest.Version.substring(1), info.Version.substring(1))) {
          info = highest;
        }

        return [info, goTypes[0], null, name];
      }
    }), {concurrency});

    for (const [data, type, registry, name] of entries) {
      if (data?.error) throw new Error(data.error);

      const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(data.name, greatest);
      const usePre = typeof prerelease === "boolean" ? prerelease : matchesAny(data.name, prerelease);
      const useRel = typeof release === "boolean" ? release : matchesAny(data.name, release);

      let semvers: Set<string>;
      if (patch === true || matchesAny(data.name, patch)) {
        semvers = new Set<string>(["patch"]);
      } else if (minor === true || matchesAny(data.name, minor)) {
        semvers = new Set<string>(["patch", "minor"]);
      } else {
        semvers = new Set<string>(["patch", "minor", "major"]);
      }

      const key = `${type}${sep}${name}`;
      const oldRange = deps[mode][key].old;
      const oldOriginal = deps[mode][key].oldOriginal;
      const newVersion = findNewVersion(data, {
        usePre, useRel, useGreatest, semvers, range: oldRange, mode,
      });

      let newRange: string = "";
      if (["go", "pypi"].includes(mode) && newVersion) {
        // go has no ranges and pypi oldRange is a version at this point, not a range
        newRange = newVersion;
      } else if (newVersion) {
        newRange = updateNpmRange(oldRange, newVersion, oldOriginal);
      }

      if (!newVersion || oldOriginal && (oldOriginal === newRange)) {
        delete deps[mode][key];
      } else {
        deps[mode][key].new = newRange;

        if (mode === "npm") {
          deps[mode][key].info = getInfoUrl(data?.versions?.[newVersion], registry, data.name);
        } else if (mode === "pypi") {
          deps[mode][key].info = getInfoUrl(data, registry, data.info.name);
        } else {
          deps[mode][key].info = data?.Origin?.URL ?? `https://${name}`;
        }

        let date: TimerelAnyDate = "";
        if (mode === "npm" && data.time?.[newVersion]) { // npm
          date = data.time[newVersion];
        } else if (mode === "pypi" && data.releases?.[newVersion]?.[0]?.upload_time_iso_8601) {
          date = data.releases[newVersion][0].upload_time_iso_8601;
        } else if (mode === "go" && data.Time) {
          date = data.Time;
        }
        if (date) {
          deps[mode][key].age = timerel(date, {noAffix: true});
        }
      }
    }

    if (Object.keys(maybeUrlDeps).length) {
      const results = (await pAll(Object.entries(maybeUrlDeps).map(([key, dep]) => () => {
        const name = key.split(sep)[1];
        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(name, greatest);
        return checkUrlDep(key, dep, useGreatest);
      }), {concurrency})).filter(v => v !== undefined);

      for (const res of results) {
        const {key, newRange, user, repo, oldRef, newRef, newDate} = res;
        deps[mode][key] = {
          old: maybeUrlDeps[key].old,
          new: newRange,
          oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
          newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
          info: `https://github.com/${user}/${repo}`,
          ...(newDate ? {age: timerel(newDate, {noAffix: true})} : {}),
        };
      }
    }
  }

  if (numDependencies === 0) {
    finishWithMessage("No dependencies found, nothing to do.");
  }

  let numEntries = 0;
  for (const mode of Object.keys(deps)) {
    numEntries += Object.keys(deps[mode]).length;
  }

  if (!numEntries) {
    finishWithMessage("All dependencies are up to date.");
  }

  const exitCode = outputDeps(deps);

  if (update) {
    for (const mode of Object.keys(deps)) {
      if (!Object.keys(deps[mode]).length) continue;
      try {
        const fn = (mode === "npm") ? updatePackageJson : updatePyprojectToml;
        write(filePerMode[mode], fn(pkgStrs[mode], deps[mode]));
      } catch (err) {
        throw new Error(`Error writing ${basename(filePerMode[mode])}: ${(err as Error).message}`);
      }

      // TODO: json
      console.info(green(`✨ ${basename(filePerMode[mode])} updated`));
    }
  }

  await doExit(undefined, exitCode);
}

try {
  await main();
} catch (err) {
  await doExit(err);
}
