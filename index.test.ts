import nanoSpawn from "nano-spawn";
import {createServer} from "node:http";
import {join, parse} from "node:path";
import {readFileSync, mkdtempSync, readdirSync, mkdirSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {env, execPath, versions} from "node:process";
import {gzip, constants} from "node:zlib";
import {promisify} from "node:util";
import type {Server} from "node:http";
import {satisfies} from "./utils/semver.ts";
import {npmTypes} from "./utils/utils.ts";

const globalExpect = expect;
const gzipPromise = (data: string | Buffer) => promisify(gzip)(data, {level: constants.Z_BEST_SPEED});
const testFile = fileURLToPath(new URL("fixtures/npm-test/package.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/npm-empty/package.json", import.meta.url));
const jsrFile = fileURLToPath(new URL("fixtures/npm-jsr/package.json", import.meta.url));
const poetryFile = fileURLToPath(new URL("fixtures/poetry/pyproject.toml", import.meta.url));
const uvFile = fileURLToPath(new URL("fixtures/uv/pyproject.toml", import.meta.url));
const goFile = fileURLToPath(new URL("fixtures/go/go.mod", import.meta.url));
const goUpdateModFile = fileURLToPath(new URL("fixtures/go-update/go.mod", import.meta.url));
const goUpdateMainFile = fileURLToPath(new URL("fixtures/go-update/main.go", import.meta.url));
const goUpdateV2ModFile = fileURLToPath(new URL("fixtures/go-update-v2/go.mod", import.meta.url));
const goUpdateV2MainFile = fileURLToPath(new URL("fixtures/go-update-v2/main.go", import.meta.url));
const goPreFile = fileURLToPath(new URL("fixtures/go-prerelease/go.mod", import.meta.url));
const dualFile = fileURLToPath(new URL("fixtures/dual", import.meta.url));
const invalidConfigFile = fileURLToPath(new URL("fixtures/invalid-config/package.json", import.meta.url));
const actionsDir = fileURLToPath(new URL("fixtures/actions/.github/workflows", import.meta.url));

const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const script = fileURLToPath(new URL("dist/index.js", import.meta.url));

type RouteHandler = (req: any, res: any) => void | Promise<void>;

function isObject<T = Record<string, any>>(obj: any): obj is T {
  return Object.prototype.toString.call(obj) === "[object Object]";
}

function makeServer(defaultHandler: RouteHandler) {
  const routes = new Map<string, RouteHandler>();

  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const handler = routes.get(url) || defaultHandler;

    (res as any).send = (data: Buffer) => {
      res.setHeader("Content-Encoding", "gzip");
      res.end(data);
    };

    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(err);
    }
  });

  return {
    get: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
    start: (port: number) => {
      return new Promise<Server>((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          resolve(server);
        });
      });
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    address: () => server.address(),
  };
}

const testPackages = new Set<string>(["npm"]);
for (const dependencyType of npmTypes) {
  if (!isObject(testPkg[dependencyType])) continue;
  for (const name of Object.keys(testPkg[dependencyType] || [])) {
    testPackages.add(name);
  }
}

function makeUrl(server: ReturnType<typeof makeServer>) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Server address is not available");
  }
  const {port}: any = addr;
  return Object.assign(new URL("http://127.0.0.1"), {port}).toString();
}

function defaultRoute(req: any, res: any) {
  console.error(`default handler hit for ${req.url}`);
  res.statusCode = 404;
  res.end();
}

function resolutionsBasePackage(name: string) {
  const packages = name.match(/(@[^/]+\/)?([^/]+)/g) || [];
  return packages[packages.length - 1];
}

let npmServer: ReturnType<typeof makeServer>;
let githubServer: ReturnType<typeof makeServer>;
let pypiServer: ReturnType<typeof makeServer>;
let jsrServer: ReturnType<typeof makeServer>;
let goProxyServer: ReturnType<typeof makeServer>;

let githubUrl: string;
let pypiUrl: string;
let npmUrl: string;
let jsrUrl: string;
let goProxyUrl: string;

