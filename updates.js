#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "production";
const MAX_SOCKETS = 64;

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/1
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#.]+)?.*?([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]+$/i;

const args = require("minimist")(process.argv.slice(2), {
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
  process.stdout.write(`usage: updates [options]

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
  process.exit(0);
}

const path = require("path");

if (args.version) {
  console.info(require(path.join(__dirname, "package.json")).version);
  process.exit(0);
}

if (args["no-color"]) {
  process.env.FORCE_COLOR = "0";
} else if (args["color"] || process.stdout.isTTY === undefined) { // winpty compat
  process.env.FORCE_COLOR = "1";
}

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);
const release = parseMixedArg(args.release);
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);
const allowDowngrade = parseMixedArg(args["allow-downgrade"]);

const chalk = require("chalk");
const defaultRegistry = "https://registry.npmjs.org";
const npmrc = require("rc")("npm", {registry: defaultRegistry});
const authTokenOpts = {npmrc, recursive: true};
const registry = normalizeRegistryUrl(args.registry || npmrc.registry);
const maxSockets = typeof args.sockets === "number" ? args.sockets : MAX_SOCKETS;

let packageFile;
const deps = {};
const maybeUrlDeps = {};

if (args.file) {
  let stat;
  try {
    stat = require("fs").lstatSync(args.file);
  } catch (err) {
    finish(new Error(`Unable to open ${args.file}: ${err.message}`));
  }

  if (stat && stat.isFile()) {
    packageFile = args.file;
  } else if (stat && stat.isDirectory()) {
    packageFile = path.join(args.file, "package.json");
  } else {
    finish(new Error(`${args.file} is neither a file nor directory`));
  }
} else {
  packageFile = require("find-up").sync("package.json");
  if (!packageFile) {
    finish(new Error(`Unable to find package.json in ${process.cwd()} or any of its parent directories`));
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

const fs = require("fs");
let pkg, pkgStr;

try {
  pkgStr = fs.readFileSync(packageFile, "utf8");
} catch (err) {
  finish(new Error(`Unable to open package.json: ${err.message}`));
}

try {
  pkg = JSON.parse(pkgStr);
} catch (err) {
  finish(new Error(`Error parsing package.json: ${err.message}`));
}

const semver = require("semver");

let include, exclude;
if (args.include && args.include !== true) include = args.include.split(",");
if (args.exclude && args.exclude !== true) exclude = args.exclude.split(",");

for (const key of dependencyTypes) {
  if (pkg[key]) {
    const names = Object.keys(pkg[key])
      .filter(name => !include ? true : include.includes(name))
      .filter(name => !exclude ? true : !exclude.includes(name));

    for (const name of names) {
      const old = pkg[key][name];
      if (isValidSemverRange(old)) {
        deps[`${key}|${name}`] = {old};
      } else {
        maybeUrlDeps[`${key}|${name}`] = {old};
      }
    }
  }
}

if (!Object.keys(deps).length) {
  if (include || exclude) {
    finish(new Error("No packages match the given filters"));
  } else {
    finish(new Error("No packages found"));
  }
}

const fetch = require("make-fetch-happen");
const gitInfo = memoize(require("hosted-git-info").fromUrl);
const registryAuthToken = memoize(require("registry-auth-token"));
const registryUrl = memoize(require("registry-auth-token/registry-url"));

function esc(str) {
  return str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function memoize(fn) {
  const cache = {};
  return (arg, arg2) => cache[arg] || (cache[arg] = fn(arg, arg2));
}

function getAuthAndRegistry(name, registry) {
  if (!name.startsWith("@")) {
    return [registryAuthToken(registry, authTokenOpts), registry];
  } else {
    const scope = (/@[a-z0-9][\w-.]+/.exec(name) || [])[0];
    const url = normalizeRegistryUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = registryAuthToken(url, authTokenOpts);
        if (newAuth && newAuth.token) {
          return [newAuth, url];
        }
      } catch (err) {
        return [registryAuthToken(registry, authTokenOpts), registry];
      }
    } else {
      return [registryAuthToken(registry, authTokenOpts), registry];
    }
  }
}

function fetchFromRegistry(name, registry, auth) {
  // on scoped packages replace "/" with "%2f"
  if (/@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*/gi.test(name)) {
    name = name.replace(/\//g, "%2f");
  }

  const opts = {maxSockets};
  if (auth && auth.token) {
    opts.headers = {Authorization: `${auth.type} ${auth.token}`};
  }

  return fetch(`${registry}/${name}`, opts);
}

const get = async (name, type, originalRegistry) => {
  const [auth, registry] = getAuthAndRegistry(name, originalRegistry);

  let res;
  try {
    res = await fetchFromRegistry(name, registry, auth);
  } catch (err) {
    if (registry === defaultRegistry) throw err;
  }
  if (res && res.ok) {
    return [await res.json(), type, registry];
  } else if (res && res.status && res.statusText && registry === defaultRegistry) {
    throw new Error(`Received ${res.status} ${res.statusText} for ${name}`);
  }

  // retry on default registry if custom registry fails
  // TODO: evaluate if this retrying can be dropped
  if (registry !== defaultRegistry) {
    res = await fetchFromRegistry(name, defaultRegistry);
    if (res && res.ok) {
      return [await res.json(), type, registry];
    } else if (res && res.status && res.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name}`);
    }
  }
};

