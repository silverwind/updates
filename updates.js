#!/usr/bin/env node
"use strict";

const ansiRegex = require("ansi-regex")();
const dns = require("dns");
const fetch = require("make-fetch-happen");
const minimist = require("minimist");
const rat = require("registry-auth-token");
const rc = require("rc");
const ru = require("registry-auth-token/registry-url");
const semver = require("semver");
const textTable = require("text-table");
const {cwd: cwdFn, stdout, argv, env, exit} = require("process");
const {fromUrl} = require("hosted-git-info");
const {join, dirname} = require("path");
const {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync} = require("fs");
const {platform} = require("os");

env.NODE_ENV = "production";

const MAX_SOCKETS = 96;
const sep = "\0";
const cwd = cwdFn();

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]+$/i;

const memoize = fn => {
  const cache = {};
  return (arg, arg2) => cache[arg] || (cache[arg] = fn(arg, arg2));
};

const esc = str => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const hostedGitInfo = memoize(fromUrl);
const registryAuthToken = memoize(rat);
const registryUrl = memoize(ru);
const normalizeUrl = memoize(url => url.endsWith("/") ? url.substring(0, url.length - 1) : url);

// dns cache
const cache = {};
const waiting = {};
const originalLookup = dns.lookup;
dns.lookup = (hostname, opts, callback) => {
  if (!callback) {
    callback = opts;
    opts = undefined;
  }
  if (cache[hostname]) {
    callback(...cache[hostname]);
  } else {
    if (!waiting[hostname]) {
      waiting[hostname] = [callback];
      originalLookup(hostname, opts, (...args) => {
        if (!cache[hostname]) cache[hostname] = args;
        waiting[hostname].forEach(callback => callback(...args));
      });
    } else {
      waiting[hostname].push(callback);
    }
  }
};

const args = minimist(argv.slice(2), {
  boolean: [
    "c", "color",
    "E", "error-on-outdated",
    "U", "error-on-unchanged",
    "h", "help",
    "j", "json",
    "n", "no-color",
    "u", "update",
    "v", "version",
  ],
  string: [
    "d", "allow-downgrade",
    "f", "file",
    "g", "greatest",
    "G", "githubapi",
    "m", "minor",
    "P", "patch",
    "p", "prerelease",
    "R", "release",
    "r", "registry",
    "t", "types",
  ],
  alias: {
    c: "color",
    d: "allow-downgrade",
    E: "error-on-outdated",
    U: "error-on-unchanged",
    e: "exclude",
    f: "file",
    g: "greatest",
    G: "githubapi",
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
  },
});

if (args.help) {
  stdout.write(`usage: updates [options]

  Options:
    -u, --update                       Update versions and write package.json
    -p, --prerelease [<pkg,...>]       Consider prerelease versions
    -R, --release [<pkg,...>]          Only use release versions, may downgrade
    -g, --greatest [<pkg,...>]         Prefer greatest over latest version
    -i, --include <pkg,...>            Include only given packages
    -e, --exclude <pkg,...>            Exclude given packages
    -t, --types <type,...>             Check only given dependency types
    -P, --patch [<pkg,...>]            Consider only up to semver-patch
    -m, --minor [<pkg,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<pkg,...>]  Allow version downgrades when using latest version
    -E, --error-on-outdated            Exit with code 2 when updates are available and code 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and code 2 when not
    -r, --registry <url>               Override npm registry URL
    -G, --githubapi <url>              Override Github API URL
    -f, --file <path>                  Use given package.json file or module directory
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${MAX_SOCKETS}
    -j, --json                         Output a JSON object
    -c, --color                        Force-enable color output
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -m -e eslint
    $ updates -u -U && rm -rf node_modules && npm i
`);
  exit(0);
}

if (args.version) {
  console.info(require("./package.json").version);
  exit(0);
}

if (args["no-color"]) {
  env.NO_COLOR = "0";
} else if (args["color"] || stdout.isTTY === undefined) { // winpty compat
  env.FORCE_COLOR = "1";
}
const {gray, green, red} = require("colorette");

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);
const release = parseMixedArg(args.release);
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);
const allowDowngrade = parseMixedArg(args["allow-downgrade"]);

const defaultRegistry = "https://registry.npmjs.org";
const npmrc = rc("npm", {registry: defaultRegistry});
const authTokenOpts = {npmrc, recursive: true};
const registry = normalizeUrl(args.registry || npmrc.registry);
const maxSockets = typeof args.sockets === "number" ? args.sockets : MAX_SOCKETS;
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";

