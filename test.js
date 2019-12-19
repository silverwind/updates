"use strict";

const assert = require("assert");
const process = require("process");
const execa = require("execa");
const tempy = require("tempy");
const fs = require("fs");
const path = require("path");
const del = require("del");

const testDir = tempy.directory();
const cli = path.join(__dirname, "./updates.js");
const oldFixture = {
  dependencies: {
    "gulp-sourcemaps": "2.0.0",
    "prismjs": "1.0.0",
    "svgstore": "^3.0.0",
    "html-webpack-plugin": "4.0.0-alpha.2",
    "noty": "3.1.0",
    "jpeg-buffer-orientation": "0.0.0",
    "styled-components": "2.5.0-1",
    "@babel/preset-env": "7.0.0"
  },
  peerDependencies: {
    "@babel/preset-env": "~6.0.0"
  }
};

async function exit(err) {
  await del(testDir, {force: true});

  if (err) {
    console.info(err);
  }
  process.exit(err ? 1 : 0);
}

async function run({
  args = [],
  packageJson,
  filename = "package.json"
}) {
  args.push("--json");
  fs.writeFileSync(path.join(testDir, filename), JSON.stringify(packageJson));
  const {stdout} = await execa(cli, args, {cwd: testDir});
  return JSON.parse(stdout).results;
}

async function main() {
  // Should get latest version
  assert.deepStrictEqual(
    await run({
      packageJson: {
        dependencies: {
          updates: "1.0.0",
        }
      }
    }),
    {
      dependencies: {
        updates: {
          old: "1.0.0",
          new: "9.3.3",
          info: "https://github.com/silverwind/updates",
        }
      }
    }
  );

  // Should support `--file` flag
  assert.deepStrictEqual(
    await run({
      args: ["--file", "test.json"],
      filename: "test.json",
      packageJson: {
        dependencies: {
          updates: "2.0.0",
        }
      },
    }),
    {
      dependencies: {
        updates: {
          old: "2.0.0",
          new: "9.3.3",
          info: "https://github.com/silverwind/updates",
        }
      }
    }
  );

  // Should not crash on version of "0.0.0", #23
  assert.deepStrictEqual(
    await run({
      packageJson: {
        dependencies: {
          "jpeg-buffer-orientation": "0.0.0",
        }
      },
    }),
    {
      dependencies: {
        "jpeg-buffer-orientation": {
          old: "0.0.0",
          new: "2.0.3",
          info: "https://github.com/fisker/jpeg-buffer-orientation",
        }
      }
    }
  );

  // Should support multiple version of the same package, #29
  assert.deepStrictEqual(
    await run({
      packageJson: {
        dependencies: {
          "@babel/preset-env": "7.0.0"
        },
        peerDependencies: {
          "@babel/preset-env": "~6.0.0"
        }
      },
    }),
    {
      dependencies: {
        "@babel/preset-env": {
          old: "7.0.0",
          new: "7.7.7",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
      peerDependencies: {
        "@babel/preset-env": {
          old: "~6.0.0",
          new: "~7.7.7",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
    }
  );

  // TODO: refactor test cases bellow
  assert.deepStrictEqual(
    await run({
      packageJson: oldFixture
    }),
    {
      dependencies: {
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
          new: "4.0.0-beta.11",
          info: "https://github.com/jantimon/html-webpack-plugin",
        },
        "noty": {
          old: "3.1.0",
          new: "3.2.0-beta",
          info: "https://github.com/needim/noty",
        },
        "jpeg-buffer-orientation": {
          old: "0.0.0",
          new: "2.0.3",
          info: "https://github.com/fisker/jpeg-buffer-orientation",
        },
        "styled-components": {
          old: "2.5.0-1",
          new: "5.0.0-rc.2",
          info: "https://github.com/styled-components/styled-components",
        },
        "@babel/preset-env": {
          old: "7.0.0",
          new: "7.7.6",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
      peerDependencies: {
        "@babel/preset-env": {
          "old": "~6.0.0",
          "new": "~7.7.6",
          "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
        }
      },
    });

  assert.deepStrictEqual(
    await run({
      args: ["--greatest"],
      packageJson: oldFixture,
    }),
    {
      dependencies: {
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
        "html-webpack-plugin": {
          old: "4.0.0-alpha.2",
          new: "4.0.0-beta.11",
          info: "https://github.com/jantimon/html-webpack-plugin",
        },
        "noty": {
          old: "3.1.0",
          new: "3.1.4",
          info: "https://github.com/needim/noty",
        },
        "jpeg-buffer-orientation": {
          old: "0.0.0",
          new: "2.0.3",
          info: "https://github.com/fisker/jpeg-buffer-orientation",
        },
        "styled-components": {
          old: "2.5.0-1",
          new: "5.0.0-rc.2",
          info: "https://github.com/styled-components/styled-components",
        },
        "@babel/preset-env": {
          old: "7.0.0",
          new: "7.7.6",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
      peerDependencies: {
        "@babel/preset-env": {
          "old": "~6.0.0",
          "new": "~7.7.6",
          "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
        }
      }
    });

  assert.deepStrictEqual(
    await run({
      args: ["--greatest", "--prerelease"],
      packageJson: oldFixture,
    }),
    {
      dependencies: {
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
          new: "4.0.0-beta.11",
          info: "https://github.com/jantimon/html-webpack-plugin",
        },
        "noty": {
          old: "3.1.0",
          new: "3.2.0-beta",
          info: "https://github.com/needim/noty",
        },
        "jpeg-buffer-orientation": {
          old: "0.0.0",
          new: "2.0.3",
          info: "https://github.com/fisker/jpeg-buffer-orientation",
        },
        "styled-components": {
          old: "2.5.0-1",
          new: "5.0.0-rc.2",
          info: "https://github.com/styled-components/styled-components",
        },
        "@babel/preset-env": {
          old: "7.0.0",
          new: "7.7.6",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
      peerDependencies: {
        "@babel/preset-env": {
          "old": "~6.0.0",
          "new": "~7.7.6",
          "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
        }
      },
    });

  assert.deepStrictEqual(
    await run({
      args: ["--release"],
      packageJson: oldFixture,
    }),
    {
      dependencies: {
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
          new: "2.0.3",
          info: "https://github.com/fisker/jpeg-buffer-orientation",
        },
        "styled-components": {
          old: "2.5.0-1",
          new: "4.4.1",
          info: "https://github.com/styled-components/styled-components",
        },
        "@babel/preset-env": {
          old: "7.0.0",
          new: "7.7.6",
          info: "https://github.com/babel/babel/tree/master/packages/babel-preset-env",
        }
      },
      peerDependencies: {
        "@babel/preset-env": {
          "old": "~6.0.0",
          "new": "~7.7.6",
          "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
        }
      },
    });

  assert.deepStrictEqual(
    await run({
      args: ["--patch"],
      packageJson: oldFixture,
    }),
    {
      dependencies: {
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
          new: "4.0.0-beta.11",
          info: "https://github.com/jantimon/html-webpack-plugin",
        },
        "noty": {
          old: "3.1.0",
          new: "3.1.4",
          info: "https://github.com/needim/noty",
        },
      },
    });
}

main().then(exit).catch(exit);
