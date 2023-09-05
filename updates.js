#!/usr/bin/env node
import ansiRegex from "ansi-regex";
import fetchEnhanced from "fetch-enhanced";
import minimist from "minimist";
import nodeFetch from "node-fetch"; // seems twice as fast than undici for the 1500 deps case
import rat from "registry-auth-token";
import rc from "rc";
import {parse, coerce, diff, gt, gte, lt, neq, valid, validRange} from "semver";
import textTable from "text-table";
import {cwd, stdout, argv, env, exit, versions} from "node:process";
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

let fetch;
if (globalThis.fetch && !versions?.node) { // avoid node experimental warning
  fetch = globalThis.fetch;
} else {
  fetch = fetchEnhanced(nodeFetch, {undici: false});
}

const MAX_SOCKETS = 96;
const sep = "\0";

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const versionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const esc = str => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const gitInfo = memize(hostedGitInfo.fromUrl);
const registryAuthToken = memize(rat);
const normalizeUrl = memize(url => url.endsWith("/") ? url.substring(0, url.length - 1) : url);
const patchSemvers = new Set(["patch"]);
const minorSemvers = new Set(["patch", "minor"]);
const majorSemvers = new Set(["patch", "minor", "major"]);
const packageVersion = import.meta.VERSION || "0.0.0";

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

const npmrc = rc("npm", {registry: "https://registry.npmjs.org"});
const authTokenOpts = {npmrc, recursive: true};
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";
const pypiApiUrl = args.pypiapi ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const maxSockets = typeof args.sockets === "number" ? parseInt(args.sockets) : MAX_SOCKETS;

function matchesAny(str, set) {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

const registryUrl = memize((scope, npmrc) => {
  const url = npmrc[`${scope}:registry`] || npmrc.registry;
  return url.endsWith("/") ? url : `${url}/`;
});

function findUpSync(filename, dir, stopDir) {
  const path = join(dir, filename);
  try {
    accessSync(path);
    return path;
  } catch {}

  const parent = dirname(dir);
  if ((stopDir && path === stopDir) || parent === dir) {
    return null;
  } else {
    return findUpSync(filename, parent, stopDir);
  }
}

function getAuthAndRegistry(name, registry) {
  if (!name.startsWith("@")) {
    return [registryAuthToken(registry, authTokenOpts), registry];
  } else {
    const scope = (/@[a-z0-9][\w-.]+/.exec(name) || [])[0];
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = registryAuthToken(url, authTokenOpts);
        if (newAuth?.token) return [newAuth, url];
      } catch {}
    }
    return [registryAuthToken(registry, authTokenOpts), registry];
  }
}

const getFetchOpts = memize((agentOpts, authType, authToken) => {
  return {
    ...(Object.keys(agentOpts).length && {agentOpts}),
    headers: {
      "user-agent": `updates/${packageVersion}`,
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
});

async function fetchNpmInfo(name, type, originalRegistry, agentOpts) {
  const [auth, registry] = getAuthAndRegistry(name, originalRegistry);
  const packageName = type === "resolutions" ? resolutionsBasePackage(name) : name;
  const urlName = packageName.replace(/\//g, "%2f");
  const url = `${registry}/${urlName}`;

  if (args.verbose) console.error(`${magenta("fetch")} ${url}`);

  const res = await fetch(url, getFetchOpts(agentOpts, auth?.type, auth?.token));
  if (res?.ok) {
    if (args.verbose) console.error(`${green("done")} ${url}`);
    return [await res.json(), type, registry, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name} from ${registry}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${registry}`);
    }
  }
}

async function fetchPypiInfo(name, type, agentOpts) {
  const url = `${pypiApiUrl}/pypi/${name}/json`;
  if (args.verbose) console.error(`${magenta("fetch")} ${url}`);

  const res = await fetch(url, getFetchOpts(agentOpts));
  if (res?.ok) {
    if (args.verbose) console.error(`${green("done")} ${url}`);
    return [await res.json(), type, null, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name} from PyPi`);
    } else {
      throw new Error(`Unable to fetch ${name} from PyPi`);
    }
  }
}

function getInfoUrl({repository, homepage, info}, registry, name) {
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

  let infoUrl;
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;

    const info = gitInfo(url);
    const browse = info?.browse?.();
    if (browse) {
      infoUrl = browse; // https://github.com/babel/babel
    }

    if (infoUrl && repository.directory && info.treepath) {
      // https://github.com/babel/babel/tree/HEAD/packages/babel-cli
      // HEAD seems to always go to the default branch on GitHub but ideally
      // package.json should have a field for source branch
      infoUrl = `${infoUrl}/${info.treepath}/HEAD/${repository.directory}`;
    }

    if (!infoUrl && repository?.url && /^https?:/.test(repository.url)) {
      infoUrl = repository.url;
    }

    if (!infoUrl && url) {
      infoUrl = url;
    }
  }

  let url = infoUrl || homepage || "";
  if (url) {
    const u = new URL(url);
    // force https for github.com
    if (u.protocol === "http:" && u.hostname === "github.com") {
      u.protocol = "https:";
      url = String(u);
    }
  }
  return url;
}

