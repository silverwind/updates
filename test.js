"use strict";

const createTestServer = require("create-test-server");
const del = require("del");
const execa = require("execa");
const tempy = require("tempy");
const {join} = require("path");
const {test, expect, beforeAll, afterAll} = global;
const {writeFile, readFile} = require("fs").promises;

const testDir = tempy.directory();
let server;

const testPackages = [
  "gulp-sourcemaps",
  "prismjs",
  "svgstore",
  "html-webpack-plugin",
  "noty",
  "jpeg-buffer-orientation",
  "styled-components",
  "@babel/preset-env",
];

beforeAll(async () => {
  server = await createTestServer();

  // Server response
  for (const packageName of testPackages) {
    const name = packageName.replace(/\//g, "%2f");
    const path = join(__dirname, "fixtures", "registry-responses", `${name}.json`);
    const text = await readFile(path, "utf8");
    server.get(`/${name}`, text);
  }

  const {sslUrl: registry} = server;

  // Fake registry
  await writeFile(join(testDir, ".npmrc"), `registry=${registry}`);

  // Copy fixture
  await writeFile(join(testDir, "test.json"), await readFile("test.json", "utf8"));
});

afterAll(async () => {
  await del(testDir, {force: true});
  if (server) await server.close();
});

function makeTest(args, expected) {
  return async () => {
    const {stdout} = await execa(
      join(__dirname, "./updates.js"),
      args.split(/\s+/),
      {cwd: testDir},
    );
    return expect(JSON.parse(stdout)).toEqual({results: expected});
  };
}

test("latest", makeTest("-j -f test.json", {
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
}));

test("greatest", makeTest("-j -g -f test.json", {
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
}));

test("prerelease", makeTest("-j -g -p -f test.json", {
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
}));

test("release", makeTest("-j -R -f test.json", {
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
}));

test("patch", makeTest("-j -P -f test.json", {
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
}));
