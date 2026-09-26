import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {env, platform} from "node:process";
import {
  checkUrlDep, fetchJsrInfo, fetchNpmInfo, getLatestCommit, getTags, isCatalogRef, isJsr, isLocalDep, normalizeRange,
  parseJsrDependency, parseNpmAlias, resolutionsBasePackage, updatePackageJson, updateVersionRange,
} from "./npm.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "updates-npm-"));
afterAll(() => rmSync(tempRoot, {recursive: true}));

test("dependency reference classifiers", () => {
  expect(["npm:@jsr/std__semver@1.0.5", "jsr:@std/semver@1.0.5", "jsr:1.0.5", "^1.0.0", "npm:something", ""].map(isJsr))
    .toEqual([true, true, true, false, false, false]);
  expect(["link:../foo", "file:./bar", "^1.0.0", ""].map(isLocalDep)).toEqual([true, true, false, false]);
  expect(["catalog:", "catalog:tools", "^1.0.0"].map(isCatalogRef)).toEqual([true, true, false]);
});

test("parseNpmAlias", () => {
  expect(parseNpmAlias("  npm:left-pad@^1.2.0  ")).toEqual({name: "left-pad", range: "^1.2.0"});
  expect(parseNpmAlias("npm:@hapi/hapi@18.3.0")).toEqual({name: "@hapi/hapi", range: "18.3.0"});
  for (const [range, updated] of [
    ["~>1.2.3", "~>2.0.0"],
    ["*.*.*", "*.*.*"],
    ["1.2.3 - 2.3.x", "1.2.3 - 3.0.x"],
  ]) {
    const alias = parseNpmAlias(`npm:left-pad@${range}`)!;
    expect(alias).toEqual({name: "left-pad", range});
    expect(updateVersionRange(alias.range, range === "1.2.3 - 2.3.x" ? "3.0.0" : "2.0.0", alias.range)).toBe(updated);
  }
  expect(parseNpmAlias("npm:left-pad@latest")).toBeNull();
  expect(parseNpmAlias("npm:left-pad")).toBeNull();
  expect(parseNpmAlias("^1.2.0")).toBeNull();
});

test("parseJsrDependency", () => {
  expect(parseJsrDependency("npm:@jsr/std__semver@1.0.5")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:@std/semver@1.0.5")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:1.0.5", "@std/semver")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:1.0.5")).toEqual({scope: null, name: null, version: ""});
  expect(parseJsrDependency("^1.0.0")).toEqual({scope: null, name: null, version: ""});
  expect(parseJsrDependency("jsr:1.0.5", "noscope")).toEqual({scope: null, name: null, version: ""});
});