function finishWithMessage(message) {
  if (args.json) {
    console.info(JSON.stringify({message}));
  } else {
    console.info(message);
  }
  doExit();
}

function doExit(err) {
  if (err) {
    const error = err.stack || err.message;
    if (args.json) {
      console.info(JSON.stringify({error}));
    } else {
      console.info(red(error));
    }
  }
  process.exit(err ? 1 : 0);
}

function outputDeps(deps = {}) {
  for (const mode of Object.keys(deps)) {
    for (const value of Object.values(deps[mode])) {
      if ("oldPrint" in value) {
        value.old = value.oldPrint;
        delete value.oldPrint;
      }
      if ("newPrint" in value) {
        value.new = value.newPrint;
        delete value.newPrint;
      }
      if ("oldOriginal" in value) {
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
    const output = {results: {}};
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
async function write(file, content) {
  const {platform} = await import("node:os");
  const isWindows = platform() === "win32";
  if (isWindows) truncateSync(file, 0);
  writeFileSync(file, content, isWindows ? {flag: "r+"} : undefined);
}

function highlightDiff(a, b, colorFn) {
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
        }).join("") + colorFn(`.${aParts.slice(i + 1).join(".")}`);
      }
      break;
    } else {
      res += `${aParts[i]}.`;
    }
  }
  return res;
}

function formatDeps(deps) {
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
        data.info,
      ]);
    }
  }

  return textTable(arr, {
    hsep: " ",
    stringLength: str => str.replace(ansiRegex(), "").length,
  });
}

function updatePackageJson(pkgStr, deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    const re = new RegExp(`"${esc(name)}": *"${esc(old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
  }
  return newPkgStr;
}

function updateProjectToml(pkgStr, deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    const re = new RegExp(`${esc(name)} *= *"${esc(old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `${name} = "${deps[key].new}"`);
  }
  return newPkgStr;
}

function updateRange(range, version) {
  return range.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g, version);
}

function isVersionPrerelease(version) {
  const parsed = parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

function isRangePrerelease(range) {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function rangeToVersion(range) {
  try {
    return coerce(range).version;
  } catch {
    return null;
  }
}

function findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest} = {}) {
  let tempVersion = rangeToVersion(range);
  let tempDate = 0;

  semvers = new Set(semvers);
  usePre = isRangePrerelease(range) || usePre;

  if (usePre) {
    semvers.add("prerelease");
    if (semvers.has("patch")) semvers.add("prepatch");
    if (semvers.has("minor")) semvers.add("preminor");
    if (semvers.has("major")) semvers.add("premajor");
  }

  for (const version of versions) {
    const parsed = parse(version);
    if (parsed.prerelease.length && (!usePre || useRel)) continue;

    const d = diff(tempVersion, parsed.version);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(coerce(parsed.version).version, tempVersion)) {
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

function findNewVersion(data, {mode, range, useGreatest, useRel, usePre, semvers} = {}) {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains
  const versions = Object.keys(mode === "pypi" ? data.releases : data.versions)
    .filter(version => valid(version));
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest});

  if (useGreatest) {
    return version;
  } else {
    let latestTag;
    let originalLatestTag;
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = coerce(data.info.version).version; // add .0 to 6.0 so semver eats it
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = coerce(range).version;
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
    return originalLatestTag ?? latestTag;
  }
}