beforeAll(async () => {
  npmServer = makeServer(defaultRoute);
  githubServer = makeServer(defaultRoute);
  pypiServer = makeServer(defaultRoute);
  jsrServer = makeServer(defaultRoute);
  goProxyServer = makeServer((_, res) => { res.statusCode = 404; res.end(); });

  const [commits, tags] = await Promise.all([
    readFile(fileURLToPath(new URL("fixtures/github/updates-commits.json", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("fixtures/github/updates-tags.json", import.meta.url)), "utf8"),
  ]);

  const npmFilesPromises: Array<Promise<{urlName: string, data: string}>> = [];
  for (const pkgName of testPackages) {
    const name = (testPkg.resolutions[pkgName] ? resolutionsBasePackage(pkgName) : pkgName);
    const urlName = name.replace(/\//g, "%2f");
    // can not use file URLs because node stupidely throws on "%2f" in paths.
    const path = join(import.meta.dirname, `fixtures/npm/${urlName}.json`);
    npmFilesPromises.push((async () => ({urlName, data: await readFile(path, "utf8")}))());
  }

  const pypiFilesPromises: Array<Promise<{pkgName: string, data: string}>> = [];
  for (const file of readdirSync(join(import.meta.dirname, `fixtures/pypi`))) {
    const path = join(import.meta.dirname, `fixtures/pypi/${file}`);
    const pkgName = parse(path).name;
    pypiFilesPromises.push((async () => ({pkgName, data: await readFile(path, "utf8")}))());
  }

  const jsrFilesPromises: Array<Promise<{scope: string, name: string, data: string}>> = [];
  for (const file of readdirSync(join(import.meta.dirname, `fixtures/jsr`))) {
    const path = join(import.meta.dirname, `fixtures/jsr/${file}`);
    const pkgName = parse(path).name;
    const [scope, name] = pkgName.replace("@", "").split("__");
    jsrFilesPromises.push((async () => ({scope, name, data: await readFile(path, "utf8")}))());
  }

  const [npmFiles, pypiFiles, jsrFiles] = await Promise.all([
    Promise.all(npmFilesPromises),
    Promise.all(pypiFilesPromises),
    Promise.all(jsrFilesPromises),
  ]);

  const gzipAll = await Promise.all([
    ...npmFiles.filter(Boolean).map(async (file) => ({type: "npm" as const, key: `/${file.urlName}`, gz: await gzipPromise(file.data)})),
    ...pypiFiles.map(async ({pkgName, data}) => ({type: "pypi" as const, key: `/pypi/${pkgName}/json`, gz: await gzipPromise(data)})),
    ...jsrFiles.map(async ({scope, name, data}) => ({type: "jsr" as const, key: `/@${scope}/${name}/meta.json`, gz: await gzipPromise(data)})),
    (async () => ({type: "github" as const, key: "/repos/silverwind/updates/commits", gz: await gzipPromise(commits)}))(),
    (async () => ({type: "github" as const, key: "/repos/silverwind/updates/tags", gz: await gzipPromise(tags)}))(),
  ]);

  for (const {type, key, gz} of gzipAll) {
    const server = type === "npm" ? npmServer : type === "pypi" ? pypiServer : type === "jsr" ? jsrServer : githubServer;
    server.get(key, (_, res) => res.send(gz));
  }

  // Go proxy fixtures
  const goProxyRoutes: Array<{path: string, response: string}> = [
    {path: "/github.com/google/uuid/@latest", response: JSON.stringify({Version: "v1.6.0", Time: "2024-06-13T02:52:04Z"})},
    {path: "/github.com/google/go-github/v70/@latest", response: JSON.stringify({Version: "v70.0.0", Time: "2024-11-29T00:00:00Z"})},
    {path: "/github.com/example/testpkg/@latest", response: JSON.stringify({Version: "v1.0.0", Time: "2024-01-01T00:00:00Z"})},
    {path: "/github.com/example/testpkg/v2/@latest", response: JSON.stringify({Version: "v2.0.0", Time: "2025-01-01T00:00:00Z"})},
    {path: "/github.com/google/uuid/v2/@latest", response: JSON.stringify({Version: "v2.0.0-20260217135312-8c5a7de9ffa1", Time: "2026-02-17T13:53:12Z"})},
    {path: "/github.com/example/prerelpkg/@latest", response: JSON.stringify({Version: "v1.1.0-rc.1", Time: "2025-06-01T00:00:00Z"})},
  ];
  for (let v = 71; v <= 82; v++) {
    goProxyRoutes.push({
      path: `/github.com/google/go-github/v${v}/@latest`,
      response: JSON.stringify({Version: `v${v}.0.0`, Time: "2025-01-01T00:00:00Z"}),
    });
  }
  const goProxyGzips = await Promise.all(
    goProxyRoutes.map(async ({path, response}) => ({path, gz: await gzipPromise(response)})),
  );
  for (const {path, gz} of goProxyGzips) {
    goProxyServer.get(path, (_, res) => res.send(gz));
  }

  // Actions fixtures for github server
  const actionsRoutes: Array<[string, string]> = [
    ["/repos/actions/checkout/tags", "fixtures/github/actions-checkout-tags.json"],
    ["/repos/actions/setup-node/tags", "fixtures/github/actions-setup-node-tags.json"],
    ["/repos/actions/checkout/git/commits/cccc000000000000000000000000000000000011", "fixtures/github/actions-checkout-commit-v10.0.1.json"],
    ["/repos/actions/setup-node/git/commits/bbbb000000000000000000000000000000000010", "fixtures/github/actions-setup-node-commit-v10.json"],
  ];
  for (const [route, fixture] of actionsRoutes) {
    const data = await readFile(fileURLToPath(new URL(fixture, import.meta.url)), "utf8");
    const gz = await gzipPromise(data);
    githubServer.get(route, (_, res) => res.send(gz));
  }

  await Promise.all([
    githubServer.start(0),
    pypiServer.start(0),
    npmServer.start(0),
    jsrServer.start(0),
    goProxyServer.start(0),
  ]);

  githubUrl = makeUrl(githubServer);
  npmUrl = makeUrl(npmServer);
  pypiUrl = makeUrl(pypiServer);
  jsrUrl = makeUrl(jsrServer);
  goProxyUrl = makeUrl(goProxyServer);

  await writeFile(join(testDir, ".npmrc"), `registry=${npmUrl}`); // Fake registry
  await writeFile(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2)); // Copy fixture
});

afterAll(async () => {
  await Promise.all([
    rm(testDir, {recursive: true}),
    npmServer?.close(),
    githubServer?.close(),
    pypiServer?.close(),
    jsrServer?.close(),
    goProxyServer?.close(),
  ]);
});

function makeTest(args: string) {
  return async () => {
    const argsArr = [
      ...args.split(/\s+/), "-c",
      "--forgeapi", githubUrl,
      "--pypiapi", pypiUrl,
      "--jsrapi", jsrUrl,
      "--goproxy", goProxyUrl,
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
      for (const type of Object.keys(results[mode] || {})) {
        for (const name of Object.keys(results[mode][type] || {})) {
          delete results[mode][type][name].age;
        }
      }
    }

    return results;
  };
}

test.concurrent("simple", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "--forgeapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--registry", npmUrl,
    "-f", testFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
});

