import nanoSpawn from "nano-spawn";
import restana from "restana";
import {join, parse} from "node:path";
import {readFileSync, mkdtempSync, readdirSync, mkdirSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {env, versions, execPath} from "node:process";
import type {Server} from "node:http";
import type {Service, Protocol} from "restana";
import {npmTypes, poetryTypes, uvTypes, goTypes} from "./utils.ts";

const testFile = fileURLToPath(new URL("fixtures/npm-test/package.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/npm-empty/package.json", import.meta.url));
const poetryFile = fileURLToPath(new URL("fixtures/poetry/pyproject.toml", import.meta.url));
const uvFile = fileURLToPath(new URL("fixtures/uv/pyproject.toml", import.meta.url));
const goFile = fileURLToPath(new URL("fixtures/go/go.mod", import.meta.url));
const dualFile = fileURLToPath(new URL("fixtures/dual", import.meta.url));

const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const script = fileURLToPath(new URL("dist/index.js", import.meta.url));

const testPackages = new Set<string>(["npm"]);
for (const dependencyType of npmTypes) {
  for (const name of Object.keys(testPkg[dependencyType] || [])) {
    testPackages.add(name);
  }
}

function makeUrl(server: Server) {
  const {port}: any = server.address();
  return Object.assign(new URL("http://localhost"), {port}).toString();
}

function defaultRoute(req: any, res: any) {
  console.error(`default handler hit for ${req.url}`);
  res.send(404);
}

function resolutionsBasePackage(name: string) {
  const packages = name.match(/(@[^/]+\/)?([^/]+)/g) || [];
  return packages[packages.length - 1];
}

let npmServer: Service<Protocol.HTTP> | Server;
let githubServer: Service<Protocol.HTTP> | Server;
let pypiServer: Service<Protocol.HTTP> | Server;

let githubUrl: string;
let pypiUrl: string;
let npmUrl: string;

beforeAll(async () => {
  npmServer = restana({defaultRoute});
  githubServer = restana({defaultRoute});
  pypiServer = restana({defaultRoute});

  const [commits, tags] = await Promise.all([
    readFile(fileURLToPath(new URL("fixtures/github/updates-commits.json", import.meta.url))),
    readFile(fileURLToPath(new URL("fixtures/github/updates-tags.json", import.meta.url))),
  ]);

  for (const pkgName of testPackages) {
    const name = testPkg.resolutions[pkgName] ? resolutionsBasePackage(pkgName) : pkgName;
    const urlName = name.replace(/\//g, "%2f");
    // can not use file URLs because node stupidely throws on "%2f" in paths.
    const path = join(import.meta.dirname, `fixtures/npm/${urlName}.json`);
    npmServer.get(`/${urlName}`, async (_, res) => res.send(await readFile(path)));
  }

  for (const file of readdirSync(join(import.meta.dirname, `fixtures/pypi`))) {
    const path = join(import.meta.dirname, `fixtures/pypi/${file}`);
    pypiServer.get(`/pypi/${parse(path).name}/json`, async (_, res) => res.send(await readFile(path)));
  }

  githubServer.get("/repos/silverwind/updates/commits", (_, res) => res.send(commits));
  githubServer.get("/repos/silverwind/updates/git/refs/tags", (_, res) => res.send(tags));

  [githubServer, pypiServer, npmServer] = await Promise.all([
    githubServer.start(0),
    pypiServer.start(0),
    npmServer.start(0),
  ]);

  githubUrl = makeUrl(githubServer);
  npmUrl = makeUrl(npmServer);
  pypiUrl = makeUrl(pypiServer);

  await writeFile(join(testDir, ".npmrc"), `registry=${npmUrl}`); // Fake registry
  await writeFile(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2)); // Copy fixture
});

afterAll(async () => {
  await Promise.all([
    rm(testDir, {recursive: true}),
    npmServer?.close(),
    githubServer?.close(),
    pypiServer?.close(),
  ]);
});

function makeTest(args: string) {
  return async () => {
    const argsArr = [
      ...args.split(/\s+/), "-c",
      "--githubapi", githubUrl,
      "--pypiapi", pypiUrl,
    ];

    let stdout: string;
    let results: Record<string, any>;
    try {
      ({stdout} = await nanoSpawn(execPath, [script, ...argsArr], {cwd: testDir}));
      ({results} = JSON.parse(stdout));
    } catch (err) {
      console.error(err);
      throw err;
    }

    // Parse results, with custom validation for the dynamic "age" property
    for (const mode of Object.keys(results || {})) {
      for (const dependencyType of [
        ...npmTypes,
        ...poetryTypes,
        ...uvTypes,
        ...goTypes,
      ]) {
        for (const name of Object.keys(results?.[mode]?.[dependencyType] || {})) {
          delete results[mode][dependencyType][name].age;
        }
      }
    }

    return results;
  };
}

test("simple", async () => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "--githubapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--registry", npmUrl,
    "-f", testFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
});