let packageFile;
const deps = {};
const maybeUrlDeps = {};

if (args.file) {
  let stat;
  try {
    stat = lstatSync(args.file);
  } catch (err) {
    finish(new Error(`Unable to open ${args.file}: ${err.message}`));
  }

  if (stat && stat.isFile()) {
    packageFile = args.file;
  } else if (stat && stat.isDirectory()) {
    packageFile = join(args.file, "package.json");
  } else {
    finish(new Error(`${args.file} is neither a file nor directory`));
  }
} else {
  packageFile = findSync("package.json", cwd);
  if (!packageFile) {
    finish(new Error(`Unable to find package.json in ${cwd} or any of its parents`));
  }
}

let dependencyTypes;
if (args.types) {
  dependencyTypes = Array.isArray(args.types) ? args.types : args.types.split(",");
} else {
  dependencyTypes = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
}

let pkg, pkgStr;

try {
  pkgStr = readFileSync(packageFile, "utf8");
} catch (err) {
  finish(new Error(`Unable to open package.json: ${err.message}`));
}

try {
  pkg = JSON.parse(pkgStr);
} catch (err) {
  finish(new Error(`Error parsing package.json: ${err.message}`));
}

let include, exclude;
if (args.include && args.include !== true) include = new Set(args.include.split(","));
if (args.exclude && args.exclude !== true) exclude = new Set(args.exclude.split(","));

function canInclude(name) {
  if (exclude && exclude.has(name)) return false;
  if (include && !include.has(name)) return false;
  return true;
}

for (const depType of dependencyTypes) {
  for (const [name, value] of Object.entries(pkg[depType] || {})) {
    if (semver.validRange(value) && canInclude(name)) {
      deps[`${depType}${sep}${name}`] = {old: value};
    } else if (canInclude(name)) {
      maybeUrlDeps[`${depType}${sep}${name}`] = {old: value};
    }
  }
}

if (!Object.keys(deps).length && !Object.keys(maybeUrlDeps).length) {
  if (include || exclude) {
    finish(new Error("No packages match the given filters"));
  } else {
    finish(new Error("No packages found"));
  }
}

const timeData = [
  [1e3, 1, "ns"],
  [1e6, 1e3, "µs"],
  [1e9, 1e6, "ms"],
  [60e9, 1e9, "sec"],
  [3600e9, 60e9, "min"],
  [86400e9, 3600e9, "hour"],
  [2592e12, 86400e9, "day"],
  [31536e12, 2592e12, "month"],
  [Infinity, 31536e12, "year"],
];

function getAge(isoDateString) {
  if (!isoDateString) return "";
  const unix = new Date(isoDateString).getTime() * 1e6;
  if (Number.isNaN(unix)) return "";
  const diff = (Date.now() * 1e6) - unix;
  if (diff <= 0) return "none";

  let value, suffix;
  for (let i = 0; i <= timeData.length; i++) {
    const entry = timeData[i];
    const [end, start, unit] = entry || [];
    if (entry && end && diff < end) {
      value = Math.round(diff / start);
      suffix = `${unit}${(value > 1 && !unit.endsWith("s")) ? "s" : ""}`;
      break;
    }
  }

  return `${value} ${suffix}`;
}

function findSync(filename, dir, stopDir) {
  const path = join(dir, filename);

  try {
    accessSync(path);
    return path;
  } catch {}

  const parent = dirname(dir);
  if ((stopDir && path === stopDir) || parent === dir) {
    return null;
  } else {
    return findSync(filename, parent, stopDir);
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
        if (newAuth && newAuth.token) {
          return [newAuth, url];
        }
      } catch {
        return [registryAuthToken(registry, authTokenOpts), registry];
      }
    } else {
      return [registryAuthToken(registry, authTokenOpts), registry];
    }
  }
}

function fetchFromRegistry(name, registry, auth) {
  const opts = {
    maxSockets,
    cacheManager: null,
    integrity: null,
    retry: 5,
  };

  if (auth && auth.token) {
    opts.headers = {Authorization: `${auth.type} ${auth.token}`};
  }
  return fetch(`${registry}/${name.replace(/\//g, "%2f")}`, opts);
}

