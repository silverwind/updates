"use strict";

const createTestServer = require("create-test-server");
const del = require("del");
const execa = require("execa");
const tempy = require("tempy");
const {join} = require("path");
const {test, expect, beforeAll, afterAll} = global;
const {writeFile, readFile} = require("fs").promises;

const packageJson = require("./fixtures/test.json");
const testDir = tempy.directory();
let npmServer, githubServer, githubApiUrl;

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const testPackages = [];
for (const dependencyType of dependencyTypes) {
  for (const name of Object.keys(packageJson[dependencyType] || [])) {
    testPackages.push(name);
  }
}

beforeAll(async () => {
  npmServer = await createTestServer(); // npm api response
  githubServer = await createTestServer(); // github api response

  for (const packageName of testPackages) {
    const name = packageName.replace(/\//g, "%2f");
    const path = join(__dirname, `fixtures/npm/${name}.json`);
    npmServer.get(`/${name}`, await readFile(path));
  }

  const commits = await readFile(join(__dirname, "fixtures/github/updates-commits.json"));
  const tags = await readFile(join(__dirname, "fixtures/github/updates-tags.json"));
  githubServer.get("/repos/silverwind/updates/commits", commits);
  githubServer.get("/repos/silverwind/updates/git/refs/tags", tags);

  githubApiUrl = githubServer.sslUrl;
  await writeFile(join(testDir, ".npmrc"), `registry=${npmServer.sslUrl}`); // Fake registry
  await writeFile(join(testDir, "package.json"), JSON.stringify(packageJson, null, 2)); // Copy fixture
});

afterAll(async () => {
  await Promise.all([
    del(testDir, {force: true}),
    npmServer && npmServer.close(),
    githubServer && githubServer.close(),
  ]);
});

function makeTest(args, expected) {
  return async () => {
    const argsArr = [...args.split(/\s+/), "-G", githubApiUrl];
    const {stdout} = await execa(join(__dirname, "updates.js"), argsArr, {cwd: testDir});
    const {results} = JSON.parse(stdout);

    // Parse results, with custom validation for the dynamic "age" property
    for (const dependencyType of dependencyTypes) {
      for (const [dependencyName, data] of Object.entries(expected[dependencyType] || {})) {
        for (const [key, value] of Object.entries(data || {})) {
          const resultValue = results[dependencyType][dependencyName][key];
          if (key === "age") {
            expect(resultValue).toBeInstanceOf(String);
            expect(resultValue.length > 0).toBeTruthy();
          } else {
            expect(resultValue).toEqual(value);
          }
        }
      }
    }
  };
}

test("latest", makeTest("-j", {
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
    },
    "updates": {
      old: "6941e05",
      new: "537ccb7",
      info: "https://github.com/silverwind/updates",
    },
  },
  peerDependencies: {
    "@babel/preset-env": {
      "old": "~6.0.0",
      "new": "~7.7.6",
      "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
    }
  },
}));

test("greatest", makeTest("-j -g", {
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
    },
    "updates": {
      old: "6941e05",
      new: "537ccb7",
      info: "https://github.com/silverwind/updates",
    },
  },
  peerDependencies: {
    "@babel/preset-env": {
      "old": "~6.0.0",
      "new": "~7.7.6",
      "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
    }
  }
}));

test("prerelease", makeTest("-j -g -p", {
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
    },
    "updates": {
      old: "6941e05",
      new: "537ccb7",
      info: "https://github.com/silverwind/updates",
    },
  },
  peerDependencies: {
    "@babel/preset-env": {
      "old": "~6.0.0",
      "new": "~7.7.6",
      "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
    }
  },
}));

test("release", makeTest("-j -R", {
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
    },
    "updates": {
      old: "6941e05",
      new: "537ccb7",
      info: "https://github.com/silverwind/updates",
    },
  },
  peerDependencies: {
    "@babel/preset-env": {
      "old": "~6.0.0",
      "new": "~7.7.6",
      "info": "https://github.com/babel/babel/tree/master/packages/babel-preset-env"
    },
  },
}));

test("patch", makeTest("-j -P", {
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
    "updates": {
      old: "6941e05",
      new: "537ccb7",
      info: "https://github.com/silverwind/updates",
    },
  },
}));