test("updateVersionRange", () => {
  const cases: Array<[oldRange: string, newVersion: string, expected: string, oldOrig?: string, depType?: string]> = [
    ["^1.0.0", "2.0.0", "^2.0.0"], ["~1.0.0", "1.1.0", "~1.1.0"], [">=1.0.0", "2.0.0", ">=2.0.0"],
    ["^5.0.0", "6.0.0", "^6", "^5"], ["~5.0.0", "6.0.0", "~6", "~5"], [">=5.0.0", "6.0.0", ">= 6", ">= 5"],
    [">=5.0.0", "6.0.0", ">=6", ">=5"], ["^5.9.0", "6.1.0", "^6.1", "^5.9"], ["^1.2.3", "1.3.0", "^1.3.0"],
    ["^1.0.0-alpha.1", "1.0.0-beta.2", "^1.0.0-beta.2"], ["^5.0.0", "6.0.0-beta.1", "^6.0.0-beta.1", "^5"],
    ["~1.2.0", "1.3.0-rc.1", "~1.3.0-rc.1", "~1.2"], [">=5.0.0", "6.0.0-beta.1", ">=6.0.0-beta.1", ">=5"],
    ["<2.0.0", "2.5.0", "<3.0.0"], ["<2.1.3", "2.5.0", "<2.5.1"], ["< 2.0", "2.5.0", "< 2.6"], ["<2", "2.5.0", "<3"],
    [">1.9.0", "2.5.0", ">1.9.0"], ["1.x", "2.0.1", "2.x", "1.x"], ["1.0.x", "1.1.0", "1.1.x", "1.0.x"],
    ["1.*", "2.1.0", "2.*", "1.*"], ["18.0.0", "19.1.0", "19.1", "18.0"],
    ["9.0.0+sha512.0f5b", "11.20.0", "11.20.0", "9.0.0+sha512.0f5b"],
    ["^18.0.0", "19.0.0", "^18.0.0 || ^19.0.0", "^18.0.0", "peerDependencies"],
    ["^17.0.0 || ^18.0.0", "19.0.0", "^17.0.0 || ^18.0.0 || ^19.0.0", "^17.0.0 || ^18.0.0", "peerDependencies"],
    ["^4.0.0", "5.9.2", "^4 || ^5", "^4", "peerDependencies"], ["^18.0.0", "18.3.1", "^18.0.0", "^18.0.0", "peerDependencies"],
    ["<2.0.0", "2.0.1", "<3.0.0", "<2.0.0", "peerDependencies"],
    [">=1.0.0 <2.0.0", "2.5.0", ">=1.0.0 <3.0.0", ">=1.0.0 <2.0.0", "dependencies"],
    ["^1.0.0 || ^2.0.0", "3.0.1", "^1.0.0 || ^2.0.0 || ^3.0.1", "^1.0.0 || ^2.0.0", "dependencies"],
    ["1.x >2.0.0", "2.1.0", "1.x >2.0.0", "1.x >2.0.0", "dependencies"],
    [">=5.0.0 <7.0.0-0", "7.0.0", ">=5.0.0 <7.0.1", ">=5.0.0 <7.0.0-0", "dependencies"],
    [">=2.0.0 <2.1.0-0", "2.1.0", ">=2.0.0 <2.1.1", undefined, "dependencies"],
    [">=2.0.0 <2.1.3-0", "2.1.3", ">=2.0.0 <2.1.4", undefined, "dependencies"],
    ["<v2.0.0", "2.0.0", "<3.0.0", undefined, "dependencies"], ["<2.0.0-beta", "2.0.0", "<2.0.1", undefined, "dependencies"],
    ["<1.x", "2.0.0", "<1.x", "<1.x", "dependencies"], [">1.0.0", "2.0.0-rc.1", ">1.0.0", ">1.0.0", "peerDependencies"],
    ["^1.0.0 <1.5.0", "2.0.0", "^1.0.0 <1.5.0", "^1.0.0 <1.5.0", "dependencies"],
    ["~1.0.0 <1.5.0", "2.0.0", "~1.0.0 <1.5.0", "~1.0.0 <1.5.0", "dependencies"],
    [">=1.0.0 <1.5.0", "2.0.0", ">=1.0.0 <2.1.0", ">=1.0.0 <1.5.0", "dependencies"],
    ["1.2.3 - 2.3.4", "1.0.1", "1.2.3 - 2.3.4", "1.2.3 - 2.3.4", "dependencies"],
    ["1.2.3 - 2.3.4", "3.0.0", "1.2.3 - 3.0.0", "1.2.3 - 2.3.4", "dependencies"], ["^v1.0.0", "2.0.0", "^v2.0.0", "^v1.0.0"],
    ["~v1.2.0", "1.3.0-rc.1", "~v1.3.0-rc.1", "~v1.2.0"],
  ];
  for (const [oldRange, newVersion, expected, oldOrig, depType] of cases) {
    expect(updateVersionRange(oldRange, newVersion, oldOrig, depType), `${oldRange} to ${newVersion}`).toBe(expected);
  }
  const orChain = updateVersionRange("^0.4.0||^1.0.0", "2.0.0", "^0.4.0||^1.0.0", "peerDependencies");
  expect(orChain).toBe("^0.4.0||^1.0.0 || ^2.0.0");
  expect(updateVersionRange(orChain, "2.0.0", orChain, "peerDependencies")).toBe(orChain);
});

test("package selector normalization", () => {
  for (const [selector, expected] of [
    ["@babel/core", "@babel/core"], ["config/glob", "glob"], ["**/@angular/cli", "@angular/cli"], ["@cypress/request/qs@~6.14.1", "qs"],
    ["foo/bar@1.0.0", "bar"], ["@verdaccio/core/ajv@8.17.1", "ajv"], ["foo/@babel/core@7.0.0", "@babel/core"], ["parent@^1>child@^2", "child"],
    ["@scope/parent>@other/child@^2", "@other/child"], ["semver@>=7.0.0 <7.5.2", "semver"], ["foo@>1", "foo"],
  ]) expect(resolutionsBasePackage(selector)).toBe(expected);
  expect(["^5", "^5.9", "^5.9.3", ">=1.0.0 <2.0.0"].map(normalizeRange)).toEqual(["^5.0.0", "^5.9.0", "^5.9.3", ">=1.0.0 <2.0.0"]);
});