test("empty", async () => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "--githubapi", githubUrl,
    "--pypiapi", pypiUrl,
    "-f", emptyFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
});

if (env.CI && !versions.bun) {
  test("global", async () => {
    await nanoSpawn("npm", ["i", "-g", "."]);
    const {stdout, stderr} = await nanoSpawn("updates", [
      "-C",
      "--githubapi", githubUrl,
      "--pypiapi", pypiUrl,
      "-f", testFile,
    ]);
    expect(stderr).toEqual("");
    expect(stdout).toContain("prismjs");
    expect(stdout).toContain("https://github.com/silverwind/updates");
  });
}

test("latest", async () => {
  expect(await makeTest("-j")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "7.11.5",
            "old": "7.0.0",
          },
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "0.0.0-pr-32455-sha-2828decf",
            "old": "10.0.0-beta.5",
          },
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
          "html-webpack-plugin": {
            "info": "https://github.com/jantimon/html-webpack-plugin",
            "new": "4.0.0-beta.11",
            "old": "4.0.0-alpha.2",
          },
          "jpeg-buffer-orientation": {
            "info": "https://github.com/fisker/jpeg-buffer-orientation",
            "new": "2.0.3",
            "old": "0.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
          "prismjs": {
            "info": "https://github.com/LeaVerou/prism",
            "new": "1.17.1",
            "old": "1.0.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.2.0",
            "old": "18.0",
          },
          "styled-components": {
            "info": "https://github.com/styled-components/styled-components",
            "new": "5.0.0-rc.2",
            "old": "2.5.0-1",
          },
          "svgstore": {
            "info": "https://github.com/svgstore/svgstore",
            "new": "^3.0.0-2",
            "old": "^3.0.0",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "peerDependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "~7.11.5",
            "old": "~6.0.0",
          },
          "typescript": {
            "info": "https://github.com/Microsoft/TypeScript",
            "new": "^5",
            "old": "^4",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^10.0.0",
            "old": "^1.0.0",
          },
        },
      },
    }
  `);
});

test("greatest", async () => {
  expect(await makeTest("-j -g")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "7.11.5",
            "old": "7.0.0",
          },
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "10.0.0-beta.6",
            "old": "10.0.0-beta.5",
          },
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
          "html-webpack-plugin": {
            "info": "https://github.com/jantimon/html-webpack-plugin",
            "new": "4.0.0-beta.11",
            "old": "4.0.0-alpha.2",
          },
          "jpeg-buffer-orientation": {
            "info": "https://github.com/fisker/jpeg-buffer-orientation",
            "new": "2.0.3",
            "old": "0.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
          "prismjs": {
            "info": "https://github.com/LeaVerou/prism",
            "new": "1.17.1",
            "old": "1.0.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.2.0",
            "old": "18.0",
          },
          "styled-components": {
            "info": "https://github.com/styled-components/styled-components",
            "new": "5.0.0-rc.2",
            "old": "2.5.0-1",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "peerDependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "~7.11.5",
            "old": "~6.0.0",
          },
          "typescript": {
            "info": "https://github.com/Microsoft/TypeScript",
            "new": "^5",
            "old": "^4",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^10.0.0",
            "old": "^1.0.0",
          },
        },
      },
    }
  `);
});

