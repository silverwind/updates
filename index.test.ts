import {execFile} from "node:child_process";
import {createServer} from "node:http";
import {join, parse} from "node:path";
import {readFileSync, mkdtempSync, readdirSync, mkdirSync, symlinkSync, writeFileSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {execPath, platform, versions} from "node:process";
import {gzip, gzipSync, constants} from "node:zlib";
import {promisify} from "node:util";
import type {Server} from "node:http";
import {satisfies} from "./utils/semver.ts";
import {npmTypes, forgeDirs, getOrSet} from "./utils/utils.ts";
import {updates} from "./api.ts";
import {parseCliArgs, resolveConfig} from "./cli.ts";
import {resolutionsBasePackage} from "./modes/npm.ts";
import type {UpdatesOptions} from "./api.ts";

const execFileAsync = promisify(execFile);

// Fail loudly if any in-process fetch escapes the loopback mock servers.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = input?.url ?? input; // string, URL, or Request — all accepted by new URL()
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`test attempted a non-mocked network request to ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const globalExpect = expect;
const gzipPromise = (data: string | Buffer) => promisify(gzip)(data, {level: constants.Z_BEST_SPEED});
const gzipNow = (data: string | Buffer) => gzipSync(data, {level: constants.Z_BEST_SPEED}); // for handlers, which must not await
const testFile = fileURLToPath(new URL("fixtures/npm-test/package.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/npm-empty/package.json", import.meta.url));
const jsrFile = fileURLToPath(new URL("fixtures/npm-jsr/package.json", import.meta.url));
const uvFile = fileURLToPath(new URL("fixtures/uv/pyproject.toml", import.meta.url));
const goFile = fileURLToPath(new URL("fixtures/go/go.mod", import.meta.url));
const goUpdateModFile = fileURLToPath(new URL("fixtures/go-update/go.mod", import.meta.url));
const goUpdateMainFile = fileURLToPath(new URL("fixtures/go-update/main.go", import.meta.url));
const goUpdateV2ModFile = fileURLToPath(new URL("fixtures/go-update-v2/go.mod", import.meta.url));
const goUpdateV2MainFile = fileURLToPath(new URL("fixtures/go-update-v2/main.go", import.meta.url));
const goReplaceFile = fileURLToPath(new URL("fixtures/go-replace/go.mod", import.meta.url));
const goPreFile = fileURLToPath(new URL("fixtures/go-prerelease/go.mod", import.meta.url));
const goPseudoFile = fileURLToPath(new URL("fixtures/go-pseudo/go.mod", import.meta.url));
const goPseudoUpdateFile = fileURLToPath(new URL("fixtures/go-pseudo-update/go.mod", import.meta.url));
const goWorkspaceDir = fileURLToPath(new URL("fixtures/go-workspace", import.meta.url));
const invalidConfigFile = fileURLToPath(new URL("fixtures/invalid-config/package.json", import.meta.url));
const actionsDir = fileURLToPath(new URL("fixtures/actions/.github/workflows", import.meta.url));
const dockerfileFixture = fileURLToPath(new URL("fixtures/docker/Dockerfile", import.meta.url));
const composeFixture = fileURLToPath(new URL("fixtures/docker/docker-compose.yaml", import.meta.url));
const dockerActionsDir = fileURLToPath(new URL("fixtures/docker-actions/.github/workflows", import.meta.url));
const dockerDir = fileURLToPath(new URL("fixtures/docker", import.meta.url));
const cargoFile = fileURLToPath(new URL("fixtures/cargo/Cargo.toml", import.meta.url));
const cargoWorkspaceDir = fileURLToPath(new URL("fixtures/cargo-workspace", import.meta.url));
const pnpmWorkspaceDir = fileURLToPath(new URL("fixtures/pnpm-workspace", import.meta.url));
const pnpmWorkspaceFile = fileURLToPath(new URL("fixtures/pnpm-workspace/pnpm-workspace.yaml", import.meta.url));

const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const sourceScript = fileURLToPath(new URL("index.ts", import.meta.url));
const script = fileURLToPath(new URL("dist/index.js", import.meta.url));

// An awaiting handler holds the request open, which the client sees as a response that never comes.
// The void return does not reject an async one on its own, so makeServer checks at run time.
type RouteHandler = (req: any, res: any) => void;

function isObject<T = Record<string, any>>(obj: any): obj is T {
  return Object.prototype.toString.call(obj) === "[object Object]";
}

function makeServer(defaultHandler: RouteHandler) {
  const routes = new Map<string, RouteHandler>();

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const handler = routes.get(url) || defaultHandler;

    (res as any).send = (data: Buffer) => {
      res.setHeader("Content-Encoding", "gzip");
      res.end(data);
    };

    try {
      if (handler(req, res) as unknown) throw new Error("route handler returned a promise; it must be synchronous");
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err)); // an Error makes end() throw, leaving the client to stall until its timeout
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

function defaultRoute(_: any, res: any) {
  res.statusCode = 404;
  res.end();
}

let npmServer: ReturnType<typeof makeServer>;
let githubServer: ReturnType<typeof makeServer>;
let pypiServer: ReturnType<typeof makeServer>;
let jsrServer: ReturnType<typeof makeServer>;
let goProxyServer: ReturnType<typeof makeServer>;
let dockerServer: ReturnType<typeof makeServer>;
let cargoServer: ReturnType<typeof makeServer>;

let githubUrl: string;
let pypiUrl: string;
let npmUrl: string;
let jsrUrl: string;
let goProxyUrl: string;
let dockerUrl: string;
let cargoUrl: string;
let localDependencyRequests = 0;

beforeAll(async () => {
  npmServer = makeServer(defaultRoute);
  githubServer = makeServer(defaultRoute);
  pypiServer = makeServer(defaultRoute);
  jsrServer = makeServer(defaultRoute);
  goProxyServer = makeServer(defaultRoute);
  dockerServer = makeServer(defaultRoute);
  cargoServer = makeServer(defaultRoute);

  const [commits, tags] = await Promise.all([
    readFile(fileURLToPath(new URL("fixtures/github/updates-commits.json", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("fixtures/github/updates-tags.json", import.meta.url)), "utf8"),
  ]);

  const npmFilesPromises: Array<Promise<{urlName: string, data: string}>> = [];
  for (const pkgName of testPackages) {
    const name = (testPkg.resolutions[pkgName] ? resolutionsBasePackage(pkgName) : pkgName);
    const urlName = name.replace(/\//g, "%2f");
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

  // The npm fixtures are pruned to what the client reads: dist-tags, version keys, time and
  // the per-version repository/homepage. Full packuments would be ~54MB parsed for nothing.
  const npmParsed = new Map<string, any>(npmFiles.map(({urlName, data}) => [urlName, JSON.parse(data)]));

  // registry.npmjs.org answers this `accept` with the abbreviated document, which carries no
  // `time` map, so serving one regardless would hide the full-packument fallback that fills them.
  const abbreviatedType = "application/vnd.npm.install-v1+json";
  for (const {urlName} of npmFiles) {
    const gzips = new Map<string, Buffer>();
    npmServer.get(`/${urlName}`, (req, res) => {
      const flavor = req.headers.accept?.includes(abbreviatedType) ? "abbrev" : "full";
      res.send(getOrSet(gzips, flavor, () => {
        const doc = {...npmParsed.get(urlName)};
        if (flavor === "abbrev") delete doc.time;
        return gzipNow(JSON.stringify(doc));
      }));
    });
  }
  for (const name of ["local-file", "local-link"]) {
    npmServer.get(`/${name}`, (_, res) => {
      localDependencyRequests++;
      res.statusCode = 500;
      res.end();
    });
  }

  const gzipAll = await Promise.all([
    ...pypiFiles.map(async ({pkgName, data}) => ({
      type: "pypi" as const,
      key: `/pypi/${pkgName.toLowerCase().replace(/[-_.]+/g, "-")}/json`,
      gz: await gzipPromise(data),
    })),
    ...jsrFiles.map(async ({scope, name, data}) => ({type: "jsr" as const, key: `/@${scope}/${name}/meta.json`, gz: await gzipPromise(data)})),
    (async () => ({type: "github" as const, key: "/repos/silverwind/updates/commits", gz: await gzipPromise(commits)}))(),
    (async () => ({type: "github" as const, key: "/repos/silverwind/updates/tags", gz: await gzipPromise(tags)}))(),
  ]);

  for (const {type, key, gz} of gzipAll) {
    const server = type === "pypi" ? pypiServer : type === "jsr" ? jsrServer : githubServer;
    server.get(key, (_, res) => res.send(gz));
  }

  for (const [urlName, data] of npmParsed) {
    const versions = data.versions || {};
    const time = data.time || {};
    for (const version of Object.keys(versions)) {
      let gz: Buffer | undefined;
      npmServer.get(`/${urlName}/${version}`, (_, res) => {
        if (!gz) {
          const vData = {...versions[version], _npmOperationalInternal: {tmp: `tmp/${urlName}_${version}_${Date.parse(time[version] || "2024-01-01") || 0}_0`}};
          gz = gzipNow(JSON.stringify(vData));
        }
        res.send(gz);
      });
    }
  }

  const notyVersionGz = await gzipPromise(JSON.stringify(npmParsed.get("noty").versions["3.1.4"]));
  npmServer.get("/noty/3.1.4", (_, res) => res.send(notyVersionGz));

  const goProxyRoutes: Array<{path: string, response: string}> = [
    {path: "/github.com/google/uuid/@latest", response: JSON.stringify({Version: "v1.6.0", Time: "2024-06-13T02:52:04Z"})},
    {path: "/github.com/google/go-github/v70/@latest", response: JSON.stringify({Version: "v70.0.0", Time: "2024-11-29T00:00:00Z"})},
    {path: "/github.com/example/testpkg/@latest", response: JSON.stringify({Version: "v1.0.0", Time: "2024-01-01T00:00:00Z"})},
    {path: "/github.com/example/testpkg/v2/@latest", response: JSON.stringify({Version: "v2.0.0", Time: "2025-01-01T00:00:00Z"})},
    {path: "/github.com/google/uuid/v2/@latest", response: JSON.stringify({Version: "v2.0.0-20260217135312-8c5a7de9ffa1", Time: "2026-02-17T13:53:12Z"})},
    {path: "/github.com/example/prerelpkg/@latest", response: JSON.stringify({Version: "v1.1.0-rc.1", Time: "2025-06-01T00:00:00Z"})},
    {path: "/gitea.com/gitea/act/@latest", response: JSON.stringify({Version: "v0.261.7", Time: "2025-06-01T00:00:00Z"})},
    {path: "/github.com/example/pseudopkg/@latest", response: JSON.stringify({Version: "v0.4.1", Time: "2023-06-01T00:00:00Z"})},
    {path: "/github.com/example/pseudoupd/@latest", response: JSON.stringify({Version: "v1.5.0", Time: "2025-06-01T00:00:00Z"})},
    {path: "/github.com/example/listonly/@v/list", response: "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n"},
    {path: "/github.com/example/listonly/@v/v1.2.0.info", response: JSON.stringify({Version: "v1.2.0", Time: "2025-03-01T00:00:00Z"})},
    {path: "/github.com/example/listtime/@v/list", response: "v1.0.0 2024-01-01T00:00:00Z\nv1.1.0 2024-06-01T00:00:00Z\n"},
    {path: "/github.com/example/makeallowed/@latest", response: JSON.stringify({Version: "v1.1.0", Time: "2025-01-01T00:00:00Z"})},
    {path: "/github.com/example/makeallowed/v2/@latest", response: JSON.stringify({Version: "v2.0.0", Time: "2025-06-01T00:00:00Z"})},
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

  const actionsRoutes: Array<[string, string]> = [
    ["/repos/actions/checkout/tags", "fixtures/github/actions-checkout-tags.json"],
    ["/repos/actions/setup-node/tags", "fixtures/github/actions-setup-node-tags.json"],
    ["/repos/actions/checkout/git/commits/cccc000000000000000000000000000000000011", "fixtures/github/actions-checkout-commit-v10.0.1.json"],
    ["/repos/actions/setup-node/git/commits/bbbb000000000000000000000000000000000010", "fixtures/github/actions-setup-node-commit-v10.json"],
  ];
  const emptyTagsGz = await gzipPromise("[]");
  githubServer.get("/repos/tj-actions/changed-files/tags", (_, res) => res.send(emptyTagsGz));
  githubServer.get("/repos/actions/checkout/branches/main", (_, res) =>
    res.send(gzipNow(JSON.stringify({commit: {sha: "aaaa000000000000000000000000000000000001"}}))));
  githubServer.get("/repos/actions/checkout/branches/release", (_, res) =>
    res.send(gzipNow(JSON.stringify({commit: {sha: "bbbb000000000000000000000000000000000002"}}))));
  for (const [route, fixture] of actionsRoutes) {
    const data = await readFile(fileURLToPath(new URL(fixture, import.meta.url)), "utf8");
    const gz = await gzipPromise(data);
    githubServer.get(route, (_, res) => res.send(gz));
  }

  const dockerFixtures: Array<[string, string]> = [
    ["/v2/repositories/library/node/tags", "fixtures/docker/node-tags.json"],
    ["/v2/repositories/library/noty/tags", "fixtures/docker/node-tags.json"], // an image sharing an npm dep's name
    ["/v2/repositories/library/postgres/tags", "fixtures/docker/postgres-tags.json"],
    ["/v2/repositories/library/redis/tags", "fixtures/docker/redis-tags.json"],
  ];
  for (const [route, fixture] of dockerFixtures) {
    const data = await readFile(fileURLToPath(new URL(fixture, import.meta.url)), "utf8");
    const gz = await gzipPromise(data);
    dockerServer.get(route, (_, res) => res.send(gz));
  }

  const makeImgTagsGz = await gzipPromise(JSON.stringify({count: 2, results: [
    {name: "v0.11.0", tag_last_pushed: "2025-01-01T00:00:00Z"},
    {name: "v0.12.0", tag_last_pushed: "2025-06-01T00:00:00Z"},
  ]}));
  const makeAllowedImgTagsGz = await gzipPromise(JSON.stringify({count: 3, results: [
    {name: "1.0", tag_last_pushed: "2025-01-01T00:00:00Z"},
    {name: "1.1", tag_last_pushed: "2025-03-01T00:00:00Z"},
    {name: "2.0", tag_last_pushed: "2025-06-01T00:00:00Z"},
  ]}));
  const makeOldImgGz = await gzipPromise(JSON.stringify({digest: "sha256:list-old"}));
  const makeNewImgGz = await gzipPromise(JSON.stringify({digest: "sha256:list-new"}));
  dockerServer.get("/v2/repositories/koalaman/shellcheck/tags", (_, res) => res.send(makeImgTagsGz));
  dockerServer.get("/v2/repositories/example/makeallowed/tags", (_, res) => res.send(makeAllowedImgTagsGz));
  dockerServer.get("/v2/repositories/koalaman/shellcheck/tags/v0.11.0", (_, res) => res.send(makeOldImgGz));
  dockerServer.get("/v2/repositories/koalaman/shellcheck/tags/v0.12.0", (_, res) => res.send(makeNewImgGz));

  const serdeIndex = await readFile(fileURLToPath(new URL("fixtures/cargo/serde-index.ndjson", import.meta.url)), "utf8");
  const serdeIndexGz = await gzipPromise(serdeIndex);
  cargoServer.get("/se/rd/serde", (_, res) => res.send(serdeIndexGz));
  const makeCargoVersions = (name: string, versions: ReadonlyArray<string>) =>
    versions.map(vers => JSON.stringify({name, vers, yanked: false, pubtime: "2025-01-15T12:00:00Z"})).join("\n");
  for (const [name, path, versions] of [
    ["tokio", "/to/ki/tokio", ["1.35.0"]],
    ["rand", "/ra/nd/rand", ["0.9.0"]],
    ["serde_json", "/se/rd/serde_json", ["1.0.120"]],
  ] as const) {
    const gz = await gzipPromise(makeCargoVersions(name, versions));
    cargoServer.get(path, (_, res) => res.send(gz));
  }

  await Promise.all([
    githubServer.start(0),
    pypiServer.start(0),
    npmServer.start(0),
    jsrServer.start(0),
    goProxyServer.start(0),
    dockerServer.start(0),
    cargoServer.start(0),
  ]);

  githubUrl = makeUrl(githubServer);
  npmUrl = makeUrl(npmServer);
  pypiUrl = makeUrl(pypiServer);
  jsrUrl = makeUrl(jsrServer);
  goProxyUrl = makeUrl(goProxyServer);
  dockerUrl = makeUrl(dockerServer);
  cargoUrl = makeUrl(cargoServer);

  await writeFile(join(testDir, ".npmrc"), `registry=${npmUrl}\nsave-exact=false`); // Fake registry
  await writeFile(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2)); // Copy fixture
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([
    rm(testDir, {recursive: true}),
    npmServer?.close(),
    githubServer?.close(),
    pypiServer?.close(),
    jsrServer?.close(),
    goProxyServer?.close(),
    dockerServer?.close(),
    cargoServer?.close(),
  ]);
});

async function runCliExec(argvWithScript: Array<string>): Promise<{stdout: string, stderr: string}> {
  const {args, positionals} = parseCliArgs(argvWithScript.slice(1));
  const config = await resolveConfig(args, positionals);
  config.noCache = true;
  const output = await updates(config);
  const stdout = JSON.stringify({
    ...(output.message ? {message: output.message} : {results: output.results}),
    ...(output.errors?.length && {errors: output.errors}),
  });
  return {stdout, stderr: ""};
}

async function makeTest(args: string) {
  const argv = args.split(/\s+/).filter(Boolean);
  const hasFile = argv.includes("-f") || argv.includes("--file");
  const {stdout} = await runCliExec([
    script, ...argv, "-c",
    ...apiArgs(),
    ...(hasFile ? [] : ["-f", join(testDir, "package.json")]),
  ]);
  const {results} = JSON.parse(stdout);
  for (const mode of Object.keys(results || {})) {
    for (const type of Object.keys(results[mode] || {})) {
      for (const name of Object.keys(results[mode][type] || {})) {
        delete results[mode][type][name].age;
      }
    }
  }
  return results;
}

const dep = (info: string, newVersion: string, old: string) => ({info, new: newVersion, old});

function dependencyRows(results: Awaited<ReturnType<typeof updates>>["results"]) {
  const rows = Object.entries(results).flatMap(([mode, types]) => Object.entries(types).flatMap(([type, dependencies]) =>
    Object.entries(dependencies).map(([name, dependency]) => [mode, type, name, dependency] as const)));
  return rows.sort((left, right) => {
    const leftKey = `${left[0]}\0${left[1]}\0${left[2]}`;
    const rightKey = `${right[0]}\0${right[1]}\0${right[2]}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function apiArgs(): string[] {
  return [
    "--no-cache",
    "--registry", npmUrl,
    "--forgeapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--jsrapi", jsrUrl,
    "--goproxy", goProxyUrl,
    "--cargoapi", cargoUrl,
    "--dockerapi", dockerUrl,
  ];
}

test("text output lists every dep, one row per version across sections", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await execFileAsync(execPath, [
    script, "-n", ...apiArgs(), "-f", testFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
  expect(stdout.split("\n").filter(line => line.includes("@babel/preset-env"))).toHaveLength(3);
  expect(stdout).toContain("~6.0.0 || ~7.11.5");
});

test("version info fallback", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec([
    script, "-j", "-n", ...apiArgs(), "-f", testFile, "-i", "noty",
  ]);
  expect(stderr).toEqual("");
  const {results} = JSON.parse(stdout);
  const noty = results.npm.dependencies.noty;
  expect(noty.new).toBe("3.1.4");
  expect(noty.age).toBeTruthy();
});

test("version resolves the source and built package layouts", async ({expect = globalExpect}: any = {}) => {
  const parentDir = join(testDir, "version-layouts");
  const sourceDir = join(parentDir, "updates");
  const distDir = join(sourceDir, "dist");
  mkdirSync(distDir, {recursive: true});
  const source = await readFile(sourceScript, "utf8");
  await Promise.all([
    writeFile(join(parentDir, "package.json"), JSON.stringify({version: "wrong"})),
    writeFile(join(sourceDir, "package.json"), JSON.stringify({version: "1.2.3", type: "module"})),
    writeFile(join(sourceDir, "index.ts"), source),
    writeFile(join(distDir, "index.ts"), source),
  ]);

  for (const entry of [join(sourceDir, "index.ts"), join(distDir, "index.ts")]) {
    const {stdout, stderr} = await execFileAsync(execPath, [entry, "--version"]);
    expect(stderr).toEqual("");
    expect(stdout).toBe("1.2.3\n");
  }
});

test("empty", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await execFileAsync(execPath, [
    script, "-n", ...apiArgs(), "-f", emptyFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
});

test("jsr", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec([
    script, "-n", "-j", ...apiArgs(), "-f", jsrFile,
  ]);
  expect(stderr).toEqual("");
  const {results} = JSON.parse(stdout);
  expect(results.npm.dependencies["@std/semver"].old).toBe("1.0.5");
  expect(results.npm.dependencies["@std/semver"].new).toBe("1.0.8");
  expect(results.npm.devDependencies["@std/path"].old).toBe("1.0.0");
  expect(results.npm.devDependencies["@std/path"].new).toBe("1.0.8");
});

test("npm alias resolves the aliased package, and a second run is a no-op", async ({expect = globalExpect}: any = {}) => {
  const aliasDir = join(testDir, "test-npm-alias");
  mkdirSync(aliasDir, {recursive: true});
  const pkgPath = join(aliasDir, "package.json");
  await writeFile(pkgPath, JSON.stringify({dependencies: {
    "package-matched": "npm:gulp-sourcemaps@^2.0.0",
    "dep-matched": "npm:gulp-sourcemaps@^2.0.0",
    "tagged": "npm:gulp-sourcemaps@latest",
  }}, null, 2));
  await writeFile(join(aliasDir, "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["gulp-sourcemaps"], allowedVersions: "<=2.5.2"},
    {matchDepNames: ["dep-matched"], allowedVersions: "<=2.4.1"},
  ]}));

  const run = () => updates({files: [pkgPath], registry: npmUrl, update: true, color: false, noCache: true});
  const {results} = await run();
  expect(results.npm.dependencies["package-matched"]).toMatchObject({
    old: "npm:gulp-sourcemaps@^2.0.0", new: "npm:gulp-sourcemaps@^2.5.2",
  });
  expect(results.npm.dependencies["dep-matched"]).toMatchObject({
    old: "npm:gulp-sourcemaps@^2.0.0", new: "npm:gulp-sourcemaps@^2.4.1",
  });
  expect(results.npm.dependencies["tagged"]).toBeUndefined();
  const written = await readFile(pkgPath, "utf8");
  expect(JSON.parse(written).dependencies).toMatchObject({
    "package-matched": "npm:gulp-sourcemaps@^2.5.2",
    "dep-matched": "npm:gulp-sourcemaps@^2.4.1",
  });
  await run();
  expect(await readFile(pkgPath, "utf8")).toBe(written);
});

