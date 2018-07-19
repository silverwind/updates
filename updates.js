#!/usr/bin/env node
"use strict";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "color", "c",
    "greatest", "g",
    "help", "h",
    "json", "j",
    "no-color", "n",
    "prerelease", "p",
    "update", "u",
    "version", "v",
  ],
  alias: {
    c: "color",
    e: "exclude",
    g: "greatest",
    h: "help",
    i: "include",
    j: "json",
    n: "no-color",
    p: "prerelease",
    u: "update",
    v: "version",
  },
});

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    -u, --update             Update package.json
    -p, --prerelease         Consider prerelease versions
    -j, --json               Output a JSON object
    -g, --greatest           Prefer greatest over latest version
    -i, --include <pkg,...>  Only include given packages
    -e, --exclude <pkg,...>  Exclude given packages
    -c, --color              Force-enable color output
    -n, --no-color           Disable color output
    -v, --version            Print the version
    -h, --help               Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -e semver
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

const fs = require("fs");
const semver = require("semver");
const columnify = require("columnify");
const chalk = require("chalk");
const esc = require("escape-string-regexp");

const url = "https://registry.npmjs.org/";
const packageFile = path.join(process.cwd(), "package.json");
const versionPartRe = /^[0-9a-zA-Z-.]+$/;

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

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

let include, exclude;
if (args.include) include = args.include.split(",");
if (args.exclude) exclude = args.exclude.split(",");

dependencyTypes.forEach(key => {
  if (pkg[key]) {
    const names = Object.keys(pkg[key])
      .filter(name => !include ? true : include.includes(name))
      .filter(name => !exclude ? true : !exclude.includes(name));

    names.forEach(name => {
      const old = pkg[key][name];
      if (isValidSemverRange(old)) {
        deps[name] = {old};
      }
    });
  }
});

if (!Object.keys(deps).length) {
  finish(new Error("No packages match the given include/exclude parameters"));
}

const fetch = require("make-fetch-happen");

Promise.all(Object.keys(deps).map(dep => fetch(url + dep).then(r => r.json()))).then(d => {
  d.forEach(data => {
    let newVersion;
    if (args.greatest) {
      newVersion = findHighestVersion(Object.keys(data.versions));
    } else {
      newVersion = data["dist-tags"].latest;
    }

    const oldRange = deps[data.name].old;
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[data.name];
    } else {
      deps[data.name].new = newRange;
    }
  });

  // log results
  if (!Object.keys(deps).length) {
    finish("All packages are up to date.");
  }

  // exit if -u is not given
  if (!args.update) {
    finish(0);
  }

  fs.writeFile(packageFile, updatePkg(), "utf8", err => {
    if (err) {
      finish(new Error(`Error writing package.json: ${err.message}`));
    } else {
      finish("package.json updated!");
    }
  });
});

function finish(obj, opts) {
  opts = opts || {};
  const output = {};
  if (typeof obj === "string") {
    output.message = obj;
  } else if (obj instanceof Error) {
    output.error = obj.message;
  }

  if (args.json) {
    output.results = deps;
    console.info(JSON.stringify(output, null, 2));
  } else {
    if (Object.keys(deps).length) {
      console.info(formatDeps(deps));
    }
    if (output.message || output.error) {
      console.info(output.message || output.error);
    }
  }

  process.exit(opts.exitCode || (output.error ? 1 : 0));
}

function highlightDiff(a, b, added) {
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  let res = "";

  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += chalk[added ? "green" : "red"](aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          if (versionPartRe.test(char)) {
            return chalk[added ? "green" : "red"](char);
          } else {
            return char;
          }
        }).join("") + chalk[added ? "green" : "red"]("." + aParts.slice(i + 1).join("."));
      }
      break;
    } else {
      res += aParts[i] + ".";
    }
  }

  return res;
}

function formatDeps() {
  return columnify(Object.keys(deps).map(dep => {
    return {
      "name": dep,
      "old": highlightDiff(deps[dep].old, deps[dep].new, false),
      "new": highlightDiff(deps[dep].new, deps[dep].old, true),
    };
  }), {
    columnSplitter: " ".repeat(4),
  });
}

function updatePkg() {
  let newPkgStr = pkgStr;
  Object.keys(deps).forEach(dep => {
    const re = new RegExp(`"${esc(dep)}": +"${esc(deps[dep].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${dep}": "${deps[dep].new}"`);
  });
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

// find the newest version, ignoring prerelease version unless they are requested
function findHighestVersion(versions) {
  let highest = "0.0.0";
  while (versions.length) {
    const parsed = semver.parse(versions.pop());
    if (!args.prerelease && parsed.prerelease.length) continue;
    if (semver.gt(parsed.version, highest)) {
      highest = parsed.version;
    }
  }
  return highest === "0.0.0" ? null : highest;
}