test.concurrent("empty", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "--forgeapi", githubUrl,
    "--pypiapi", pypiUrl,
    "-f", emptyFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
});

test.concurrent("jsr", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "-j",
    "--forgeapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--jsrapi", jsrUrl,
    "-f", jsrFile,
  ]);
  expect(stderr).toEqual("");
  const {results} = JSON.parse(stdout);
  expect(results.npm.dependencies["@std/semver"]).toBeDefined();
  expect(results.npm.dependencies["@std/semver"].old).toBe("1.0.5");
  expect(results.npm.dependencies["@std/semver"].new).toBe("1.0.8");
  expect(results.npm.devDependencies["@std/path"]).toBeDefined();
  expect(results.npm.devDependencies["@std/path"].old).toBe("1.0.0");
  expect(results.npm.devDependencies["@std/path"].new).toBe("1.0.8");
});

if (!versions.bun) {
  test.concurrent("global", async ({expect = globalExpect}: any = {}) => {
    await nanoSpawn("npm", ["i", "-g", "."]);
    try {
      const {stdout, stderr} = await nanoSpawn("updates", [
        "-C",
        "--forgeapi", githubUrl,
        "--pypiapi", pypiUrl,
        "-f", testFile,
      ]);
      expect(stderr).toEqual("");
      expect(stdout).toContain("prismjs");
      expect(stdout).toContain("https://github.com/silverwind/updates");
    } finally {
      if (env.CI) {
        await nanoSpawn("npm", ["uninstall", "-g", "updates"]);
      } else {
        await nanoSpawn("npm", ["install", "-g", "updates@latest"]);
      }
    }
  });
}