test("prerelease", async () => {
  expect(await makeTest("-j -g -p")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "7.11.5",
            "old": "7.0.0",
          },
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "10.0.0-beta.6",
            "old": "10.0.0-beta.5",
          },
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
          "html-webpack-plugin": {
            "info": "https://github.com/jantimon/html-webpack-plugin",
            "new": "4.0.0-beta.11",
            "old": "4.0.0-alpha.2",
          },
          "jpeg-buffer-orientation": {
            "info": "https://github.com/fisker/jpeg-buffer-orientation",
            "new": "2.0.3",
            "old": "0.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
          "prismjs": {
            "info": "https://github.com/LeaVerou/prism",
            "new": "1.17.1",
            "old": "1.0.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.3.0-next-d1e35c703-20221110",
            "old": "18.0",
          },
          "styled-components": {
            "info": "https://github.com/styled-components/styled-components",
            "new": "5.0.0-rc.2",
            "old": "2.5.0-1",
          },
          "svgstore": {
            "info": "https://github.com/svgstore/svgstore",
            "new": "^3.0.0-2",
            "old": "^3.0.0",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "peerDependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "~7.11.5",
            "old": "~6.0.0",
          },
          "typescript": {
            "info": "https://github.com/Microsoft/TypeScript",
            "new": "^5",
            "old": "^4",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^10.0.0",
            "old": "^1.0.0",
          },
        },
      },
    }
  `);
});

test("release", async () => {
  expect(await makeTest("-j -R")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "7.11.5",
            "old": "7.0.0",
          },
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "9.1.7",
            "old": "10.0.0-beta.5",
          },
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
          "html-webpack-plugin": {
            "info": "https://github.com/jantimon/html-webpack-plugin",
            "new": "3.2.0",
            "old": "4.0.0-alpha.2",
          },
          "jpeg-buffer-orientation": {
            "info": "https://github.com/fisker/jpeg-buffer-orientation",
            "new": "2.0.3",
            "old": "0.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
          "prismjs": {
            "info": "https://github.com/LeaVerou/prism",
            "new": "1.17.1",
            "old": "1.0.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.2.0",
            "old": "18.0",
          },
          "styled-components": {
            "info": "https://github.com/styled-components/styled-components",
            "new": "4.4.1",
            "old": "2.5.0-1",
          },
          "svgstore": {
            "info": "https://github.com/svgstore/svgstore",
            "new": "^2.0.3",
            "old": "^3.0.0",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "peerDependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "~7.11.5",
            "old": "~6.0.0",
          },
          "typescript": {
            "info": "https://github.com/Microsoft/TypeScript",
            "new": "^5",
            "old": "^4",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^10.0.0",
            "old": "^1.0.0",
          },
        },
      },
    }
  `);
});

test("patch", async () => {
  expect(await makeTest("-j -P")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/floridoo/gulp-sourcemaps",
            "new": "2.0.1",
            "old": "2.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.0.0",
            "old": "18.0",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^1.0.6",
            "old": "^1.0.0",
          },
        },
      },
    }
  `);
});

test("include", async () => {
  expect(await makeTest("-j -i noty")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("include 2", async () => {
  expect(await makeTest("-j -i noty -i noty,noty")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("include 3", async () => {
  expect(await makeTest("-j -i /^noty/")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("packageManager", async () => {
  expect(await makeTest("-j -i npm")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("exclude", async () => {
  expect(await makeTest("-j -e gulp-sourcemaps,prismjs,svgstore,html-webpack-plugin,noty,jpeg-buffer-orientation,styled-components,@babel/preset-env,versions/updates,react")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "0.0.0-pr-32455-sha-2828decf",
            "old": "10.0.0-beta.5",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
        "peerDependencies": {
          "typescript": {
            "info": "https://github.com/Microsoft/TypeScript",
            "new": "^5",
            "old": "^4",
          },
        },
      },
    }
  `);
});

