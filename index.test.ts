import spawn from "nano-spawn";
import restana from "restana";
import {join, dirname} from "node:path";
import {readFileSync, mkdtempSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {env} from "node:process";
import type {Server} from "node:http";
import type {Service, Protocol} from "restana";
import {npmDependencyTypes, poetryDependencyTypes, uvDependencyTypes} from "./utils.ts";

const testFile = fileURLToPath(new URL("fixtures/npm-test/package.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/npm-empty/package.json", import.meta.url));
const poetryFile = fileURLToPath(new URL("fixtures/poetry/pyproject.toml", import.meta.url));
const uvFile = fileURLToPath(new URL("fixtures/uv/pyproject.toml", import.meta.url));
const dualFile = fileURLToPath(new URL("fixtures/dual", import.meta.url));

const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const script = fileURLToPath(new URL("dist/index.js", import.meta.url));

const testPackages: Set<string> = new Set();
for (const dependencyType of npmDependencyTypes) {
  for (const name of Object.keys(testPkg[dependencyType] || [])) {
    testPackages.add(name);
  }
}

const pyTestPackages = new Set(["djlint", "PyYAML"]);

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
  let commits: Buffer;
  let tags: Buffer;

  [npmServer, githubServer, pypiServer, commits, tags] = await Promise.all([
    restana({defaultRoute}),
    restana({defaultRoute}),
    restana({defaultRoute}),
    readFile(fileURLToPath(new URL("fixtures/github/updates-commits.json", import.meta.url))),
    readFile(fileURLToPath(new URL("fixtures/github/updates-tags.json", import.meta.url))),
  ]);

  for (const pkgName of testPackages) {
    const name = testPkg.resolutions[pkgName] ? resolutionsBasePackage(pkgName) : pkgName;
    const urlName = name.replace(/\//g, "%2f");
    // can not use file URLs because node stupidely throws on "%2f" in paths.
    const path = join(dirname(fileURLToPath(import.meta.url)), `fixtures/npm/${urlName}.json`);
    npmServer.get(`/${urlName}`, async (_, res) => res.send(await readFile(path)));
  }

  for (const pkgName of pyTestPackages) {
    const path = join(dirname(fileURLToPath(import.meta.url)), `fixtures/pypi/${pkgName}.json`);
    pypiServer.get(`/pypi/${pkgName}/json`, async (_, res) => res.send(await readFile(path)));
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
      ({stdout} = await spawn(process.execPath, [script, ...argsArr], {cwd: testDir}));
      ({results} = JSON.parse(stdout));
    } catch (err) {
      console.error(err);
      throw err;
    }

    // Parse results, with custom validation for the dynamic "age" property
    for (const mode of Object.keys(results || {})) {
      for (const dependencyType of [
        ...npmDependencyTypes,
        ...poetryDependencyTypes,
        ...uvDependencyTypes,
      ]) {
        for (const name of Object.keys(results?.[mode]?.[dependencyType] || {})) {
          delete results[mode][dependencyType][name].age;
        }
      }
    }

    expect(results).toMatchSnapshot();
  };
}

test("simple", async () => {
  const {stdout, stderr} = await spawn(process.execPath, [
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
  const {stdout, stderr} = await spawn(process.execPath, [
    script,
    "-C",
    "--githubapi", githubUrl,
    "--pypiapi", pypiUrl,
    "-f", emptyFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
});

if (env.CI && !env.BUN) {
  test("global", async () => {
    await spawn("npm", ["i", "-g", "."]);
    const {stdout, stderr} = await spawn("updates", [
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

test("latest", makeTest("-j"));
test("greatest", makeTest("-j -g"));
test("prerelease", makeTest("-j -g -p"));
test("release", makeTest("-j -R"));
test("patch", makeTest("-j -P"));
test("include", makeTest("-j -i noty"));
test("include 2", makeTest("-j -i noty -i noty,noty"));
test("include 3", makeTest("-j -i /^noty/"));
test("exclude", makeTest("-j -e gulp-sourcemaps,prismjs,svgstore,html-webpack-plugin,noty,jpeg-buffer-orientation,styled-components,@babel/preset-env,versions/updates,react"));
test("exclude 2", makeTest("-j -e gulp-sourcemaps -i /react/"));
test("exclude 3", makeTest("-j -i gulp*"));
test("exclude 4", makeTest("-j -i /^gulp/ -P gulp*"));
test("poetry", makeTest(`-j -f ${poetryFile}`));
test("uv", makeTest(`-j -f ${uvFile}`));
test("dual", makeTest(`-j -f ${dualFile}`));
test("dual 2", makeTest(`-j -f ${dualFile} -i noty`));