const getInfoUrl = ({repository, homepage}, registry, name) => {
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    const info = gitInfo(url);
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

  if (args.json) {
    if (!hadError) {
      output.results = {};
      for (const [key, value] of Object.entries(deps)) {
        const [type, name] = key.split("|");
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
          console.info(chalk[index === "0" ? "red" : "grey"](line));
        }
      }
    }
  }

  if (args["error-on-outdated"]) {
    process.exit(Object.keys(deps).length ? 2 : 0);
  } else if (args["error-on-unchanged"]) {
    process.exit(Object.keys(deps).length ? 0 : 2);
  } else {
    process.exit(opts.exitCode || (output.error ? 1 : 0));
  }
}

function write(file, content) {
  if (require("os").platform() === "win32") {
    // truncate and append on windows to preserve file metadata
    fs.truncateSync(file, 0);
    fs.writeFileSync(file, content, {encoding: "utf8", flag: "r+"});
  } else {
    fs.writeFileSync(file, content, {encoding: "utf8"});
  }
}

function normalizeRegistryUrl(url) {
  return url.endsWith("/") ? url.substring(0, url.length - 1) : url;
}

function highlightDiff(a, b, added) {
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const color = chalk[added ? "green" : "red"];
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;
  let res = "";

  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += color(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? color(char) : char;
        }).join("") + color("." + aParts.slice(i + 1).join("."));
      }
      break;
    } else {
      res += aParts[i] + ".";
    }
  }

  return res;
}

function formatDeps() {
  const arr = [["NAME", "OLD", "NEW", "INFO"]];

  for (const [key, data] of Object.entries(deps)) {
    const [_type, name] = key.split("|");
    arr.push([
      name,
      highlightDiff(data.oldPrint || data.old, data.newPrint || data.new, false),
      highlightDiff(data.newPrint || data.new, data.oldPrint || data.old, true),
      data.info,
    ]);
  }

  return require("text-table")(arr, {
    hsep: " ".repeat(2),
    stringLength: require("string-width"),
  });
}