test("piped output stays colored with -c, on stdout and on -V stderr, and parseable with -u -j", async ({expect = globalExpect}: any = {}) => {
  const flagDir = join(testDir, "test-stdout-flags");
  mkdirSync(flagDir, {recursive: true});
  const pkgPath = join(flagDir, "package.json");
  await writeFile(pkgPath, JSON.stringify({dependencies: {prismjs: "1.0.0"}}));
  const env = {...process.env, FORCE_COLOR: "0"};

  const {stdout: colored, stderr: verbose} = await execFileAsync(execPath, [script, "-c", "-V", ...apiArgs(), "-f", pkgPath], {env});
  expect(colored).toContain("\u001b[");
  expect(verbose).toContain("\u001b[");

  const {stdout: json} = await execFileAsync(execPath, [script, "-u", "-j", ...apiArgs(), "-f", pkgPath], {env});
  expect(JSON.parse(json).results.npm.dependencies.prismjs.new).toBe("1.17.1");
});

if (!versions.bun) {
  test("global", async ({expect = globalExpect}: any = {}) => {
    const prefix = mkdtempSync(join(tmpdir(), "updates-global-"));
    try {
      let bin: string;
      if (platform === "win32") {
        bin = join(prefix, "updates.cmd");
        writeFileSync(bin, `@node "${script}" %*\r\n`);
      } else {
        bin = join(prefix, "bin", "updates");
        mkdirSync(join(prefix, "bin"));
        symlinkSync(script, bin);
      }
      const {stdout, stderr} = await execFileAsync(bin, [
        "-n", ...apiArgs(), "-f", testFile,
      ], {shell: platform === "win32"});
      expect(stderr).toEqual("");
      expect(stdout).toContain("prismjs");
      expect(stdout).toContain("https://github.com/silverwind/updates");
    } finally {
      await rm(prefix, {recursive: true});
    }
  });
}