test("exclude 2", async () => {
  expect(await makeTest("-j -e gulp-sourcemaps -i /react/")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.2.0",
            "old": "18.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("exclude 3", async () => {
  expect(await makeTest("-j -i gulp*")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("exclude 4", async () => {
  expect(await makeTest("-j -i /^gulp/ -P gulp*")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/floridoo/gulp-sourcemaps",
            "new": "2.0.1",
            "old": "2.0.0",
          },
        },
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
          },
        },
      },
    }
  `);
});

test("poetry", async () => {
  expect(await makeTest(`-j -f ${poetryFile}`)()).toMatchInlineSnapshot(`
    {
      "pypi": {
        "tool.poetry.group.dev.dependencies": {
          "PyYAML": {
            "info": "https://github.com/yaml/pyyaml",
            "new": "6.0",
            "old": "1.0",
          },
          "djlint": {
            "info": "https://github.com/Riverside-Healthcare/djlint",
            "new": "1.31.0",
            "old": "1.30.0",
          },
        },
      },
    }
  `);
});

test("uv", async () => {
  expect(await makeTest(`-j -f ${uvFile}`)()).toMatchInlineSnapshot(`
    {
      "pypi": {
        "dependency-groups.dev": {
          "PyYAML": {
            "info": "https://github.com/yaml/pyyaml",
            "new": "6.0",
            "old": "1.0",
          },
          "types-paramiko": {
            "info": "https://github.com/python/typeshed",
            "new": "3.5.0.20250801",
            "old": "3.4.0.20240423",
          },
          "types-requests": {
            "info": "https://github.com/python/typeshed",
            "new": "2.32.4.20250611",
            "old": "2.32.0.20240622",
          },
        },
        "project.dependencies": {
          "djlint": {
            "info": "https://github.com/Riverside-Healthcare/djlint",
            "new": "1.31.0",
            "old": "1.30.0",
          },
          "ty": {
            "info": "https://github.com/astral-sh/ty",
            "new": "0.0.1a19",
            "old": "0.0.1a15",
          },
        },
      },
    }
  `);
});

test("dual", async () => {
  expect(await makeTest(`-j -f ${dualFile}`)()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "7.11.5",
            "old": "7.0.0",
          },
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": "2.6.5",
            "old": "2.0.0",
          },
          "html-webpack-plugin": {
            "info": "https://github.com/jantimon/html-webpack-plugin",
            "new": "4.0.0-beta.11",
            "old": "4.0.0-alpha.2",
          },
          "jpeg-buffer-orientation": {
            "info": "https://github.com/fisker/jpeg-buffer-orientation",
            "new": "2.0.3",
            "old": "0.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
          "prismjs": {
            "info": "https://github.com/LeaVerou/prism",
            "new": "1.17.1",
            "old": "1.0.0",
          },
          "react": {
            "info": "https://github.com/facebook/react/tree/HEAD/packages/react",
            "new": "18.2.0",
            "old": "18.0",
          },
          "styled-components": {
            "info": "https://github.com/styled-components/styled-components",
            "new": "5.0.0-rc.2",
            "old": "2.5.0-1",
          },
          "svgstore": {
            "info": "https://github.com/svgstore/svgstore",
            "new": "^3.0.0-2",
            "old": "^3.0.0",
          },
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "peerDependencies": {
          "@babel/preset-env": {
            "info": "https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env",
            "new": "~7.11.5",
            "old": "~6.0.0",
          },
        },
        "resolutions": {
          "versions/updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "^10.0.0",
            "old": "^1.0.0",
          },
        },
      },
      "pypi": {
        "dependencies": {
          "updates": {
            "info": "https://github.com/silverwind/updates",
            "new": "537ccb7",
            "old": "6941e05",
          },
        },
        "tool.poetry.group.dev.dependencies": {
          "djlint": {
            "info": "https://github.com/Riverside-Healthcare/djlint",
            "new": "1.31.0",
            "old": "1.30.0",
          },
        },
      },
    }
  `);
});