test.concurrent("latest", async ({expect = globalExpect}: any = {}) => {
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
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": ">=2.6.5",
            "old": ">=2.0.0",
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

test.concurrent("greatest", async ({expect = globalExpect}: any = {}) => {
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
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": ">=2.6.5",
            "old": ">=2.0.0",
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

test.concurrent("prerelease", async ({expect = globalExpect}: any = {}) => {
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
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": ">=2.6.5",
            "old": ">=2.0.0",
          },
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": ">= 3.2",
            "old": ">= 3.1",
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

test.concurrent("release", async ({expect = globalExpect}: any = {}) => {
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
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": ">=2.6.5",
            "old": ">=2.0.0",
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

test.concurrent("patch", async ({expect = globalExpect}: any = {}) => {
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
        "peerDependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/floridoo/gulp-sourcemaps",
            "new": ">=2.0.1",
            "old": ">=2.0.0",
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

test.concurrent("include", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest("-j -i noty")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
        },
      },
    }
  `);
});

test.concurrent("include 2", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest("-j -i /^noty/")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
        },
      },
    }
  `);
});

test.concurrent("packageManager", async ({expect = globalExpect}: any = {}) => {
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

test.concurrent("exclude", async ({expect = globalExpect}: any = {}) => {
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
      },
    }
  `);
});

test.concurrent("exclude 2", async ({expect = globalExpect}: any = {}) => {
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
        "peerDependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/gulp-sourcemaps/gulp-sourcemaps",
            "new": ">=2.6.5",
            "old": ">=2.0.0",
          },
        },
      },
    }
  `);
});

test.concurrent("exclude 3", async ({expect = globalExpect}: any = {}) => {
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
        "peerDependencies": {
          "gulp-sourcemaps": {
            "info": "https://github.com/floridoo/gulp-sourcemaps",
            "new": ">=2.0.1",
            "old": ">=2.0.0",
          },
        },
      },
    }
  `);
});

test.concurrent("poetry", async ({expect = globalExpect}: any = {}) => {
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

test.concurrent("uv", async ({expect = globalExpect}: any = {}) => {
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

test.concurrent("dual", async ({expect = globalExpect}: any = {}) => {
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

test.concurrent("dual 2", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest(`-j -f ${dualFile} -i noty`)()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
        },
      },
    }
  `);
});

test.concurrent("invalid config", async ({expect = globalExpect}: any = {}) => {
  const args = ["-j", "-f", invalidConfigFile, "-c", "--forgeapi", githubUrl, "--pypiapi", pypiUrl];
  try {
    await nanoSpawn(execPath, [script, ...args]);
    throw new Error("Expected error but got success");
  } catch (err: any) {
    expect(err?.exitCode).toBe(1);
    const output = err?.stdout || "";
    expect(output).toContain("updates.config.js");
    expect(output).toContain("Unable to parse");
  }
});

