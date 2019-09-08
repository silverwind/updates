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
  const {stdout} = await execa("./updates.js", args.split(/\s+/));
  return JSON.parse(stdout);
}

async function main() {
  assert.deepStrictEqual(await run("-j -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.5",
        info: "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "1.17.1",
        info: "https://github.com/LeaVerou/prism",
      },
      "svgstore": {
        old: "^3.0.0",
        new: "^3.0.0-2",
        info: "https://github.com/svgstore/svgstore",
      },
      "html-webpack-plugin": {
        old: "4.0.0-alpha.2",
        new: "4.0.0-beta.8",
        info: "https://github.com/jantimon/html-webpack-plugin",
      },
      "noty": {
        old: "3.1.0",
        new: "3.2.0-beta",
        info: "https://github.com/needim/noty",
      },
      "jpeg-buffer-orientation": {
        old: "0.0.0",
        new: "2.0.1",
        info: "https://github.com/fisker/jpeg-buffer-orientation",
      },
      "styled-components": {
        old: "2.5.0-1",
        new: "5.0.0-beta.8-groupsizefix",
        info: "https://github.com/styled-components/styled-components",
      },
      "@babel/preset-env": {
        old: "7.0.0",
        new: "7.6.0",
        info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
      }
    }
  });

  assert.deepStrictEqual(await run("-j -g -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.5",
        info: "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "9000.0.1",
        info: "https://github.com/LeaVerou/prism",
      },
      "html-webpack-plugin": {
        old: "4.0.0-alpha.2",
        new: "4.0.0-beta.8",
        info: "https://github.com/jantimon/html-webpack-plugin",
      },
      "noty": {
        old: "3.1.0",
        new: "3.1.4",
        info: "https://github.com/needim/noty",
      },
      "jpeg-buffer-orientation": {
        old: "0.0.0",
        new: "2.0.1",
        info: "https://github.com/fisker/jpeg-buffer-orientation",
      },
      "styled-components": {
        old: "2.5.0-1",
        new: "5.0.0-beta.8-groupsizefix",
        info: "https://github.com/styled-components/styled-components",
      },
      "@babel/preset-env": {
        old: "7.0.0",
        new: "7.6.0",
        info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
      }
    }
  });

  assert.deepStrictEqual(await run("-j -g -p -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.5",
        info: "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "9000.0.1",
        info: "https://github.com/LeaVerou/prism",
      },
      "svgstore": {
        old: "^3.0.0",
        new: "^3.0.0-2",
        info: "https://github.com/svgstore/svgstore",
      },
      "html-webpack-plugin": {
        old: "4.0.0-alpha.2",
        new: "4.0.0-beta.8",
        info: "https://github.com/jantimon/html-webpack-plugin",
      },
      "noty": {
        old: "3.1.0",
        new: "3.2.0-beta",
        info: "https://github.com/needim/noty",
      },
      "jpeg-buffer-orientation": {
        old: "0.0.0",
        new: "2.0.1",
        info: "https://github.com/fisker/jpeg-buffer-orientation",
      },
      "styled-components": {
        old: "2.5.0-1",
        new: "5.0.0-beta.8-groupsizefix",
        info: "https://github.com/styled-components/styled-components",
      },
      "@babel/preset-env": {
        old: "7.0.0",
        new: "7.6.0",
        info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
      }
    }
  });

  assert.deepStrictEqual(await run("-j -R -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.6.5",
        info: "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
      },
      "prismjs": {
        old: "1.0.0",
        new: "1.17.1",
        info: "https://github.com/LeaVerou/prism",
      },
      "svgstore": {
        old: "^3.0.0",
        new: "^2.0.3",
        info: "https://github.com/svgstore/svgstore",
      },
      "html-webpack-plugin": {
        old: "4.0.0-alpha.2",
        new: "3.2.0",
        info: "https://github.com/jantimon/html-webpack-plugin",
      },
      "noty": {
        old: "3.1.0",
        new: "3.1.4",
        info: "https://github.com/needim/noty",
      },
      "jpeg-buffer-orientation": {
        old: "0.0.0",
        new: "2.0.1",
        info: "https://github.com/fisker/jpeg-buffer-orientation",
      },
      "styled-components": {
        old: "2.5.0-1",
        new: "4.3.2",
        info: "https://github.com/styled-components/styled-components",
      },
      "@babel/preset-env": {
        old: "7.0.0",
        new: "7.6.0",
        info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
      }
    }
  });

  assert.deepStrictEqual(await run("-j -P -f test.json"), {
    results: {
      "gulp-sourcemaps": {
        old: "2.0.0",
        new: "2.0.1",
        info: "https://github.com/floridoo/gulp-sourcemaps",
      },
      "svgstore": {
        old: "^3.0.0",
        new: "^3.0.0-2",
        info: "https://github.com/svgstore/svgstore",
      },
      "html-webpack-plugin": {
        old: "4.0.0-alpha.2",
        new: "4.0.0-beta.8",
        info: "https://github.com/jantimon/html-webpack-plugin",
      },
      "noty": {
        old: "3.1.0",
        new: "3.1.4",
        info: "https://github.com/needim/noty",
      },
    }
  });
}

main().then(exit).catch(exit);
