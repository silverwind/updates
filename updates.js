#!/usr/bin/env node
import ansiRegex from "ansi-regex";
import fetchEnhanced from "fetch-enhanced";
import minimist from "minimist";
import nodeFetch from "node-fetch"; // seems twice as fast than undici for the 1500 deps case
import rat from "registry-auth-token";
import rc from "rc";
import ru from "registry-auth-token/registry-url.js";
import semver from "semver";
import textTable from "text-table";
import {cwd, stdout, argv, env, exit, versions} from "node:process";
import hostedGitInfo from "hosted-git-info";
import {join, dirname, basename} from "node:path";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync} from "node:fs";
import {platform} from "node:os";
import {rootCertificates} from "node:tls";
import {timerel} from "timerel";
import supportsColor from "supports-color";
import {magenta, red, green, disableColor} from "glowie";
import parseTOML from "@iarna/toml/parse-string.js";
import {getProperty} from "dot-prop";
import pAll from "p-all";
import memize from "memize";

const {fromUrl} = hostedGitInfo;

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
const gitInfo = memize(fromUrl);
const registryAuthToken = memize(rat);
const registryUrl = memize(ru);
const normalizeUrl = memize(url => url.endsWith("/") ? url.substring(0, url.length - 1) : url);
const patchSemvers = new Set(["patch"]);
const minorSemvers = new Set(["patch", "minor"]);
const majorSemvers = new Set(["patch", "minor", "major"]);
const packageVersion = import.meta.VERSION || "0.0.0";
let config = {};

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
    "l", "language",
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
    l: "language",
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

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);
const release = parseMixedArg(args.release);
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);
const allowDowngrade = parseMixedArg(args["allow-downgrade"]);

const npmrc = rc("npm", {registry: "https://registry.npmjs.org"});
const authTokenOpts = {npmrc, recursive: true};
const githubApiUrl = args.githubapi ? normalizeUrl(args.githubapi) : "https://api.github.com";
const pypiApiUrl = args.pypiapi ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const maxSockets = typeof args.sockets === "number" ? parseInt(args.sockets) : MAX_SOCKETS;

function extractCerts(str) {
  return Array.from(str.matchAll(/(----BEGIN CERT[^]+?IFICATE----)/g), m => m[0]);
}

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

