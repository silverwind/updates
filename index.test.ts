import {execFile} from "node:child_process";
import {AsyncLocalStorage} from "node:async_hooks";
import {createServer} from "node:http";
import {basename, dirname, join, parse, relative} from "node:path";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import {readFile, rm} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {tmpdir} from "node:os";
import {env, platform, versions} from "node:process";
import {gzip, gzipSync, constants} from "node:zlib";
import {format, promisify} from "node:util";
import {Readable} from "node:stream";
import type {AddressInfo} from "node:net";
import {satisfies} from "./utils/semver.ts";
import {forgeDirs, getOrSet} from "./utils/utils.ts";
import {updates} from "./api.ts";
import {parseCliArgs, resolveConfig, runCli} from "./cli.ts";
import type {UpdatesOptions} from "./api.ts";

const execFileAsync = promisify(execFile);
const cliStderr = new AsyncLocalStorage<(text: string) => void>();
const realConsoleError = console.error;
console.error = (...args) => {
  const write = cliStderr.getStore();
  if (write) write(`${format(...args)}\n`);
  else realConsoleError(...args);
};

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`test attempted a non-mocked network request to ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

const gzipOptions = {level: constants.Z_BEST_SPEED};
const fixture = (path: string) => join(import.meta.dirname, "fixtures", path);
const read = (...paths: Array<string>) => readFileSync(join(...paths), "utf8");
const lines = (...rows: Array<string>) => `${rows.join("\n")}\n`;
const testFile = fixture("npm-test/package.json");
const emptyFile = fixture("npm-empty/package.json");
const uvFile = fixture("uv/pyproject.toml");
const goFile = fixture("go/go.mod");
const goPreFile = fixture("go-prerelease/go.mod");
const actionsDir = fixture("actions/.github/workflows");
const composeFixture = fixture("docker/docker-compose.yaml");
const dockerActionsDir = fixture("docker-actions/.github/workflows");
const pnpmWorkspaceFile = fixture("pnpm-workspace/pnpm-workspace.yaml");
const testPkg = JSON.parse(read(testFile));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const originalXdgConfigHome = env.XDG_CONFIG_HOME;
const sourceScript = join(import.meta.dirname, "index.ts");
const script = join(import.meta.dirname, "dist/index.js");

type RouteHandler = (req: any, res: any) => void;
const routes = new Map<string, RouteHandler>();
const requestedUrls: Array<string> = [];
const mockServer = createServer((req, res) => {
  requestedUrls.push(req.url!);
  (res as any).send = (data: Buffer) => {
    res.setHeader("Content-Encoding", "gzip");
    res.end(data);
  };
  try {
    const handler = routes.get(req.url!.split("?")[0]);
    if (!handler) res.writeHead(404).end();
    else if (handler(req, res) as unknown) throw new Error("route handler returned a promise; it must be synchronous");
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});
await new Promise<void>(resolve => mockServer.listen(0, "127.0.0.1", resolve));
const mockUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
const [npmUrl, githubUrl, pypiUrl, jsrUrl, goProxyUrl, cargoUrl, dockerUrl] =
  ["npm", "github", "pypi", "jsr", "go", "cargo", "docker"].map(prefix => `${mockUrl}/${prefix}/`);
const apiUrls = {registry: npmUrl, forgeapi: githubUrl, pypiapi: pypiUrl, jsrapi: jsrUrl, goproxy: goProxyUrl, cargoapi: cargoUrl, dockerapi: dockerUrl};
const apiArgs = ["--no-cache", ...Object.entries(apiUrls).flatMap(([name, url]) => [`--${name}`, url])];
const apiOpts = (options: UpdatesOptions = {}): UpdatesOptions => ({files: [testFile], noCache: true, ...apiUrls, ...options});
const npmUpdates = async (options: UpdatesOptions = {}) => (await updates(apiOpts(options))).results.npm.dependencies;
writeFileSync(join(testDir, ".npmrc"), `registry=${npmUrl}\nsave-exact=false`);
writeFileSync(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2));

function lazyRoute(path: string, body: () => unknown) {
  let gz: Buffer | undefined;
  routes.set(path, (_, res) => res.send(gz ??= gzipSync(JSON.stringify(body()), gzipOptions)));
}

beforeAll(async () => {
  env.XDG_CONFIG_HOME = join(testDir, "xdg");
  const fixtureText = (path: string) => readFile(fixture(path), "utf8");
  await Promise.all(readdirSync(fixture("npm")).map(async file => {
    const urlName = parse(file).name;
    const doc = JSON.parse(await fixtureText(`npm/${file}`));
    const gzips = new Map<string, Buffer>();
    routes.set(`/npm/${urlName}`, (req, res) => {
      const flavor = req.headers.accept?.includes("application/vnd.npm.install-v1+json") ? "abbrev" : "full";
      res.send(getOrSet(gzips, flavor, () => gzipSync(JSON.stringify({...doc, time: flavor === "abbrev" ? undefined : doc.time}), gzipOptions)));
    });
    for (const [version, versionDoc] of Object.entries(doc.versions || {})) {
      lazyRoute(`/npm/${urlName}/${version}`, () => urlName === "noty" && version === "3.1.4" ? versionDoc : {
        ...versionDoc as object, _npmOperationalInternal: {tmp: `tmp/${urlName}_${version}_${Date.parse(doc.time?.[version] || "2024-01-01") || 0}_0`},
      });
    }
  }));

  const goLatest = (version: string, time: string) => JSON.stringify({Version: version, Time: time});
  const cargoIndex = (name: string, vers: string) => JSON.stringify({name, vers, yanked: false, pubtime: "2025-01-15T12:00:00Z"});
  const dockerTags = (...tags: Array<[string, string]>) =>
    JSON.stringify({count: tags.length, results: tags.map(([name, pushed]) => ({name, tag_last_pushed: pushed}))});
  const staticRoutes: Array<[string, string | Promise<string>]> = [
    ...readdirSync(fixture("pypi")).map((file): [string, Promise<string>] =>
      [`/pypi/pypi/${parse(file).name.toLowerCase().replace(/[-_.]+/g, "-")}/json`, fixtureText(`pypi/${file}`)]),
    ...readdirSync(fixture("jsr")).map((file): [string, Promise<string>] =>
      [`/jsr/${parse(file).name.replace("__", "/")}/meta.json`, fixtureText(`jsr/${file}`)]),
    ["/github/repos/silverwind/updates/commits", fixtureText("github/updates-commits.json")],
    ["/github/repos/actions/checkout/tags", fixtureText("github/actions-checkout-tags.json")],
    ["/github/repos/actions/setup-node/tags", fixtureText("github/actions-setup-node-tags.json")],
    ["/github/repos/actions/checkout/git/commits/cccc000000000000000000000000000000000011", fixtureText("github/actions-checkout-commit-v10.0.1.json")],
    ["/github/repos/actions/setup-node/git/commits/bbbb000000000000000000000000000000000010", fixtureText("github/actions-setup-node-commit-v10.json")],
    ["/github/repos/actions/checkout/branches/main", JSON.stringify({commit: {sha: "aaaa000000000000000000000000000000000001"}})],
    ["/github/repos/actions/checkout/branches/release", JSON.stringify({commit: {sha: "bbbb000000000000000000000000000000000002"}})],
    ["/github/repos/tj-actions/changed-files/tags", "[]"],
    ["/docker/v2/repositories/library/node/tags", fixtureText("docker/node-tags.json")],
    ["/docker/v2/repositories/library/noty/tags", fixtureText("docker/node-tags.json")],
    ["/docker/v2/repositories/library/postgres/tags", fixtureText("docker/postgres-tags.json")],
    ["/docker/v2/repositories/library/redis/tags", fixtureText("docker/redis-tags.json")],
    ["/docker/v2/repositories/koalaman/shellcheck/tags", dockerTags(["v0.11.0", "2025-01-01T00:00:00Z"], ["v0.12.0", "2025-06-01T00:00:00Z"])],
    ["/docker/v2/repositories/koalaman/shellcheck/tags/v0.12.0", JSON.stringify({digest: "sha256:list-new"})],
    ["/docker/v2/repositories/example/makeallowed/tags",
      dockerTags(["1.0", "2025-01-01T00:00:00Z"], ["1.1", "2025-03-01T00:00:00Z"], ["2.0", "2025-06-01T00:00:00Z"])],
    ["/cargo/se/rd/serde", fixtureText("cargo/serde-index.ndjson")],
    ["/cargo/to/ki/tokio", cargoIndex("tokio", "1.35.0")],
    ["/cargo/ra/nd/rand", cargoIndex("rand", "0.9.0")],
    ["/cargo/se/rd/serde_json", cargoIndex("serde_json", "1.0.120")],
    ["/go/github.com/google/uuid/@latest", goLatest("v1.6.0", "2024-06-13T02:52:04Z")],
    ["/go/github.com/google/uuid/v2/@latest", goLatest("v2.0.0-20260217135312-8c5a7de9ffa1", "2026-02-17T13:53:12Z")],
    ["/go/github.com/google/go-github/v70/@latest", goLatest("v70.0.0", "2024-11-29T00:00:00Z")],
    ...Array.from({length: 12}, (_, index): [string, string] =>
      [`/go/github.com/google/go-github/v${index + 71}/@latest`, goLatest(`v${index + 71}.0.0`, "2025-01-01T00:00:00Z")]),
    ["/go/github.com/example/testpkg/@latest", goLatest("v1.0.0", "2024-01-01T00:00:00Z")],
    ["/go/github.com/example/testpkg/v2/@latest", goLatest("v2.0.0", "2025-01-01T00:00:00Z")],
    ["/go/github.com/example/prerelpkg/@latest", goLatest("v1.1.0-rc.1", "2025-06-01T00:00:00Z")],
    ["/go/gitea.com/gitea/act/@latest", goLatest("v0.261.7", "2025-06-01T00:00:00Z")],
    ["/go/github.com/example/pseudopkg/@latest", goLatest("v0.4.1", "2023-06-01T00:00:00Z")],
    ["/go/github.com/example/pseudoupd/@latest", goLatest("v1.5.0", "2025-06-01T00:00:00Z")],
    ["/go/github.com/example/makeallowed/@latest", goLatest("v1.1.0", "2025-01-01T00:00:00Z")],
    ["/go/github.com/example/makeallowed/v2/@latest", goLatest("v2.0.0", "2025-06-01T00:00:00Z")],
    ["/go/github.com/example/listonly/@v/list", "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n"],
    ["/go/github.com/example/listonly/@v/v1.2.0.info", goLatest("v1.2.0", "2025-03-01T00:00:00Z")],
    ["/go/github.com/example/listtime/@v/list", "v1.0.0 2024-01-01T00:00:00Z\nv1.1.0 2024-06-01T00:00:00Z\n"],
  ];
  await Promise.all(staticRoutes.map(async ([path, body]) => {
    const gz = await promisify(gzip)(await body, gzipOptions);
    routes.set(path, (_, res) => res.send(gz));
  }));
  routes.set("/github/user", (req, res) => {
    res.writeHead(req.headers.authorization === "Bearer tok" ? 200 : 401).end(JSON.stringify({login: "someone"}));
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  if (originalXdgConfigHome === undefined) delete env.XDG_CONFIG_HOME;
  else env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await Promise.all([rm(testDir, {recursive: true}), new Promise(resolve => mockServer.close(resolve))]);
});

async function runCliExec(argv: Array<string>): Promise<Record<string, any>> {
  const {args, positionals} = parseCliArgs(argv);
  const output = await updates({...await resolveConfig(args, positionals), noCache: true});
  return {...(output.message ? {message: output.message} : {results: output.results}), ...(output.errors?.length && {errors: output.errors})};
}

async function captureCli(argv: Array<string>, stdin?: Readable, moduleUrl = pathToFileURL(sourceScript).href) {
  let stdout = "";
  let stderr = "";
  const exitCode = await cliStderr.run(text => { stderr += text; }, () =>
    runCli(argv, {stdout: text => { stdout += text; }, stdoutIsTTY: false, stdin, moduleUrl}, false));
  return {stdout, stderr, exitCode};
}

type Row = [mode: string, type: string, name: string, dependency: Record<string, string>];
const dep = (info: string, newVersion: string, old: string) => ({info, new: newVersion, old});

function dependencyRows(results: Record<string, Record<string, Record<string, Record<string, string>>>>): Array<Row> {
  const key = ([mode, type, name]: Row) => `${mode}\0${type}\0${name}`;
  return Object.entries(results).flatMap(([mode, types]) => Object.entries(types).flatMap(([type, dependencies]) =>
    Object.entries(dependencies).map(([name, {age: _age, ...dependency}]): Row => [mode, type, name, dependency])))
    .sort((left, right) => key(left) < key(right) ? -1 : 1);
}

async function makeTest(args: string) {
  const argv = args.split(" ");
  const {results} = await runCliExec([...argv, "-c", ...apiArgs, ...(argv.includes("-f") ? [] : ["-f", join(testDir, "package.json")])]);
  return results && dependencyRows(results);
}

function writeTree(name: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(testDir, `${name}-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), {recursive: true});
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function copyFixture(name: string) {
  const dir = mkdtempSync(join(testDir, `${name}-`));
  cpSync(fixture(name), dir, {recursive: true});
  return dir;
}