const get = async (name, type, originalRegistry) => {
  const [auth, registry] = getAuthAndRegistry(name, originalRegistry);

  const res = await fetchFromRegistry(name, registry, auth);
  if (res && res.ok) {
    return [await res.json(), type, registry];
  } else {
    if (res && res.status && res.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name} from ${registry}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${registry}`);
    }
  }
};

const getInfoUrl = ({repository, homepage}, registry, name) => {
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    const info = hostedGitInfo(url);
    if (info && info.browse) return info.browse();
    if (repository && repository.url && /^https?:/.test(repository.url)) return repository.url;
  }

  return homepage || "";
};

function finish(obj, opts = {}) {
  const output = {};
  const hadError = obj instanceof Error;

  if (typeof obj === "string") {
    output.message = obj;
  } else if (hadError) {
    output.error = obj.stack;
  }

  for (const value of Object.values(deps)) {
    if ("oldPrint" in value) {
      value.old = value.oldPrint;
      delete value.oldPrint;
    }
    if ("newPrint" in value) {
      value.new = value.newPrint;
      delete value.newPrint;
    }
  }

  if (args.json) {
    if (!hadError) {
      output.results = {};
      for (const [key, value] of Object.entries(deps)) {
        const [type, name] = key.split(sep);
        if (!output.results[type]) output.results[type] = {};
        output.results[type][name] = value;
      }
    }
    console.info(JSON.stringify(output));
  } else {
    if (Object.keys(deps).length && !hadError) {
      console.info(formatDeps(deps));
    }
    if (output.message || output.error) {
      if (output.message) {
        console.info(output.message);
      } else if (output.error) {
        const lines = output.error.split(/\r?\n/);
        for (const [index, line] of Object.entries(lines)) {
          console.info((index === "0" ? red : gray)(line));
        }
      }
    }
  }

  if (args["error-on-outdated"]) {
    exit(Object.keys(deps).length ? 2 : 0);
  } else if (args["error-on-unchanged"]) {
    exit(Object.keys(deps).length ? 0 : 2);
  } else {
    exit(opts.exitCode || (output.error ? 1 : 0));
  }
}

// preserve file metadata on windows
function write(file, content) {
  const isWindows = platform() === "win32";
  if (isWindows) truncateSync(file, 0);
  writeFileSync(file, content, isWindows ? {flag: "r+"} : undefined);
}

function highlightDiff(a, b, added) {
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const color = added ? green : red;
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;
  let res = "";

  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += color(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? color(char) : char;
        }).join("") + color(`.${aParts.slice(i + 1).join(".")}`);
      }
      break;
    } else {
      res += `${aParts[i]}.`;
    }
  }

  return res;
}

function formatDeps() {
  const arr = [["NAME", "OLD", "NEW", "AGE", "INFO"]];

  for (const [key, data] of Object.entries(deps)) {
    const [_type, name] = key.split(sep);
    arr.push([
      name,
      highlightDiff(data.old, data.new, false),
      highlightDiff(data.new, data.old, true),
      data.age || "",
      data.info,
    ]);
  }

  return textTable(arr, {
    hsep: "  ",
    stringLength: str => str.replace(ansiRegex, "").length,
  });
}

function updatePackageJson() {
  let newPkgStr = pkgStr;

  for (const key of Object.keys(deps)) {
    const [_type, name] = key.split(sep);
    const re = new RegExp(`"${esc(name)}": +"${esc(deps[key].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
  }

  return newPkgStr;
}

function updateRange(range, version) {
  return range.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g, version);
}