const latestRows: Array<[string, string, string, ReturnType<typeof dep>]> = [
  ["npm", "dependencies", "@babel/preset-env", dep("https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env", "7.11.5", "7.0.0")],
  ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "10.0.0-beta.6", "10.0.0-beta.5")],
  ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/gulp-sourcemaps/gulp-sourcemaps", "2.6.5", "2.0.0")],
  ["npm", "dependencies", "html-webpack-plugin", dep("https://github.com/jantimon/html-webpack-plugin", "4.0.0-beta.11", "4.0.0-alpha.2")],
  ["npm", "dependencies", "jpeg-buffer-orientation", dep("https://github.com/fisker/jpeg-buffer-orientation", "2.0.3", "0.0.0")],
  ["npm", "dependencies", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
  ["npm", "dependencies", "prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
  ["npm", "dependencies", "react", dep("https://github.com/facebook/react/tree/HEAD/packages/react", "18.2", "18.0")],
  ["npm", "dependencies", "styled-components", dep("https://github.com/styled-components/styled-components", "4.4.1", "2.5.0-1")],
  ["npm", "dependencies", "updates", dep("https://github.com/silverwind/updates", "537ccb7", "6941e05")],
  ["npm", "overrides", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
  ["npm", "overrides", "prismjs:overrides.@babel/preset-env.prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
  ["npm", "overrides", "prismjs:overrides.prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
  ["npm", "packageManager", "npm", dep("https://github.com/npm/cli", "11.6.2", "11.6.0")],
  ["npm", "peerDependencies", "@babel/preset-env", dep("https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env", "~6.0.0 || ~7.11.5", "~6.0.0")],
  ["npm", "peerDependencies", "typescript", dep("https://github.com/Microsoft/TypeScript", "^4 || ^5", "^4")],
  ["npm", "resolutions", "versions/updates", dep("https://github.com/silverwind/updates", "^10.0.0", "^1.0.0")],
];

test("latest", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j"))).toEqual(latestRows);
});

test("prerelease", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -g -p"))).toEqual([
    ["npm", "dependencies", "@babel/preset-env", dep("https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env", "7.11.5", "7.0.0")],
    ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "10.0.0-beta.6", "10.0.0-beta.5")],
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/gulp-sourcemaps/gulp-sourcemaps", "2.6.5", "2.0.0")],
    ["npm", "dependencies", "html-webpack-plugin", dep("https://github.com/jantimon/html-webpack-plugin", "4.0.0-beta.11", "4.0.0-alpha.2")],
    ["npm", "dependencies", "jpeg-buffer-orientation", dep("https://github.com/fisker/jpeg-buffer-orientation", "2.0.3", "0.0.0")],
    ["npm", "dependencies", "noty", dep("https://github.com/needim/noty", "3.2.0-beta", "3.1.0")],
    ["npm", "dependencies", "prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
    ["npm", "dependencies", "react", dep("https://github.com/facebook/react/tree/HEAD/packages/react", "18.3.0-next-fecc288b7-20221025", "18.0")],
    ["npm", "dependencies", "styled-components", dep("https://github.com/styled-components/styled-components", "5.0.0-regexrehydrate", "2.5.0-1")],
    ["npm", "dependencies", "updates", dep("https://github.com/silverwind/updates", "537ccb7", "6941e05")],
    ["npm", "overrides", "noty", dep("https://github.com/needim/noty", "3.2.0-beta", "3.1.0")],
    ["npm", "overrides", "prismjs:overrides.@babel/preset-env.prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
    ["npm", "overrides", "prismjs:overrides.prismjs", dep("https://github.com/LeaVerou/prism", "1.17.1", "1.0.0")],
    ["npm", "packageManager", "npm", dep("https://github.com/npm/cli", "11.6.2", "11.6.0")],
    ["npm", "peerDependencies", "@babel/preset-env", dep("https://github.com/babel/babel/tree/HEAD/packages/babel-preset-env", "~6.0.0 || ~7.11.5", "~6.0.0")],
    ["npm", "peerDependencies", "noty", dep("https://github.com/needim/noty", ">= 3.1 || >= 3.2.0-beta", ">= 3.1")],
    ["npm", "peerDependencies", "svgstore", dep("https://github.com/svgstore/svgstore", "^1.0.0 || ^2.0.0 || ^3.0.0-2", "^1.0.0 || ^2.0.0")],
    ["npm", "peerDependencies", "typescript", dep("https://github.com/Microsoft/TypeScript", "^4 || ^5.5.0-dev.20240601", "^4")],
    ["npm", "resolutions", "versions/updates", dep("https://github.com/silverwind/updates", "^10.0.0", "^1.0.0")],
  ]);
});

test("release", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -R"))).toEqual(latestRows.filter(row =>
    !["eslint-plugin-storybook", "html-webpack-plugin"].includes(row[2])));
});

test("release with allow-downgrade", async ({expect = globalExpect}: any = {}) => {
  const results = await makeTest("-j -R -d");
  expect(results.npm.dependencies["eslint-plugin-storybook"]).toEqual({
    info: "https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin",
    new: "9.1.7",
    old: "10.0.0-beta.5",
  });
});

test("patch", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -P"))).toEqual([
    ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "10.0.0-beta.6", "10.0.0-beta.5")],
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/floridoo/gulp-sourcemaps", "2.0.1", "2.0.0")],
    ["npm", "dependencies", "html-webpack-plugin", dep("https://github.com/jantimon/html-webpack-plugin", "4.0.0-beta.11", "4.0.0-alpha.2")],
    ["npm", "dependencies", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
    ["npm", "dependencies", "updates", dep("https://github.com/silverwind/updates", "537ccb7", "6941e05")],
    ["npm", "overrides", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
    ["npm", "packageManager", "npm", dep("https://github.com/npm/cli", "11.6.2", "11.6.0")],
    ["npm", "resolutions", "versions/updates", dep("https://github.com/silverwind/updates", "^1.0.6", "^1.0.0")],
  ]);
});

const notyDep = {info: "https://github.com/needim/noty", new: "3.1.4", old: "3.1.0"};
const notyResult = {npm: {dependencies: {noty: notyDep}, overrides: {noty: notyDep}}};

test.each([
  ["include", "-j -i noty"],
  ["include 2", "-j -i /^noty/"],
])("%s", async (_name, args, {expect = globalExpect}: any = {}) => {
  expect(await makeTest(args)).toEqual(notyResult);
});

// Out of process, unlike its siblings: the in-process registry cache is keyed by URL alone, so
// the abbreviated document a run without --cooldown caches would answer this one too.
test("cooldown duration", async ({expect = globalExpect}: any = {}) => {
  const {stdout} = await execFileAsync(execPath, [
    script, "-j", "-i", "noty", "-C", "12h", ...apiArgs(), "-f", testFile,
  ]);
  const {results} = JSON.parse(stdout);
  delete results.npm.dependencies.noty.age;
  delete results.npm.overrides.noty.age;
  expect(results).toEqual(notyResult);
});

test("packageManager", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -i npm"))).toEqual([
    ["npm", "packageManager", "npm", dep("https://github.com/npm/cli", "11.6.2", "11.6.0")],
  ]);
});

test("overrides type", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest("-j -t overrides")).toEqual({npm: {overrides: {
    noty: notyDep,
    "prismjs:overrides.@babel/preset-env.prismjs": {
      info: "https://github.com/LeaVerou/prism", new: "1.17.1", old: "1.0.0",
    },
    "prismjs:overrides.prismjs": {
      info: "https://github.com/LeaVerou/prism", new: "1.17.1", old: "1.0.0",
    },
  }}});
});

test("exclude", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -e gulp-sourcemaps -i /react/"))).toEqual([
    ["npm", "dependencies", "react", dep("https://github.com/facebook/react/tree/HEAD/packages/react", "18.2", "18.0")],
  ]);
});

test("exclude 2", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -i gulp*"))).toEqual([
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/gulp-sourcemaps/gulp-sourcemaps", "2.6.5", "2.0.0")],
  ]);
});

test("exclude 3", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -i /^gulp/ -P gulp*"))).toEqual([
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/floridoo/gulp-sourcemaps", "2.0.1", "2.0.0")],
  ]);
});

test("uv", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest(`-j -f ${uvFile}`))).toEqual([
    ["pypi", "dependency-groups.dev", "PyYAML", dep("https://github.com/yaml/pyyaml", "6.0", "1.0")],
    ["pypi", "dependency-groups.dev", "types-requests", dep("https://github.com/python/typeshed", "2.32.4.20250611", "2.32.0.20240622")],
    ["pypi", "project.dependencies", "djlint", dep("https://github.com/Riverside-Healthcare/djlint", "1.31.0", "1.30.0")],
    ["pypi", "project.dependencies", "ty", dep("https://github.com/astral-sh/ty", "0.0.1a19", "0.0.1a15")],
  ]);
});

test("invalid config", async ({expect = globalExpect}: any = {}) => {
  const args = ["-j", "-f", invalidConfigFile, "-c", ...apiArgs()];
  try {
    await execFileAsync(execPath, [script, ...args]);
    throw new Error("Expected error but got success");
  } catch (err: any) {
    expect(err?.code).toBe(1);
    const output = err?.stdout || "";
    expect(output).toContain("updates.config.js");
    expect(output).toContain("Unable to parse");
  }
});

test("prerelease selection", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest("-j -i noty -p"))).toEqual([
    ["npm", "dependencies", "noty", dep("https://github.com/needim/noty", "3.2.0-beta", "3.1.0")],
    ["npm", "overrides", "noty", dep("https://github.com/needim/noty", "3.2.0-beta", "3.1.0")],
    ["npm", "peerDependencies", "noty", dep("https://github.com/needim/noty", ">= 3.1 || >= 3.2.0-beta", ">= 3.1")],
  ]);
  expect(dependencyRows(await makeTest("-j -i eslint-plugin-storybook"))).toEqual([
    ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "10.0.0-beta.6", "10.0.0-beta.5")],
  ]);
});

