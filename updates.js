#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "production";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
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
    "p", "prerelease",
    "r", "registry",
    "t", "types",
    "s", "semver",
  ],
  default: {
    "registry": "https://registry.npmjs.org/",
  },
  alias: {
    c: "color",
    E: "error-on-outdated",
    e: "exclude",
    f: "file",
    g: "greatest",
    h: "help",
    i: "include",
    j: "json",
    n: "no-color",
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
    -s, --semver patch|minor      Consider only up to given semver level
    -E, --error-on-outdated       Exit with error code 2 on outdated packages
    -r, --registry <url>          Use given registry URL
    -f, --file <path>             Use given package.json file
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -e semver
    $ updates -u -t devDependencies
`);
  process.exit(0);
}

const path = require("path");

if (args.version) {
  console.info(require(path.join(__dirname, "package.json")).version);
  process.exit(0);
}

if (args["color"]) process.env.FORCE_COLOR = "1";
if (args["no-color"]) process.env.FORCE_COLOR = "0";

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);

const registry = args.registry.endsWith("/") ? args.registry : args.registry + "/";
const packageFile = args.file || require("find-up").sync("package.json");

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

let semvers;
if (args.semver === "patch") {
  semvers = ["patch"];
} else if (args.semver === "minor") {
  semvers = ["patch", "minor"];
} else {
  semvers = ["patch", "minor", "major"];
}

const fs = require("fs");
let pkg, pkgStr;
const deps = {};

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
const esc = require("escape-string-regexp");
const chalk = require("chalk");

const get = async name => {
  // on scoped packages replace "/" with "%2f"
  if (/@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*/gi.test(name)) {
    name = name.replace(/\//g, "%2f");
  }

  return fetch(registry + name).then(r => r.json());
};

Promise.all(Object.keys(deps).map(name => get(name))).then(dati => {
  for (const data of dati) {
    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.includes(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.includes(data.name);
    const oldRange = deps[data.name].old;
    const newVersion = findNewVersion(data, {usePre, useGreatest, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[data.name];
    } else {
      deps[data.name].new = newRange;
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
  const arr = [["NAME", "OLD", "NEW"]];
  for (const [name, versions] of Object.entries(deps)) arr.push([
    name,
    highlightDiff(versions.old, versions.new, false),
    highlightDiff(versions.new, versions.old, true),
  ]);
  return require("text-table")(arr, {
    hsep: " ".repeat(4),
    stringLength: require("string-width"),
  });
}

function updatePkg() {
  let newPkgStr = pkgStr;
  for (const dep of Object.keys(deps)) {
    const re = new RegExp(`"${esc(dep)}": +"${esc(deps[dep].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${dep}": "${deps[dep].new}"`);
  }
  return newPkgStr;
}

// naive regex replace
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

function findNewVersion(data, opts) {
  const versions = Object.keys(data.time).filter(version => semver.valid(version));
  const newVersion = [semver.coerce(opts.range) || "0.0.0", 0];

  for (const version of versions) {
    const parsed = semver.parse(version);
    if (parsed.prerelease.length && !opts.usePre) continue;

    let diff = semver.diff(newVersion[0], parsed.version);
    if (diff && opts.usePre) {
      diff = diff.replace(/^pre(?!release)/, "");
    }

    if ((diff === null) ||
        (semvers.includes(diff) && semver.gte(parsed.version, newVersion[0])) ||
        (opts.usePre && diff === "prerelease")) {
      if (opts.useGreatest && semver.gt(parsed.version, newVersion[0])) {
        newVersion[0] = parsed.version;
      } else {
        const date = (new Date(data.time[version])).getTime();
        if (date >= 0 && date > newVersion[1]) {
          newVersion[0] = parsed.version;
          newVersion[1] = date;
        }
      }
    }
  }

  // Special case for when pre-releases are tagged as latest. This ignores the
  // --prerelease option, but it's how npm and other tools work so we copy
  // their behaviour.
  const latestTag = data["dist-tags"].latest;
  if (!opts.useGreatest && latestTag !== newVersion[0] && semver.diff(newVersion[0], latestTag) === "prerelease") {
    newVersion[0] = latestTag;
  }

  return newVersion[0] === "0.0.0" ? null : newVersion[0];
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