test("dual 2", async () => {
  expect(await makeTest(`-j -f ${dualFile} -i noty`)()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
        },
      },
    }
  `);
});

test("go", async () => {
  expect(await makeTest(`-j -f ${goFile}`)()).toMatchInlineSnapshot(`
    {
      "go": {
        "deps": {
          "github.com/google/uuid": {
            "info": "https://github.com/google/uuid",
            "new": "1.6.0",
            "old": "1.5.0",
          },
        },
      },
    }
  `);
});

test("go update", async () => {
  // Create a temporary go.mod with an old version for testing
  const testGoModDir = join(testDir, "test-go");
  mkdirSync(testGoModDir, {recursive: true});
  await writeFile(join(testGoModDir, "go.mod"), `module example.com/test

go 1.24

require (
  github.com/google/uuid v1.5.0
)
`);

  // Initialize the go module
  await nanoSpawn("go", ["mod", "download"], {cwd: testGoModDir});

  // Run updates with -u flag
  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
  ], {cwd: testGoModDir});

  // Read the updated file
  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  // Verify the version was updated
  expect(updatedContent).toContain("github.com/google/uuid v1.6.0");
  expect(updatedContent).not.toContain("v1.5.0");
});

test("go update - single-line format", async () => {
  // Create a temporary go.mod with single-line require format
  const testGoModDir = join(testDir, "test-go-single");
  mkdirSync(testGoModDir, {recursive: true});
  await writeFile(join(testGoModDir, "go.mod"), `module example.com/test

go 1.24

require github.com/google/uuid v1.5.0
`);

  // Initialize the go module
  await nanoSpawn("go", ["mod", "download"], {cwd: testGoModDir});

  // Run updates with -u flag
  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
  ], {cwd: testGoModDir});

  // Read the updated file
  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  // Verify the version was updated
  expect(updatedContent).toContain("require github.com/google/uuid v1.6.0");
  expect(updatedContent).not.toContain("v1.5.0");
});

test("go update - multiple same dependencies", async () => {
  // Create a temporary go.mod with duplicate dependencies
  const testGoModDir = join(testDir, "test-go-multiple");
  mkdirSync(testGoModDir, {recursive: true});
  await writeFile(join(testGoModDir, "go.mod"), `module example.com/test

go 1.24

require (
  github.com/google/uuid v1.5.0
)

require (
  github.com/google/uuid v1.5.0
)
`);

  // Initialize the go module
  await nanoSpawn("go", ["mod", "download"], {cwd: testGoModDir});

  // Run updates with -u flag
  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
  ], {cwd: testGoModDir});

  // Read the updated file
  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  // Verify all occurrences were updated
  expect(updatedContent).toContain("github.com/google/uuid v1.6.0");
  expect(updatedContent).not.toContain("v1.5.0");
  // Count occurrences of the updated version
  const matches = updatedContent.match(/github\.com\/google\/uuid v1\.6\.0/g);
  expect(matches).toBeTruthy();
  expect(matches?.length).toBe(2);
});

test("go update - mixed with other dependencies", async () => {
  // Create a temporary go.mod with multiple dependencies
  const testGoModDir = join(testDir, "test-go-mixed");
  mkdirSync(testGoModDir, {recursive: true});
  await writeFile(join(testGoModDir, "go.mod"), `module example.com/test

go 1.24

require (
  github.com/google/go-github/v70 v70.0.0
  github.com/google/uuid v1.5.0
)
`);

  // Initialize the go module
  await nanoSpawn("go", ["mod", "download"], {cwd: testGoModDir});

  // Run updates with -u flag
  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
  ], {cwd: testGoModDir});

  // Read the updated file
  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  // Verify only uuid was updated (go-github/v70 is at v70.0.0 which is latest)
  expect(updatedContent).toContain("github.com/google/uuid v1.6.0");
  expect(updatedContent).not.toContain("uuid v1.5.0");
  // Verify other dependency remained unchanged
  expect(updatedContent).toContain("github.com/google/go-github/v70 v70.0.0");
});