test("go", async ({expect = globalExpect}: any = {}) => {
  const directRows = [
    ["go", "deps", "github.com/example/listonly", dep("https://github.com/example/listonly", "1.2.0", "1.0.0")],
    ["go", "deps", "github.com/example/listtime", dep("https://github.com/example/listtime", "1.1.0", "1.0.0")],
    ["go", "deps", "github.com/google/go-github/v70", dep("https://github.com/google/go-github", "82.0.0", "70.0.0")],
    ["go", "deps", "github.com/google/uuid", dep("https://github.com/google/uuid", "2.0.0-2026021", "1.5.0")],
  ];
  expect(dependencyRows(await makeTest(`-j -f ${goFile}`))).toEqual(directRows);
  expect(dependencyRows(await makeTest(`-j -f ${goFile} -I`))).toEqual([
    ...directRows,
    ["go", "indirect", "github.com/example/testpkg", dep("https://github.com/example/testpkg", "2.0.0", "0.9.0")],
  ]);
});

test("go @v/list fallback takes a date off the list line when .info is absent", async ({expect = globalExpect}: any = {}) => {
  const {stdout} = await runCliExec([script, "-j", "-f", goFile, "-c", "--goproxy", goProxyUrl]);
  const {deps} = JSON.parse(stdout).results.go;
  expect(deps["github.com/example/listtime"].age).toBeTruthy();
});

test("fractional timeout does not throw a non-integer AbortSignal delay", async ({expect = globalExpect}: any = {}) => {
  const {results} = await updates({files: [goFile], goproxy: goProxyUrl, timeout: 9999.4, color: false, noCache: true});
  expect(results?.go?.deps).toBeTruthy();
});

test("a negative timeout is rejected, on the cli and through the api", async ({expect = globalExpect}: any = {}) => {
  await expect(runCliExec([script, "-T", "-5", ...apiArgs(), "-f", testFile])).rejects.toThrow(/timeout/i);
  await expect(updates({files: [goFile], goproxy: goProxyUrl, timeout: -1, color: false, noCache: true}))
    .rejects.toThrow(/invalid timeout/i);
});

test("color flags reach the config", async ({expect = globalExpect}: any = {}) => {
  for (const [argv, expected] of [
    [["-n"], {color: false, noColor: true}],
    [["-c"], {color: true, noColor: false}],
    [["-c", "-n"], {color: false, noColor: true}],
  ] as const) {
    const {args, positionals} = parseCliArgs([...argv]);
    const config = await resolveConfig(args, positionals);
    expect({color: config.color, noColor: config.noColor}).toEqual(expected);
  }
});

test("cargo", async ({expect = globalExpect}: any = {}) => {
  expect(dependencyRows(await makeTest(`-j -f ${cargoFile}`))).toEqual([
    ["cargo", "dependencies", "tokio", dep("https://crates.io/crates/tokio", "1.35", "1.0")],
    ["cargo", "dev-dependencies", "rand", dep("https://crates.io/crates/rand", "0.9", "0.8")],
    ["cargo", "target.cfg(unix).dependencies", "rand", dep("https://crates.io/crates/rand", "0.9", "0.8")],
  ]);
});

test("go update", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-update");
  mkdirSync(testGoModDir, {recursive: true});

  const goUpdateContent = readFileSync(goUpdateModFile, "utf8");
  await writeFile(join(testGoModDir, "go.mod"), goUpdateContent);
  const goMainContent = readFileSync(goUpdateMainFile, "utf8");
  await writeFile(join(testGoModDir, "main.go"), goMainContent);

  await runCliExec([
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
    "--goproxy", goProxyUrl,
  ]);

  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");

  expect(updatedContent).toContain("github.com/google/uuid/v2 v2.0.0-20260217135312-8c5a7de9ffa1");
  expect(updatedContent).not.toContain("uuid v1.5.0");
  expect(updatedContent).not.toContain("go-github/v70");
  expect(updatedContent).toMatch(/github\.com\/google\/go-github\/v\d+ v\d+\.\d+\.\d+/);

  const matches = updatedContent.match(/github\.com\/google\/uuid\/v2 v2\.0\.0-20260217135312-8c5a7de9ffa1/g);
  expect(matches).toBeTruthy();
  expect(matches?.length).toBe(4);

  const updatedMain = await readFile(join(testGoModDir, "main.go"), "utf8");
  expect(updatedMain).not.toContain("go-github/v70");
  expect(updatedMain).toMatch(/go-github\/v\d+\/github/);
});

test("go update v1 to v2", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-update-v2");
  mkdirSync(testGoModDir, {recursive: true});

  await writeFile(join(testGoModDir, "go.mod"), readFileSync(goUpdateV2ModFile, "utf8"));
  await writeFile(join(testGoModDir, "main.go"), readFileSync(goUpdateV2MainFile, "utf8"));

  await runCliExec([
    script,
    "-u",
    "-f", join(testGoModDir, "go.mod"),
    "-c",
    "--goproxy", goProxyUrl,
  ]);

  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");
  expect(updatedContent).toContain("github.com/example/testpkg/v2 v2.0.0");
  expect(updatedContent).not.toContain("testpkg v1.0.0");

  const updatedMain = await readFile(join(testGoModDir, "main.go"), "utf8");
  expect(updatedMain).toContain(`"github.com/example/testpkg/v2"`);
  expect(updatedMain).toContain(`"github.com/example/testpkg/v2/sub"`);
  expect(updatedMain).not.toMatch(/"github\.com\/example\/testpkg"(?!\/v2)/);
});

test("go prerelease is excluded by default and enabled globally or per package", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest(`-j -f ${goPreFile}`)).toBeUndefined();
  const expected = [["go", "deps", "github.com/example/prerelpkg",
    dep("https://github.com/example/prerelpkg", "1.1.0-rc.1", "1.0.0")]];
  for (const flag of ["-p", "-p github.com/example/prerelpkg"]) {
    expect(dependencyRows(await makeTest(`-j -f ${goPreFile} ${flag}`))).toEqual(expected);
  }
});

test("go pseudo-version no downgrade", async ({expect = globalExpect}: any = {}) => {
  expect(await makeTest(`-j -f ${goPseudoFile}`)).toBeUndefined();
});

test("go pseudo-version update rewrites the full version", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-pseudo-update");
  mkdirSync(testGoModDir, {recursive: true});
  const modPath = join(testGoModDir, "go.mod");
  await writeFile(modPath, readFileSync(goPseudoUpdateFile, "utf8"));

  await updates({
    files: [modPath],
    goproxy: goProxyUrl,
    update: true,
    indirect: true,
    color: false,
    noCache: true,
  });

  const updated = await readFile(modPath, "utf8");
  expect(updated).toContain("github.com/example/pseudoupd v1.5.0");
  expect(updated).not.toContain("20221128193559");
  expect(updated).not.toContain("754e69321358");
});

test("make mode bumps go install versions and rewrites paths on major bumps", async ({expect = globalExpect}: any = {}) => {
  const makeDir = join(testDir, "test-make");
  mkdirSync(makeDir, {recursive: true});
  const makePath = join(makeDir, "Makefile");
  await writeFile(makePath, [
    "UUID_PACKAGE ?= github.com/google/uuid@v1.4.0",
    "TESTPKG_PACKAGE := github.com/example/testpkg@v1.0.0  # pinned tool",
    "# DISABLED := github.com/example/testpkg@v0.5.0",
    "SOURCE := $(wildcard *.go)",
    "",
  ].join("\n"));

  await updates({files: [makePath], goproxy: goProxyUrl, update: true, color: false, noCache: true});

  const updated = await readFile(makePath, "utf8");
  expect(updated).toContain("UUID_PACKAGE ?= github.com/google/uuid/v2@v2.0.0-20260217135312-8c5a7de9ffa1");
  expect(updated).toContain("TESTPKG_PACKAGE := github.com/example/testpkg/v2@v2.0.0  # pinned tool");
  expect(updated).toContain("# DISABLED := github.com/example/testpkg@v0.5.0");
  expect(updated).toContain("SOURCE := $(wildcard *.go)");
});

test("auto-discovery finds a Makefile once on a case-insensitive filesystem", async ({expect = globalExpect}: any = {}) => {
  const makeDir = join(testDir, "test-make-discovery");
  mkdirSync(makeDir, {recursive: true});
  await writeFile(join(makeDir, "Makefile"), "UUID_PACKAGE ?= github.com/google/uuid@v1.4.0\n");

  // Discovery reads the cwd, so this runs out of process: a chdir here would be seen by every
  // concurrent sibling, which resolves paths and config against the cwd too.
  const {stdout} = await execFileAsync(execPath, [script, "-j", "-x", "-M", "make", ...apiArgs()], {cwd: makeDir});
  expect(Object.keys(JSON.parse(stdout).results.make)).toEqual(["Makefile"]);
});

test("make mode bumps docker image tags and re-resolves digests in Makefiles", async ({expect = globalExpect}: any = {}) => {
  const makeDir = join(testDir, "test-make-docker");
  mkdirSync(makeDir, {recursive: true});
  const makePath = join(makeDir, "Makefile");
  const oldDigest = `sha256:${"a".repeat(64)}`;
  await writeFile(makePath, [
    `SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@${oldDigest}  # renovate: datasource=docker`,
    "PLAIN := koalaman/shellcheck:v0.11.0",
    "TEST_MYSQL_HOST ?= mysql:3306",
    "",
  ].join("\n"));

  await updates({files: [makePath], dockerapi: dockerUrl, update: true, color: false, noCache: true});

  const updated = await readFile(makePath, "utf8");
  expect(updated).toContain("SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.12.0@sha256:list-new  # renovate: datasource=docker");
  expect(updated).toContain("PLAIN := koalaman/shellcheck:v0.12.0");
  expect(updated).toContain("TEST_MYSQL_HOST ?= mysql:3306");
});

test("make allowedVersions falls back to the highest allowed candidate", async ({expect = globalExpect}: any = {}) => {
  const dir = join(testDir, "test-make-allowed");
  mkdirSync(dir, {recursive: true});
  const file = join(dir, "Makefile");
  await writeFile(file, [
    "TOOL := github.com/example/makeallowed/cmd/tool@v1.0.0",
    "IMAGE := example/makeallowed:1.0",
    "",
  ].join("\n"));
  await writeFile(join(dir, "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["github.com/example/makeallowed/cmd/tool"], allowedVersions: "<2"},
    {matchPackageNames: ["example/makeallowed"], allowedVersions: "<2"},
  ]}));

  await updates({
    files: [file], modes: ["make"], goproxy: goProxyUrl, dockerapi: dockerUrl,
    update: true, color: false, noCache: true,
  });

  expect(await readFile(file, "utf8")).toBe([
    "TOOL := github.com/example/makeallowed/cmd/tool@v1.1.0",
    "IMAGE := example/makeallowed:1.1",
    "",
  ].join("\n"));
});

test("docker image names match with and without the docker.io prefix", async ({expect = globalExpect}: any = {}) => {
  const makeDir = join(testDir, "test-docker-io-prefix");
  mkdirSync(makeDir, {recursive: true});
  const makePath = join(makeDir, "Makefile");
  await writeFile(makePath, [
    "PREFIXED := docker.io/koalaman/shellcheck:v0.11.0",
    "PLAIN := koalaman/shellcheck:v0.11.0",
    "",
  ].join("\n"));

  await updates({files: [makePath], dockerapi: dockerUrl, update: true, color: false, noCache: true, pin: {"koalaman/shellcheck": "0.11.x"}});
  expect(await readFile(makePath, "utf8")).toBe([
    "PREFIXED := docker.io/koalaman/shellcheck:v0.11.0",
    "PLAIN := koalaman/shellcheck:v0.11.0",
    "",
  ].join("\n"));

  await updates({files: [makePath], dockerapi: dockerUrl, update: true, color: false, noCache: true, exclude: ["docker.io/koalaman/shellcheck"]});
  expect(await readFile(makePath, "utf8")).toBe([
    "PREFIXED := docker.io/koalaman/shellcheck:v0.11.0",
    "PLAIN := koalaman/shellcheck:v0.11.0",
    "",
  ].join("\n"));

  const clashDir = join(testDir, "test-docker-npm-name-clash");
  mkdirSync(clashDir, {recursive: true});
  await writeFile(join(clashDir, "package.json"), JSON.stringify({dependencies: {noty: "3.1.0"}}));
  await writeFile(join(clashDir, "Dockerfile"), "FROM noty:18\n");
  const clash = await updates({
    files: [clashDir], registry: npmUrl, forgeapi: githubUrl, dockerapi: dockerUrl,
    color: false, noCache: true, patch: ["docker.io/library/noty"],
  });
  expect(clash.results.npm.dependencies.noty.new).toBe("3.1.4");
  expect(clash.results.docker).toBeUndefined(); // 18 to 22 is no patch
});

