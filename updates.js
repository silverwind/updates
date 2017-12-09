#!/usr/bin/env node
"use strict";

const args = require("minimist")(process.argv.slice(2), {
  boolean: ["update", "u", "json", "j", "color", "no-color", "version", "v", "help", "h"]
});

args.update = args.update || args.u;
args.version = args.version || args.v;
args.json = args.json || args.j;
args.help = args.help || args.h;

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    --update, -u    Update package.json
    --json, -j      Output a JSON object
    --color, -c     Force-enable color output
    --no-color, -n  Disable color output
    --version, -v   Print the version
    --help -h       Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -j\n`);
  process.exit(0);
}

const os = require("os");
const path = require("path");

if (args.version) {
  process.stdout.write(require(path.join(__dirname, "package.json")).version + os.EOL);
  process.exit(0);
}

if (process.argv.includes("-n")) process.argv.push("--no-color");
if (process.argv.includes("-c")) process.argv.push("--color");

const fs = require("fs");
const got = require("got");
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

try {
  pkgStr = fs.readFileSync(packageFile, "utf8");
} catch (err) {
  finish(new Error("Unable to open package.json."));
}

try {
  pkg = JSON.parse(pkgStr);
} catch (err) {
  finish(new Error("Error parsing package.json:" + err.message));
}

const deps = {};

dependencyTypes.forEach(function(key) {
  if (pkg[key]) {
    Object.keys(pkg[key]).forEach(function(name) {
      const old = pkg[key][name];
      if (isValidSemverRange(old)) {
        deps[name] = {old};
      }
    });
  }
});

Promise.all(Object.keys(deps).map(dep => got(url + dep))).then(function(responses) {
  responses.forEach(function(res) {
    const registryData = JSON.parse(res.body);
    const dep = registryData.name;
    const oldRange = deps[dep].old;
    const newRange = updateRange(oldRange, registryData["dist-tags"].latest);
    if (oldRange === newRange) {
      delete deps[dep];
    } else {
      deps[dep].new = newRange;
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

  fs.writeFile(packageFile, updatePkg(), "utf8", function(err) {
    if (err) {
      finish(new Error("Error writing package.json:" + err.message));
    } else {
      finish("package.json updated!");
    }
  });
});

function finish(obj) {
  const output = {};
  if (typeof obj === "string") {
    output.message = obj;
  } else if (obj instanceof Error) {
    output.error = obj.message;
  }

  if (args.json) {
    output.results = deps;
    logStr(JSON.stringify(output, null, 2));
  } else {
    if (Object.keys(deps).length) {
      logStr(formatDeps(deps));
    }
    if (output.message || output.error) {
      logStr(output.message || output.error);
    }
  }

  process.exit(output.error ? 1 : 0);
}

function logStr(str) {
  process.stdout.write(str + os.EOL);
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
      "package": dep,
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
  return range.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/, version);
}

function isValidSemverRange(range) {
  let valid = false;
  try {
    semver.Range(range);
    valid = true;
  } catch (err) {}
  return valid;
}
