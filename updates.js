#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "production";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "a", "auth",
    "c", "color",
    "E", "error-on-outdated",
    "h", "help",
    "j", "json",
    "n", "no-color",
    "u", "update",
    "v", "version",
  ],
  string: [
    "f", "file",
    "g", "greatest",
    "m", "minor",
    "P", "patch",
    "p", "prerelease",
    "r", "registry",
    "t", "types",
  ],
  default: {
    "registry": "https://registry.npmjs.org/",
  },
  alias: {
    a: "auth",
    c: "color",
    E: "error-on-outdated",
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
    s: "semver",
    t: "types",
    u: "update",
    v: "version",
  },
});

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    -u, --update                  Update versions and write package.json
    -p, --prerelease [<pkg,...>]  Consider prerelease versions
    -g, --greatest [<pkg,...>]    Prefer greatest over latest version
    -i, --include <pkg,...>       Include only given packages
    -e, --exclude <pkg,...>       Exclude given packages
    -t, --types <type,...>        Check only given dependency types
    -P, --patch [<pkg,...>]       Consider only up to semver-patch
    -m, --minor [<pkg,...>]       Consider only up to semver-minor
    -E, --error-on-outdated       Exit with error code 2 on outdated packages
    -r, --registry <url>          Use given registry URL
    -a, --auth                    Authorize against the registry
    -f, --file <path>             Use given package.json file or module directory
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -m
    $ updates -u -e chalk
    $ updates -u -t devDependencies
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
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);

const registry = args.registry.endsWith("/") ? args.registry : args.registry + "/";

let packageFile;
const deps = {};

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
        deps[name] = {old};
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
const chalk = require("chalk");
const hostedGitInfo = require("hosted-git-info");

let auth;
if (args.auth) {
  auth = require("registry-auth-token")(registry);
  if (!auth) {
    finish(new Error(`Unable to find auth token for ${registry}`));
  }
}

const get = async name => {
  // on scoped packages replace "/" with "%2f"
  if (/@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*/gi.test(name)) {
    name = name.replace(/\//g, "%2f");
  }

  let opts;
  if (auth && auth.token) {
    opts = {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    };
  }

  return fetch(registry + name, opts).then(r => r.json());
};

const getInfoUrl = ({repository, homepage}) => {
  if (repository) {
    const gitUrl = typeof repository === "string" ? repository : repository.url;
    const info = hostedGitInfo.fromUrl(gitUrl);
    if (info && info.browse) return info.browse();
  }

  return homepage || "";
};

Promise.all(Object.keys(deps).map(name => get(name))).then(dati => {
  for (const data of dati) {
    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.includes(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.includes(data.name);

    let semvers;
    if (patch === true || Array.isArray(patch) && patch.includes(data.name)) {
      semvers = ["patch"];
    } else if (minor === true || Array.isArray(minor) && minor.includes(data.name)) {
      semvers = ["patch", "minor"];
    } else {
      semvers = ["patch", "minor", "major"];
    }

    const oldRange = deps[data.name].old;
    const newVersion = findNewVersion(data, {usePre, useGreatest, semvers, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[data.name];
    } else {
      deps[data.name].new = newRange;
      deps[data.name].info = getInfoUrl(data.versions[newVersion] || data);
    }
  }

  if (!Object.keys(deps).length) {
    finish("All packages are up to date.");
  }

  if (!args.update) {
    finish();
  }

  try {
    fs.writeFileSync(packageFile, updatePkg(), "utf8");
  } catch (err) {
    finish(new Error(`Error writing package.json: ${err.message}`));
  }

  const msg = `
 ╭────────────────────────╮
 │  package.json updated  │
 ╰────────────────────────╯`;

  finish(chalk.green(msg.substring(1)));
}).catch(finish);

function finish(obj, opts) {
  opts = opts || {};
  const output = {};
  const hadError = obj instanceof Error;

  if (typeof obj === "string") {
    output.message = obj;
  } else if (hadError) {
    output.error = obj.stack;
  }

  if (args.json) {
    if (!hadError) {
      output.results = deps;
    }
    console.info(JSON.stringify(output));
  } else {
    if (Object.keys(deps).length && !hadError) {
      console.info(formatDeps(deps));
    }
    if (output.message || output.error) {
      console.info(output.message || output.error);
    }
  }

  if (args["error-on-outdated"]) {
    process.exit(Object.keys(deps).length ? 2 : 0);
  } else {
    process.exit(opts.exitCode || (output.error ? 1 : 0));
  }
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

  for (const [name, data] of Object.entries(deps)) arr.push([
    name,
    highlightDiff(data.old, data.new, false),
    highlightDiff(data.new, data.old, true),
    data.info,
  ]);

  return require("text-table")(arr, {
    hsep: " ".repeat(4),
    stringLength: require("string-width"),
  });
}

function updatePkg() {
  const esc = require("escape-string-regexp");
  let newPkgStr = pkgStr;

  for (const dep of Object.keys(deps)) {
    const re = new RegExp(`"${esc(dep)}": +"${esc(deps[dep].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${dep}": "${deps[dep].new}"`);
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
  return Boolean(semver.parse(version).prerelease.length);
}

function isRangePrerelease(range) {
  // can not use semver.coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function rangeToVersion(range) {
  try {
    return semver.coerce(range).version;
  } catch (err) {
    return "0.0.0";
  }
}

function findVersion(data, versions, opts) {
  let tempVersion = rangeToVersion(opts.range);
  let tempDate = 0;
  let semvers = opts.semvers.slice();
  const usePre = isRangePrerelease(opts.range) || opts.usePre;

  if (usePre) {
    semvers = semvers.concat(["prerelease", "prepatch", "preminor", "premajor"]);
  }

  for (const version of versions) {
    const parsed = semver.parse(version);
    if (parsed.prerelease.length && !usePre) continue;

    const diff = semver.diff(tempVersion, parsed.version);
    if (!diff || !semvers.includes(diff)) continue;

    if (opts.useGreatest) {
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

  return tempVersion === "0.0.0" ? null : tempVersion;
}

function findNewVersion(data, opts) {
  const versions = Object.keys(data.time).filter(version => semver.valid(version));
  const version = findVersion(data, versions, opts);

  if (opts.useGreatest) {
    return version;
  } else {
    const latestTag = data["dist-tags"].latest;
    const oldVersion = semver.coerce(opts.range).version;
    const oldIsPre = isRangePrerelease(opts.range);
    const newIsPre = isVersionPrerelease(version);
    const isGreater = semver.gt(version, oldVersion);

    // update to new prerelease
    if (opts.usePre && newIsPre && isGreater) {
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

    // in all other cases, return latest dist-tag
    return latestTag;
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