test("go replace reports and writes the update", async ({expect = globalExpect}: any = {}) => {
  const testGoModDir = join(testDir, "test-go-replace");
  mkdirSync(testGoModDir, {recursive: true});
  await writeFile(join(testGoModDir, "go.mod"), readFileSync(goReplaceFile, "utf8"));
  const {stdout} = await runCliExec([
    script, "-j", "-u", "-f", join(testGoModDir, "go.mod"), "-c", "--goproxy", goProxyUrl,
  ]);
  expect(dependencyRows(JSON.parse(stdout).results)).toMatchObject([
    ["go", "replace", "gitea.com/gitea/act", dep("https://gitea.com/gitea/act", "0.261.7", "0.261.4")],
  ]);
  const updatedContent = await readFile(join(testGoModDir, "go.mod"), "utf8");
  expect(updatedContent).toContain("gitea.com/gitea/act v0.261.7");
  expect(updatedContent).not.toContain("gitea.com/gitea/act v0.261.4");
  expect(updatedContent).toContain("replace");
});

test("go workspace reports and writes member updates", async ({expect = globalExpect}: any = {}) => {
  const testGoWorkDir = join(testDir, "test-go-workspace");
  mkdirSync(join(testGoWorkDir, "app"), {recursive: true});
  mkdirSync(join(testGoWorkDir, "lib"), {recursive: true});

  writeFileSync(join(testGoWorkDir, "go.work"), readFileSync(join(goWorkspaceDir, "go.work"), "utf8"));
  writeFileSync(join(testGoWorkDir, "app", "go.mod"), readFileSync(join(goWorkspaceDir, "app", "go.mod"), "utf8"));
  writeFileSync(join(testGoWorkDir, "app", "main.go"), readFileSync(join(goWorkspaceDir, "app", "main.go"), "utf8"));
  writeFileSync(join(testGoWorkDir, "lib", "go.mod"), readFileSync(join(goWorkspaceDir, "lib", "go.mod"), "utf8"));

  const {go} = (await updates({
    files: [join(testGoWorkDir, "go.work")], goproxy: goProxyUrl, update: true, color: false, noCache: true,
  })).results;
  expect(go["deps|./app"]["github.com/google/uuid"].old).toBe("1.5.0");
  expect(go["deps|./lib"]["github.com/google/uuid"].old).toBe("1.5.0");

  const appMod = await readFile(join(testGoWorkDir, "app", "go.mod"), "utf8");
  const libMod = await readFile(join(testGoWorkDir, "lib", "go.mod"), "utf8");
  expect(appMod).toContain("github.com/google/uuid/v2 v2.0.0-20260217135312-8c5a7de9ffa1");
  expect(appMod).not.toContain("uuid v1.5.0");
  expect(libMod).toContain("github.com/google/uuid/v2 v2.0.0-20260217135312-8c5a7de9ffa1");
  expect(libMod).not.toContain("uuid v1.5.0");
  expect(await readFile(join(testGoWorkDir, "app", "main.go"), "utf8")).toContain('"github.com/google/uuid/v2"');
});

test("cargo workspace reports and writes root and member updates", async ({expect = globalExpect}: any = {}) => {
  const testCargoWorkDir = join(testDir, "test-cargo-workspace");
  mkdirSync(join(testCargoWorkDir, "crate-a"), {recursive: true});
  mkdirSync(join(testCargoWorkDir, "crate-b"), {recursive: true});

  writeFileSync(join(testCargoWorkDir, "Cargo.toml"), readFileSync(join(cargoWorkspaceDir, "Cargo.toml"), "utf8"));
  writeFileSync(join(testCargoWorkDir, "Cargo.lock"), readFileSync(join(cargoWorkspaceDir, "Cargo.lock"), "utf8"));
  writeFileSync(join(testCargoWorkDir, "crate-a", "Cargo.toml"), readFileSync(join(cargoWorkspaceDir, "crate-a", "Cargo.toml"), "utf8"));
  writeFileSync(join(testCargoWorkDir, "crate-b", "Cargo.toml"), readFileSync(join(cargoWorkspaceDir, "crate-b", "Cargo.toml"), "utf8"));

  const both = await updates({
    files: [join(testCargoWorkDir, "crate-a", "Cargo.toml"), join(testCargoWorkDir, "Cargo.toml")],
    cargoapi: cargoUrl, color: false, noCache: true,
  });
  expect(Object.keys(both.results.cargo).filter(key => key.includes("crate-a"))).toHaveLength(1);

  const {cargo} = (await updates({
    files: [join(testCargoWorkDir, "Cargo.toml")], cargoapi: cargoUrl,
    update: true, color: false, noCache: true,
  })).results;
  expect(cargo["workspace.dependencies"]["serde_json"]).toMatchObject({old: "1.0.100", new: "1.0.120"});
  expect(cargo["dependencies|./crate-a"].serde).toMatchObject({old: "1.0.100", new: "1.0.200"});
  expect(cargo["dependencies|./crate-b"].tokio).toMatchObject({old: "1.34.0", new: "1.35.0"});
  expect(cargo["dev-dependencies|./crate-b"].rand).toMatchObject({old: "0.8.5", new: "0.9.0"});

  const rootToml = await readFile(join(testCargoWorkDir, "Cargo.toml"), "utf8");
  const crateAToml = await readFile(join(testCargoWorkDir, "crate-a", "Cargo.toml"), "utf8");
  const crateBToml = await readFile(join(testCargoWorkDir, "crate-b", "Cargo.toml"), "utf8");
  expect(rootToml).toContain('serde_json = "1.0.120"');
  expect(crateAToml).toContain('serde = "1.0.200"');
  expect(crateBToml).toContain('version = "1.35.0"');
  expect(crateBToml).toContain('rand = "0.9.0"');
});

test("multiple Cargo workspace roots keep member config identity", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "updates-cargo-workspaces-"));
  const roots = [join(dir, "one"), join(dir, "two")];
  try {
    for (const [index, root] of roots.entries()) {
      mkdirSync(join(root, "crates", "app"), {recursive: true});
      await writeFile(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');
      await writeFile(join(root, "crates", "app", "Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0.0"\n');
      await writeFile(join(root, "renovate.json"), JSON.stringify({packageRules: [{
        matchPackageNames: ["serde"], allowedVersions: index === 0 ? "<=1.0.100" : "<=1.0.200",
      }]}));
    }

    await updates({
      files: roots.map(root => join(root, "Cargo.toml")), cargoapi: cargoUrl,
      modes: ["cargo"], update: true, color: false, noCache: true,
    });

    expect(await readFile(join(roots[0], "crates", "app", "Cargo.toml"), "utf8")).toContain('serde = "1.0.100"');
    expect(await readFile(join(roots[1], "crates", "app", "Cargo.toml"), "utf8")).toContain('serde = "1.0.200"');
  } finally {
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
});

test("pnpm workspace", async ({expect = globalExpect}: any = {}) => {
  const opts = {
    files: [pnpmWorkspaceFile],
    registry: npmUrl,
    forgeapi: githubUrl,
    color: false,
    noCache: true,
  };
  const result = await updates(opts);
  const {npm} = result.results;
  expect(npm["devDependencies"]["typescript"].new).toBeTruthy();

  const appADeps = npm["dependencies|./packages/app-a"];
  const libBDeps = npm["dependencies|./packages/lib-b"];
  expect(appADeps["prismjs"].new).toBeTruthy();
  expect(libBDeps["react"].new).toBeTruthy();

  expect(npm["catalog|pnpm-workspace.yaml"]["svgstore"].new).toBeTruthy();
  expect(npm["catalogs.build|pnpm-workspace.yaml"]["typescript"].new).toBeTruthy();
  expect(libBDeps["svgstore"]).toBeUndefined();

  const fromMember = await updates({
    ...opts,
    files: [join(pnpmWorkspaceDir, "packages", "app-a", "package.json"), pnpmWorkspaceFile],
  });
  expect(Object.keys(fromMember.results.npm).sort()).toEqual(Object.keys(npm).sort());
});

test("pnpm workspace update, and a second run is a no-op", async ({expect = globalExpect}: any = {}) => {
  const testPnpmWorkDir = join(testDir, "test-pnpm-workspace");
  mkdirSync(join(testPnpmWorkDir, "packages", "app-a"), {recursive: true});
  mkdirSync(join(testPnpmWorkDir, "packages", "lib-b"), {recursive: true});

  writeFileSync(join(testPnpmWorkDir, "pnpm-workspace.yaml"), readFileSync(join(pnpmWorkspaceDir, "pnpm-workspace.yaml"), "utf8"));
  writeFileSync(join(testPnpmWorkDir, "package.json"), readFileSync(join(pnpmWorkspaceDir, "package.json"), "utf8"));
  writeFileSync(join(testPnpmWorkDir, "packages", "app-a", "package.json"), readFileSync(join(pnpmWorkspaceDir, "packages", "app-a", "package.json"), "utf8"));
  writeFileSync(join(testPnpmWorkDir, "packages", "lib-b", "package.json"), readFileSync(join(pnpmWorkspaceDir, "packages", "lib-b", "package.json"), "utf8"));

  const wsPath = join(testPnpmWorkDir, "pnpm-workspace.yaml");
  const run = () => runCliExec([script, "-u", "-f", wsPath, "-c", ...apiArgs()]);
  await run();

  const rootPkg = await readFile(join(testPnpmWorkDir, "package.json"), "utf8");
  const appAPkg = await readFile(join(testPnpmWorkDir, "packages", "app-a", "package.json"), "utf8");
  const libBPkg = await readFile(join(testPnpmWorkDir, "packages", "lib-b", "package.json"), "utf8");
  const workspace = await readFile(wsPath, "utf8");
  expect(rootPkg).not.toContain('"^4"');
  expect(appAPkg).not.toContain('"1.0.0"');
  expect(libBPkg).not.toContain('"18.0"');
  expect(libBPkg).toContain('"svgstore": "catalog:"');
  expect(workspace).toContain('  svgstore: "^2.0.3"  # pinned');
  expect(workspace).toContain("    typescript: ^5\n");
  await run();
  expect(await readFile(wsPath, "utf8")).toBe(workspace);
});

test("pnpm workspace alongside unrelated package.json", async ({expect = globalExpect}: any = {}) => {
  for (const files of [[pnpmWorkspaceFile, testFile], [testFile, pnpmWorkspaceFile]]) {
    const result = await updates({files, registry: npmUrl, forgeapi: githubUrl, color: false, noCache: true});
    const {npm} = result.results;
    expect(npm["devDependencies"]["typescript"].new).toBeTruthy();
    expect(npm["dependencies|./packages/app-a"]["prismjs"].new).toBeTruthy();
    expect(npm["dependencies|./packages/lib-b"]["react"].new).toBeTruthy();

    const allNames = Object.values(npm).flatMap((group: any) => Object.keys(group));
    expect(allNames).toContain("gulp-sourcemaps");
  }
});

test("multiple npm workspace roots keep dependency and config identity", async ({expect = globalExpect}: any = {}) => {
  const dir = join(testDir, "test-multiple-npm-workspaces");
  const roots = [join(dir, "array"), join(dir, "object")];
  for (const root of roots) mkdirSync(join(root, "packages", "app"), {recursive: true});
  await writeFile(join(roots[0], "package.json"), JSON.stringify({
    workspaces: ["packages/*"], dependencies: {react: "^17.0.0"},
  }));
  await writeFile(join(roots[1], "package.json"), JSON.stringify({
    workspaces: {packages: ["packages/*"]}, dependencies: {react: "^17.0.0"},
  }));
  for (const root of roots) {
    await writeFile(join(root, "packages", "app", "package.json"), JSON.stringify({dependencies: {noty: "^3.1.0"}}));
  }
  await writeFile(join(roots[0], "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["react"], allowedVersions: "<=18.2.0"},
    {matchPackageNames: ["noty"], allowedVersions: "<=3.1.4"},
  ]}));
  await writeFile(join(roots[1], "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["react"], allowedVersions: "<=18.1.0"},
    {matchPackageNames: ["noty"], allowedVersions: "<=3.1.3"},
  ]}));

  await updates(apiOpts({files: roots.map(root => join(root, "package.json")), modes: ["npm"], update: true}));

  expect(JSON.parse(await readFile(join(roots[0], "package.json"), "utf8")).dependencies.react).toBe("^18.2.0");
  expect(JSON.parse(await readFile(join(roots[1], "package.json"), "utf8")).dependencies.react).toBe("^18.1.0");
  expect(JSON.parse(await readFile(join(roots[0], "packages", "app", "package.json"), "utf8")).dependencies.noty).toBe("^3.1.4");
  expect(JSON.parse(await readFile(join(roots[1], "packages", "app", "package.json"), "utf8")).dependencies.noty).toBe("^3.1.3");
});