function isVersionPrerelease(version) {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

function isRangePrerelease(range) {
  // can not use semver.coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function rangeToVersion(range) {
  try {
    return semver.coerce(range).version;
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
    const parsed = semver.parse(version);
    if (parsed.prerelease.length && (!usePre || useRel)) continue;

    const diff = semver.diff(tempVersion, parsed.version);
    if (!diff || !semvers.has(diff)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (semver.gte(semver.coerce(parsed.version).version, tempVersion)) {
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

function findNewVersion(data, opts) {
  if (opts.range === "*") return "*";
  const versions = Object.keys(data.versions).filter(version => semver.valid(version));
  const version = findVersion(data, versions, opts);

  if (opts.useGreatest) {
    return version;
  } else {
    const latestTag = data["dist-tags"].latest;
    const oldVersion = semver.coerce(opts.range).version;
    const oldIsPre = isRangePrerelease(opts.range);
    const newIsPre = isVersionPrerelease(version);
    const latestIsPre = isVersionPrerelease(latestTag);
    const isGreater = semver.gt(version, oldVersion);

    // update to new prerelease
    if (!opts.useRel && opts.usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // downgrade from prerelease to release on --release-only
    if (opts.useRel && !isGreater && oldIsPre && !newIsPre) {
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
    const diff = semver.diff(oldVersion, latestTag);
    if (diff && diff !== "prerelease" && !opts.semvers.has(diff.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (opts.useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (semver.lt(latestTag, oldVersion) && !latestIsPre) {
      if (allowDowngrade === true || (Array.isArray(allowDowngrade) && allowDowngrade.has(data.name))) {
        return latestTag;
      } else {
        return null;
      }
    }

    // in all other cases, return latest dist-tag
    return latestTag;
  }
}

// TODO: refactor this mess
async function checkUrlDep([key, dep], {useGreatest} = {}) {
  const stripped = dep.old.replace(stripRe, "");
  const [_, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return;

  if (hashRe.test(oldRef)) {
    const res = await fetch(`${githubApiUrl}/repos/${user}/${repo}/commits`);
    if (!res || !res.ok) return;
    const data = await res.json();
    let {sha: newRef, commit} = data[0];
    if (!newRef || !newRef.length) return;

    let newDate;
    if (commit && commit.committer && commit.committer.date) {
      newDate = commit.committer.date;
    } else if (commit && commit.auhor && commit.author.date) {
      newDate = commit.author.date;
    }

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
    if (!semver.valid(oldRefBare)) return;

    if (!useGreatest) {
      const lastTag = tags[tags.length - 1];
      const lastTagBare = lastTag.replace(/^v/, "");
      if (!semver.valid(lastTagBare)) return;

      if (semver.neq(oldRefBare, lastTagBare)) {
        const newRange = lastTag;
        const newRef = lastTag;
        return {key, newRange, user, repo, oldRef, newRef};
      }
    } else {
      let greatestTag = oldRef;
      let greatestTagBare = oldRef.replace(/^v/, "");

      for (const tag of tags) {
        const tagBare = tag.replace(/^v/, "");
        if (!semver.valid(tagBare)) continue;
        if (!greatestTag || semver.gt(tagBare, greatestTagBare)) {
          greatestTag = tag;
          greatestTagBare = tagBare;
        }
      }
      if (semver.neq(oldRefBare, greatestTagBare)) {
        const newRange = greatestTag;
        const newRef = greatestTag;
        return {key, newRange, user, repo, oldRef, newRef};
      }
    }
  }
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

async function main() {
  const dati = await Promise.all(Object.keys(deps).map(key => {
    const [type, name] = key.split(sep);
    return get(name, type, registry);
  }));

  for (const [data, type, registry] of dati) {
    if (data && data.error) {
      throw new Error(data.error);
    }

    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.has(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.has(data.name);
    const useRel = typeof release === "boolean" ? release : release.has(data.name);

    let semvers;
    if (patch === true || Array.isArray(patch) && patch.has(data.name)) {
      semvers = new Set(["patch"]);
    } else if (minor === true || Array.isArray(minor) && minor.has(data.name)) {
      semvers = new Set(["patch", "minor"]);
    } else {
      semvers = new Set(["patch", "minor", "major"]);
    }

    const key = `${type}${sep}${data.name}`;
    const oldRange = deps[key].old;
    const newVersion = findNewVersion(data, {usePre, useRel, useGreatest, semvers, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[key];
    } else {
      deps[key].new = newRange;
      deps[key].info = getInfoUrl(data.versions[newVersion] || data, registry, data.name);
      if (data.time && data.time[newVersion]) deps[key].age = getAge(data.time[newVersion]);
    }
  }

  if (Object.keys(maybeUrlDeps).length) {
    let results = await Promise.all(Object.entries(maybeUrlDeps).map(([key, dep]) => {
      const [_, name] = key.split(sep);
      const useGreatest = typeof greatest === "boolean" ? greatest : greatest.has(name);
      return checkUrlDep([key, dep], {useGreatest});
    }));
    results = results.filter(r => !!r);
    for (const res of results || []) {
      const {key, newRange, user, repo, oldRef, newRef, newDate} = res;
      deps[key] = {
        old: maybeUrlDeps[key].old,
        new: newRange,
        oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
        newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
        info: `https://github.com/${user}/${repo}`,
      };

      if (newDate) deps[key].age = getAge(newDate);
    }
  }

  if (!Object.keys(deps).length) {
    finish("All packages are up to date.");
  }

  if (!args.update) {
    finish();
  }

  try {
    write(packageFile, updatePackageJson());
  } catch (err) {
    finish(new Error(`Error writing ${packageFile}: ${err.message}`));
  }

  finish(green(`
 ╭────────────────────────╮
 │  package.json updated  │
 ╰────────────────────────╯`.substring(1)));
}

main().catch(finish);