test("updatePackageJson", () => {
  const pkg = JSON.stringify({dependencies: {"foo": "^1.0.0"}, packageManager: "pnpm@8.0.0"}, null, 2);
  expect(updatePackageJson(pkg, {[`dependencies${fieldSep}foo`]: {old: "^1.0.0", new: "^2.0.0"}})).toContain(`"foo": "^2.0.0"`);
  expect(updatePackageJson(pkg, {[`packageManager${fieldSep}pnpm`]: {old: "8.0.0", new: "9.0.0"}})).toContain(`"packageManager": "pnpm@9.0.0"`);
  const sections = ["dependencies", "peerDependencies", "overrides", "scripts", "resolutions", "invented"];
  const sectionPkg = JSON.stringify({
    ...Object.fromEntries(sections.map(section => [section, {"react": "^18.0.0"}])),
    pnpm: {overrides: {"react": "^18.0.0"}},
    packageManager: "pnpm@9.0.0+sha512.0f5b",
  }, null, 2);

  const result = updatePackageJson(sectionPkg, {
    [`peerDependencies${fieldSep}react`]: {old: "^18.0.0", oldOrig: "^18.0.0", new: "^18.0.0 || ^19.0.0"},
    [`packageManager${fieldSep}pnpm`]: {old: "9.0.0+sha512.0f5b", oldOrig: "9.0.0+sha512.0f5b", new: "11.20.0"},
  });

  expect(JSON.parse(result)).toEqual({
    ...Object.fromEntries(sections.map(section => [section, {"react": section === "peerDependencies" ? "^18.0.0 || ^19.0.0" : "^18.0.0"}])),
    pnpm: {overrides: {"react": "^18.0.0"}},
    packageManager: "pnpm@11.20.0",
  });

  const nested = JSON.stringify({pnpm: {overrides: {"react": "^18.0.0"}}, overrides: {"react": "^18.0.0"}}, null, 2);
  expect(JSON.parse(updatePackageJson(nested, {[`overrides${fieldSep}react`]: {old: "^18.0.0", new: "^19.0.0"}})))
    .toEqual({pnpm: {overrides: {"react": "^18.0.0"}}, overrides: {"react": "^19.0.0"}});

  const outOfOrder = JSON.stringify({dependencies: {"foo": "github:u/r#v1.0.0", "bar": "^1.0.0"}, optionalDependencies: {"foo": "github:u/r#v1.0.0"}}, null, 2);
  expect(JSON.parse(updatePackageJson(outOfOrder, {
    [`dependencies${fieldSep}bar`]: {old: "^1.0.0", new: "^1.1.0"},
    [`dependencies${fieldSep}foo`]: {old: "github:u/r#v1.0.0", new: "github:u/r#v2.0.0"},
    [`optionalDependencies${fieldSep}foo`]: {old: "github:u/r#v1.0.0", new: "github:u/r#v2.0.0"},
  }))).toEqual({dependencies: {"foo": "github:u/r#v2.0.0", "bar": "^1.1.0"}, optionalDependencies: {"foo": "github:u/r#v2.0.0"}});
});

const modeCtx = (props: Record<string, unknown>): ModeContext => ({fetchTimeout, ...props} as unknown as ModeContext);
const forgeCtx = (props: Record<string, unknown>) => modeCtx({forgeApiUrl: "https://api.github.com", ...props});
const textRes = (body: unknown) => Promise.resolve({ok: true, text: () => Promise.resolve(JSON.stringify(body)), headers: new Headers()});
const jsonRes = (body: unknown) => Promise.resolve({ok: true, json: () => Promise.resolve(body), headers: new Headers()});
const tempDir = () => mkdtempSync(join(tempRoot, "dir-"));