function updatePackageJson() {
  let newPkgStr = pkgStr;

  for (const key of Object.keys(deps)) {
    const [_type, name] = key.split("|");
    const re = new RegExp(`"${esc(name)}": +"${esc(deps[key].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
  }

  return newPkgStr;
}

function updateRange(range, version) {
  return range.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g, version);
}

function isValidSemverRange(range) {
  let valid = false;
  try {
    semver.Range(range);
    valid = true;
  } catch (err) {}
  return valid;
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
  } catch (err) {
    return null;
  }
}

function findVersion(data, versions, opts) {
  let tempVersion = rangeToVersion(opts.range);
  let tempDate = 0;

  const semvers = opts.semvers.slice();
  const usePre = isRangePrerelease(opts.range) || opts.usePre;

  if (usePre) {
    semvers.push("prerelease");
    if (semvers.includes("patch")) semvers.push("prepatch");
    if (semvers.includes("minor")) semvers.push("preminor");
    if (semvers.includes("major")) semvers.push("premajor");
  }

  for (const version of versions) {
    const parsed = semver.parse(version);
    if (parsed.prerelease.length && (!usePre || opts.useRel)) continue;

    const diff = semver.diff(tempVersion, parsed.version);
    if (!diff || !semvers.includes(diff)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (opts.useGreatest || !("time" in data)) {
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
    if (diff && diff !== "prerelease" && !opts.semvers.includes(diff.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (opts.useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (semver.lt(latestTag, oldVersion) && !latestIsPre) {
      if (allowDowngrade === true || (Array.isArray(allowDowngrade) && allowDowngrade.includes(data.name))) {
        return latestTag;
      } else {
        return null;
      }
    }

    // in all other cases, return latest dist-tag
    return latestTag;
  }
}

async function checkUrlDep([key, dep], {useGreatest} = {}) {
  const stripped = dep.old.replace(stripRe, "");
  if (typeof stripped !== "array") return;
  const [_, user, repo, oldRef] = partsRe.exec(stripped);
  if (!user || !repo || !oldRef) return;

  if (hashRe.test(oldRef)) {
    const res = await fetch(`https://api.github.com/repos/${user}/${repo}/commits`);
    if (!res || !res.ok) return;
    const data = await res.json();
    let newRef = data.map(entry => entry.sha)[0];
    if (!newRef || !newRef.length) return;
    newRef = newRef.substring(0, oldRef.length);
    if (oldRef !== newRef) {
      const newRange = dep.old.replace(oldRef, newRef);
      return {key, newRange, user, repo, oldRef, newRef};
    }
  } else {
    const res = await fetch(`https://api.github.com/repos/${user}/${repo}/git/refs/tags`);
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
  if (arg === "") {
    return true;
  } else if (typeof arg === "string") {
    return arg.includes(",") ? arg.split(",") : [arg];
  } else if (Array.isArray(arg)) {
    return arg;
  } else {
    return false;
  }
}

async function main() {
  const dati = await Promise.all(Object.keys(deps).map(key => {
    const [type, name] = key.split("|");
    return get(name, type, registry);
  }));

  for (const [data, type, registry] of dati) {
    if (data && data.error) {
      throw new Error(data.error);
    }

    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.includes(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.includes(data.name);
    const useRel = typeof release === "boolean" ? release : release.includes(data.name);

    let semvers;
    if (patch === true || Array.isArray(patch) && patch.includes(data.name)) {
      semvers = ["patch"];
    } else if (minor === true || Array.isArray(minor) && minor.includes(data.name)) {
      semvers = ["patch", "minor"];
    } else {
      semvers = ["patch", "minor", "major"];
    }

    const key = `${type}|${data.name}`;
    const oldRange = deps[key].old;
    const newVersion = findNewVersion(data, {usePre, useRel, useGreatest, semvers, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[key];
    } else {
      deps[key].new = newRange;
      deps[key].info = getInfoUrl(data.versions[newVersion] || data, registry, data.name);
    }
  }

  if (Object.keys(maybeUrlDeps).length) {
    let results = await Promise.all(Object.entries(maybeUrlDeps).map(([key, dep]) => {
      const [_, name] = key.split("|");
      const useGreatest = typeof greatest === "boolean" ? greatest : greatest.includes(name);
      return checkUrlDep([key, dep], {useGreatest});
    }));
    results = results.filter(r => !!r);
    for (const res of results || []) {
      const {key, newRange, user, repo, oldRef, newRef} = res;
      deps[key] = {
        old: maybeUrlDeps[key].old,
        new: newRange,
        oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
        newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
        info: `https://github.com/${user}/${repo}`,
      };
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

  finish(chalk.green(`
 ╭────────────────────────╮
 │  package.json updated  │
 ╰────────────────────────╯`.substring(1)));
}

main().catch(finish);