test.concurrent("preup", async ({expect = globalExpect}: any = {}) => {
  // Test that we don't upgrade from stable to prerelease when latest dist-tag is a prerelease
  // noty: 3.1.0 -> should suggest 3.1.4 (not 3.2.0-beta which is on latest dist-tag)
  expect(await makeTest("-j -i noty")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.1.4",
            "old": "3.1.0",
          },
        },
      },
    }
  `);
});

test.concurrent("preup 1", async ({expect = globalExpect}: any = {}) => {
  // Test that we DO upgrade to prerelease when explicitly requested with -p flag
  // noty: 3.1.0 -> should suggest 3.2.0-beta (from latest dist-tag) when -p is used
  expect(await makeTest("-j -i noty -p")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": "3.2.0-beta",
            "old": "3.1.0",
          },
        },
        "peerDependencies": {
          "noty": {
            "info": "https://github.com/needim/noty",
            "new": ">= 3.2",
            "old": ">= 3.1",
          },
        },
      },
    }
  `);
});

test.concurrent("preup 2", async ({expect = globalExpect}: any = {}) => {
  // Test that upgrading from prerelease to prerelease works without -p flag
  // eslint-plugin-storybook: 10.0.0-beta.5 -> should allow upgrade to another prerelease
  expect(await makeTest("-j -i eslint-plugin-storybook")()).toMatchInlineSnapshot(`
    {
      "npm": {
        "dependencies": {
          "eslint-plugin-storybook": {
            "info": "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
            "new": "0.0.0-pr-32455-sha-2828decf",
            "old": "10.0.0-beta.5",
          },
        },
      },
    }
  `);
});