const sequential = (test as any).serial ?? test;

sequential("login verifies and stores tokens, logout removes them", {concurrent: false}, async () => {
  const path = join(env.XDG_CONFIG_HOME!, "updates", "tokens.json");
  const login = (token: string) => captureCli(["--login", "github.com", "--forgeapi", githubUrl], Readable.from([`${token}\n`]));
  expect(await login("bad")).toEqual({stdout: "token for github.com was rejected\n", stderr: "", exitCode: 1});
  expect(existsSync(path)).toBe(false);
  expect(await login("tok")).toEqual({stdout: "stored token for github.com (someone)\n", stderr: "", exitCode: 0});
  expect(JSON.parse(read(path))).toEqual({"github.com": "tok"});
  expect(statSync(path).mode & 0o777).toBe(platform === "win32" ? 0o666 : 0o600);
  expect(await captureCli(["--logout", "github.com"])).toEqual({stdout: "removed token for github.com\n", stderr: "", exitCode: 0});
  expect(await captureCli(["--logout", "github.com"])).toEqual({stdout: "no stored token for github.com\n", stderr: "", exitCode: 1});
});

test("text output lists every dep, one row per version across sections", async () => {
  const {stdout, stderr} = await captureCli(["-n", ...apiArgs, "-f", testFile]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
  expect(stdout.split("\n").filter(line => line.includes("@babel/preset-env"))).toHaveLength(3);
  expect(stdout).toContain("~6.0.0 || ~7.11.5");
});

test("version info fallback", async () => {
  const {noty} = (await runCliExec(["-j", "-n", ...apiArgs, "-f", testFile, "-i", "noty"])).results.npm.dependencies;
  expect(noty.new).toBe("3.1.4");
  expect(noty.age).toBeTruthy();
});

test("version resolves the source and built package layouts", async () => {
  const dir = writeTree("version-layouts", {
    "package.json": JSON.stringify({version: "wrong"}),
    "updates/package.json": JSON.stringify({version: "1.2.3", type: "module"}),
  });
  for (const entry of [join(dir, "updates", "index.ts"), join(dir, "updates", "dist", "index.ts")]) {
    expect(await captureCli(["--version"], undefined, pathToFileURL(entry).href)).toMatchObject({stdout: "1.2.3\n", stderr: ""});
  }
});

test("empty", async () => {
  const {stdout, stderr} = await captureCli(["-n", ...apiArgs, "-f", emptyFile]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
});

test("npm alias resolves the aliased package, and a second run is a no-op", async () => {
  const dir = writeTree("npm-alias", {
    "package.json": JSON.stringify({dependencies: {
      "package-matched": "npm:gulp-sourcemaps@^2.0.0",
      "dep-matched": "npm:gulp-sourcemaps@^2.0.0",
      "tagged": "npm:gulp-sourcemaps@latest",
    }}, null, 2),
    "renovate.json": JSON.stringify({packageRules: [
      {matchPackageNames: ["gulp-sourcemaps"], allowedVersions: "<=2.5.2"},
      {matchDepNames: ["dep-matched"], allowedVersions: "<=2.4.1"},
    ]}),
  });
  const run = () => updates({files: [join(dir, "package.json")], registry: npmUrl, update: true, color: false, noCache: true});
  const {dependencies} = (await run()).results.npm;
  expect(dependencies["package-matched"]).toMatchObject({old: "npm:gulp-sourcemaps@^2.0.0", new: "npm:gulp-sourcemaps@^2.5.2"});
  expect(dependencies["dep-matched"]).toMatchObject({old: "npm:gulp-sourcemaps@^2.0.0", new: "npm:gulp-sourcemaps@^2.4.1"});
  expect(dependencies.tagged).toBeUndefined();
  const written = read(dir, "package.json");
  expect(JSON.parse(written).dependencies).toMatchObject({
    "package-matched": "npm:gulp-sourcemaps@^2.5.2",
    "dep-matched": "npm:gulp-sourcemaps@^2.4.1",
  });
  await run();
  expect(read(dir, "package.json")).toBe(written);
});

test("piped output stays colored with -c, on stdout and on -V stderr, and parseable with -u -j", async () => {
  const pkgPath = join(writeTree("stdout-flags", {"package.json": JSON.stringify({dependencies: {prismjs: "1.0.0"}})}), "package.json");
  const {stdout: colored, stderr: verbose} = await captureCli(["-c", "-V", ...apiArgs, "-f", pkgPath]);
  expect(colored).toContain("\u001b[");
  expect(verbose).toContain("\u001b[");
  const {stdout: json} = await captureCli(["-u", "-j", ...apiArgs, "-f", pkgPath]);
  expect(JSON.parse(json).results.npm.dependencies.prismjs.new).toBe("1.17.1");
});

test.skipIf(Boolean(versions.bun))("global", async () => {
  const bin = join(testDir, "global", ...(platform === "win32" ? ["updates.cmd"] : ["bin", "updates"]));
  mkdirSync(dirname(bin), {recursive: true});
  if (platform === "win32") writeFileSync(bin, `@node "${script}" %*\r\n`);
  else symlinkSync(script, bin);
  const {stdout, stderr} = await execFileAsync(bin, ["-n", ...apiArgs, "-f", testFile], {shell: platform === "win32"});
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
});

const latestRows: Array<Row> = [
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

const prereleaseRows: Array<Row> = [
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
];

const pick = (rows: Array<Row>, ...names: Array<string>) => rows.filter(row => names.includes(row[2]));

const goRows: Array<Row> = [
  ["go", "deps", "github.com/example/listonly", dep("https://github.com/example/listonly", "1.2.0", "1.0.0")],
  ["go", "deps", "github.com/example/listtime", dep("https://github.com/example/listtime", "1.1.0", "1.0.0")],
  ["go", "deps", "github.com/google/go-github/v70", dep("https://github.com/google/go-github", "82.0.0", "70.0.0")],
  ["go", "deps", "github.com/google/uuid", dep("https://github.com/google/uuid", "2.0.0-2026021", "1.5.0")],
];

const goPrereleaseRows: Array<Row> = [["go", "deps", "github.com/example/prerelpkg", dep("https://github.com/example/prerelpkg", "1.1.0-rc.1", "1.0.0")]];

test.each([
  ["latest", "-j", latestRows],
  ["prerelease", "-j -g -p", prereleaseRows],
  ["release", "-j -R", latestRows.filter(row => !["eslint-plugin-storybook", "html-webpack-plugin"].includes(row[2]))],
  ["release with allow-downgrade", "-j -R -d -i eslint-plugin-storybook", [
    ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "9.1.7", "10.0.0-beta.5")],
  ]],
  ["patch", "-j -P", [
    ["npm", "dependencies", "eslint-plugin-storybook", dep("https://github.com/storybookjs/storybook/tree/HEAD/code/lib/eslint-plugin", "10.0.0-beta.6", "10.0.0-beta.5")],
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/floridoo/gulp-sourcemaps", "2.0.1", "2.0.0")],
    ["npm", "dependencies", "html-webpack-plugin", dep("https://github.com/jantimon/html-webpack-plugin", "4.0.0-beta.11", "4.0.0-alpha.2")],
    ["npm", "dependencies", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
    ["npm", "dependencies", "updates", dep("https://github.com/silverwind/updates", "537ccb7", "6941e05")],
    ["npm", "overrides", "noty", dep("https://github.com/needim/noty", "3.1.4", "3.1.0")],
    ["npm", "packageManager", "npm", dep("https://github.com/npm/cli", "11.6.2", "11.6.0")],
    ["npm", "resolutions", "versions/updates", dep("https://github.com/silverwind/updates", "^1.0.6", "^1.0.0")],
  ]],
  ["include", "-j -i noty", pick(latestRows, "noty")],
  ["include regex", "-j -i /^noty/", pick(latestRows, "noty")],
  ["cooldown duration", "-j -i noty -C 12h", pick(latestRows, "noty")],
  ["packageManager", "-j -i npm", pick(latestRows, "npm")],
  ["overrides type", "-j -t overrides", latestRows.filter(row => row[1] === "overrides")],
  ["exclude and regex include select only matching packages", "-j -e gulp-sourcemaps -i /react/", pick(latestRows, "react")],
  ["glob include selects matching packages", "-j -i gulp*", pick(latestRows, "gulp-sourcemaps")],
  ["regex include and glob patch select matching packages", "-j -i /^gulp/ -P gulp*", [
    ["npm", "dependencies", "gulp-sourcemaps", dep("https://github.com/floridoo/gulp-sourcemaps", "2.0.1", "2.0.0")],
  ]],
  ["prerelease selection", "-j -i noty -p", pick(prereleaseRows, "noty")],
  ["a /regex/ greatest value applies to the packages it matches alone", "-j -i gulp-sourcemaps,noty -g /^gulp/", pick(latestRows, "gulp-sourcemaps", "noty")],
  ["a /regex/ prerelease value applies to the packages it matches alone", "-j -i gulp-sourcemaps,noty -p /^noty/", pick(prereleaseRows, "gulp-sourcemaps", "noty")],
  ["repeated multi-value flag survives swallowed flag recovery", "-j -i react -i -p", pick(prereleaseRows, "react")],
  ["repeated multi-value flag survives swallowed flag recovery when not last", "-j -i react -i -p -i gulp-sourcemaps", pick(prereleaseRows, "react", "gulp-sourcemaps")],
  ["jsr", `-j -f ${fixture("npm-jsr/package.json")}`, [
    ["npm", "dependencies", "@std/semver", dep("", "1.0.8", "1.0.5")],
    ["npm", "devDependencies", "@std/path", dep("", "1.0.8", "1.0.0")],
  ]],
  ["uv", `-j -f ${uvFile}`, [
    ["pypi", "dependency-groups.dev", "PyYAML", dep("https://github.com/yaml/pyyaml", "6.0", "1.0")],
    ["pypi", "dependency-groups.dev", "types-requests", dep("https://github.com/python/typeshed", "2.32.4.20250611", "2.32.0.20240622")],
    ["pypi", "project.dependencies", "djlint", dep("https://github.com/Riverside-Healthcare/djlint", "1.31.0", "1.30.0")],
    ["pypi", "project.dependencies", "ty", dep("https://github.com/astral-sh/ty", "0.0.1a19", "0.0.1a15")],
  ]],
  ["cargo", `-j -f ${fixture("cargo/Cargo.toml")}`, [
    ["cargo", "dependencies", "tokio", dep("https://crates.io/crates/tokio", "1.35", "1.0")],
    ["cargo", "dev-dependencies", "rand", dep("https://crates.io/crates/rand", "0.9", "0.8")],
    ["cargo", "target.cfg(unix).dependencies", "rand", dep("https://crates.io/crates/rand", "0.9", "0.8")],
  ]],
  ["go", `-j -f ${goFile}`, goRows],
  ["go indirect", `-j -f ${goFile} -I`, [
    ...goRows,
    ["go", "indirect", "github.com/example/testpkg", dep("https://github.com/example/testpkg", "2.0.0", "0.9.0")],
  ]],
  ["go prerelease is excluded by default", `-j -f ${goPreFile}`, undefined],
  ["go prerelease is enabled globally", `-j -f ${goPreFile} -p`, goPrereleaseRows],
  ["go prerelease is enabled per package", `-j -f ${goPreFile} -p github.com/example/prerelpkg`, goPrereleaseRows],
  ["go pseudo-version no downgrade", `-j -f ${fixture("go-pseudo/go.mod")}`, undefined],
])("%s", async (_name, args, expected) => {
  expect(await makeTest(args)).toEqual(expected);
});

test("invalid config", async () => {
  const {stdout, exitCode} = await captureCli(["-j", "-f", fixture("invalid-config/package.json"), "-c", ...apiArgs]);
  expect(exitCode).toBe(1);
  expect(stdout).toContain("updates.config.js");
  expect(stdout).toContain("Unable to parse");
});

test("go @v/list fallback takes a date off the list line when .info is absent", async () => {
  const {results} = await runCliExec(["-j", "-f", goFile, "-c", "--goproxy", goProxyUrl]);
  expect(results.go.deps["github.com/example/listtime"].age).toBeTruthy();
});

test("a fractional timeout does not throw a non-integer AbortSignal delay, a negative one is rejected on the cli and through the api", async () => {
  const {results} = await updates({files: [goFile], goproxy: goProxyUrl, timeout: 9999.4, color: false, noCache: true});
  expect(results?.go?.deps).toBeTruthy();
  await expect(runCliExec(["-T", "-5", ...apiArgs, "-f", testFile])).rejects.toThrow(/timeout/i);
  await expect(updates({files: [goFile], goproxy: goProxyUrl, timeout: -1, color: false, noCache: true})).rejects.toThrow(/invalid timeout/i);
});

test.each([
  [["-N", "a/**,{b,c}/**", "-X", "d/**"], {includePaths: ["a/**", "{b,c}/**"], excludePaths: ["d/**"]}],
  [["-n"], {color: false, noColor: true}],
  [["-c"], {color: true, noColor: false}],
  [["-c", "-n"], {color: false, noColor: true}],
])("cli flags %s reach the config", async (argv, expected) => {
  const {args, positionals} = parseCliArgs(argv);
  expect(await resolveConfig(args, positionals)).toMatchObject(expected);
});

test("an = joined value is not taken for a flag", () => {
  expect(parseCliArgs(["-i", "noty", "--exclude=-u"]).args).toEqual({include: ["noty"], exclude: ["-u"]});
});

test("go update", async () => {
  const dir = copyFixture("go-update");
  await runCliExec(["-u", "-f", join(dir, "go.mod"), "-c", "--goproxy", goProxyUrl]);
  const goMod = read(dir, "go.mod");
  expect(goMod.match(/github\.com\/google\/uuid\/v2 v2\.0\.0-20260217135312-8c5a7de9ffa1/g)).toHaveLength(4);
  expect(goMod).not.toContain("uuid v1.5.0");
  expect(goMod).not.toContain("go-github/v70");
  expect(goMod).toMatch(/github\.com\/google\/go-github\/v\d+ v\d+\.\d+\.\d+/);
  const main = read(dir, "main.go");
  expect(main).not.toContain("go-github/v70");
  expect(main).toMatch(/go-github\/v\d+\/github/);
});

test("go update v1 to v2", async () => {
  const dir = copyFixture("go-update-v2");
  await runCliExec(["-u", "-f", join(dir, "go.mod"), "-c", "--goproxy", goProxyUrl]);
  const goMod = read(dir, "go.mod");
  expect(goMod).toContain("github.com/example/testpkg/v2 v2.0.0");
  expect(goMod).not.toContain("testpkg v1.0.0");
  const main = read(dir, "main.go");
  expect(main).toContain(`"github.com/example/testpkg/v2"`);
  expect(main).toContain(`"github.com/example/testpkg/v2/sub"`);
  expect(main).not.toMatch(/"github\.com\/example\/testpkg"(?!\/v2)/);
});

test("go pseudo-version update rewrites the full version", async () => {
  const modPath = join(copyFixture("go-pseudo-update"), "go.mod");
  await updates({files: [modPath], goproxy: goProxyUrl, update: true, indirect: true, color: false, noCache: true});
  const updated = read(modPath);
  expect(updated).toContain("github.com/example/pseudoupd v1.5.0");
  expect(updated).not.toContain("20221128193559");
  expect(updated).not.toContain("754e69321358");
});

test("make mode bumps go install versions and rewrites paths on major bumps", async () => {
  const dir = writeTree("make", {Makefile: lines(
    "UUID_PACKAGE ?= github.com/google/uuid@v1.4.0",
    "TESTPKG_PACKAGE := github.com/example/testpkg@v1.0.0  # pinned tool",
    "# DISABLED := github.com/example/testpkg@v0.5.0",
    "SOURCE := $(wildcard *.go)",
  )});
  await updates({files: [join(dir, "Makefile")], goproxy: goProxyUrl, update: true, color: false, noCache: true});
  expect(read(dir, "Makefile")).toBe(lines(
    "UUID_PACKAGE ?= github.com/google/uuid/v2@v2.0.0-20260217135312-8c5a7de9ffa1",
    "TESTPKG_PACKAGE := github.com/example/testpkg/v2@v2.0.0  # pinned tool",
    "# DISABLED := github.com/example/testpkg@v0.5.0",
    "SOURCE := $(wildcard *.go)",
  ));
});

test("auto-discovery finds a Makefile once on a case-insensitive filesystem", async () => {
  const dir = writeTree("make-discovery", {Makefile: "UUID_PACKAGE ?= github.com/google/uuid@v1.4.0\n"});
  const {results} = await runCliExec(["-j", "-x", "-M", "make", ...apiArgs, "-f", dir]);
  expect(Object.keys(results.make).map(file => basename(file))).toEqual(["Makefile"]);
});

test("auto-discovery finds tracked and untracked files at any depth, skipping gitignored ones unless passed and excluded paths", async () => {
  const makefile = "UUID_PACKAGE ?= github.com/google/uuid@v1.4.0\n";
  const dir = realpathSync.native(writeTree("discovery", {
    "Makefile": makefile, "tools/tools.mk": makefile, "deep/er/Makefile": makefile, "node_modules/pkg/Makefile": makefile,
    "untracked/Makefile": makefile, "gitignored/Makefile": makefile, "svc/app.Dockerfile": "FROM node:18\n", ".gitignore": "gitignored/\n",
  }));
  await execFileAsync("git", ["init", "-q"], {cwd: dir});
  await execFileAsync("git", ["add", ".", ":!untracked"], {cwd: dir});
  const discovered = async (options: UpdatesOptions) => Object.values((await updates(apiOpts({files: [dir], modes: ["make", "docker"], ...options}))).results)
    .flatMap(Object.keys).map(file => relative(dir, file).replaceAll("\\", "/")).sort();
  expect(await discovered({})).toEqual(["Makefile", "deep/er/Makefile", "svc/app.Dockerfile", "tools/tools.mk", "untracked/Makefile"]);
  expect(await discovered({excludePaths: ["deep/**"]})).toEqual([
    "Makefile", "node_modules/pkg/Makefile", "svc/app.Dockerfile", "tools/tools.mk", "untracked/Makefile",
  ]);
  expect(await discovered({includePaths: ["tools/**"]})).toEqual(["tools/tools.mk"]);
  expect(await discovered({files: [join(dir, "gitignored")]})).toEqual(["gitignored/Makefile"]);
  expect(await discovered({files: [join(dir, "gitignored/Makefile")]})).toEqual(["gitignored/Makefile"]);
});

test("make mode bumps docker image tags and re-resolves digests in Makefiles", async () => {
  const dir = writeTree("make-docker", {Makefile: lines(
    `SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@sha256:${"a".repeat(64)}  # renovate: datasource=docker`,
    "PLAIN := koalaman/shellcheck:v0.11.0",
    "TEST_MYSQL_HOST ?= mysql:3306",
  )});
  await updates({files: [join(dir, "Makefile")], dockerapi: dockerUrl, update: true, color: false, noCache: true});
  expect(read(dir, "Makefile")).toBe(lines(
    "SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.12.0@sha256:list-new  # renovate: datasource=docker",
    "PLAIN := koalaman/shellcheck:v0.12.0",
    "TEST_MYSQL_HOST ?= mysql:3306",
  ));
});

test("make allowedVersions falls back to the highest allowed candidate", async () => {
  const dir = writeTree("make-allowed", {
    "Makefile": lines("TOOL := github.com/example/makeallowed/cmd/tool@v1.0.0", "IMAGE := example/makeallowed:1.0"),
    "renovate.json": JSON.stringify({packageRules: [
      {matchPackageNames: ["github.com/example/makeallowed/cmd/tool"], allowedVersions: "<2"},
      {matchPackageNames: ["example/makeallowed"], allowedVersions: "<2"},
    ]}),
  });
  await updates({files: [join(dir, "Makefile")], modes: ["make"], goproxy: goProxyUrl, dockerapi: dockerUrl, update: true, color: false, noCache: true});
  expect(read(dir, "Makefile")).toBe(lines("TOOL := github.com/example/makeallowed/cmd/tool@v1.1.0", "IMAGE := example/makeallowed:1.1"));
});

test("docker image names match with and without the docker.io prefix", async () => {
  const makefile = lines("PREFIXED := docker.io/koalaman/shellcheck:v0.11.0", "PLAIN := koalaman/shellcheck:v0.11.0");
  const dir = writeTree("docker-io-prefix", {Makefile: makefile});
  for (const options of [{pin: {"koalaman/shellcheck": "0.11.x"}}, {exclude: ["docker.io/koalaman/shellcheck"]}]) {
    await updates({files: [join(dir, "Makefile")], dockerapi: dockerUrl, update: true, color: false, noCache: true, ...options});
    expect(read(dir, "Makefile")).toBe(makefile);
  }
  const clashDir = writeTree("docker-npm-name-clash", {"package.json": JSON.stringify({dependencies: {noty: "3.1.0"}}), "Dockerfile": "FROM noty:18\n"});
  const clash = await updates({
    files: [clashDir], registry: npmUrl, forgeapi: githubUrl, dockerapi: dockerUrl, color: false, noCache: true, patch: ["docker.io/library/noty"],
  });
  expect(clash.results.npm.dependencies.noty.new).toBe("3.1.4");
  expect(clash.results.docker).toBeUndefined();
});

test("go replace reports and writes the update", async () => {
  const modPath = join(copyFixture("go-replace"), "go.mod");
  const {results} = await runCliExec(["-j", "-u", "-f", modPath, "-c", "--goproxy", goProxyUrl]);
  expect(dependencyRows(results)).toEqual([["go", "replace", "gitea.com/gitea/act", dep("https://gitea.com/gitea/act", "0.261.7", "0.261.4")]]);
  const updated = read(modPath);
  expect(updated).toContain("gitea.com/gitea/act v0.261.7");
  expect(updated).not.toContain("gitea.com/gitea/act v0.261.4");
  expect(updated).toContain("replace");
});

test("go workspace reports and writes member updates", async () => {
  const dir = copyFixture("go-workspace");
  appendFileSync(join(dir, "app", "go.mod"), "require example.com/workspace/lib v1.0.0\n");
  const {results: {go}, errors} = await updates({files: [join(dir, "go.work")], goproxy: goProxyUrl, update: true, color: false, noCache: true});
  expect(errors).toBeUndefined();
  expect(go["deps|./app"]["github.com/google/uuid"].old).toBe("1.5.0");
  expect(go["deps|./lib"]["github.com/google/uuid"].old).toBe("1.5.0");
  for (const member of ["app", "lib"]) {
    expect(read(dir, member, "go.mod")).toContain("github.com/google/uuid/v2 v2.0.0-20260217135312-8c5a7de9ffa1");
    expect(read(dir, member, "go.mod")).not.toContain("uuid v1.5.0");
  }
  expect(read(dir, "app", "main.go")).toContain('"github.com/google/uuid/v2"');
});

test("cargo workspace reports and writes root and member updates", async () => {
  const dir = copyFixture("cargo-workspace");
  const both = await updates({files: [join(dir, "crate-a", "Cargo.toml"), join(dir, "Cargo.toml")], cargoapi: cargoUrl, color: false, noCache: true});
  expect(Object.keys(both.results.cargo).filter(key => key.includes("crate-a"))).toHaveLength(1);

  const {cargo} = (await updates({files: [join(dir, "Cargo.toml")], cargoapi: cargoUrl, update: true, color: false, noCache: true})).results;
  expect(cargo).toMatchObject({
    "workspace.dependencies": {serde_json: {old: "1.0.100", new: "1.0.120"}},
    "dependencies|./crate-a": {serde: {old: "1.0.100", new: "1.0.200"}},
    "dependencies|./crate-b": {tokio: {old: "1.34.0", new: "1.35.0"}},
    "dev-dependencies|./crate-b": {rand: {old: "0.8.5", new: "0.9.0"}},
  });
  expect(read(dir, "Cargo.toml")).toContain('serde_json = "1.0.120"');
  expect(read(dir, "crate-a", "Cargo.toml")).toContain('serde = "1.0.200"');
  expect(read(dir, "crate-b", "Cargo.toml")).toContain('version = "1.35.0"');
  expect(read(dir, "crate-b", "Cargo.toml")).toContain('rand = "0.9.0"');
});

test("multiple Cargo workspace roots keep member config identity", async () => {
  const dir = writeTree("cargo-workspaces", Object.fromEntries([["one", "<=1.0.100"], ["two", "<=1.0.200"]].flatMap(([root, allowedVersions]) => [
    [`${root}/Cargo.toml`, '[workspace]\nmembers = ["crates/*"]\n'],
    [`${root}/crates/app/Cargo.toml`, '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0.0"\n'],
    [`${root}/renovate.json`, JSON.stringify({packageRules: [{matchPackageNames: ["serde"], allowedVersions}]})],
  ])));
  await updates({
    files: [join(dir, "one", "Cargo.toml"), join(dir, "two", "Cargo.toml")], cargoapi: cargoUrl, modes: ["cargo"], update: true, color: false, noCache: true,
  });
  expect(read(dir, "one", "crates", "app", "Cargo.toml")).toContain('serde = "1.0.100"');
  expect(read(dir, "two", "crates", "app", "Cargo.toml")).toContain('serde = "1.0.200"');
});

test("pnpm workspace", async () => {
  const options = {registry: npmUrl, forgeapi: githubUrl, color: false, noCache: true};
  const {npm} = (await updates({...options, files: [pnpmWorkspaceFile]})).results;
  expect(npm.devDependencies.typescript.new).toBeTruthy();
  expect(npm["dependencies|./packages/app-a"].prismjs.new).toBeTruthy();
  expect(npm["dependencies|./packages/lib-b"].react.new).toBeTruthy();
  expect(npm["catalog|pnpm-workspace.yaml"].svgstore.new).toBeTruthy();
  expect(npm["catalogs.build|pnpm-workspace.yaml"].typescript.new).toBeTruthy();
  expect(npm["dependencies|./packages/lib-b"].svgstore).toBeUndefined();
  const fromMember = await updates({...options, files: [fixture("pnpm-workspace/packages/app-a/package.json"), pnpmWorkspaceFile]});
  expect(Object.keys(fromMember.results.npm).sort()).toEqual(Object.keys(npm).sort());
});

test("pnpm workspace update, and a second run is a no-op", async () => {
  const dir = copyFixture("pnpm-workspace");
  const run = () => runCliExec(["-u", "-f", join(dir, "pnpm-workspace.yaml"), "-c", ...apiArgs]);
  await run();
  expect(read(dir, "package.json")).not.toContain('"^4"');
  expect(read(dir, "packages", "app-a", "package.json")).not.toContain('"1.0.0"');
  expect(read(dir, "packages", "lib-b", "package.json")).not.toContain('"18.0"');
  expect(read(dir, "packages", "lib-b", "package.json")).toContain('"svgstore": "catalog:"');
  const workspace = read(dir, "pnpm-workspace.yaml");
  expect(workspace).toContain('  svgstore: "^2.0.3"  # pinned');
  expect(workspace).toContain("    typescript: ^5\n");
  await run();
  expect(read(dir, "pnpm-workspace.yaml")).toBe(workspace);
});

test("pnpm workspace alongside unrelated package.json", async () => {
  for (const files of [[pnpmWorkspaceFile, testFile], [testFile, pnpmWorkspaceFile]]) {
    const {npm} = (await updates({files, registry: npmUrl, forgeapi: githubUrl, color: false, noCache: true})).results;
    expect(npm.devDependencies.typescript.new).toBeTruthy();
    expect(npm["dependencies|./packages/app-a"].prismjs.new).toBeTruthy();
    expect(npm["dependencies|./packages/lib-b"].react.new).toBeTruthy();
    expect(Object.values(npm).flatMap(group => Object.keys(group))).toContain("gulp-sourcemaps");
  }
});

test("multiple npm workspace roots keep dependency and config identity", async () => {
  const rules = (react: string, noty: string) => JSON.stringify({packageRules: [
    {matchPackageNames: ["react"], allowedVersions: react},
    {matchPackageNames: ["noty"], allowedVersions: noty},
  ]});
  const member = JSON.stringify({dependencies: {noty: "^3.1.0"}});
  const dir = writeTree("multiple-npm-workspaces", {
    "array/package.json": JSON.stringify({workspaces: ["packages/*"], dependencies: {react: "^17.0.0"}}),
    "array/packages/app/package.json": member,
    "array/renovate.json": rules("<=18.2.0", "<=3.1.4"),
    "object/package.json": JSON.stringify({workspaces: {packages: ["packages/*"]}, dependencies: {react: "^17.0.0"}}),
    "object/packages/app/package.json": member,
    "object/renovate.json": rules("<=18.1.0", "<=3.1.3"),
  });
  await updates(apiOpts({files: [join(dir, "array", "package.json"), join(dir, "object", "package.json")], modes: ["npm"], update: true}));
  const dependencies = (...path: Array<string>) => JSON.parse(read(dir, ...path, "package.json")).dependencies;
  expect(dependencies("array").react).toBe("^18.2.0");
  expect(dependencies("object").react).toBe("^18.1.0");
  expect(dependencies("array", "packages", "app").noty).toBe("^3.1.4");
  expect(dependencies("object", "packages", "app").noty).toBe("^3.1.3");
});

test("local npm dependencies are neither requested nor rewritten", async () => {
  const content = `${JSON.stringify({dependencies: {"local-file": "file:../local-file", "local-link": "link:../local-link"}}, null, 2)}\n`;
  const file = join(writeTree("local-npm-dependencies", {"package.json": content}), "package.json");
  await updates(apiOpts({files: [file], modes: ["npm"], update: true}));
  expect(requestedUrls.filter(url => url.startsWith("/npm/local-"))).toEqual([]);
  expect(read(file)).toBe(content);
});

test("npm workspace members are skipped, published or not, the root and an alias are not", async () => {
  const dir = writeTree("internal-workspace-packages", {
    "package.json": JSON.stringify({
      name: "react", workspaces: ["packages/*"], overrides: {"internal-lib": "^1.0.0"}, resolutions: {"react/internal-lib": "^1.0.0"},
    }),
    "packages/noty/package.json": JSON.stringify({name: "noty", version: "3.1.0"}),
    "packages/unpublished/package.json": JSON.stringify({name: "internal-lib"}),
    "packages/app/package.json": JSON.stringify({
      name: "app", dependencies: {"internal-lib": "^1.0.0", noty: "^3.1.0", react: "^17.0.0", aliased: "npm:noty@^3.1.0"},
    }),
  });
  const {errors} = await updates(apiOpts({files: [join(dir, "package.json")], modes: ["npm"], update: true}));
  expect(errors).toBeUndefined();
  const {dependencies} = JSON.parse(read(dir, "packages", "app", "package.json"));
  expect(dependencies.noty).toBe("^3.1.0");
  expect(dependencies.react).not.toBe("^17.0.0");
  expect(dependencies.aliased).toBe("npm:noty@^3.1.4");
});

test("pin holds the range and keeps the authored precision", async () => {
  const dependencies = await npmUpdates({pin: {prismjs: "^1.0.0", react: "^18.0.0"}});
  expect(satisfies(dependencies.prismjs.new, "^1.0.0")).toBe(true);
  expect(dependencies.react.new).toBe("18.2");
});

test("a config-file pin and overrides merge with the renovate ones and a sub-day renovate cooldown rather than replacing them", async () => {
  const dir = writeTree("pinmerge", {
    "package.json": JSON.stringify({dependencies: {noty: "3.1.0"}}),
    "renovate.json": JSON.stringify({minimumReleaseAge: "50ms", packageRules: [
      {matchPackageNames: ["noty"], allowedVersions: "<3.1.4"},
      {matchPackageNames: ["esbuild"], minimumReleaseAge: "1 day"},
    ]}),
    "updates.config.js": `module.exports = {inherit: {renovate: {cooldown: true}}, ` +
      `pin: {"gulp-sourcemaps": "^2.0.0"}, overrides: [{include: ["gulp-sourcemaps"], greatest: true}]};\n`,
  });
  expect((await npmUpdates({files: [join(dir, "package.json")]})).noty.new).toBe("3.1.3");
  const {args, positionals} = parseCliArgs(["-f", join(dir, "package.json")]);
  const resolved = await resolveConfig(args, positionals) as UpdatesOptions & {renovateVersionRules: Array<Record<string, any>>};
  expect(resolved.overrides).toEqual([{include: ["gulp-sourcemaps"], greatest: true}]);
  expect(resolved.renovateVersionRules).toContainEqual({matchPackageNames: ["esbuild"], cooldownDays: 1});
});

test.each([
  ["a renovate packageRules cooldown still requests the dated npm document", "7 days", ""],
  ["a config-file cooldown override wins over an inherited renovate packageRule", "999999 days", `, overrides: [{include: ["noty"], cooldown: 0}]`],
])("%s", async (_name, minimumReleaseAge, extraConfig) => {
  const dir = writeTree("renovate-cooldown", {
    "package.json": JSON.stringify({dependencies: {noty: "3.1.0"}}),
    "renovate.json": JSON.stringify({packageRules: [{matchPackageNames: ["noty"], minimumReleaseAge}]}),
    "updates.config.js": `module.exports = {inherit: {renovate: {cooldown: true}}${extraConfig}};\n`,
  });
  expect((await npmUpdates({files: [join(dir, "package.json")]})).noty.new).toBe("3.1.4");
});

const actionsArgs = ["-c", "--forgeapi", githubUrl, "--dockerapi", dockerUrl, "-M", "actions"];
const workflowSteps = (...steps: Array<string>) =>
  lines("name: ci", "on: push", "jobs:", "  ci:", "    runs-on: ubuntu-latest", "    steps:", ...steps.map(step => `      - uses: ${step}`));

test("branch-only actions do not fetch forge metadata", async () => {
  const dir = writeTree("actions-branches", {".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: one/repo@main\n      - uses: two/repo@develop\n"});
  await updates({files: [join(dir, ".github/workflows/ci.yml")], modes: ["actions"], forgeapi: githubUrl, noCache: true, noColor: true});
  expect(requestedUrls.filter(url => /^\/github\/repos\/(?:one|two)\/repo\//.test(url))).toEqual([]);
});

test("actions scan older tags for configured downgrades and pins", async () => {
  const dir = writeTree("actions-older", {".github/workflows/ci.yml": lines("jobs:", "  test:", "    steps:", "      - uses: o/down@v10.0.0-alpha", "      - uses: o/pinned@v10.0.0")});
  for (const repo of ["down", "pinned"]) {
    routes.set(`/github/repos/o/${repo}/tags`, (req, res) => {
      const page = Number(new URL(req.url, githubUrl).searchParams.get("page"));
      const names = ["main", "edge", repo === "down" ? "v10.0.0-alpha" : "v10.0.0", "legacy", "v9.0.0"];
      res.setHeader("Link", `<${githubUrl}repos/o/${repo}/tags?per_page=100&page=5>; rel="last"`);
      res.end(JSON.stringify([{name: names[page - 1], commit: {sha: `${repo}${page}`}}]));
    });
  }
  const output = await updates({
    files: [join(dir, ".github/workflows/ci.yml")], modes: ["actions"], forgeapi: githubUrl, noCache: true, noColor: true,
    allowDowngrade: ["o/down"], pin: {"o/pinned": "^9"},
  });
  expect(Object.values(output.results.actions)[0]).toMatchObject({"o/down": {new: "9.0.0"}, "o/pinned": {new: "9.0.0"}});
});

const checkoutUpdate = {"actions/checkout": {old: "2", new: "10", info: "https://github.com/actions/checkout"}};
const setupNodeUpdates = {"actions/setup-node@v1.0": {old: "1.0", new: "10.0.0"}, "actions/setup-node@v1.0.0": {old: "1.0.0", new: "10.0.0"}};

test.each([
  ["basic", ["-f", actionsDir], {...checkoutUpdate, ...setupNodeUpdates}],
  ["positional args", [actionsDir], {...checkoutUpdate, ...setupNodeUpdates}],
  ["include filter, with no false upgrade on the same major", ["-f", actionsDir, "-i", "actions/checkout"], checkoutUpdate],
  ["exclude filter", ["-f", actionsDir, "-e", "actions/checkout"], setupNodeUpdates],
])("actions %s", async (_name, args, expected) => {
  const [dependencies] = Object.values<any>((await runCliExec([...actionsArgs, "-j", ...args])).results.actions);
  expect(Object.keys(dependencies)).toEqual(Object.keys(expected));
  expect(dependencies).toMatchObject(expected);
});

test("actions cooldown gates on the tag date after selection, not before", async () => {
  const run = (cooldown: string) => runCliExec([...actionsArgs, "-j", "-f", actionsDir, "-i", "actions/checkout", "-C", cooldown]);
  expect(Object.values((await run("1")).results.actions)[0]).toMatchObject({"actions/checkout": {new: "10"}});
  expect((await run("999999d")).message).toContain("up to date");
});

test("text output renders several modes with a MODE column", async () => {
  const {stdout, stderr} = await captureCli(["-n", "--forgeapi", githubUrl, "--dockerapi", dockerUrl, "-M", "actions,docker", "-f", actionsDir]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("MODE");
  expect(stdout).toContain("actions/checkout");
  expect(stdout).toContain("actions/setup-node");
  expect(stdout).toContain("https://hub.docker.com/_/node");
});

test("actions update rewrites tags and keeps same-sha pin identities distinct", async () => {
  const dir = writeTree("actions-update", {".github/workflows/ci.yaml": workflowSteps(
    "actions/checkout@v2",
    "actions/setup-node@v1",
    "actions/checkout@dddd000000000000000000000000000000000000 # v4.2.0",
    "actions/checkout@dddd000000000000000000000000000000000000 # main",
    "actions/checkout@dddd000000000000000000000000000000000000 # release",
  )});
  await runCliExec(["-u", ...actionsArgs, "-f", join(dir, ".github/workflows")]);
  expect(read(dir, ".github/workflows/ci.yaml")).toBe(workflowSteps(
    "actions/checkout@v10",
    "actions/setup-node@v10.0.0",
    "actions/checkout@cccc000000000000000000000000000000000011 # v10.0.1",
    "actions/checkout@aaaa000000000000000000000000000000000001 # main",
    "actions/checkout@bbbb000000000000000000000000000000000002 # release",
  ));
});

test("actions hash-pinned on a version comment updates the sha and the comment", async () => {
  const oldDigest = "dddd000000000000000000000000000000000000";
  const dir = writeTree("actions-hash", {".github/workflows/ci.yaml": workflowSteps(`actions/checkout@${oldDigest} # v4.2.0`, `actions/setup-node@${oldDigest} # v10.0.0`)});
  const {results} = await runCliExec(["-u", "-j", ...actionsArgs, "-f", join(dir, ".github/workflows")]);
  expect(Object.values(results.actions)[0]).toMatchObject({
    "actions/checkout": {old: "4.2.0", new: "10.0.1"},
    "actions/setup-node": {old: "v10.0.0", new: "v10.0.0", newDigest: "bbbb000000000000000000000000000000000010"},
  });
  expect(read(dir, ".github/workflows/ci.yaml")).toBe(workflowSteps(
    "actions/checkout@cccc000000000000000000000000000000000011 # v10.0.1",
    "actions/setup-node@bbbb000000000000000000000000000000000010 # v10.0.0",
  ));
});

test("actions composite action discovery", async () => {
  const {results} = await runCliExec([...actionsArgs, "-j", "-f", fixture("actions-composite/.github")]);
  const byFile = (suffix: string) => Object.entries<any>(results.actions).find(([file]) => file.replaceAll("\\", "/").endsWith(suffix))![1];
  expect(byFile("workflows/ci.yml")["actions/checkout"].new).toBe("10");
  expect(byFile("my-action/action.yml")["actions/setup-node"].new).toBe("10.0.0");
  expect(byFile("nested/sub/action.yaml")["actions/checkout"].new).toBe("10");
});

test("actions composite action update, in every forge dir", async () => {
  const dir = writeTree("composite-update", Object.fromEntries(forgeDirs.flatMap(forgeDir => [
    [`${forgeDir}/workflows/ci.yml`, workflowSteps("actions/checkout@v2")],
    [`${forgeDir}/actions/my-action/action.yml`, "name: my-action\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v1.0\n      shell: bash\n"],
  ])));
  await runCliExec(["-u", ...actionsArgs, "-f", dir]);
  for (const forgeDir of forgeDirs) {
    expect(read(dir, forgeDir, "workflows", "ci.yml")).toContain("actions/checkout@v10");
    expect(read(dir, forgeDir, "actions", "my-action", "action.yml")).toContain("actions/setup-node@v10.0.0");
  }
});

const dockerDeps = async (...args: Array<string>) => (await runCliExec(["-c", "--dockerapi", dockerUrl, "-M", "docker", "-j", ...args])).results.docker;

test.each([
  ["Dockerfile", fixture("docker/Dockerfile"), [], {
    "node:18": {old: "18", new: "22", info: "https://hub.docker.com/_/node"},
    "node:20": {old: "20", new: "22"},
    "postgres": {old: "15-alpine", new: "17-alpine", info: "https://hub.docker.com/_/postgres"},
  }],
  ["compose", composeFixture, [], {node: {old: "18", new: "22"}, postgres: {old: "15-alpine", new: "17-alpine"}, redis: {old: "7", new: "8"}}],
  ["compose include filter", composeFixture, ["-i", "node"], {node: {old: "18", new: "22"}}],
  ["compose exclude filter", composeFixture, ["-e", "node"], {postgres: {old: "15-alpine", new: "17-alpine"}, redis: {old: "7", new: "8"}}],
  ["workflow", dockerActionsDir, [], {node: {old: "18", new: "22"}, postgres: {old: "15", new: "17"}, redis: {old: "7", new: "8"}}],
])("docker %s", async (name, file, args, expected) => {
  const [dependencies] = Object.values<any>(await dockerDeps("-f", file, ...args));
  expect(Object.keys(dependencies)).toEqual(Object.keys(expected));
  expect(dependencies).toMatchObject(expected);
  if (name === "workflow") {
    const crlfFile = join(writeTree("docker-actions-crlf", {".github/workflows/ci.yaml": read(file, "ci.yaml").replaceAll("\n", "\r\n")}), ".github/workflows/ci.yaml");
    expect(Object.values(await dockerDeps("-f", crlfFile))[0]).toEqual(dependencies);
  }
});

test("docker allowedVersions compares floating tags with Docker semantics", async () => {
  const dir = writeTree("docker-allowed", {
    "Dockerfile": "FROM node:18\n",
    "renovate.json": JSON.stringify({packageRules: [{matchPackageNames: ["node"], allowedVersions: "<22"}]}),
  });
  const output = await updates({files: [join(dir, "Dockerfile")], modes: ["docker"], dockerapi: dockerUrl, update: true, color: false, noCache: true});
  expect(Object.values(output.results.docker)[0].node.new).toBe("20");
  expect(read(dir, "Dockerfile")).toBe("FROM node:20\n");
});

test("actions mode does not include docker from workflows", async () => {
  expect((await runCliExec([...actionsArgs, "-j", "-f", actionsDir, "-f", dockerActionsDir])).results.docker).toBeUndefined();
});

test("docker update rewrites Dockerfiles, compose files and workflows", async () => {
  const workflow = lines(
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
  );
  const dir = writeTree("docker-update", {
    "Dockerfile": "FROM node:18\nRUN npm install\n",
    "docker-compose.yaml": "services:\n  web:\n    image: node:18\n  db:\n    image: redis:7\n",
    ".github/workflows/ci.yaml": workflow,
  });
  await runCliExec(["-u", "-c", "--dockerapi", dockerUrl, "-M", "docker", "-f", dir]);
  expect(read(dir, "Dockerfile")).toBe("FROM node:22\nRUN npm install\n");
  expect(read(dir, "docker-compose.yaml")).toBe("services:\n  web:\n    image: node:22\n  db:\n    image: redis:8\n");
  expect(read(dir, ".github/workflows/ci.yaml")).toBe(workflow
    .replace("container: node:18", "container: node:22")
    .replace("image: postgres:15", "image: postgres:17")
    .replace("- uses: docker://node:18", "- uses: docker://node:22")
    .replace("image: redis:7", "image: redis:8"));
});

test("docker directory discovery covers every recognized filename", async () => {
  const dockerDir = fixture("docker");
  const byName = Object.fromEntries(Object.entries<any>(await dockerDeps("-f", dockerDir)).map(([file, deps]) => [basename(file), deps]));
  expect(Object.keys(byName).sort()).toEqual(["Dockerfile", "Dockerfile.dev", "compose.yaml", "docker-compose.yaml", "docker-stack.yml"]);
  expect(byName["Dockerfile.dev"].node).toMatchObject({old: "18", new: "22"});
  expect(byName["docker-stack.yml"].node).toMatchObject({old: "18", new: "22"});
  expect(Object.keys(await dockerDeps("-f", fixture("docker/Dockerfile")))).toEqual([join("fixtures", "docker", "Dockerfile")]);

  const linked = join(testDir, "docker-dir-symlink");
  symlinkSync(dockerDir, linked, "junction");
  expect(Object.keys(await dockerDeps("-f", linked))).toHaveLength(5);

  const linkedFile = join(testDir, "docker-file-symlink");
  const target = join(dockerDir, "Dockerfile.dev");
  symlinkSync(target, linkedFile);
  for (const [first, second] of [[linkedFile, target], [target, linkedFile]]) {
    expect(Object.keys(await dockerDeps("-f", first, "-f", second))).toHaveLength(1);
  }
});

test("fetch error includes URL and no stack trace", async () => {
  const url = `${mockUrl}/fetch-error/`;
  const {errors = []} = await updates(apiOpts({registry: url, timeout: 1000}));
  expect(errors.length).toBeGreaterThan(0);
  for (const {error} of errors) {
    expect(error).toContain(url);
    expect(error).not.toContain("    at ");
  }
});

function runWithConfig(config: string, args: string) {
  const dir = writeTree("config", {
    "package.json": JSON.stringify(testPkg, null, 2),
    ".npmrc": `registry=${npmUrl}\nsave-exact=false`,
    "updates.config.js": `module.exports = ${config};\n`,
  });
  return captureCli([...args.split(" "), "-c", "--no-cache", "--forgeapi", githubUrl, "--pypiapi", pypiUrl,
    "--jsrapi", jsrUrl, "--goproxy", goProxyUrl, "--cargoapi", cargoUrl, "-f", join(dir, "package.json")]);
}

test.each([
  ["errorOnOutdated", "-j -i noty", "noty"],
  ["errorOnUnchanged", "-j -i svgstore", "All dependencies are up to date."],
])("config %s exits with code 2", async (option, args, output) => {
  const {stdout, exitCode} = await runWithConfig(`{${option}: true}`, args);
  expect(exitCode).toBe(2);
  expect(stdout).toContain(output);
});

test("config cli overrides config", async () => {
  const {stdout} = await runWithConfig("{minor: true}", "-j -i gulp-sourcemaps -P");
  expect(JSON.parse(stdout).results.npm.dependencies["gulp-sourcemaps"].new).toBe("2.0.1");
});

test("config json yields JSON error output without -j flag", async () => {
  const registry = `${mockUrl}/config-fetch-error/`;
  const fetchError = await runWithConfig("{json: true}", `-i noty --registry ${registry} -T 1000`);
  expect(fetchError.exitCode).toBe(1);
  expect(JSON.parse(fetchError.stdout).errors[0].error).toContain(registry);
  const invalidPin = await runWithConfig("{}", "-j -l foo");
  expect(invalidPin.exitCode).toBe(1);
  expect(JSON.parse(invalidPin.stdout).error).toContain("Invalid pin: foo");
});

test("a second api run re-requests rather than answering from the finished run's cache", async () => {
  const dir = writeTree("api-rerun", {"package.json": JSON.stringify({dependencies: {"dynamic-noty": "3.1.0"}})});
  let latest = "3.1.4";
  routes.set("/npm/dynamic-noty", (_, res) => res.send(gzipSync(JSON.stringify({
    name: "dynamic-noty", "dist-tags": {latest}, versions: {"3.1.0": {}, "3.1.4": {}, "3.2.1": {}},
  }), gzipOptions)));
  const run = async () => (await npmUpdates({files: [join(dir, "package.json")], include: ["dynamic-noty"]}))["dynamic-noty"].new;
  expect(await run()).toBe("3.1.4");
  latest = "3.2.1";
  expect(await run()).toBe("3.2.1");
});

test("api messages, filters and mode validation", async () => {
  const emptyOutput = await updates(apiOpts({files: [emptyFile]}));
  expect(emptyOutput.message).toBe("No dependencies found, nothing to do.");
  expect(emptyOutput.results).toEqual({});
  expect((await updates(apiOpts({include: ["updates"], cooldown: "999999d"}))).message).toBe("All dependencies are up to date.");
  expect(Object.keys(await npmUpdates({include: [/^noty$/]}))).toEqual(["noty"]);
  expect(Object.keys(await npmUpdates({include: ["noty", "gulp-sourcemaps"], exclude: [/sourcemaps/]}))).toEqual(["noty"]);
  expect((await updates(apiOpts({include: ["noty"], modes: ["pypi"]}))).message).toBe("No dependencies found, nothing to do.");
  await expect(updates(apiOpts({modes: ["nope"]}))).rejects.toThrow("Invalid mode: nope");
});

test.each([
  ["greatest", {greatest: true}, "2.6.5"],
  ["patch", {patch: true}, "2.0.1"],
  ["minor", {minor: true}, "2.6.5"],
  ["greatest array", {greatest: ["gulp-sourcemaps"]}, "2.6.5"],
  ["greatest regex", {greatest: [/^gulp/]}, "2.6.5"],
  ["overrides target a package", {overrides: [{include: ["gulp-sourcemaps"], greatest: true}]}, "2.6.5"],
  ["overrides exclude within a rule", {overrides: [{exclude: ["noty"], greatest: true}]}, "2.6.5"],
])("api %s", async (_name, options, gulpVersion) => {
  const dependencies = await npmUpdates({include: ["gulp-sourcemaps", "noty"], ...options});
  expect([dependencies["gulp-sourcemaps"].new, dependencies.noty.new]).toEqual([gulpVersion, "3.1.4"]);
});

test("api cooldown overrides apply per package and last match wins", async () => {
  const dependencies = await npmUpdates({include: ["noty", "updates"], cooldown: "999999d", overrides: [{include: ["noty"], cooldown: 0}]});
  expect(dependencies.noty.new).toBe("3.1.4");
  expect(dependencies.updates).toBeUndefined();
  const lastMatch = await npmUpdates({
    include: ["noty"], cooldown: "999999d", overrides: [{include: ["noty"], cooldown: "999999d"}, {include: ["noty"], cooldown: 0}],
  });
  expect(lastMatch.noty.new).toBe("3.1.4");
});

test("pypi dotted group names are collected, a declined rewrite is not reported", async () => {
  const pyproject = lines(
    `[project]`,
    `dependencies = ["djlint>=1.30.0,!=1.31.0"]`,
    ``,
    `[project.optional-dependencies]`,
    `"extra.one" = ["PyYAML>=1.0"]`,
    ``,
    `[dependency-groups]`,
    `"test.unit" = ["types-paramiko>=3.4.0.20240423"]`,
  );
  const file = join(writeTree("pypi-groups", {"pyproject.toml": pyproject}), "pyproject.toml");
  const {pypi} = (await updates(apiOpts({files: [file], modes: ["pypi"], update: true}))).results;
  expect(pypi["project.optional-dependencies.extra.one"].PyYAML.new).toBe("6.0");
  expect(pypi["dependency-groups.test.unit"]["types-paramiko"].new).toBe("3.5.0.20250801");
  expect(pypi["project.dependencies"]).toBeUndefined();
  expect(read(file)).toBe(pyproject.replace("PyYAML>=1.0", "PyYAML>=6.0").replace("types-paramiko>=3.4.0.20240423", "types-paramiko>=3.5.0.20250801"));
});

test.each(["PyYAML", "pyyaml"])("a pypi pin holds, keyed by the authored spelling or the normalized one: %s", async key => {
  const {pypi} = (await updates(apiOpts({files: [uvFile], modes: ["pypi"], include: ["PyYAML"], pin: {[key]: "<6.0"}}))).results;
  expect(pypi["dependency-groups.dev"].PyYAML.new).toBe("5.4.1");
});

test("non-workspace manifests keep distinct dependencies and duplicate identities", async () => {
  const manifest = (name: string, version: string) => `${JSON.stringify({dependencies: {[name]: version}}, null, 2)}\n`;
  const dir = writeTree("multi-manifest", {
    "a/package.json": manifest("noty", "3.1.0"),
    "b/package.json": manifest("noty", "3.1.0"),
    "c/package.json": manifest("gulp-sourcemaps", "2.0.0"),
  });
  const files = ["a", "b", "c"].map(subdir => join(dir, subdir, "package.json"));
  const {npm} = (await updates(apiOpts({files, update: true}))).results;
  expect(Object.values(npm).filter(section => "noty" in section)).toHaveLength(2);
  expect(files.map(file => read(file))).toEqual([manifest("noty", "3.1.4"), manifest("noty", "3.1.4"), manifest("gulp-sourcemaps", "2.6.5")]);
});