test("local npm dependencies are neither requested nor rewritten", async ({expect = globalExpect}: any = {}) => {
  const dir = join(testDir, "test-local-npm-dependencies");
  mkdirSync(dir, {recursive: true});
  const file = join(dir, "package.json");
  const content = `${JSON.stringify({dependencies: {
    "local-file": "file:../local-file",
    "local-link": "link:../local-link",
  }}, null, 2)}\n`;
  await writeFile(file, content);
  const requestsBefore = localDependencyRequests;
  await updates(apiOpts({files: [file], modes: ["npm"], update: true}));
  expect(localDependencyRequests).toBe(requestsBefore);
  expect(await readFile(file, "utf8")).toBe(content);
});

test("pin holds the range and keeps the authored precision", async ({expect = globalExpect}: any = {}) => {
  const result = await updates({
    files: [testFile],
    forgeapi: githubUrl,
    pypiapi: pypiUrl,
    registry: npmUrl,
    color: false,
    noCache: true,
    pin: {"prismjs": "^1.0.0", "react": "^18.0.0"},
  });
  const {npm} = result.results;

  expect(npm.dependencies.prismjs).toBeDefined();
  expect(satisfies(npm.dependencies.prismjs.new, "^1.0.0")).toBe(true);

  expect(npm.dependencies.react.new).toBe("18.2");
});

test("a config-file pin and overrides merge with the renovate ones rather than replacing them", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "updates-pinmerge-"));
  try {
    const file = join(dir, "package.json");
    await writeFile(file, JSON.stringify({dependencies: {noty: "3.1.0"}}));
    await writeFile(join(dir, "renovate.json"), JSON.stringify({
      packageRules: [
        {matchPackageNames: ["noty"], allowedVersions: "<3.1.4"},
        {matchPackageNames: ["esbuild"], minimumReleaseAge: "1 day"},
      ],
    }));
    await writeFile(join(dir, "updates.config.js"), `module.exports = {inherit: {renovate: {cooldown: true}}, ` +
      `pin: {"gulp-sourcemaps": "^2.0.0"}, overrides: [{include: ["gulp-sourcemaps"], greatest: true}]};\n`);

    const output = await updates(apiOpts({files: [file]}));
    expect(output.results.npm.dependencies.noty.new).toBe("3.1.3");

    const {args, positionals} = parseCliArgs(["-f", file]);
    const resolved = await resolveConfig(args, positionals) as UpdatesOptions & {renovateVersionRules: Array<Record<string, any>>};
    expect(resolved.overrides).toEqual([{include: ["gulp-sourcemaps"], greatest: true}]);
    expect(resolved.renovateVersionRules).toContainEqual({matchPackageNames: ["esbuild"], cooldownDays: 1});
  } finally {
    try {
      await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    } catch {}
  }
});

function actionsArgs(...extra: Array<string>) {
  return [script, "-c", "--forgeapi", githubUrl, "--dockerapi", dockerUrl, "-M", "actions", "-f", actionsDir, ...extra];
}

function getActionsDeps(results: any) {
  const ciType = Object.keys(results.actions).find(t => t.endsWith("ci.yaml"));
  return results.actions[ciType!];
}

test("branch-only actions do not fetch forge metadata", async () => {
  let requests = 0;
  const server = makeServer((_req, res) => {
    requests++;
    res.statusCode = 500;
    res.end();
  });
  const dir = mkdtempSync(join(tmpdir(), "updates-actions-branches-"));
  const workflow = join(dir, ".github", "workflows", "ci.yml");
  mkdirSync(join(dir, ".github", "workflows"), {recursive: true});
  writeFileSync(workflow, "jobs:\n  test:\n    steps:\n      - uses: one/repo@main\n      - uses: two/repo@develop\n");
  await server.start(0);
  try {
    await updates({files: [workflow], modes: ["actions"], forgeapi: makeUrl(server), noCache: true, noColor: true});
    expect(requests).toBe(0);
  } finally {
    await Promise.all([server.close(), rm(dir, {recursive: true, force: true})]);
  }
});

test("actions scan older tags for configured downgrades and pins", async () => {
  const server = makeServer(defaultRoute);
  const dir = mkdtempSync(join(tmpdir(), "updates-actions-older-"));
  const workflow = join(dir, ".github", "workflows", "ci.yml");
  mkdirSync(join(dir, ".github", "workflows"), {recursive: true});
  writeFileSync(workflow, [
    "jobs:",
    "  test:",
    "    steps:",
    "      - uses: o/down@v10.0.0-alpha",
    "      - uses: o/pinned@v10.0.0",
  ].join("\n"));
  await server.start(0);
  const forgeapi = makeUrl(server);
  for (const repo of ["down", "pinned"]) {
    server.get(`/repos/o/${repo}/tags`, (req, res) => {
      const page = Number(new URL(req.url, forgeapi).searchParams.get("page"));
      const names = ["main", "edge", repo === "down" ? "v10.0.0-alpha" : "v10.0.0", "legacy", "v9.0.0"];
      res.setHeader("Link", `<${forgeapi}repos/o/${repo}/tags?per_page=100&page=5>; rel="last"`);
      res.end(JSON.stringify([{name: names[page - 1], commit: {sha: `${repo}${page}`}}]));
    });
  }
  try {
    const output = await updates({
      files: [workflow], modes: ["actions"], forgeapi, noCache: true, noColor: true,
      allowDowngrade: ["o/down"], pin: {"o/pinned": "^9"},
    });
    const results = Object.values(output.results.actions)[0];
    expect(results["o/down"].new).toBe("9.0.0");
    expect(results["o/pinned"].new).toBe("9.0.0");
  } finally {
    await Promise.all([server.close(), rm(dir, {recursive: true, force: true})]);
  }
});

test("actions basic", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(actionsArgs("-j"));
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  expect(output.results.actions).toBeDefined();
  const actionsDeps = getActionsDeps(output.results);

  expect(actionsDeps["actions/checkout"].old).toBe("2");
  expect(actionsDeps["actions/checkout"].new).toBe("10");
  expect(actionsDeps["actions/checkout"].info).toContain("actions/checkout");

  expect(actionsDeps["actions/setup-node@v1.0"].old).toBe("1.0");
  expect(actionsDeps["actions/setup-node@v1.0"].new).toBe("10.0.0");
  expect(actionsDeps["actions/setup-node@v1.0.0"].old).toBe("1.0.0");
  expect(actionsDeps["actions/setup-node@v1.0.0"].new).toBe("10.0.0");

  expect(actionsDeps["tj-actions/changed-files"]).toBeUndefined();
});

test("actions include filter, with no false upgrade on the same major", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(actionsArgs("-j", "-i", "actions/checkout"));
  expect(stderr).toEqual("");
  const actionsDeps = getActionsDeps(JSON.parse(stdout).results);
  expect(actionsDeps["actions/checkout"].old).toBe("2");
  expect(actionsDeps["actions/checkout"].new).toBe("10");
  expect(actionsDeps["actions/setup-node"]).toBeUndefined();
  expect(Object.keys(actionsDeps).filter(key => actionsDeps[key].old === "10")).toHaveLength(0);
});

test("actions cooldown gates on the tag date after selection, not before", async ({expect = globalExpect}: any = {}) => {
  const {stdout} = await runCliExec(actionsArgs("-j", "-i", "actions/checkout", "-C", "1"));
  expect(getActionsDeps(JSON.parse(stdout).results)["actions/checkout"].new).toBe("10");

  const tooNew = await runCliExec(actionsArgs("-j", "-i", "actions/checkout", "-C", "999999d"));
  expect(JSON.parse(tooNew.stdout).message).toContain("up to date");
});

test("actions exclude filter", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(actionsArgs("-j", "-e", "actions/checkout"));
  expect(stderr).toEqual("");
  const actionsDeps = getActionsDeps(JSON.parse(stdout).results);
  expect(actionsDeps["actions/checkout"]).toBeUndefined();
  expect(actionsDeps["actions/setup-node@v1.0"]).toBeDefined();
  expect(actionsDeps["actions/setup-node@v1.0.0"]).toBeDefined();
});

test("text output renders several modes with a MODE column", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await execFileAsync(execPath, [
    script, "-n", "--forgeapi", githubUrl, "--dockerapi", dockerUrl, "-M", "actions,docker", "-f", actionsDir,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("MODE");
  expect(stdout).toContain("actions/checkout");
  expect(stdout).toContain("actions/setup-node");
  expect(stdout).toContain("https://hub.docker.com/_/node");
});

test("actions positional args", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec([script, "-c", "--forgeapi", githubUrl, "-M", "actions", "-j", actionsDir]);
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  const actionsDeps = getActionsDeps(output.results);
  expect(actionsDeps["actions/checkout"].old).toBe("2");
  expect(actionsDeps["actions/checkout"].new).toBe("10");
  expect(actionsDeps["actions/setup-node@v1.0"].old).toBe("1.0");
  expect(actionsDeps["actions/setup-node@v1.0"].new).toBe("10.0.0");
});

test("actions update rewrites tags and keeps same-sha pin identities distinct", async ({expect = globalExpect}: any = {}) => {
  const tmpActionsDir = join(testDir, "actions-update-test/.github/workflows");
  mkdirSync(tmpActionsDir, {recursive: true});
  const wfPath = join(tmpActionsDir, "ci.yaml");
  await writeFile(wfPath, [
    "name: ci",
    "on: push",
    "jobs:",
    "  ci:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v2",
    "      - uses: actions/setup-node@v1",
    "      - uses: actions/checkout@dddd000000000000000000000000000000000000 # v4.2.0",
    "      - uses: actions/checkout@dddd000000000000000000000000000000000000 # main",
    "      - uses: actions/checkout@dddd000000000000000000000000000000000000 # release",
    "",
  ].join("\n"));

  const {stderr} = await runCliExec([
    script, "-u", "-c", "--forgeapi", githubUrl, "-M", "actions", "-f", tmpActionsDir,
  ]);
  expect(stderr).toEqual("");

  const updatedContent = await readFile(wfPath, "utf8");
  expect(updatedContent).toContain("actions/checkout@v10\n");
  expect(updatedContent).not.toContain("actions/checkout@v2");
  expect(updatedContent).toContain("actions/setup-node@v10.0.0");
  expect(updatedContent).toContain("actions/checkout@cccc000000000000000000000000000000000011 # v10.0.1");
  expect(updatedContent).toContain("actions/checkout@aaaa000000000000000000000000000000000001 # main");
  expect(updatedContent).toContain("actions/checkout@bbbb000000000000000000000000000000000002 # release");
  expect(updatedContent).not.toContain("dddd000000000000000000000000000000000000");
});

