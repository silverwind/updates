#!/usr/bin/env -S node --import @swc-node/register/esm-register
import ansiRegex from "ansi-regex";
import minimist from "minimist";
import rat from "registry-auth-token";
import rc from "rc";
import {parse, coerce, diff, gt, gte, lt, neq, valid, validRange} from "semver";
import textTable from "text-table";
import {cwd, stdout, argv, env, exit} from "node:process";
import hostedGitInfo from "hosted-git-info";
import {join, dirname, basename, resolve} from "node:path";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync} from "node:fs";
import {timerel} from "timerel";
import supportsColor from "supports-color";
import {magenta, red, green, disableColor} from "glowie";
import {getProperty} from "dot-prop";
import pAll from "p-all";
import memize from "memize";
import picomatch from "picomatch";
import pkg from "./package.json" with {type: "json"};
import type {AuthOptions} from "registry-auth-token";
import type {AgentOptions} from "node:https";

type Npmrc = {
  registry?: string,
  ca?: string,
  cafile?: string,
  [other: string]: any,
}

type Dep = {
  "old": string,
  "new": string,
  "oldPrint"?: string,
  "newPrint"?: string,
  "oldOriginal"?: string,
  "info"?: string,
  "age"?: string,
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

type NpmData = {[other: string]: any};

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

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const versionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const gitInfo = memize(hostedGitInfo.fromUrl);
const registryAuthToken = memize(rat);
const normalizeUrl = memize((url: string) => url.endsWith("/") ? url.substring(0, url.length - 1) : url);
const packageVersion = pkg.version || "0.0.0";
const sep = "\0";

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
    "P", "patch",
    "p", "prerelease",
    "R", "release",
    "r", "registry",
    "t", "types",
    "githubapi", // undocumented, only for tests
    "pypiapi", // undocumented, only for tests
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

if (args["no-color"] || !supportsColor.stdout) disableColor();

const greatest = argSetToRegexes(parseMixedArg(args.greatest));
const prerelease = argSetToRegexes(parseMixedArg(args.prerelease));
const release = argSetToRegexes(parseMixedArg(args.release));
const patch = argSetToRegexes(parseMixedArg(args.patch));
const minor = argSetToRegexes(parseMixedArg(args.minor));
const allowDowngrade = parseMixedArg(args["allow-downgrade"]);
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";
const pypiApiUrl = args.pypiapi ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const stripV = (str: string) => str.replace(/^v/, "");

function matchesAny(str: string, set: boolean | Set<RegExp>) {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

const registryUrl = memize((scope: string, npmrc: Npmrc) => {
  const url = npmrc[`${scope}:registry`] || npmrc.registry;
  return url.endsWith("/") ? url : `${url}/`;
});

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

const getFetchOpts = memize((agentOpts: AgentOptions, authType?: string, authToken?: string) => {
  return {
    ...(Object.keys(agentOpts).length && {agentOpts}),
    headers: {
      "user-agent": `updates/${packageVersion}`,
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
});

async function doFetch(url: string, opts: RequestInit) {
  if (args.verbose) console.error(`${magenta("fetch")} ${url}`);
  const res = await fetch(url, opts);
  if (args.verbose) console.error(`${res.ok ? green("done") : red("error")} ${url}`);
  return res;
}

async function fetchNpmInfo(name: string, type: string, originalRegistry: string, agentOpts: AgentOptions, authTokenOpts: AuthOptions, npmrc: Npmrc) {
  const {auth, registry} = getAuthAndRegistry(name, originalRegistry, authTokenOpts, npmrc);
  const packageName = type === "resolutions" ? basename(name) : name;
  const urlName = packageName.replace(/\//g, "%2f");
  const url = `${registry}/${urlName}`;

  const res = await doFetch(url, getFetchOpts(agentOpts, auth?.type, auth?.token));
  if (res?.ok) {
    return [await res.json(), type, registry, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name} from ${registry}`);
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
      throw new Error(`Received ${res.status} ${res.statusText} for ${name} from PyPi`);
    } else {
      throw new Error(`Unable to fetch ${name} from PyPi`);
    }
  }
}

function getInfoUrl({repository, homepage, info}: {repository: string | {[other: string]: any}, homepage: string, info: {[other: string]: any}}, registry: string, name: string): string {
  if (info) { // pypi
    repository =
      info.project_urls.repository ||
      info.project_urls.Repository ||
      info.project_urls.repo ||
      info.project_urls.Repo ||
      info.project_urls.source ||
      info.project_urls.Source ||
      info.project_urls["source code"] ||
      info.project_urls["Source Code"] ||
      info.project_urls.homepage ||
      info.project_urls.Homepage ||
      `https://pypi.org/project/${name}/`;
  }

  let infoUrl = "";
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url: string = typeof repository === "string" ? repository : repository.url;
    const info = gitInfo(url);
    const browse = info?.browse?.();
    if (browse) {
      infoUrl = browse;
    }
    if (infoUrl && typeof repository !== "string" && repository.directory && info?.treepath) {
      infoUrl = `${infoUrl}/${info.treepath}/HEAD/${repository.directory}`;
    }
    if (!infoUrl && typeof repository !== "string" && repository?.url && /^https?:/.test(repository.url)) {
      infoUrl = repository.url;
    }
    if (!infoUrl && url) {
      infoUrl = url;
    }
  }

  return infoUrl || homepage || "";
}

function finishWithMessage(message: string) {
  console.info(args.json ? JSON.stringify({message}) : message);
  doExit();
}

function doExit(err?: Error | void) {
  if (err) {
    const error = err.stack ?? err.message;
    console.info(args.json ? JSON.stringify({error}) : red(error));
  }
  process.exit(err ? 1 : 0);
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
async function write(file: string, content: string) {
  const {platform} = await import("node:os");
  const isWindows = platform() === "win32";
  if (isWindows) truncateSync(file, 0);
  writeFileSync(file, content, isWindows ? {flag: "r+"} : undefined);
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

function formatDeps(deps: DepsByMode) {
  const arr = [["NAME", "OLD", "NEW", "AGE", "INFO"]];
  const seen = new Set();

  for (const mode of Object.keys(deps)) {
    for (const [key, data] of Object.entries(deps[mode])) {
      const name = key.split(sep)[1];
      const id = `${mode}|${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      arr.push([
        name,
        highlightDiff(data.old, data.new, red),
        highlightDiff(data.new, data.old, green),
        data.age || "",
        data.info || "",
      ]);
    }
  }

  return textTable(arr, {
    hsep: " ",
    stringLength: str => str.replace(ansiRegex(), "").length,
  });
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

function updateProjectToml(pkgStr: string, deps: Deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    const re = new RegExp(`${esc(name)} *= *"${esc(old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `${name} = "${deps[key].new}"`);
  }
  return newPkgStr;
}

function updateRange(oldRange: string, newVersion: string, oldOriginal?: string) {
  let newRange = oldRange.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g, newVersion);

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

function findVersion(data: NpmData, versions: string[], {range, semvers, usePre, useRel, useGreatest}: FindVersionOpts) {
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

function findNewVersion(data: NpmData, {mode, range, useGreatest, useRel, usePre, semvers}: FindNewVersionOpts) {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains
  const versions = Object.keys(mode === "pypi" ? data.releases : data.versions)
    .filter(version => valid(version));
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

async function getLastestCommit(user: string, repo: string): Promise<{hash: string, commit: {[other: string]: any}}> {
  const url = `${githubApiUrl}/repos/${user}/${repo}/commits`;
  const res = await fetchGitHub(url);
  if (!res?.ok) return {hash: "", commit: {}};
  const data = await res.json();
  const {sha: hash, commit} = data[0];
  return {hash, commit};
}

// return list of tags sorted old to new
// TODO: newDate support, semver matching
async function getTags(user: string, repo: string): Promise<string[]> {
  const res = await fetchGitHub(`${githubApiUrl}/repos/${user}/${repo}/git/refs/tags`);
  if (!res?.ok) return [];
  const data = await res.json();
  const tags = data.map((entry: {ref: string}) => entry.ref.replace(/^refs\/tags\//, ""));
  return tags;
}

function selectTag(tags: string[], oldRef: string, useGreatest: boolean) {
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

function normalizeRange(range: string) {
  const versionMatches = range.match(versionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(versionRe, rangeToVersion(versionMatches[0]));
}

function parseMixedArg(arg: any) {
  if (arg === undefined) {
    return false;
  } else if (arg === "") {
    return true;
  } else if (typeof arg === "string") {
    return arg.includes(",") ? new Set(arg.split(",")) : new Set([arg]);
  } else if (Array.isArray(arg)) {
    return new Set(arg);
  } else {
    return false;
  }
}

function extractCerts(str: string): string[] {
  return Array.from(str.matchAll(/(----BEGIN CERT[^]+?IFICATE----)/g), (m: string[]) => m[0]);
}

async function getCerts(extra: string[] = []) {
  return [...(await import("node:tls")).rootCertificates, ...extra];
}

// convert arg from cli or config to regex
function argToRegex(arg: string | RegExp, cli: boolean) {
  if (cli && typeof arg === "string") {
    return /\/.+\//.test(arg) ? new RegExp(arg.slice(1, -1)) : picomatch.makeRe(arg);
  } else {
    return arg instanceof RegExp ? arg : picomatch.makeRe(arg);
  }
}

// parse cli arg into regex set
function argSetToRegexes(arg: any) {
  if (arg instanceof Set) {
    const ret = new Set();
    for (const entry of arg) {
      ret.add(argToRegex(entry, true));
    }
    return ret;
  }
  return arg;
}

// parse include/exclude into a Set of regexes
function matchersToRegexSet(cliArgs: string[], configArgs: string[]): Set<RegExp> {
  const ret = new Set();
  for (const arg of cliArgs || []) {
    ret.add(argToRegex(arg, true));
  }
  for (const arg of configArgs || []) {
    ret.add(argToRegex(arg, false));
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

function resolveFiles(filesArg: Set<string>): Set<string> {
  const resolvedFiles = new Set<string>();

  if (filesArg) { // check passed files
    for (const file of filesArg) {
      let stat;
      try {
        stat = lstatSync(file);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }

      if (stat?.isFile()) {
        resolvedFiles.add(resolve(file));
      } else if (stat?.isDirectory()) {
        for (const filename of ["package.json", "pyproject.toml"]) {
          const f = join(file, filename);
          let stat;
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
    for (const filename of ["package.json", "pyproject.toml"]) {
      const file = findUpSync(filename, cwd());
      if (file) resolvedFiles.add(resolve(file));
    }
  }
  return resolvedFiles;
}

async function main() {
  for (const stream of [process.stdout, process.stderr]) {
    // @ts-expect-error
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
    exit(0);
  }

  if (version) {
    console.info(packageVersion);
    exit(0);
  }

  // output vars
  const deps: DepsByMode = {};
  const maybeUrlDeps: DepsByMode = {};
  const pkgStrs: {[other: string]: string} = {};
  const filePerMode: {[other: string]: string} = {};
  let numDependencies = 0;

  for (const file of resolveFiles(parseMixedArg(filesArg) as Set<string>)) {
    const projectDir = dirname(resolve(file));
    const filename = basename(file);

    const mode = filename === "pyproject.toml" ? "pypi" : "npm";
    filePerMode[mode] = file;
    if (!deps[mode]) deps[mode] = {};

    let config: {[other: string]: any} = {};
    try {
      ({default: config} = await Promise.any([
        "updates.config.js",
        "updates.config.ts",
        "updates.config.mjs",
        "updates.config.mts",
        ".config/updates.js",
        ".config/updates.ts",
        ".config/updates.mjs",
        ".config/updates.mts",
      ].map(str => import(join(projectDir, ...str.split("/"))))));
    } catch {}

    let includeCli: string[] = [];
    let excludeCli: string[] = [];
    if (args.include && args.include !== true) { // cli
      includeCli = (Array.isArray(args.include) ? args.include : [args.include]).flatMap(item => item.split(","));
    }
    if (args.exclude && args.exclude !== true) {
      excludeCli = (Array.isArray(args.exclude) ? args.exclude : [args.exclude]).flatMap(item => item.split(","));
    }
    const include = matchersToRegexSet(includeCli, config?.include);
    const exclude = matchersToRegexSet(excludeCli, config?.exclude);

    const agentOpts: AgentOptions = {};
    const npmrc: Npmrc = rc("npm", {registry: "https://registry.npmjs.org"});
    const authTokenOpts = {npmrc, recursive: true};
    if (mode === "npm") {
      if (npmrc["strict-ssl"] === false) {
        agentOpts.rejectUnauthorized = false;
      }
      if (npmrc?.cafile) {
        agentOpts.ca = await getCerts(extractCerts(readFileSync(npmrc.cafile, "utf8")));
      }
      if (npmrc?.ca) {
        const cas = Array.isArray(npmrc.ca) ? npmrc.ca : [npmrc.ca];
        agentOpts.ca = await getCerts(cas.flatMap(ca => extractCerts(ca)));
      }
    }

    let dependencyTypes;
    if (types) {
      dependencyTypes = Array.isArray(types) ? types : types.split(",");
    } else if ("types" in config && Array.isArray(config.types)) {
      dependencyTypes = config.types;
    } else {
      if (mode === "npm") {
        dependencyTypes = [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "resolutions",
        ];
      } else {
        dependencyTypes = [
          "tool.poetry.dependencies",
          "tool.poetry.dev-dependencies",
          "tool.poetry.test-dependencies",
          "tool.poetry.group.dev.dependencies",
          "tool.poetry.group.test.dependencies",
        ];
      }
    }

    let pkg: {[other: string]: any};
    try {
      pkgStrs[mode] = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
    }

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else {
        pkg = (await import("smol-toml")).parse(pkgStrs[mode]);
      }
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }

    for (const depType of dependencyTypes) {
      let obj: {[other: string]: string};
      if (mode === "npm") {
        obj = pkg[depType] || {};
      } else {
        obj = getProperty(pkg, depType) || {};
      }

      for (const [name, value] of Object.entries(obj)) {
        if (validRange(value) && canInclude(name, mode, include, exclude)) {
          // @ts-expect-error
          deps[mode][`${depType}${sep}${name}`] = {
            old: normalizeRange(value),
            oldOriginal: value,
          } as Partial<Dep>;
        } else if (mode === "npm" && canInclude(name, mode, include, exclude)) {
          // @ts-expect-error
          maybeUrlDeps[`${depType}${sep}${name}`] = {
            old: value,
          } as Partial<Dep>;
        }
      }
    }

    numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
    if (!numDependencies) continue;

    let registry: string;
    if (mode === "npm") {
      registry = normalizeUrl(args.registry || config.registry || npmrc.registry);
    }

    const entries = await pAll(Object.keys(deps[mode]).map(key => () => {
      const [type, name] = key.split(sep);
      if (mode === "npm") {
        return fetchNpmInfo(name, type, registry, agentOpts, authTokenOpts, npmrc);
      } else {
        return fetchPypiInfo(name, type, agentOpts);
      }
    }), {concurrency});

    for (const [data, type, registry, name] of entries) {
      if (data?.error) throw new Error(data.error);

      const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(data.name, greatest);
      const usePre = typeof prerelease === "boolean" ? prerelease : matchesAny(data.name, prerelease);
      const useRel = typeof release === "boolean" ? release : matchesAny(data.name, release);

      let semvers;
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
      if (newVersion) {
        newRange = updateRange(oldRange, newVersion, oldOriginal);
      }

      if (!newVersion || oldOriginal === newRange) {
        delete deps[mode][key];
      } else {
        deps[mode][key].new = newRange;

        if (mode === "npm") {
          deps[mode][key].info = getInfoUrl(data?.versions?.[newVersion], registry, data.name);
        } else {
          deps[mode][key].info = getInfoUrl(data, registry, data.info.name);
        }

        if (data.time?.[newVersion]) {
          deps[mode][key].age = timerel(data.time[newVersion], {noAffix: true});
        } else if (data.releases?.[newVersion]?.[0]?.upload_time_iso_8601) {
          deps[mode][key].age = timerel(data.releases[newVersion][0].upload_time_iso_8601, {noAffix: true});
        }
      }
    }

    if (Object.keys(maybeUrlDeps).length) {
      const results = await pAll(Object.entries(maybeUrlDeps).map(([key, dep]) => () => {
        const name = key.split(sep)[1];
        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(name, greatest);
        // @ts-expect-error
        return checkUrlDep(key, dep, useGreatest);
      }), {concurrency});

      for (const res of (results || []).filter(Boolean)) {
        const {key, newRange, user, repo, oldRef, newRef, newDate} = res as CheckResult;
        deps[mode][key] = {
          // @ts-expect-error
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
    doExit();
  }

  let numEntries = 0;
  for (const mode of Object.keys(deps)) {
    numEntries += Object.keys(deps[mode]).length;
  }

  if (!numEntries) {
    finishWithMessage("All dependencies are up to date.");
    doExit();
  }

  const exitCode = outputDeps(deps);

  if (update) {
    for (const mode of Object.keys(deps)) {
      if (!Object.keys(deps[mode]).length) continue;
      try {
        const fn = (mode === "npm") ? updatePackageJson : updateProjectToml;
        await write(filePerMode[mode], fn(pkgStrs[mode], deps[mode]));
      } catch (err) {
        throw new Error(`Error writing ${basename(filePerMode[mode])}: ${(err as Error).message}`);
      }

      // TODO: json
      console.info(green(`✨ ${basename(filePerMode[mode])} updated`));
    }
  }

  process.exit(exitCode);
}

main().catch(doExit).then(doExit);
