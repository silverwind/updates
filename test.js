"use strict";

const assert = require("assert");
const process = require("process");
const execa = require("execa");

function exit(err) {
  if (err) {
    console.info(err);
  }
  process.exit(err ? 1 : 0);
}

async function run(args) {
  return JSON.parse(await execa.stdout("./updates.js", args.split(/\s+/)));
}

async function main() {
  assert.deepStrictEqual(await run("-j -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.4",
        info: "https://github.com/floridoo/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "1.15.0",
        info: "https://github.com/LeaVerou/prism",
      },
      "svgstore": {
        old: "^3.0.0",
        new: "^3.0.0-2",
        info: "https://github.com/svgstore/svgstore",
      }
    }
  });

  assert.deepStrictEqual(await run("-j -g -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.4",
        info: "https://github.com/floridoo/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "9000.0.2",
        info: "https://github.com/LeaVerou/prism",
      }
    }
  });
}

main().then(exit).catch(exit);