test("actions hash-pinned on a version comment updates the sha and the comment", async ({expect = globalExpect}: any = {}) => {
  const tmpActionsDir = join(testDir, "actions-hash-test/.github/workflows");
  mkdirSync(tmpActionsDir, {recursive: true});
  const wfPath = join(tmpActionsDir, "ci.yaml");
  const oldDigest = "dddd000000000000000000000000000000000000";
  await writeFile(wfPath, [
    "name: ci", "on: push", "jobs:", "  ci:", "    runs-on: ubuntu-latest", "    steps:",
    `      - uses: actions/checkout@${oldDigest} # v4.2.0`,
    `      - uses: actions/setup-node@${oldDigest} # v10.0.0`,
    "",
  ].join("\n"));

  const {stdout, stderr} = await runCliExec([
    script, "-u", "-j", "-c", "--forgeapi", githubUrl, "-M", "actions", "-f", tmpActionsDir,
  ]);
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  const ciKey = Object.keys(output.results.actions).find(t => t.endsWith("ci.yaml"));
  const actionsDeps = output.results.actions[ciKey!];
  expect(actionsDeps["actions/checkout"].old).toBe("4.2.0");
  expect(actionsDeps["actions/checkout"].new).toBe("10.0.1");
  // already on the newest version, so only the stale sha moves
  expect(actionsDeps["actions/setup-node"].old).toBe("v10.0.0");
  expect(actionsDeps["actions/setup-node"].new).toBe("v10.0.0");
  expect(actionsDeps["actions/setup-node"].newDigest).toBe("bbbb000000000000000000000000000000000010");

  const updated = await readFile(wfPath, "utf8");
  expect(updated).toContain("actions/checkout@cccc000000000000000000000000000000000011 # v10.0.1");
  expect(updated).toContain("actions/setup-node@bbbb000000000000000000000000000000000010 # v10.0.0");
  expect(updated).not.toContain(oldDigest);
});

test("actions composite action discovery", async ({expect = globalExpect}: any = {}) => {
  const compositeDir = fileURLToPath(new URL("fixtures/actions-composite/.github", import.meta.url));
  const {stdout, stderr} = await runCliExec([
    script, "-j", "-c", "--forgeapi", githubUrl, "-M", "actions", "-f", compositeDir,
  ]);
  expect(stderr).toEqual("");
  const raw = JSON.parse(stdout).results.actions;
  const results: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) results[k.replace(/\\/g, "/")] = v;
  const wfKey = Object.keys(results).find(k => k.endsWith("workflows/ci.yml"));
  const compKey = Object.keys(results).find(k => k.endsWith("my-action/action.yml"));
  const nestedKey = Object.keys(results).find(k => k.endsWith("nested/sub/action.yaml"));
  expect(results[wfKey!]["actions/checkout"].new).toBe("10");
  expect(results[compKey!]["actions/setup-node"].new).toBe("10.0.0");
  expect(results[nestedKey!]["actions/checkout"].new).toBe("10");
});

test("actions composite action update, in every forge dir", async ({expect = globalExpect}: any = {}) => {
  const root = join(testDir, "composite-update");
  for (const forgeDirName of forgeDirs) {
    const forgeDir = join(root, forgeDirName);
    mkdirSync(join(forgeDir, "workflows"), {recursive: true});
    mkdirSync(join(forgeDir, "actions", "my-action"), {recursive: true});
    await writeFile(join(forgeDir, "workflows", "ci.yml"), "name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v2\n");
    await writeFile(join(forgeDir, "actions", "my-action", "action.yml"), "name: my-action\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v1.0\n      shell: bash\n");
  }

  const {stderr} = await runCliExec([
    script, "-u", "-c", "--forgeapi", githubUrl, "-M", "actions", "-f", root,
  ]);
  expect(stderr).toEqual("");

  for (const forgeDirName of forgeDirs) {
    const forgeDir = join(root, forgeDirName);
    expect(await readFile(join(forgeDir, "workflows", "ci.yml"), "utf8")).toContain("actions/checkout@v10");
    expect(await readFile(join(forgeDir, "actions", "my-action", "action.yml"), "utf8")).toContain("actions/setup-node@v10.0.0");
  }
});


function dockerArgs(...extra: Array<string>) {
  return [script, "-c", "--dockerapi", dockerUrl, "-M", "docker", ...extra];
}

test.each([
  ["Dockerfile", dockerfileFixture, "Dockerfile", {
    "node:18": {old: "18", new: "22", info: "https://hub.docker.com/_/node"},
    "node:20": {old: "20", new: "22"},
    postgres: {old: "15-alpine", new: "17-alpine", info: "https://hub.docker.com/_/postgres"},
  }],
  ["compose", composeFixture, "docker-compose.yaml", {
    node: {old: "18", new: "22"}, postgres: {old: "15-alpine", new: "17-alpine"}, redis: {old: "7", new: "8"},
  }],
  ["workflow", dockerActionsDir, "ci.yaml", {
    node: {old: "18", new: "22"}, postgres: {old: "15", new: "17"}, redis: {old: "7", new: "8"},
  }],
])("docker %s basic", async (name, file, suffix, expected, {expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(dockerArgs("-j", "-f", file));
  expect(stderr).toEqual("");
  const docker = JSON.parse(stdout).results.docker;
  const dependencies = docker[Object.keys(docker).find(key => key.endsWith(suffix))!];
  expect(dependencies).toMatchObject(expected);
  if (name === "workflow") {
    const crlfDir = join(testDir, "docker-actions-crlf", ".github", "workflows");
    const crlfFile = join(crlfDir, "ci.yaml");
    mkdirSync(crlfDir, {recursive: true});
    await writeFile(crlfFile, (await readFile(join(file, suffix), "utf8")).replaceAll("\n", "\r\n"));
    const crlfOutput = await runCliExec(dockerArgs("-j", "-f", crlfFile));
    expect(crlfOutput.stderr).toEqual("");
    const crlfDocker = JSON.parse(crlfOutput.stdout).results.docker;
    expect(crlfDocker[Object.keys(crlfDocker).find(key => key.endsWith(suffix))!]).toEqual(dependencies);
  }
});

test("docker allowedVersions compares floating tags with Docker semantics", async ({expect = globalExpect}: any = {}) => {
  const dir = join(testDir, "test-docker-allowed");
  mkdirSync(dir, {recursive: true});
  const file = join(dir, "Dockerfile");
  await writeFile(file, "FROM node:18\n");
  await writeFile(join(dir, "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["node"], allowedVersions: "<22"},
  ]}));

  const output = await updates({files: [file], modes: ["docker"], dockerapi: dockerUrl, update: true, color: false, noCache: true});

  expect(Object.values(output.results.docker)[0].node.new).toBe("20");
  expect(await readFile(file, "utf8")).toBe("FROM node:20\n");
});

test("actions mode does not include docker from workflows", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(actionsArgs("-j", "-f", dockerActionsDir));
  expect(stderr).toEqual("");
  const output = JSON.parse(stdout);
  expect(output.results.docker).toBeUndefined();
});