// TODO: refactor this mess
async function checkUrlDep([key, dep], {useGreatest} = {}) {
  const stripped = dep.old.replace(stripRe, "");
  const [_, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return;

  if (hashRe.test(oldRef)) {
    const opts = {maxSockets};
    const token = env.UPDATES_GITHUB_API_TOKEN || env.GITHUB_API_TOKEN || env.GH_TOKEN || env.HOMEBREW_GITHUB_API_TOKEN;
    if (token) {
      opts.headers = {Authorization: `Bearer ${token}`};
    }

    const url = `${githubApiUrl}/repos/${user}/${repo}/commits`;
    if (args.verbose) console.error(`${magenta("fetch")} ${url}`);
    const res = await fetch(url, opts);
    if (args.verbose && res?.ok) console.error(`${green("done")} ${url}`);

    if (!res || !res.ok) return;
    const data = await res.json();
    let {sha: newRef, commit} = data[0];
    if (!newRef || !newRef.length) return;

    const newDate = commit?.committer?.date ?? commit?.author?.date;
    newRef = newRef.substring(0, oldRef.length);
    if (oldRef !== newRef) {
      const newRange = dep.old.replace(oldRef, newRef);
      return {key, newRange, user, repo, oldRef, newRef, newDate};
    }
  } else { // TODO: newDate support
    const res = await fetch(`${githubApiUrl}/repos/${user}/${repo}/git/refs/tags`);
    if (!res || !res.ok) return;
    const data = await res.json();
    const tags = data.map(entry => entry.ref.replace(/^refs\/tags\//, ""));
    const oldRefBare = oldRef.replace(/^v/, "");
    if (!valid(oldRefBare)) return;

    if (!useGreatest) {
      const lastTag = tags[tags.length - 1];
      const lastTagBare = lastTag.replace(/^v/, "");
      if (!valid(lastTagBare)) return;

      if (neq(oldRefBare, lastTagBare)) {
        return {key, newRange: lastTag, user, repo, oldRef, newRef: lastTag};
      }
    } else {
      let greatestTag = oldRef;
      let greatestTagBare = oldRef.replace(/^v/, "");

      for (const tag of tags) {
        const tagBare = tag.replace(/^v/, "");
        if (!valid(tagBare)) continue;
        if (!greatestTag || gt(tagBare, greatestTagBare)) {
          greatestTag = tag;
          greatestTagBare = tagBare;
        }
      }
      if (neq(oldRefBare, greatestTagBare)) {
        return {key, newRange: greatestTag, user, repo, oldRef, newRef: greatestTag};
      }
    }
  }
}

function resolutionsBasePackage(name) {
  const packages = name.match(/(@[^/]+\/)?([^/]+)/g) || [];
  return packages[packages.length - 1];
}

function normalizeRange(range) {
  const versionMatches = range.match(versionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(versionRe, coerce(versionMatches[0]));
}

function parseMixedArg(arg) {
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

function extractCerts(str) {
  return Array.from(str.matchAll(/(----BEGIN CERT[^]+?IFICATE----)/g), m => m[0]);
}

async function getCerts(extra = []) {
  return [...(await import("node:tls")).rootCertificates, ...extra];
}

// convert arg from cli or config to regex
function argToRegex(arg, cli) {
  if (cli) {
    return /\/.+\//.test(arg) ? new RegExp(arg.slice(1, -1)) : picomatch.makeRe(arg);
  } else {
    return arg instanceof RegExp ? arg : picomatch.makeRe(arg);
  }
}

// parse cli arg into regex set
function argSetToRegexes(arg) {
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
function matchersToRegexSet(cliArgs, configArgs) {
  const ret = new Set();
  for (const arg of cliArgs || []) {
    ret.add(argToRegex(arg, true));
  }
  for (const arg of configArgs || []) {
    ret.add(argToRegex(arg, false));
  }
  return ret;
}

function canInclude(name, mode, {include, exclude}) {
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

function resolveFiles(filesArg) {
  const resolvedFiles = new Set();

  if (filesArg) { // check passed files
    for (const file of filesArg) {
      let stat;
      try {
        stat = lstatSync(file);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${err.message}`);
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
      const pwd = cwd();
      const file = findUpSync(filename, pwd);
      if (file) resolvedFiles.add(resolve(file));
    }
  }
  return resolvedFiles;
}

async function main() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?._handle?.setBlocking?.(true);
  }

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
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${MAX_SOCKETS}
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
  const deps = {};
  const maybeUrlDeps = {};
  const pkgStrs = {};
  const filePerMode = {};
  let numDependencies = 0;

  for (const file of resolveFiles(parseMixedArg(filesArg))) {
    const projectDir = dirname(resolve(file));
    const filename = basename(file);

    let mode;
    if (filename === "pyproject.toml") {
      mode = "pypi";
    } else {
      mode = "npm";
    }
    filePerMode[mode] = file;
    if (!deps[mode]) deps[mode] = {};

    let config = {};
    try {
      config = (await import(join(projectDir, "updates.config.js"))).default;
    } catch {
      try {
        config = (await import(join(projectDir, "updates.config.mjs"))).default;
      } catch {}
    }

    let includeCli, excludeCli;
    if (args.include && args.include !== true) { // cli
      includeCli = (Array.isArray(args.include) ? args.include : [args.include]).flatMap(item => item.split(","));
    }
    if (args.exclude && args.exclude !== true) {
      excludeCli = (Array.isArray(args.exclude) ? args.exclude : [args.exclude]).flatMap(item => item.split(","));
    }
    const include = matchersToRegexSet(includeCli, config?.include);
    const exclude = matchersToRegexSet(excludeCli, config?.exclude);

    const agentOpts = {};
    if (mode === "npm") {
      if (npmrc["strict-ssl"] === false) {
        agentOpts.rejectUnauthorized = false;
      }
      if ("cafile" in npmrc) {
        agentOpts.ca = getCerts(extractCerts(readFileSync(npmrc.cafile, "utf8")));
      }
      if ("ca" in npmrc) {
        const cas = Array.isArray(npmrc.ca) ? npmrc.ca : [npmrc.ca];
        agentOpts.ca = getCerts(cas.map(ca => extractCerts(ca)));
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

    let pkg;
    try {
      pkgStrs[mode] = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`Unable to open ${file}: ${err.message}`);
    }

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else {
        pkg = (await import("@iarna/toml/parse-string.js")).default(pkgStrs[mode]);
      }
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${err.message}`);
    }

    for (const depType of dependencyTypes) {
      let obj;
      if (mode === "npm") {
        obj = pkg[depType] || {};
      } else {
        obj = getProperty(pkg, depType) || {};
      }

      for (const [name, value] of Object.entries(obj)) {
        if (validRange(value) && canInclude(name, mode, {include, exclude})) {
          deps[mode][`${depType}${sep}${name}`] = {
            old: normalizeRange(value),
            oldOriginal: value,
          };
        } else if (mode === "npm" && canInclude(name, mode, {include, exclude})) {
          maybeUrlDeps[`${depType}${sep}${name}`] = {
            old: value,
          };
        }
      }
    }

    numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
    if (!numDependencies) continue;

    let registry;
    if (mode === "npm") {
      registry = normalizeUrl(args.registry || config.registry || npmrc.registry);
    }

    const entries = await pAll(Object.keys(deps[mode]).map(key => () => {
      const [type, name] = key.split(sep);
      if (mode === "npm") {
        return fetchNpmInfo(name, type, registry, agentOpts);
      } else {
        return fetchPypiInfo(name, type, agentOpts);
      }
    }), {concurrency: maxSockets});

    for (const [data, type, registry, name] of entries) {
      if (data?.error) throw new Error(data.error);

      const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(data.name, greatest);
      const usePre = typeof prerelease === "boolean" ? prerelease : matchesAny(data.name, prerelease);
      const useRel = typeof release === "boolean" ? release : matchesAny(data.name, release);

      let semvers;
      if (patch === true || matchesAny(data.name, patch)) {
        semvers = patchSemvers;
      } else if (minor === true || matchesAny(data.name, minor)) {
        semvers = minorSemvers;
      } else {
        semvers = majorSemvers;
      }

      const key = `${type}${sep}${name}`;
      const oldRange = deps[mode][key].old;
      const newVersion = findNewVersion(data, {
        usePre, useRel, useGreatest, semvers, range: oldRange, mode,
      });
      const newRange = updateRange(oldRange, newVersion);

      if (!newVersion || oldRange === newRange) {
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
      const results = await Promise.all(Object.entries(maybeUrlDeps).map(([key, dep]) => {
        const name = key.split(sep)[1];
        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(name, greatest);
        return checkUrlDep([key, dep], {useGreatest});
      }));

      for (const res of (results || []).filter(Boolean)) {
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
    finishWithMessage("No dependencies found, nothing to do");
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
        let fn;
        if (mode === "npm") {
          fn = updatePackageJson;
        } else {
          fn = updateProjectToml;
        }
        await write(filePerMode[mode], fn(pkgStrs[mode], deps[mode]));
      } catch (err) {
        throw new Error(`Error writing ${basename(filePerMode[mode])}: ${err.message}`);
      }

      // TODO: json
      console.info(green(`✨ ${basename(filePerMode[mode])} updated`));
    }
  }

  doExit(exitCode);
}

main().catch(doExit).then(doExit);