test.concurrent("go", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest(`-j -f ${goFile}`)()).toMatchInlineSnapshot(`
    {
      "go": {
        "deps": {
          "github.com/google/go-github/v70": {
            "info": "https://github.com/google/go-github/tree/HEAD/v82",
            "new": "82.0.0",
            "old": "70.0.0",
          },
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

test.concurrent("go update", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-update");
  mkdirSync(testGoModDir, {recursive: true});

  const goUpdateContent = readFileSync(goUpdateModFile, "utf8");
  await writeFile(join(testGoModDir, "go.mod"), goUpdateContent);
  const goMainContent = readFileSync(goUpdateMainFile, "utf8");
  await writeFile(join(testGoModDir, "main.go"), goMainContent);

  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
    "--goproxy", goProxyUrl,
  ], {cwd: testGoModDir});

  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  expect(updatedContent).toContain("github.com/google/uuid v1.6.0");
  expect(updatedContent).not.toContain("uuid v1.5.0");
  expect(updatedContent).not.toContain("go-github/v70");
  expect(updatedContent).toMatch(/github\.com\/google\/go-github\/v\d+ v\d+\.\d+\.\d+/);

  const matches = updatedContent.match(/github\.com\/google\/uuid v1\.6\.0/g);
  expect(matches).toBeTruthy();
  expect(matches?.length).toBe(4);

  expect(updatedContent).not.toContain("replace");

  const updatedMain = await readFile(join(testGoModDir, "main.go"), "utf8");
  expect(updatedMain).not.toContain("go-github/v70");
  expect(updatedMain).toMatch(/go-github\/v\d+\/github/);
});

test.concurrent("go update v1 to v2", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-update-v2");
  mkdirSync(testGoModDir, {recursive: true});

  await writeFile(join(testGoModDir, "go.mod"), readFileSync(goUpdateV2ModFile, "utf8"));
  await writeFile(join(testGoModDir, "main.go"), readFileSync(goUpdateV2MainFile, "utf8"));

  await nanoSpawn(execPath, [
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
    "--goproxy", goProxyUrl,
  ], {cwd: testGoModDir});

  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");
  expect(updatedContent).toContain("github.com/example/testpkg/v2 v2.0.0");
  expect(updatedContent).not.toContain("testpkg v1.0.0");

  const updatedMain = await readFile(join(testGoModDir, "main.go"), "utf8");
  expect(updatedMain).toContain(`"github.com/example/testpkg/v2"`);
  expect(updatedMain).toContain(`"github.com/example/testpkg/v2/sub"`);
  expect(updatedMain).not.toMatch(/"github\.com\/example\/testpkg"(?!\/v2)/);
});

test.concurrent("go prerelease excluded by default", async ({expect = globalExpect}: any = {}) => {
  // Without --prerelease, Go prerelease versions should not be offered
  expect(await makeTest(`-j -f ${goPreFile}`)()).toMatchInlineSnapshot(`undefined`);
});

test.concurrent("go prerelease with -p flag", async ({expect = globalExpect}: any = {}) => {
  // With global --prerelease, Go prerelease versions should be offered
  expect(await makeTest(`-j -f ${goPreFile} -p`)()).toMatchInlineSnapshot(`
    {
      "go": {
        "deps": {
          "github.com/example/prerelpkg": {
            "info": "https://github.com/example/prerelpkg",
            "new": "1.1.0-rc.1",
            "old": "1.0.0",
          },
        },
      },
    }
  `);
});

test.concurrent("go prerelease with -p per-package", async ({expect = globalExpect}: any = {}) => {
  // With per-package --prerelease, Go prerelease versions should be offered for that package
  expect(await makeTest(`-j -f ${goPreFile} -p github.com/example/prerelpkg`)()).toMatchInlineSnapshot(`
    {
      "go": {
        "deps": {
          "github.com/example/prerelpkg": {
            "info": "https://github.com/example/prerelpkg",
            "new": "1.1.0-rc.1",
            "old": "1.0.0",
          },
        },
      },
    }
  `);
});

test.concurrent("pin", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-j",
    "-c",
    "--forgeapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--registry", npmUrl,
    "-f", testFile,
    "--pin", "prismjs=^1.0.0",
    "--pin", "react=^18.0.0",
  ]);
  expect(stderr).toEqual("");
  const {results} = JSON.parse(stdout);

  // prismjs should be updated but only within the ^1.0.0 range
  expect(results.npm.dependencies.prismjs).toBeDefined();
  const prismjsNew = results.npm.dependencies.prismjs.new;
  expect(satisfies(prismjsNew, "^1.0.0")).toBe(true);

  // react should not be updated beyond ^18.0.0 range
  expect(results.npm.dependencies.react).toBeDefined();
  const reactNew = results.npm.dependencies.react.new;
  expect(satisfies(reactNew, "^18.0.0")).toBe(true);
});

function actionsArgs(...extra: Array<string>) {
  return [script, "-c", "--forgeapi", githubUrl, "-M", "actions", "-f", actionsDir, ...extra];
}

function getActionsDeps(results: any) {
  const ciType = Object.keys(results.actions).find(t => t.endsWith("ci.yaml"));
  return results.actions[ciType!];
}

test.concurrent("actions basic", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, actionsArgs("-j"));
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  expect(output.results.actions).toBeDefined();
  const actionsDeps = getActionsDeps(output.results);

  // actions/checkout v2 -> v10 (major format preserved)
  expect(actionsDeps["actions/checkout"].old).toBe("v2");
  expect(actionsDeps["actions/checkout"].new).toBe("v10");
  expect(actionsDeps["actions/checkout"].info).toContain("actions/checkout");

  // actions/setup-node v1.0 -> v10.0 (minor format preserved)
  expect(actionsDeps["actions/setup-node"].old).toBe("v1.0");
  expect(actionsDeps["actions/setup-node"].new).toBe("v10.0");

  // Docker, local, and hash-pinned without tags should be skipped
  expect(actionsDeps["tj-actions/changed-files"]).toBeUndefined();
});

test.concurrent("actions include filter", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, actionsArgs("-j", "-i", "actions/checkout"));
  expect(stderr).toEqual("");
  const actionsDeps = getActionsDeps(JSON.parse(stdout).results);
  expect(actionsDeps["actions/checkout"]).toBeDefined();
  expect(actionsDeps["actions/setup-node"]).toBeUndefined();
});

test.concurrent("actions exclude filter", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, actionsArgs("-j", "-e", "actions/checkout"));
  expect(stderr).toEqual("");
  const actionsDeps = getActionsDeps(JSON.parse(stdout).results);
  expect(actionsDeps["actions/checkout"]).toBeUndefined();
  expect(actionsDeps["actions/setup-node"]).toBeDefined();
});

test.concurrent("actions text output", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, actionsArgs());
  expect(stderr).toEqual("");
  expect(stdout).toContain("actions/checkout");
  expect(stdout).toContain("actions/setup-node");
});

test.concurrent("actions update", async ({expect = globalExpect}: any = {}) => {
  const tmpActionsDir = join(testDir, "actions-update-test/.github/workflows");
  mkdirSync(tmpActionsDir, {recursive: true});
  const wfPath = join(tmpActionsDir, "ci.yaml");
  await writeFile(wfPath, "name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v2\n");

  const {stderr} = await nanoSpawn(process.execPath, [
    script, "-u", "-c", "--forgeapi", githubUrl, "-M", "actions",
    "-f", join(testDir, "actions-update-test/.github/workflows"),
  ]);
  expect(stderr).toEqual("");

  const updatedContent = await readFile(wfPath, "utf8");
  expect(updatedContent).toContain("actions/checkout@v10");
  expect(updatedContent).not.toContain("actions/checkout@v2");
});

test.concurrent("actions no false upgrade on same major", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, actionsArgs("-j", "-i", "actions/checkout"));
  expect(stderr).toEqual("");
  const actionsDeps = getActionsDeps(JSON.parse(stdout).results);
  // actions/checkout@v10 should not show as an update even though v10.0.1 patch exists
  // because formatted version (v10) equals the old ref (v10)
  expect(actionsDeps["actions/checkout"].old).toBe("v2");
  expect(actionsDeps["actions/checkout"].new).toBe("v10");
  // The v10 entry should not appear as a separate dep
  const allKeys = Object.keys(actionsDeps);
  const v10Entries = allKeys.filter(k => actionsDeps[k].old === "v10");
  expect(v10Entries).toHaveLength(0);
});

test.concurrent("actions hash-pinned", async ({expect = globalExpect}: any = {}) => {
  const tmpActionsDir = join(testDir, "actions-hash-test/.github/workflows");
  mkdirSync(tmpActionsDir, {recursive: true});
  const wfPath = join(tmpActionsDir, "ci.yaml");
  await writeFile(wfPath, "name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@cccc000000000000000000000000000000000006 # v4.2.0\n");

  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script, "-j", "-c", "--forgeapi", githubUrl, "-M", "actions",
    "-f", join(testDir, "actions-hash-test/.github/workflows"),
  ]);
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  const ciKey = Object.keys(output.results.actions).find(t => t.endsWith("ci.yaml"));
  const actionsDeps = output.results.actions[ciKey!];
  expect(actionsDeps["actions/checkout"].old).toBe("v4.2.0");
  expect(actionsDeps["actions/checkout"].new).toBe("v10.0.1");
});

test.concurrent("actions hash-pinned update", async ({expect = globalExpect}: any = {}) => {
  const tmpActionsDir = join(testDir, "actions-hash-update/.github/workflows");
  mkdirSync(tmpActionsDir, {recursive: true});
  const wfPath = join(tmpActionsDir, "ci.yaml");
  await writeFile(wfPath, "name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@cccc000000000000000000000000000000000006 # v4.2.0\n");

  const {stderr} = await nanoSpawn(process.execPath, [
    script, "-u", "-c", "--forgeapi", githubUrl, "-M", "actions",
    "-f", join(testDir, "actions-hash-update/.github/workflows"),
  ]);
  expect(stderr).toEqual("");

  const updatedContent = await readFile(wfPath, "utf8");
  expect(updatedContent).toContain("actions/checkout@cccc000000000000000000000000000000000011");
  expect(updatedContent).not.toContain("cccc000000000000000000000000000000000006");
});
