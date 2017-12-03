#!/usr/bin/env node
"use strict";

const cli = require("meow")(`
  Options:
    --update, -u  Also update package.json
    --json, -j    Output JSON

  Examples:
    $ updates
    $ updates -u
    $ updates -j
`);

const fs = require("fs");
const os = require("os");
const got = require("got");
const path = require("path");
const semver = require("semver");
const columnify = require("columnify");
const chalk = require("chalk");
const esc = require("escape-string-regexp");

const pkgStr = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
const pkg = JSON.parse(pkgStr);
const url = "https://registry.npmjs.org/";
const deps = [];

[
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "bundledDependencies",
  "optionalDependencies"
].forEach(function(key) {
  if (pkg[key]) {
    Object.keys(pkg[key]).forEach(function(name) {
      const range = pkg[key][name];
      if (isValidSemverRange(range)) {
        deps.push({name, range});
      }
    });
  }
});

Promise.all(deps.map(dep => got(`${url}${dep.name}`))).then(function(responses) {
  return responses.map(function(response, i) {
    const dep = Object.keys(deps)[i];
    const newVersion = JSON.parse(response.body)["dist-tags"]["latest"];
    return {
      package: deps[dep].name,
      old: deps[dep].range,
      new: updateRange(deps[dep].range, newVersion),
    };
  });
}).then(function(results) {
  results = results.filter(function(result) {
    return result.old !== result.new;
  });

  // print results
  if (!results.length) {
    print("All packages are up to date.");
    process.exit(0);
  } else {
    if (cli.flags.j || cli.flags.json) {
      print(results);
    } else {
      print(formatResults(results));
    }
  }

  // exit if -u is not given
  if (!cli.flags.u && !cli.flags.update) {
    process.exit(0);
  }
  return results;
}).then(function(results) {
  fs.writeFile("package.json", updatePkg(results), "utf8", function(err) {
    if (err) {
      print(err);
      process.exit(1);
    } else {
      print("package.json updated!");
      process.exit(0);
    }
  });
});

function print(obj) {
  if (cli.flags.j || cli.flags.json) {
    if (typeof obj === "string") {
      obj = {message: obj};
    } else if (obj instanceof Error) {
      obj = {error: obj.message};
    }
    process.stdout.write(JSON.stringify(obj, null, 2) + os.EOL);
  } else {
    if (obj instanceof Error) {
      process.stderr.write(obj + os.EOL);
    } else {
      process.stdout.write(obj + os.EOL);
    }
  }
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

function formatResults(results) {
  return columnify(results.map(r => Object.assign({}, r)).map(function(output) {
    if (output.new !== output.old) {
      return {
        "package": output.package,
        "old": highlightDiff(output.old, output.new, false),
        "new": highlightDiff(output.new, output.old, true),
      };
    }
  }), {
    columnSplitter: "    ",
  });
}

function updatePkg(results) {
  let newPkgStr = pkgStr;
  results.forEach(function(result) {
    const re = new RegExp(`"${esc(result.package)}": +"${esc(result.old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${result.package}": "${result.new}"`);
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
