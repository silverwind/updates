#!/usr/bin/env node
"use strict";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "update", "u", "json", "j", "color", "no-color", "version", "v",
    "help", "h", "prerelease", "p"
  ],
  alias: {
    u: "update",
    p: "prerelease",
    o: "only",
    e: "exclude",
    j: "json",
    v: "version",
    h: "help"
  },
});

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    -u, --update             Update package.json
    -p, --prerelease         Update to prerelease versions
    -j, --json               Output a JSON object
    -o, --only <name,...>    Only update given packages
    -e, --exclude <name,...> Exclude given packages
    -c, --color              Force-enable color output
    -n, --no-color           Disable color output
    -v, --version            Print the version
    -h, --help               Print this help

  Exit Codes:
    0                        Success
    1                        Error
    255                      Dependencies are up to date

  Examples:
    $ updates
    $ updates -u
    $ updates -j
    $ updates -o eslint,chalk
`);
  process.exit(0);
}

const path = require("path");

if (args.version) {
  console.info(require(path.join(__dirname, "package.json")).version);
  process.exit(0);
}

if (process.argv.includes("-n")) process.argv.push("--no-color");
if (process.argv.includes("-c")) process.argv.push("--color");

const fs = require("fs");
const rp = require("request-promise-native");
const semver = require("semver");
const columnify = require("columnify");
const chalk = require("chalk");
const esc = require("escape-string-regexp");

const url = "https://registry.npmjs.org/";
const packageFile = path.join(process.cwd(), "package.json");

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "bundledDependencies",
  "optionalDependencies"
];

let pkg, pkgStr;
const deps = {};

try {
  pkgStr = fs.readFileSync(packageFile, "utf8");
} catch (err) {
  finish(new Error("Unable to open package.json"));
}

try {
  pkg = JSON.parse(pkgStr);
} catch (err) {
  finish(new Error("Error parsing package.json:" + err.message));
}

let only, exclude;
if (args.only) {
  only = args.only.split(",");
}
if (args.exclude) {
  exclude = args.exclude.split(",");
}

dependencyTypes.forEach(function(key) {
  if (pkg[key]) {
    Object.keys(pkg[key]).filter(function(name) {
      if (!only) return true;
      return only.includes(name);
    }).filter(function(name) {
      if (!exclude) return true;
      return !exclude.includes(name);
    }).forEach(function(name) {
      const old = pkg[key][name];
      if (isValidSemverRange(old)) {
        deps[name] = {old};
      }
    });
  }
});

if (!Object.keys(deps).length) {
  finish(new Error("No packages match the given filters"));
}

Promise.all(Object.keys(deps).map(dep => rp(url + dep))).then(function(responses) {
  responses.forEach(function(res) {
    const registryData = JSON.parse(res);
    const dep = registryData.name;
    const oldRange = deps[dep].old;
    const highestVersion = findHighestVersion(Object.keys(registryData["versions"]));
    const newRange = updateRange(oldRange, highestVersion);

    if (!highestVersion || oldRange === newRange) {
      delete deps[dep];
    } else {
      deps[dep].new = newRange;
    }
  });

  // log results
  if (!Object.keys(deps).length) {
    finish("All packages are up to date.", {exitCode: 255});
  }

  // exit if -u is not given
  if (!args.update) {
    finish(0);
  }

  fs.writeFile(packageFile, updatePkg(), "utf8", function(err) {
    if (err) {
      finish(new Error("Error writing package.json:" + err.message));
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
      if (/^[0-9]+$/.test(aParts[i])) {
        res += chalk[added ? "green" : "red"](aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(function(char) {
          if (/^[0-9]+$/.test(char)) {
            return chalk[added ? "green" : "red"](char + ".");
          } else {
            return char;
          }
        }).join("") + chalk[added ? "green" : "red"](aParts.slice(i + 1).join("."));
      }
      break;
    } else res += aParts[i] + ".";
  }

  return res;
}

function formatDeps() {
  return columnify(Object.keys(deps).map(function(dep) {
    return {
      "name": dep,
      "old": highlightDiff(deps[dep].old, deps[dep].new, false),
      "new": highlightDiff(deps[dep].new, deps[dep].old, true),
    };
  }), {
    columnSplitter: "    ",
  });
}

function updatePkg() {
  let newPkgStr = pkgStr;
  Object.keys(deps).forEach(function(dep) {
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
  let highest;
  while (versions.length) {
    const parsed = semver.parse(versions.pop());
    if (!args.prerelease && parsed.prerelease.length) continue;
    if (semver.gt(parsed.version, highest || "0.0.0")) {
      highest = parsed.version;
    }
  }
  return highest;
}
