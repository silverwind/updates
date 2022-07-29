#!/usr/bin/env node
import ansiRegex from "ansi-regex";
import dns from "dns";
import fetchEnhanced from "fetch-enhanced";
import minimist from "minimist";
import nodeFetch from "node-fetch";
import rat from "registry-auth-token";
import rc from "rc";
import ru from "registry-auth-token/registry-url.js";
import semver from "semver";
import textTable from "text-table";
import {cwd, stdout, argv, env, exit} from "process";
import {fromUrl} from "hosted-git-info";
import {join, dirname} from "path";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync} from "fs";
import {platform} from "os";
import {rootCertificates} from "tls";
import {timerel} from "timerel";

const fetch = fetchEnhanced(nodeFetch);
const MAX_SOCKETS = 96;
const sep = "\0";
const pwd = cwd();

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const esc = str => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const hostedGitInfo = memoize(fromUrl);
const registryAuthToken = memoize(rat);
const registryUrl = memoize(ru);
const normalizeUrl = memoize(url => url.endsWith("/") ? url.substring(0, url.length - 1) : url);
const patchSemvers = new Set(["patch"]);
const minorSemvers = new Set(["patch", "minor"]);
const majorSemvers = new Set(["patch", "minor", "major"]);

// dns cache
const cache = Object.create(null);
const waiting = Object.create(null);
const originalLookup = dns.lookup;
dns.lookup = (hostname, opts, callback) => {
  if (!callback) {
    callback = opts;
    opts = undefined;
  }
  if (hostname in cache) {
    callback(...cache[hostname]);
  } else {
    if (!(hostname in waiting)) {
      waiting[hostname] = [callback];
      originalLookup(hostname, opts, (...args) => {
        if (!(hostname in cache)) cache[hostname] = args;
        for (const callback of waiting[hostname]) {
          callback(...args);
        }
      });
    } else {
      waiting[hostname].push(callback);
    }
  }
};

// workaround for https://github.com/nodejs/node/issues/6379
for (const stream of [process.stdout, process.stderr]) {
  stream?._handle?.setBlocking?.(true);
}

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
    "G", "githubapi",
    "m", "minor",
    "P", "patch",
    "p", "prerelease",
    "R", "release",
    "r", "registry",
    "t", "types",
  ],
  alias: {
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
    V: "verbose",
  },
});

if (args.color === false) env.NO_COLOR = "1";

let magenta, red, green, gray;
if ("NO_COLOR" in env || env.TERM === "dumb") {
  magenta = red = green = gray = str => str;
} else {
  magenta = str => `\x1b[35m${str}\x1b[0m`;
  red = str => `\x1b[31m${str}\x1b[0m`;
  green = str => `\x1b[32m${str}\x1b[0m`;
  gray = str => `\x1b[90m${str}\x1b[0m`;
}

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
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -G, --githubapi <url>              Override Github API URL
    -f, --file <path>                  Use given package.json file or module directory
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${MAX_SOCKETS}
    -j, --json                         Output a JSON object
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
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
  const path = new URL("package.json", import.meta.url);
  const {version} = JSON.parse(readFileSync(path, "utf8"));
  console.info(version);
  exit(0);
}

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);
const release = parseMixedArg(args.release);
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);
const allowDowngrade = parseMixedArg(args["allow-downgrade"]);

const npmrc = rc("npm", {registry: "https://registry.npmjs.org"});
const authTokenOpts = {npmrc, recursive: true};
const registry = normalizeUrl(args.registry || npmrc.registry);
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";
const maxSockets = typeof args.sockets === "number" ? parseInt(args.sockets) : MAX_SOCKETS;
const extractCerts = str => Array.from(str.matchAll(/(----BEGIN CERT[^]+?IFICATE----)/g)).map(m => m[0]);

const agentOpts = {};
if (npmrc["strict-ssl"] === false) {
  agentOpts.rejectUnauthorized = false;
} else {
  if ("cafile" in npmrc) {
    agentOpts.ca = rootCertificates.concat(extractCerts(readFileSync(npmrc.cafile, "utf8")));
  }
  if ("ca" in npmrc) {
    const cas = Array.isArray(npmrc.ca) ? npmrc.ca : [npmrc.ca];
    agentOpts.ca = rootCertificates.concat(cas.map(ca => extractCerts(ca)));
  }
}