test.each([
  ["include", "-i", ["node"]],
  ["exclude", "-e", ["postgres", "redis"]],
])("docker %s filter", async (_name, flag, expected, {expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(dockerArgs("-j", "-f", composeFixture, flag, "node"));
  expect(stderr).toEqual("");
  const docker = JSON.parse(stdout).results.docker;
  expect(Object.keys(docker[Object.keys(docker).find(key => key.endsWith("docker-compose.yaml"))!]).sort()).toEqual(expected);
});

test("docker update rewrites Dockerfiles, compose files and workflows", async ({expect = globalExpect}: any = {}) => {
  const tmpDir = join(testDir, "docker-update-test");
  const wfDir = join(tmpDir, ".github", "workflows");
  mkdirSync(wfDir, {recursive: true});
  const dockerfilePath = join(tmpDir, "Dockerfile");
  const composePath = join(tmpDir, "docker-compose.yaml");
  const wfPath = join(wfDir, "ci.yaml");
  await writeFile(dockerfilePath, "FROM node:18\nRUN npm install\n");
  await writeFile(composePath, "services:\n  web:\n    image: node:18\n  db:\n    image: redis:7\n");
  await writeFile(wfPath, [
    "name: ci",
    "on: [push]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    container: node:18",
    "    services:",
    "      db:",
    "        image: postgres:15",
    "    steps:",
    "      - uses: docker://node:18",
    "      - run: |",
    "          cat >fragment.yml <<'EOF'",
    "          uses: docker://node:18",
    "          EOF",
    "  test2:",
    "    runs-on: ubuntu-latest",
    "    container:",
    "      image: redis:7",
    "    steps:",
    "      - run: echo test",
    "",
  ].join("\n"));

  const {stderr} = await runCliExec(dockerArgs("-u", "-f", tmpDir));
  expect(stderr).toEqual("");

  expect(await readFile(dockerfilePath, "utf8")).toBe("FROM node:22\nRUN npm install\n");
  expect(await readFile(composePath, "utf8")).toBe("services:\n  web:\n    image: node:22\n  db:\n    image: redis:8\n");

  const updatedWorkflow = await readFile(wfPath, "utf8");
  expect(updatedWorkflow).toContain("container: node:22");
  expect(updatedWorkflow).not.toContain("container: node:18");
  expect(updatedWorkflow).toContain("image: postgres:17");
  expect(updatedWorkflow).not.toContain("image: postgres:15");
  expect(updatedWorkflow).toContain("docker://node:22");
  expect(updatedWorkflow).toContain("          uses: docker://node:18");
  expect(updatedWorkflow).toContain("image: redis:8");
  expect(updatedWorkflow).not.toContain("image: redis:7");
});

test("docker directory discovery covers every recognized filename", async ({expect = globalExpect}: any = {}) => {
  const {stdout, stderr} = await runCliExec(dockerArgs("-j", "-f", dockerDir));
  expect(stderr).toEqual("");
  const {docker} = JSON.parse(stdout).results;
  const byName = new Map(Object.entries(docker).map(([key, deps]) => [key.replace(/\\/g, "/"), deps as any]));
  const find = (suffix: string) => byName.keys().find(key => key.endsWith(suffix));
  for (const suffix of ["Dockerfile", "Dockerfile.dev", "docker-compose.yaml", "docker-stack.yml", "/compose.yaml"]) {
    expect(find(suffix), suffix).toBeDefined();
  }
  for (const suffix of ["Dockerfile.dev", "docker-stack.yml"]) {
    expect(byName.get(find(suffix)!).node).toMatchObject({old: "18", new: "22"});
  }

  const linked = join(testDir, "test-docker-dir-symlink");
  symlinkSync(dockerDir, linked, "junction");
  const {stdout: linkedStdout} = await runCliExec(dockerArgs("-j", "-f", linked));
  expect(Object.keys(JSON.parse(linkedStdout).results.docker)).toHaveLength(byName.size);

  const linkedFile = join(testDir, "test-docker-file-symlink");
  const target = join(dockerDir, "Dockerfile.dev");
  symlinkSync(target, linkedFile);
  for (const args of [[linkedFile, target], [target, linkedFile]]) {
    const {stdout} = await runCliExec(dockerArgs("-j", "-f", args[0], "-f", args[1]));
    expect(Object.keys(JSON.parse(stdout).results.docker)).toHaveLength(1);
  }
});

test("fetch error includes URL and no stack trace", async ({expect = globalExpect}: any = {}) => {
  const url = "http://test.invalid";
  try {
    await execFileAsync(execPath, [
      script, "-j", "-T", "1000", ...apiArgs(), "--registry", url, "-f", testFile,
    ]);
    throw new Error("Expected error but got success");
  } catch (err: any) {
    const {errors} = JSON.parse(err?.stdout || "{}");
    expect(errors.length).toBeGreaterThan(0);
    for (const {error} of errors) {
      expect(error).toContain(url);
      expect(error).not.toContain("    at ");
    }
  }
});

test("repeated multi-value flag survives swallowed flag recovery", async ({expect = globalExpect}: any = {}) => {
  const results = await makeTest("-j -i react -i -p");
  expect(Object.keys(results.npm.dependencies)).toEqual(["react"]);
  expect(results.npm.dependencies.react.new).toBe("18.3.0-next-fecc288b7-20221025");

  const nonLast = await makeTest("-j -i react -i -p -i gulp-sourcemaps");
  const keys = Object.keys(nonLast.npm.dependencies);
  expect(keys).toContain("react");
  expect(keys).toContain("gulp-sourcemaps");
  expect(nonLast.npm.dependencies.react.new).toBe("18.3.0-next-fecc288b7-20221025");

  const {args} = parseCliArgs(["-i", "noty", "--exclude=-u"]);
  expect(args.exclude).toEqual(["-u"]);
  expect(args.update).toBeUndefined();
});

async function withConfigDir<T>(config: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "updates-cfg-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(testPkg, null, 2));
  writeFileSync(join(dir, ".npmrc"), `registry=${npmUrl}\nsave-exact=false`);
  writeFileSync(join(dir, "updates.config.js"), `module.exports = ${config};\n`);
  try {
    return await fn(dir);
  } finally {
    try {
      await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    } catch {}
  }
}

function configTest(config: string, args: string): Promise<{stdout: string, stderr: string}> {
  return withConfigDir(config, dir => execFileAsync(execPath, [script, ...args.split(/\s+/), "-c",
    "--no-cache",
    "--forgeapi", githubUrl, "--pypiapi", pypiUrl,
    "--jsrapi", jsrUrl, "--goproxy", goProxyUrl, "--cargoapi", cargoUrl,
  ], {cwd: dir}));
}

test("config exit-code options", async ({expect = globalExpect}: any = {}) => {
  for (const [config, args, output] of [
    ["{ errorOnOutdated: true }", "-j -i noty", "noty"],
    ["{ errorOnUnchanged: true }", "-j -i svgstore", "All dependencies are up to date."],
  ]) {
    try {
      await configTest(config, args);
      throw new Error("Expected non-zero exit");
    } catch (err: any) {
      expect(err?.code).toBe(2);
      expect(err?.stdout || err?.message).toContain(output);
    }
  }
});

test("config cli overrides config", async ({expect = globalExpect}: any = {}) => {
  const {stdout} = await withConfigDir(`{ minor: true }`, dir =>
    runCliExec([script, "-j", "-i", "gulp-sourcemaps", "-P", "-c", ...apiArgs(), "-f", join(dir, "package.json")]));
  expect(JSON.parse(stdout).results.npm.dependencies["gulp-sourcemaps"].new).toBe("2.0.1");
});

test("config json yields JSON error output without -j flag", async ({expect = globalExpect}: any = {}) => {
  try {
    await configTest(`{ json: true }`, "-i noty --registry http://test.invalid -T 1000");
    throw new Error("Expected non-zero exit");
  } catch (err: any) {
    const {errors} = JSON.parse(err?.stdout || "{}");
    expect(errors[0].error).toContain("test.invalid");
  }

  try {
    await configTest(`{}`, "-j -l foo");
    throw new Error("Expected non-zero exit");
  } catch (err: any) {
    expect(JSON.parse(err?.stdout || "{}").error).toContain("Invalid pin: foo");
  }
});

test("a /regex/ cli value applies the flag to the packages it matches alone", async ({expect = globalExpect}: any = {}) => {
  const greatest = await makeTest("-j -i gulp-sourcemaps,noty -g /^gulp/");
  expect(greatest.npm.dependencies["gulp-sourcemaps"].new).toBe("2.6.5");
  expect(greatest.npm.dependencies.noty.new).toBe("3.1.4");

  const prerelease = await makeTest("-j -i gulp-sourcemaps,noty -p /^noty/");
  expect(prerelease.npm.dependencies.noty.new).toBe("3.2.0-beta");
  expect(prerelease.npm.dependencies["gulp-sourcemaps"].new).toBe("2.6.5");
});

function apiOpts(overrides: UpdatesOptions = {}): UpdatesOptions {
  return {
    files: [testFile],
    modes: ["npm"],
    noCache: true,
    registry: npmUrl,
    forgeapi: githubUrl,
    pypiapi: pypiUrl,
    jsrapi: jsrUrl,
    goproxy: goProxyUrl,
    cargoapi: cargoUrl,
    dockerapi: dockerUrl,
    ...overrides,
  };
}

test("api basic", async ({expect = globalExpect}: any = {}) => {
  const output = await updates(apiOpts({include: ["noty"]}));
  expect(output.results.npm.dependencies.noty).toBeDefined();
  expect(output.results.npm.dependencies.noty.old).toBe("3.1.0");
  expect(output.results.npm.dependencies.noty.new).toBe("3.1.4");
  expect(output.results.npm.dependencies.noty.info).toBeTruthy();

  let latest = "3.1.4";
  const registry = makeServer((_, res) => res.send(gzipNow(JSON.stringify({
    name: "noty", "dist-tags": {latest}, versions: {"3.1.0": {}, "3.1.4": {}, "3.2.1": {}},
  }))));
  await registry.start(0);
  try {
    const opts = apiOpts({include: ["noty"], registry: makeUrl(registry), noCache: true});
    expect((await updates(opts)).results.npm.dependencies.noty.new).toBe("3.1.4");
    latest = "3.2.1";
    expect((await updates(opts)).results.npm.dependencies.noty.new).toBe("3.2.1");
  } finally {
    await registry.close();
  }
});

test("api messages, filters and mode validation", async ({expect = globalExpect}: any = {}) => {
  let output = await updates(apiOpts({files: [emptyFile]}));
  expect(output.message).toBe("No dependencies found, nothing to do.");
  expect(Object.keys(output.results)).toHaveLength(0);

  output = await updates(apiOpts({include: ["updates"], cooldown: "999999d"}));
  expect(output.message).toBe("All dependencies are up to date.");

  output = await updates(apiOpts({include: [/^noty$/]}));
  expect(Object.keys(output.results.npm.dependencies)).toEqual(["noty"]);

  output = await updates(apiOpts({include: ["noty", "gulp-sourcemaps"], exclude: [/sourcemaps/]}));
  expect(Object.keys(output.results.npm.dependencies)).toEqual(["noty"]);

  output = await updates(apiOpts({include: ["noty"], modes: ["pypi"]}));
  expect(output.message).toBe("No dependencies found, nothing to do.");
  await expect(updates(apiOpts({modes: ["nope"]}))).rejects.toThrow("Invalid mode: nope");
});

test.each([
  ["greatest", {greatest: true}, "2.6.5"],
  ["patch", {patch: true}, "2.0.1"],
  ["minor", {minor: true}, "2.6.5"],
])("api %s", async (_name, option, expected, {expect = globalExpect}: any = {}) => {
  const output = await updates(apiOpts({include: ["gulp-sourcemaps"], ...option}));
  expect(output.results.npm.dependencies["gulp-sourcemaps"].new).toBe(expected);
});

test.each([
  ["api greatest array", {greatest: ["gulp-sourcemaps"]}],
  ["api greatest regex", {greatest: [/^gulp/]}],
  ["api overrides target a package", {overrides: [{include: ["gulp-sourcemaps"], greatest: true}]}],
  ["api overrides exclude within a rule", {overrides: [{exclude: ["noty"], greatest: true}]}],
])("%s", async (_name, overrides, {expect = globalExpect}: any = {}) => {
  const output = await updates(apiOpts({include: ["gulp-sourcemaps", "noty"], ...overrides}));
  expect(output.results.npm.dependencies["gulp-sourcemaps"].new).toBe("2.6.5");
  expect(output.results.npm.dependencies.noty.new).toBe("3.1.4");
});

test("api cooldown overrides apply per package and last match wins", async ({expect = globalExpect}: any = {}) => {
  let output = await updates(apiOpts({include: ["noty", "updates"], cooldown: "999999d", overrides: [{include: ["noty"], cooldown: 0}]}));
  expect(output.results.npm.dependencies.noty.new).toBe("3.1.4");
  expect(output.results.npm.dependencies.updates).toBeUndefined();

  output = await updates(apiOpts({include: ["noty"], cooldown: "999999d", overrides: [{include: ["noty"], cooldown: "999999d"}, {include: ["noty"], cooldown: 0}]}));
  expect(output.results.npm.dependencies.noty.new).toBe("3.1.4");
});

test("pypi dotted group names are collected, a declined rewrite is not reported", async ({expect = globalExpect}: any = {}) => {
  const file = join(testDir, "test-pypi-groups", "pyproject.toml");
  mkdirSync(join(testDir, "test-pypi-groups"));
  await writeFile(file, [
    `[project]`,
    `dependencies = ["djlint>=1.30.0,!=1.31.0"]`,
    ``,
    `[project.optional-dependencies]`,
    `"extra.one" = ["PyYAML>=1.0"]`,
    ``,
    `[dependency-groups]`,
    `"test.unit" = ["types-paramiko>=3.4.0.20240423"]`,
    ``,
  ].join("\n"));

  const {pypi} = (await updates(apiOpts({files: [file], modes: ["pypi"], update: true}))).results;
  expect(pypi["project.optional-dependencies.extra.one"].PyYAML.new).toBe("6.0");
  expect(pypi["dependency-groups.test.unit"]["types-paramiko"].new).toBe("3.5.0.20250801");
  expect(pypi["project.dependencies"]).toBeUndefined();

  const written = await readFile(file, "utf8");
  expect(written).toContain(`"PyYAML>=6.0"`);
  expect(written).toContain(`"types-paramiko>=3.5.0.20250801"`);
  expect(written).toContain(`"djlint>=1.30.0,!=1.31.0"`);
});

test("a pypi pin holds, keyed by the authored spelling or the normalized one", async ({expect = globalExpect}: any = {}) => {
  for (const key of ["PyYAML", "pyyaml"]) {
    const {pypi} = (await updates(apiOpts({files: [uvFile], modes: ["pypi"], include: ["PyYAML"], pin: {[key]: "<6.0"}}))).results;
    expect(pypi["dependency-groups.dev"].PyYAML.new).toBe("5.4.1");
  }
});

test("non-workspace manifests keep distinct dependencies and duplicate identities", async ({expect = globalExpect}: any = {}) => {
  const dir = join(testDir, "test-multi-manifest");
  const manifests = [
    ["a", "noty", "3.1.0", "3.1.4"],
    ["b", "noty", "3.1.0", "3.1.4"],
    ["c", "gulp-sourcemaps", "2.0.0", "2.6.5"],
  ] as const;
  const files = await Promise.all(manifests.map(async ([subdir, name, old]) => {
    mkdirSync(join(dir, subdir), {recursive: true});
    const file = join(dir, subdir, "package.json");
    await writeFile(file, `${JSON.stringify({dependencies: {[name]: old}}, null, 2)}\n`);
    return file;
  }));

  const {npm} = (await updates(apiOpts({files, update: true}))).results;
  expect(Object.values(npm).filter(section => "noty" in section)).toHaveLength(2);
  for (const [index, [, name, , expected]] of manifests.entries()) {
    expect(await readFile(files[index], "utf8")).toContain(`"${name}": "${expected}"`);
  }
});
