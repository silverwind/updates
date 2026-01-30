import nanoSpawn from "nano-spawn";
import {createServer} from "node:http";
import {join, parse} from "node:path";
import {readFileSync, mkdtempSync, readdirSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {execPath, versions} from "node:process";
import {gzipSync} from "node:zlib";
import type {Server} from "node:http";
import {npmTypes, poetryTypes, uvTypes, goTypes} from "./utils.ts";

const testFile = fileURLToPath(new URL("fixtures/npm-test/package.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/npm-empty/package.json", import.meta.url));
const jsrFile = fileURLToPath(new URL("fixtures/npm-jsr/package.json", import.meta.url));
const poetryFile = fileURLToPath(new URL("fixtures/poetry/pyproject.toml", import.meta.url));
const uvFile = fileURLToPath(new URL("fixtures/uv/pyproject.toml", import.meta.url));
// const goFile = fileURLToPath(new URL("fixtures/go/go.mod", import.meta.url));
const dualFile = fileURLToPath(new URL("fixtures/dual", import.meta.url));

const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const script = fileURLToPath(new URL("dist/index.js", import.meta.url));

type RouteHandler = (req: any, res: any) => void | Promise<void>;

function parseAcceptEncoding(header: string): Array<string> {
  return header.split(",").map(s => s.trim().split(";")[0]).filter(Boolean);
}

function createSimpleServer(defaultHandler: RouteHandler) {
  const routes = new Map<string, RouteHandler>();

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    const handler = routes.get(url) || defaultHandler;

    (res as any).send = (data: any) => {
      const acceptEncoding = req.headers["accept-encoding"] || "";
      const encodings = parseAcceptEncoding(acceptEncoding);
      const shouldCompress = encodings.includes("gzip");

      if (Buffer.isBuffer(data)) {
        res.setHeader("Content-Type", "application/json");
        if (shouldCompress) {
          res.setHeader("Content-Encoding", "gzip");
          res.end(gzipSync(data));
        } else {
          res.end(data);
        }
      } else if (typeof data === "object") {
        res.setHeader("Content-Type", "application/json");
        const json = JSON.stringify(data);
        if (shouldCompress) {
          res.setHeader("Content-Encoding", "gzip");
          res.end(gzipSync(json));
        } else {
          res.end(json);
        }
      } else {
        if (shouldCompress) {
          res.setHeader("Content-Encoding", "gzip");
          res.end(gzipSync(String(data)));
        } else {
          res.end(data);
        }
      }
    };

    try {
      await handler(req, res);
    } catch (err) {
      console.error("Error in request handler:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    }
  });

  return {
    get: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
    start: (port: number) => {
      return new Promise<Server>((resolve) => {
        server.listen(port, () => {
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
  for (const name of Object.keys(testPkg[dependencyType] || [])) {
    testPackages.add(name);
  }
}

function makeUrl(server: ReturnType<typeof createSimpleServer>) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Server address is not available");
  }
  const {port}: any = addr;
  return Object.assign(new URL("http://localhost"), {port}).toString();
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

let npmServer: ReturnType<typeof createSimpleServer>;
let githubServer: ReturnType<typeof createSimpleServer>;
let pypiServer: ReturnType<typeof createSimpleServer>;
let jsrServer: ReturnType<typeof createSimpleServer>;

let githubUrl: string;
let pypiUrl: string;
let npmUrl: string;
let jsrUrl: string;

beforeAll(async () => {
  npmServer = createSimpleServer(defaultRoute);
  githubServer = createSimpleServer(defaultRoute);
  pypiServer = createSimpleServer(defaultRoute);
  jsrServer = createSimpleServer(defaultRoute);

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

  for (const file of readdirSync(join(import.meta.dirname, `fixtures/jsr`))) {
    const path = join(import.meta.dirname, `fixtures/jsr/${file}`);
    const pkgName = parse(path).name; // e.g., "@std__semver"
    const [scope, name] = pkgName.replace("@", "").split("__");
    jsrServer.get(`/@${scope}/${name}/meta.json`, async (_, res) => res.send(await readFile(path)));
  }

  githubServer.get("/repos/silverwind/updates/commits", (_, res) => res.send(commits));
  githubServer.get("/repos/silverwind/updates/git/refs/tags", (_, res) => res.send(tags));

  await Promise.all([
    githubServer.start(0),
    pypiServer.start(0),
    npmServer.start(0),
    jsrServer.start(0),
  ]);

  githubUrl = makeUrl(githubServer);
  npmUrl = makeUrl(npmServer);
  pypiUrl = makeUrl(pypiServer);
  jsrUrl = makeUrl(jsrServer);

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
  ]);
});

function makeTest(args: string) {
  return async () => {
    const argsArr = [
      ...args.split(/\s+/), "-c",
      "--githubapi", githubUrl,
      "--pypiapi", pypiUrl,
      "--jsrapi", jsrUrl,
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

test("jsr", async () => {
  const {stdout, stderr} = await nanoSpawn(process.execPath, [
    script,
    "-C",
    "-j",
    "--githubapi", githubUrl,
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
  test("global", async () => {
    await nanoSpawn("npm", ["i", "-g", "."]);
    try {
      const {stdout, stderr} = await nanoSpawn("updates", [
        "-C",
        "--githubapi", githubUrl,
        "--pypiapi", pypiUrl,
        "-f", testFile,
      ]);
      expect(stderr).toEqual("");
      expect(stdout).toContain("prismjs");
      expect(stdout).toContain("https://github.com/silverwind/updates");
    } finally {
      await nanoSpawn("npm", ["install", "-g", "updates@latest"]);
    }
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

test("include", async () => {
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
            "new": "3.1.4",
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
            "new": "3.1.4",
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

test("dual 2", async () => {
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

test("issue #76: don't upgrade to prerelease from latest dist-tag by default", async () => {
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

test("issue #76: allow upgrade to prerelease with -p flag", async () => {
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
        "packageManager": {
          "npm": {
            "info": "https://github.com/npm/cli",
            "new": "11.6.2",
            "old": "11.6.0",
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

test("issue #76: allow upgrade from prerelease to prerelease without -p flag", async () => {
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

// test("go", async () => {
//   expect(await makeTest(`-j -f ${goFile}`)()).toMatchInlineSnapshot(`
//     {
//       "go": {
//         "deps": {
//           "github.com/google/go-github/v70": {
//             "info": "https://github.com/google/go-github",
//             "new": "v71.0.0",
//             "old": "v70.0.0",
//           },
//         },
//       },
//     }
//   `);
// });