let packageFile;
if (args.file) {
  let stat;
  try {
    stat = lstatSync(args.file);
  } catch (err) {
    finish(new Error(`Unable to open ${args.file}: ${err.message}`));
  }

  if (stat?.isFile()) {
    packageFile = args.file;
  } else if (stat?.isDirectory()) {
    packageFile = join(args.file, "package.json");
  } else {
    finish(new Error(`${args.file} is neither a file nor directory`));
  }
} else {
  packageFile = findSync("package.json", pwd);
  if (!packageFile) {
    finish(new Error(`Unable to find package.json in ${pwd} or any of its parents`));
  }
}

let dependencyTypes;
if (args.types) {
  dependencyTypes = Array.isArray(args.types) ? args.types : args.types.split(",");
} else {
  dependencyTypes = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "resolutions",
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
if (args.include && args.include !== true) include = new Set(((Array.isArray(args.include) ? args.include : [args.include]).flatMap(item => item.split(","))));
if (args.exclude && args.exclude !== true) exclude = new Set(((Array.isArray(args.exclude) ? args.exclude : [args.exclude]).flatMap(item => item.split(","))));

function canInclude(name) {
  if (exclude?.has?.(name) === true) return false;
  if (include?.has?.(name) === false) return false;
  return true;
}

const deps = {}, maybeUrlDeps = {};
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
  finish(new Error(`No packages ${include || exclude ? "match the given filters" : "found"}`));
}

function memoize(fn) {
  const cache = Object.create(null);
  return (arg, arg2) => arg in cache ? cache[arg] : cache[arg] = fn(arg, arg2);
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
        if (newAuth?.token) {
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

async function fetchInfo(name, type, originalRegistry) {
  const [auth, registry] = getAuthAndRegistry(name, originalRegistry);

  const opts = {maxSockets};
  if (Object.keys(agentOpts).length) {
    opts.agentOpts = agentOpts;
  }
  if (auth?.token) {
    opts.headers = {Authorization: `${auth.type} ${auth.token}`};
  }

  const packageName = type === "resolutions" ? resolutionsBasePackage(name) : name;
  const urlName = packageName.replace(/\//g, "%2f");

  const url = `${registry}/${urlName}`;
  if (args.verbose) console.error(`${magenta("fetch")} ${url}`);

  const res = await fetch(url, opts);
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

function getInfoUrl({repository, homepage}, registry, name) {
  let infoUrl;
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;

    const info = hostedGitInfo(url);
    if (info?.browse) {
      // https://github.com/babel/babel
      infoUrl = info.browse();
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
  }

  let url = infoUrl || homepage || "";
  // force https for github.com
  if (url) {
    const u = new URL(url);
    if (u.hostname === "github.com" && u.protocol === "http:") {
      u.protocol = "https:";
      url = String(u);
    }
  }
  return url;
}

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

  fetch.clearCache();

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
    hsep: " ",
    stringLength: str => str.replace(ansiRegex(), "").length,
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
  if (opts.range === "*") return null; // ignore wildcard
  if (opts.range.includes("||")) return null; // ignore or-chains
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
      if (allowDowngrade === true || allowDowngrade?.has?.(data.name)) {
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

function resolutionsBasePackage(name) {
  const packages = name.match(/(@[^/]+\/)?([^/]+)/g) || [];
  return packages[packages.length - 1];
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
  const entries = await Promise.all(Object.keys(deps).map(key => {
    const [type, name] = key.split(sep);
    return fetchInfo(name, type, registry);
  }));

  for (const [data, type, registry, name] of entries) {
    if (data?.error) {
      throw new Error(data.error);
    }

    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.has(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.has(data.name);
    const useRel = typeof release === "boolean" ? release : release.has(data.name);

    let semvers;
    if (patch === true || patch?.has?.(data.name)) {
      semvers = patchSemvers;
    } else if (minor === true || minor?.has?.(data.name)) {
      semvers = minorSemvers;
    } else {
      semvers = majorSemvers;
    }

    const key = `${type}${sep}${name}`;
    const oldRange = deps[key].old;
    const newVersion = findNewVersion(data, {usePre, useRel, useGreatest, semvers, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[key];
    } else {
      deps[key].new = newRange;
      deps[key].info = getInfoUrl(data.versions[newVersion] || data, registry, data.name);
      if (data.time?.[newVersion]) deps[key].age = timerel(data.time[newVersion], {noAffix: true});
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
        ...(newDate ? {age: timerel(newDate, {noAffix: true})} : {}),
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

  finish(green(`✨ package.json updated`));
}

main().catch(finish);
