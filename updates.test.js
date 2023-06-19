import {execa} from "execa";
import restana from "restana";
import {join, dirname} from "node:path";
import {readFileSync, mkdtempSync} from "node:fs";
import {writeFile, readFile, rm} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {env} from "node:process";

const testFile = fileURLToPath(new URL("fixtures/test.json", import.meta.url));
const emptyFile = fileURLToPath(new URL("fixtures/empty.json", import.meta.url));
const testPkg = JSON.parse(readFileSync(testFile, "utf8"));
const testDir = mkdtempSync(join(tmpdir(), "updates-"));
const script = fileURLToPath(new URL("bin/updates.js", import.meta.url));

const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "resolutions",
];

const testPackages = new Set();
for (const dependencyType of dependencyTypes) {
  for (const name of Object.keys(testPkg[dependencyType] || [])) {
    testPackages.add(name);
  }
}

function makeUrl(server) {
  const {port} = server.address();
  return Object.assign(new URL("http://localhost"), {port}).toString();
}

function defaultRoute(req, res) {
  console.error(`default handler hit for ${req.url}`);
  res.send(404);
}

function resolutionsBasePackage(name) {
  const packages = name.match(/(@[^/]+\/)?([^/]+)/g) || [];
  return packages[packages.length - 1];
}

let npmServer, githubServer, githubUrl, pypiServer, pypiUrl, npmUrl;
beforeAll(async () => {
  let commits, tags, djlint;

  [npmServer, githubServer, pypiServer, commits, tags, djlint] = await Promise.all([
    restana({defaultRoute}),
    restana({defaultRoute}),
    restana({defaultRoute}),
    readFile(fileURLToPath(new URL("fixtures/github/updates-commits.json", import.meta.url))),
    readFile(fileURLToPath(new URL("fixtures/github/updates-tags.json", import.meta.url))),
    readFile(fileURLToPath(new URL("fixtures/pypi/djlint.json", import.meta.url))),
  ]);

  for (const pkgName of testPackages) {
    const name = testPkg.resolutions[pkgName] ? resolutionsBasePackage(pkgName) : pkgName;
    const urlName = name.replace(/\//g, "%2f");
    // can not use file URLs because node stupidely throws on "%2f" in paths.
    const path = join(dirname(fileURLToPath(import.meta.url)), `fixtures/npm/${urlName}.json`);
    npmServer.get(`/${urlName}`, async (_, res) => res.send(await readFile(path)));
  }

  githubServer.get("/repos/silverwind/updates/commits", (_, res) => res.send(commits));
  githubServer.get("/repos/silverwind/updates/git/refs/tags", (_, res) => res.send(tags));
  pypiServer.get("/pypi/djlint/json", (_, res) => res.send(djlint));

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

function makeTest(args) {
  return async () => {
    const argsArr = [
      ...args.split(/\s+/), "-c",
      "--githubapi", githubUrl,
      "--pypiapi", pypiUrl,
    ];
    const {stdout} = await execa(script, argsArr, {cwd: testDir});
    const {results} = JSON.parse(stdout);

    // Parse results, with custom validation for the dynamic "age" property
    for (const dependencyType of [
      ...dependencyTypes,
      "tool.poetry.dependencies",
      "tool.poetry.group.dev.dependencies"
    ]) {
      for (const name of Object.keys(results[dependencyType] || {})) {
        delete results[dependencyType][name].age;
      }
    }

    expect(results).toMatchSnapshot();
  };
}

test("version", async () => {
  const {version: expected} = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  const {stdout, exitCode} = await execa("node", [script, "-v"]);
  expect(stdout).toEqual(expected);
  expect(exitCode).toEqual(0);
});

test("simple", async () => {
  const {stdout, stderr, exitCode} = await execa(script, [
    "-C",
    "--githubapi", githubUrl,
    "--pypiapi", pypiUrl,
    "--registry", npmUrl,
    "-f", testFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("prismjs");
  expect(stdout).toContain("https://github.com/silverwind/updates");
  expect(exitCode).toEqual(0);
});

test("empty", async () => {
  const {stdout, stderr, exitCode} = await execa(script, [
    "-C",
    "--githubapi", githubUrl,
    "--pypiapi", pypiUrl,
    "-f", emptyFile,
  ]);
  expect(stderr).toEqual("");
  expect(stdout).toContain("No dependencies");
  expect(exitCode).toEqual(0);
});

if (env.CI) {
  test("global", async () => {
    await execa("npm", ["i", "-g", "."]);
    const {stdout, stderr, exitCode} = await execa("updates", [
      "-C",
      "--githubapi", githubUrl,
      "--pypiapi", pypiUrl,
      "-f", testFile,
    ]);
    expect(stderr).toEqual("");
    expect(stdout).toContain("prismjs");
    expect(stdout).toContain("https://github.com/silverwind/updates");
    expect(exitCode).toEqual(0);
  });
}

test("latest", makeTest("-j"));
test("greatest", makeTest("-j -g"));
test("prerelease", makeTest("-j -g -p"));
test("release", makeTest("-j -R"));
test("patch", makeTest("-j -P"));
test("include version deps", makeTest("-j -i noty"));
test("include version deps #2", makeTest("-j -i noty -i noty,noty"));
test("exclude version deps", makeTest("-j -e gulp-sourcemaps,prismjs,svgstore,html-webpack-plugin,noty,jpeg-buffer-orientation,styled-components,@babel/preset-env,versions/updates,react"));

test("pypi", makeTest(
  `-j -f ${fileURLToPath(new URL("fixtures/pyproject.toml", import.meta.url))}`,
));