test("fetchJsrInfo", async () => {
  const jsrData = {latest: "1.0.0", versions: {"1.0.0": {createdAt: "2025-01-01T00:00:00Z"}, "0.9.0": {createdAt: "2024-06-01T00:00:00Z"}}};
  const ctx = modeCtx({jsrApiUrl: "https://jsr.io", doFetch: () => textRes(jsrData)});
  const [data, registry] = await fetchJsrInfo("@std/semver", ctx);
  expect(registry).toBe("https://jsr.io");
  expect(data).toMatchObject({name: "@std/semver", "dist-tags": {latest: "1.0.0"}, time: {"1.0.0": "2025-01-01T00:00:00Z"}});
  expect(Object.keys(data.versions)).toEqual(["1.0.0", "0.9.0"]);
  await expect(fetchJsrInfo("noscopepkg", {} as ModeContext)).rejects.toThrow("Invalid JSR package name");
  const failureCtx = modeCtx({jsrApiUrl: "https://jsr.io",
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"})});
  await expect(fetchJsrInfo("@std/semver", failureCtx)).rejects.toThrow("404");
});

test("fetchNpmInfo resolutions key keeps scope", async () => {
  let fetchedUrl = "";
  const ctx = modeCtx({noCache: true, doFetch: (url: string) => {
    fetchedUrl = url;
    return textRes({});
  }});
  for (const [name, type, version, path] of [
    ["@babel/core", "resolutions", undefined, "/@babel%2fcore"], ["yarn", "packageManager", "4.9.2", "/@yarnpkg%2fcli"],
    ["yarn", "packageManager", "1.22.22", "/yarn"], ["noty@3", "overrides", undefined, "/noty"],
  ] as const) {
    await fetchNpmInfo(name, type, {}, {}, ctx, undefined, version);
    expect(fetchedUrl.endsWith(path)).toBe(true);
  }
});

test.each([
  ["npmrc scoped registry", {
    ".npmrc": "registry=https://default.test\n@myorg:registry=https://private.test\n",
  }, ["https://private.test/@myorg%2fpkg", "https://default.test/lodash"]],
  ["pnpm workspace registries", {
    "pnpm-workspace.yaml": "registry: https://pnpm.test\nregistries:\n  '@myorg': https://scope.pnpm.test\n",
  }, ["https://scope.pnpm.test/@myorg%2fpkg", "https://pnpm.test/lodash"]],
])("fetchNpmInfo honors %s", async (_name, files, expected) => {
  const dir = tempDir();
  const fetchUrl = async (name: string) => {
    let fetchedUrl = "";
    await fetchNpmInfo(name, "dependencies", {}, {}, modeCtx({noCache: true, doFetch: (url: string) => {
      fetchedUrl = url;
      return textRes({});
    }}), dir);
    return fetchedUrl;
  };
  for (const [filename, content] of Object.entries(files)) writeFileSync(join(dir, filename), content);
  expect(await Promise.all([fetchUrl("@myorg/pkg"), fetchUrl("lodash")])).toEqual(expected);
});

test("fetchNpmInfo prefers a scoped npmrc registry over a native default", async () => {
  const dir = tempDir();
  let fetchedUrl = "";
  let authorization: string | null = null;
  const ctx = modeCtx({noCache: true, doFetch: (url: string, opts: RequestInit) => {
    fetchedUrl = url;
    authorization = new Headers(opts.headers).get("authorization");
    return textRes({});
  }});
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "registry: https://registry.npmjs.org\n");
  writeFileSync(join(dir, ".npmrc"), "@company:registry=https://npm.company.example\n//npm.company.example/:_authToken=secret\n");
  await fetchNpmInfo("@company/pkg", "dependencies", {}, {}, ctx, dir);
  expect([fetchedUrl, authorization]).toEqual(["https://npm.company.example/@company%2fpkg", "Bearer secret"]);
});

test("fetchNpmInfo never sends unscoped _auth to a repository registry", async () => {
  const dir = tempDir();
  const home = join(dir, "home");
  const project = join(dir, "project");
  const authorizations: Array<string | null> = [];
  const ctx = modeCtx({noCache: true, doFetch: (_url: string, opts: RequestInit) => {
    authorizations.push(new Headers(opts.headers).get("authorization"));
    return textRes({});
  }});
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(join(home, ".npmrc"), "_auth=dXNlcjpzZWNyZXQ=\n");
  writeFileSync(join(project, ".npmrc"), "registry=https://attacker.example\n");
  const homeVar = platform === "win32" ? "USERPROFILE" : "HOME";
  const originalHome = env[homeVar];
  env[homeVar] = home;
  try {
    await fetchNpmInfo("untrusted", "dependencies", {}, {}, ctx, project);
    await fetchNpmInfo("trusted", "dependencies", {registry: "https://registry.npmjs.org"}, {}, ctx, project);
  } finally {
    if (originalHome === undefined) delete env[homeVar];
    else env[homeVar] = originalHome;
  }
  expect(authorizations).toEqual([null, "Basic dXNlcjpzZWNyZXQ="]);
});

test("fetchNpmInfo requests the full doc only when dates are needed, never reusing the abbreviated one", async () => {
  const accepts: Array<string | undefined> = [];
  const ctx = modeCtx({noCache: true, doFetch: (_url: string, opts: any) => {
    accepts.push(opts?.headers?.accept);
    return textRes({});
  }});
  await fetchNpmInfo("abbreviated", "dependencies", {}, {}, ctx);
  await fetchNpmInfo("full", "dependencies", {}, {needsDates: true}, ctx);
  expect(accepts).toEqual(["application/vnd.npm.install-v1+json", undefined]);

  await fetchNpmInfo("both", "dependencies", {}, {}, ctx);
  await fetchNpmInfo("both", "dependencies", {}, {needsDates: true}, ctx);
  expect(accepts.slice(2)).toEqual(["application/vnd.npm.install-v1+json", undefined]);
});

test("getLatestCommit", async () => {
  const ctx = forgeCtx({noCache: true, doFetch: () => textRes([{sha: "abc1234567890", commit: {committer: {date: "2025-01-01"}}}])});
  expect(await getLatestCommit("user", "repo", ctx)).toMatchObject({hash: "abc1234567890", commit: {committer: {date: "2025-01-01"}}});
  for (const doFetch of [() => textRes([]), () => Promise.resolve({ok: false})]) {
    expect(await getLatestCommit("user", "repo", forgeCtx({doFetch}))).toEqual({hash: "", commit: {}});
  }
  await expect(getLatestCommit("user", "repo", forgeCtx({doFetch: () => Promise.reject(new Error("network error"))})))
    .rejects.toThrow(/network error/);
});

test("getTags returns tag names, or none when the fetch fails", async () => {
  const tagsData = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const fetched: Array<string> = [];
  const ctx = forgeCtx({noCache: true, doFetch: (url: string) => {
    fetched.push(url);
    if (url.includes("/releases?")) return Promise.resolve({ok: false, status: 500, statusText: "Internal Server Error"});
    return jsonRes(tagsData);
  }});
  expect(await getTags("user", "repo", "v1.0.0", ctx)).toEqual(["v1.0.0", "v2.0.0"]);
  expect(fetched.every(url => url.includes("/tags?"))).toBe(true);
  expect(await getTags("user", "repo", "v1.0.0", forgeCtx({doFetch: () => Promise.resolve({ok: false})}))).toEqual([]);
});

test("checkUrlDep parses refs and refreshes hashes", async () => {
  const ctx = forgeCtx({doFetch: () => Promise.resolve({ok: false})});
  expect(await checkUrlDep("key", {old: "not-a-url", new: ""} as any, ctx)).toBeNull();
  let fetches = 0;
  const hashCtx = forgeCtx({noCache: true, doFetch: () => {
    fetches++;
    return textRes([{sha: "def5678901234", commit: {committer: {date: "2025-03-01"}}}]);
  }});
  expect(await checkUrlDep("key", {old: "github:user/repo#abc4567", new: ""}, hashCtx))
    .toMatchObject({newRange: "github:user/repo#def5678", newRef: "def5678", newDate: "2025-03-01"});
  expect(await checkUrlDep("key", {old: "github:user/repo#abc123", new: ""}, hashCtx)).toBeNull();
  expect(fetches).toBe(1);
  expect(await checkUrlDep("key", {old: "git+https://github.com/user/repo.git#abc1234", new: ""} as any,
    forgeCtx({noCache: true, doFetch: () => textRes([{sha: "abc1234567890", commit: {}}])}))).toBeNull();
});

const urlDepCases = [
  ["github:user/repo#v1.2.3", "github:user/repo#v2.0.0"],
  ["git+https://github.com/user/repo.git#v1.2.3-beta.1", "git+https://github.com/user/repo.git#v2.0.0"],
  ["git+ssh://git@github.com/user/repo.git#v1.2.3", "git+ssh://git@github.com/user/repo.git#v2.0.0"],
  ["git@github.com:user/repo.git#v1.2.3", "git@github.com:user/repo.git#v2.0.0"],
  ["github:user/repo#semver:^1", "github:user/repo#semver:^2"],
  ["https://github.com/user/repo-v1.2.3/tarball/v1.2.3", "https://github.com/user/repo-v1.2.3/tarball/v2.0.0"],
  ["https://github.com/user/repo/abc1234", "https://github.com/user/repo/def5678"],
] as const;
const urlDepResults = Promise.all(urlDepCases.map(([old]) => {
  const tags = [{name: "v1.2.3", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = forgeCtx({noCache: true, doFetch: (url: string) => url.endsWith("/commits") ?
    textRes([{sha: "def5678901234", commit: {}}]) : jsonRes(url.includes("/releases?") ? [] : tags)});
  return checkUrlDep("key", {old, new: ""}, ctx);
}));

test.each(urlDepCases.map(([old, expected], index) => [old, expected, index] as const))(
  "checkUrlDep updates %s", async (_old, expected, index) => {
    expect((await urlDepResults)[index]!.newRange).toBe(expected);
  },
);
