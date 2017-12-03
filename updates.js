#!/usr/bin/env node
"use strict";

const cli = require("meow")(`
  Options:
    --update, -u  Also update package.json

  Examples:
    $ updates
    $ updates -u
`);

const fs = require("fs");
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
    const name = deps[dep].name;
    const range = deps[dep].range;
    const newVersion = JSON.parse(response.body)["dist-tags"]["latest"];
    const newRange = updateRange(range, newVersion);
    return {name, range, newRange};
  });
}).then(function(results) {
  const different = results.some(function(result) {
    return result.range !== result.newRange;
  });

  if (!different) {
    console.info("All packages are up to date.");
    process.exit(0);
  } else if (!cli.flags.u && !cli.flags.update) {
    console.info(formatResults(results));
    process.exit(0);
  }
  return results;
}).then(function(results) {
  fs.writeFile("package.json", updatePkg(results), "utf8", function(err) {
    if (err) {
      console.error(err);
      process.exit(1);
    } else {
      console.info("package.json updated!");
      process.exit(0);
    }
  });
});

function formatResults(results) {
  return columnify(results.map(r => Object.assign({}, r)).map(function(output) {
    if (output.newRange !== output.range) {
      return {
        name: output.name,
        old: chalk.red(output.newRange),
        "new": chalk.green(output.newRange),
      };
    }
  }).filter(result => Boolean(result)), {
    columnSplitter: "    ",
  });
}

function updatePkg(results) {
  let newPkgStr = pkgStr;
  results.forEach(function(result) {
    const re = new RegExp(`"${esc(result.name)}": +"${esc(result.range)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${result.name}": "${result.newRange}"`);
  });
  return newPkgStr;
}

// naive regex replace
function updateRange(range, version) {
  return range.replace(/[0-9]+\.[0-9]+\.[0-9](-.+)?/, version);
}

function isValidSemverRange(range) {
  let valid = false;
  try {
    semver.Range(range);
    valid = true;
  } catch (err) {}
  return valid;
}