function finish(obj, deps = {}) {
  const output = {};
  const hadError = obj instanceof Error;

  if (typeof obj === "string") {
    output.message = obj;
  } else if (hadError) {
    output.error = obj.stack || obj.message;
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
    if ("oldOriginal" in value) {
      value.old = value.oldOriginal;
      delete value.oldOriginal;
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
        console.info(red(output.error));
      }
    }
  }

  if (args["error-on-outdated"]) {
    exit(Object.keys(deps).length ? 2 : 0);
  } else if (args["error-on-unchanged"]) {
    exit(Object.keys(deps).length ? 0 : 2);
  } else {
    exit(output.error ? 1 : 0);
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

function formatDeps(deps) {
  const arr = [["NAME", "OLD", "NEW", "AGE", "INFO"]];

  for (const [key, data] of Object.entries(deps)) {
    arr.push([
      key.split(sep)[1],
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

function updatePackageJson(pkgStr, deps) {
  let newPkgStr = pkgStr;
  for (const key of Object.keys(deps)) {
    const name = key.split(sep)[1];
    const old = deps[key].oldOriginal || deps[key].old;
    const re = new RegExp(`"${esc(name)}": +"${esc(old)}"`, "g");
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

function coerce(version) {
  return semver.coerce(version).version;
}

function findNewVersion(data, {language, range, useGreatest, useRel, usePre, semvers} = {}) {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains
  const versions = Object.keys(language === "py" ? data.releases : data.versions)
    .filter(version => semver.valid(version));
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest});

  if (useGreatest) {
    return version;
  } else {
    let latestTag;
    if (language === "py") {
      latestTag = coerce(data.info.version); // add .0 to 6.0
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = coerce(range);
    const oldIsPre = isRangePrerelease(range);
    const newIsPre = isVersionPrerelease(version);
    const latestIsPre = isVersionPrerelease(latestTag);
    const isGreater = semver.gt(version, oldVersion);

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
    const diff = semver.diff(oldVersion, latestTag);
    if (diff && diff !== "prerelease" && !semvers.has(diff.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (useRel && isVersionPrerelease(latestTag)) {
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
    if (!semver.valid(oldRefBare)) return;

    if (!useGreatest) {
      const lastTag = tags[tags.length - 1];
      const lastTagBare = lastTag.replace(/^v/, "");
      if (!semver.valid(lastTagBare)) return;

      if (semver.neq(oldRefBare, lastTagBare)) {
        return {key, newRange: lastTag, user, repo, oldRef, newRef: lastTag};
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
  return range.replace(versionRe, semver.coerce(versionMatches[0]));
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
  for (const stream of [process.stdout, process.stderr]) {
    stream?._handle?.setBlocking?.(true);
  }

  let {help, version, language, file, types, update} = args;

  if (help) {
    stdout.write(`usage: updates [options]

  Options:
    -l, --language <lang>              Language to check, either 'js' or 'py'
    -u, --update                       Update versions and write package file
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
    -f, --file <path>                  Use given package file or module directory
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${MAX_SOCKETS}
    -j, --json                         Output a JSON object
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u && npm i
`);
    exit(0);
  }

  if (version) {
    console.info(packageVersion);
    exit(0);
  }

  if (language && !["js", "py"].includes(language)) {
    throw new Error(`Invalid language: ${language}`);
  }

  if (file) {
    const filename = basename(file);
    if (filename === "package.json") {
      language = "js";
    } else if (filename === "pyproject.toml") {
      language = "py";
    }
  }
  if (!language) language = "js";

  let packageFileName;
  if (language === "py") {
    packageFileName = "pyproject.toml";
  } else if (language === "js") {
    packageFileName = "package.json";
  }

  let packageFile;
  if (file) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch (err) {
      finish(new Error(`Unable to open ${file}: ${err.message}`));
    }

    if (stat?.isFile()) {
      packageFile = file;
    } else if (stat?.isDirectory()) {
      packageFile = join(file, packageFileName);
    } else {
      finish(new Error(`${file} is neither a file nor directory`));
    }
  } else {
    const pwd = cwd();
    packageFile = findUpSync(packageFileName, pwd);
    if (!packageFile) return finish(new Error(`Unable to find ${packageFileName} in ${pwd} or any of its parent directories`));
  }

  const packageDir = dirname(packageFile);

  try {
    config = (await import(join(packageDir, "updates.config.js"))).default;
  } catch {
    try {
      config = (await import(join(packageDir, "updates.config.mjs"))).default;
    } catch {}
  }

  const agentOpts = {};
  if (language === "js") {
    if (npmrc["strict-ssl"] === false) {
      agentOpts.rejectUnauthorized = false;
    }
    if ("cafile" in npmrc) {
      agentOpts.ca = rootCertificates.concat(extractCerts(readFileSync(npmrc.cafile, "utf8")));
    }
    if ("ca" in npmrc) {
      const cas = Array.isArray(npmrc.ca) ? npmrc.ca : [npmrc.ca];
      agentOpts.ca = rootCertificates.concat(cas.map(ca => extractCerts(ca)));
    }
  }

  let dependencyTypes;
  if (types) {
    dependencyTypes = Array.isArray(types) ? types : types.split(",");
  } else if ("types" in config && Array.isArray(config.types)) {
    dependencyTypes = config.types;
  } else {
    if (language === "js") {
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
        "tool.poetry.group.dev.dependencies",
      ];
    }
  }

  let pkg, pkgStr;
  try {
    pkgStr = readFileSync(packageFile, "utf8");
  } catch (err) {
    finish(new Error(`Unable to open ${packageFile}: ${err.message}`));
  }
  try {
    if (language === "js") {
      pkg = JSON.parse(pkgStr);
    } else {
      pkg = parseTOML(pkgStr);
    }
  } catch (err) {
    finish(new Error(`Error parsing ${packageFile}: ${err.message}`));
  }

  let include, exclude;
  if (args.include && args.include !== true) {
    include = new Set(((Array.isArray(args.include) ? args.include : [args.include]).flatMap(item => item.split(","))));
  } else if ("include" in config && Array.isArray(config.include)) {
    include = new Set(config.include);
  }
  if (args.exclude && args.exclude !== true) {
    exclude = new Set(((Array.isArray(args.exclude) ? args.exclude : [args.exclude]).flatMap(item => item.split(","))));
  } else if ("exclude" in config && Array.isArray(config.exclude)) {
    exclude = new Set(config.exclude);
  }

  function canInclude(name, language) {
    if (language === "py" && name === "python") return false;
    if (exclude?.has?.(name) === true) return false;
    if (include?.has?.(name) === false) return false;
    return true;
  }

  const deps = {}, maybeUrlDeps = {};
  for (const depType of dependencyTypes) {
    let obj;
    if (language === "js") {
      obj = pkg[depType] || {};
    } else {
      obj = getProperty(pkg, depType) || {};
    }

    for (const [name, value] of Object.entries(obj)) {
      if (semver.validRange(value) && canInclude(name, language)) {
        deps[`${depType}${sep}${name}`] = {
          old: normalizeRange(value),
          oldOriginal: value,
        };
      } else if (language === "js" && canInclude(name, language)) {
        maybeUrlDeps[`${depType}${sep}${name}`] = {
          old: value,
        };
      }
    }
  }

  if (!Object.keys(deps).length && !Object.keys(maybeUrlDeps).length) {
    if (include || exclude) {
      finish(new Error(`No dependencies match the given include/exclude filters`));
    } else {
      finish("No dependencies present, nothing to do");
    }
  }

  let registry;

  if (language === "js") {
    registry = normalizeUrl(args.registry || config.registry || npmrc.registry);
  }

  const entries = await pAll(Object.keys(deps).map(key => () => {
    const [type, name] = key.split(sep);
    if (language === "js") {
      return fetchNpmInfo(name, type, registry, agentOpts);
    } else {
      return fetchPypiInfo(name, type, agentOpts);
    }
  }), {concurrency: maxSockets});

  for (const [data, type, registry, name] of entries) {
    if (data?.error) throw new Error(data.error);

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
    const newVersion = findNewVersion(data, {
      usePre, useRel, useGreatest, semvers, range: oldRange, language,
    });
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[key];
    } else {
      deps[key].new = newRange;
      const info = data?.versions?.[newVersion] || data;
      deps[key].info = getInfoUrl(info, registry, data.name);
      if (data.time?.[newVersion]) {
        deps[key].age = timerel(data.time[newVersion], {noAffix: true});
      } else if (data.releases?.[newVersion][0]?.upload_time_iso_8601) {
        deps[key].age = timerel(data.releases?.[newVersion][0]?.upload_time_iso_8601, {noAffix: true});
      }
    }
  }

  if (Object.keys(maybeUrlDeps).length) {
    const results = await Promise.all(Object.entries(maybeUrlDeps).map(([key, dep]) => {
      const name = key.split(sep)[1];
      const useGreatest = typeof greatest === "boolean" ? greatest : greatest.has(name);
      return checkUrlDep([key, dep], {useGreatest});
    }));

    for (const res of (results || []).filter(Boolean)) {
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
    finish("All dependencies are up to date.");
  }

  if (!update) {
    finish(undefined, deps);
  }

  try {
    write(packageFile, updatePackageJson(pkgStr, deps));
  } catch (err) {
    finish(new Error(`Error writing ${packageFile}: ${err.message}`));
  }

  finish(green(`✨ package.json updated`), deps);
}

main().catch(finish);
