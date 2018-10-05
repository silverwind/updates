#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "production";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "c", "color",
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
  ],
  default: {
    "registry": "https://registry.npmjs.org/",
  },
  alias: {
    c: "color",
    e: "exclude",
    f: "file",
    g: "greatest",
    h: "help",
    i: "include",
    j: "json",
    n: "no-color",
    p: "prerelease",
    r: "registry",
    u: "update",
    v: "version",
  },
});

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    -u, --update                  Update packages and write package.json
    -p, --prerelease [<pkg,...>]  Consider prerelease versions
    -g, --greatest [<pkg,...>]    Prefer greatest over latest version
    -i, --include <pkg,...>       Only include given packages
    -e, --exclude <pkg,...>       Exclude given packages
    -r, --registry <url>          Use a custom registry
    -f, --file <path>             Use specified package.json file
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

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

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);

const registry = args.registry.endsWith("/") ? args.registry : args.registry + "/";
const packageFile = args.file || require("find-up").sync("package.json");

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

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
if (args.include) include = args.include.split(",");
if (args.exclude) exclude = args.exclude.split(",");

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

    const newVersion = useGreatest ? findHighestVersion(Object.keys(data.versions), usePre) : data["dist-tags"].latest;
    const oldRange = deps[data.name].old;
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
    output.error = obj.message;
  }

  if (args.json) {
    if (!hadError) {
      output.results = deps;
    }
    console.info(JSON.stringify(output, null, 2));
  } else {
    if (Object.keys(deps).length && !hadError) {
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

// find the newest version, ignoring prerelease version unless they are requested
function findHighestVersion(versions, pre) {
  let highest = "0.0.0";
  while (versions.length) {
    const parsed = semver.parse(versions.pop());
    if (!pre && parsed.prerelease.length) continue;
    if (semver.gt(parsed.version, highest)) {
      highest = parsed.version;
    }
  }
  return highest === "0.0.0" ? null : highest;
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
