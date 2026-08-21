import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {env} from "node:process";
import {
  checkUrlDep, fetchJsrInfo, fetchNpmInfo, getLatestCommit, getTags, isCatalogRef, isJsr, isLocalDep, normalizeRange,
  parseJsrDependency, parseNpmAlias, resolutionsBasePackage, updatePackageJson, updateVersionRange,
} from "./npm.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

test("dependency reference classifiers", () => {
  for (const [value, expected] of [["npm:@jsr/std__semver@1.0.5", true], ["jsr:@std/semver@1.0.5", true],
    ["jsr:1.0.5", true], ["^1.0.0", false], ["npm:something", false], ["", false]] as const) {
    expect(isJsr(value)).toBe(expected);
  }
  for (const [value, expected] of [["link:../foo", true], ["file:./bar", true], ["^1.0.0", false], ["", false]] as const) {
    expect(isLocalDep(value)).toBe(expected);
  }
  for (const [value, expected] of [["catalog:", true], ["catalog:tools", true], ["^1.0.0", false]] as const) {
    expect(isCatalogRef(value)).toBe(expected);
  }
});

test("parseNpmAlias", () => {
  expect(parseNpmAlias("npm:left-pad@^1.2.0")).toEqual({name: "left-pad", range: "^1.2.0"});
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
  expect(updateVersionRange("^1.0.0", "2.0.0", undefined)).toBe("^2.0.0");
  expect(updateVersionRange("~1.0.0", "1.1.0", undefined)).toBe("~1.1.0");
  expect(updateVersionRange(">=1.0.0", "2.0.0", undefined)).toBe(">=2.0.0");
  expect(updateVersionRange("^5.0.0", "6.0.0", "^5")).toBe("^6");
  expect(updateVersionRange("~5.0.0", "6.0.0", "~5")).toBe("~6");
  expect(updateVersionRange(">=5.0.0", "6.0.0", ">= 5")).toBe(">= 6");
  expect(updateVersionRange(">=5.0.0", "6.0.0", ">=5")).toBe(">=6");
  expect(updateVersionRange("^5.9.0", "6.1.0", "^5.9")).toBe("^6.1");
  expect(updateVersionRange("^1.2.3", "1.3.0", undefined)).toBe("^1.3.0");
  expect(updateVersionRange("^1.0.0-alpha.1", "1.0.0-beta.2", undefined)).toBe("^1.0.0-beta.2");
  expect(updateVersionRange("^5.0.0", "6.0.0-beta.1", "^5")).toBe("^6.0.0-beta.1");
  expect(updateVersionRange("~1.2.0", "1.3.0-rc.1", "~1.2")).toBe("~1.3.0-rc.1");
  expect(updateVersionRange(">=5.0.0", "6.0.0-beta.1", ">=5")).toBe(">=6.0.0-beta.1");
  expect(updateVersionRange("<2.0.0", "2.5.0", undefined)).toBe("<3.0.0");
  expect(updateVersionRange("<2.1.3", "2.5.0", undefined)).toBe("<2.5.1");
  expect(updateVersionRange("< 2.0", "2.5.0", undefined)).toBe("< 2.6");
  expect(updateVersionRange("<2", "2.5.0", undefined)).toBe("<3");
  expect(updateVersionRange(">1.9.0", "2.5.0", undefined)).toBe(">1.9.0");
  expect(updateVersionRange("1.x", "2.0.1", "1.x")).toBe("2.x");
  expect(updateVersionRange("1.0.x", "1.1.0", "1.0.x")).toBe("1.1.x");
  expect(updateVersionRange("1.*", "2.1.0", "1.*")).toBe("2.*");
  expect(updateVersionRange("18.0.0", "19.1.0", "18.0")).toBe("19.1");
  expect(updateVersionRange("9.0.0+sha512.0f5b", "11.20.0", "9.0.0+sha512.0f5b")).toBe("11.20.0");
  expect(updateVersionRange("^18.0.0", "19.0.0", "^18.0.0", "peerDependencies")).toBe("^18.0.0 || ^19.0.0");
  expect(updateVersionRange("^17.0.0 || ^18.0.0", "19.0.0", "^17.0.0 || ^18.0.0", "peerDependencies")).toBe("^17.0.0 || ^18.0.0 || ^19.0.0");
  expect(updateVersionRange("^4.0.0", "5.9.2", "^4", "peerDependencies")).toBe("^4 || ^5");
  expect(updateVersionRange("^18.0.0", "18.3.1", "^18.0.0", "peerDependencies")).toBe("^18.0.0");
  expect(updateVersionRange("<2.0.0", "2.0.1", "<2.0.0", "peerDependencies")).toBe("<3.0.0");
  expect(updateVersionRange(">=1.0.0 <2.0.0", "2.5.0", ">=1.0.0 <2.0.0", "dependencies")).toBe(">=1.0.0 <3.0.0");
  expect(updateVersionRange("^1.0.0 || ^2.0.0", "3.0.1", "^1.0.0 || ^2.0.0", "dependencies")).toBe("^1.0.0 || ^2.0.0 || ^3.0.1");
  expect(updateVersionRange("1.x >2.0.0", "2.1.0", "1.x >2.0.0", "dependencies")).toBe("1.x >2.0.0");
  const orChain = updateVersionRange("^0.4.0||^1.0.0", "2.0.0", "^0.4.0||^1.0.0", "peerDependencies");
  expect(orChain).toBe("^0.4.0||^1.0.0 || ^2.0.0");
  expect(updateVersionRange(orChain, "2.0.0", orChain, "peerDependencies")).toBe(orChain);

  expect(updateVersionRange(">=5.0.0 <7.0.0-0", "7.0.0", ">=5.0.0 <7.0.0-0", "dependencies")).toBe(">=5.0.0 <7.0.1");
  expect(updateVersionRange(">=2.0.0 <2.1.0-0", "2.1.0", undefined, "dependencies")).toBe(">=2.0.0 <2.1.1");
  expect(updateVersionRange(">=2.0.0 <2.1.3-0", "2.1.3", undefined, "dependencies")).toBe(">=2.0.0 <2.1.4");
  expect(updateVersionRange("<v2.0.0", "2.0.0", undefined, "dependencies")).toBe("<3.0.0");
  expect(updateVersionRange("<2.0.0-beta", "2.0.0", undefined, "dependencies")).toBe("<2.0.1");

  expect(updateVersionRange("<1.x", "2.0.0", "<1.x", "dependencies")).toBe("<1.x");
  expect(updateVersionRange(">1.0.0", "2.0.0-rc.1", ">1.0.0", "peerDependencies")).toBe(">1.0.0");

  expect(updateVersionRange("^1.0.0 <1.5.0", "2.0.0", "^1.0.0 <1.5.0", "dependencies")).toBe("^1.0.0 <1.5.0");
  expect(updateVersionRange("~1.0.0 <1.5.0", "2.0.0", "~1.0.0 <1.5.0", "dependencies")).toBe("~1.0.0 <1.5.0");
  expect(updateVersionRange(">=1.0.0 <1.5.0", "2.0.0", ">=1.0.0 <1.5.0", "dependencies")).toBe(">=1.0.0 <2.1.0");

  expect(updateVersionRange("1.2.3 - 2.3.4", "1.0.1", "1.2.3 - 2.3.4", "dependencies")).toBe("1.2.3 - 2.3.4");
  expect(updateVersionRange("1.2.3 - 2.3.4", "3.0.0", "1.2.3 - 2.3.4", "dependencies")).toBe("1.2.3 - 3.0.0");
  expect(updateVersionRange("^v1.0.0", "2.0.0", "^v1.0.0")).toBe("^v2.0.0");
  expect(updateVersionRange("~v1.2.0", "1.3.0-rc.1", "~v1.2.0")).toBe("~v1.3.0-rc.1");
});

test("package selector normalization", () => {
  expect(resolutionsBasePackage("@babel/core")).toBe("@babel/core");
  expect(resolutionsBasePackage("config/glob")).toBe("glob");
  expect(resolutionsBasePackage("**/@angular/cli")).toBe("@angular/cli");
  expect(resolutionsBasePackage("@cypress/request/qs@~6.14.1")).toBe("qs");
  expect(resolutionsBasePackage("foo/bar@1.0.0")).toBe("bar");
  expect(resolutionsBasePackage("@verdaccio/core/ajv@8.17.1")).toBe("ajv");
  expect(resolutionsBasePackage("foo/@babel/core@7.0.0")).toBe("@babel/core");
  expect(normalizeRange("^5")).toBe("^5.0.0");
  expect(normalizeRange("^5.9")).toBe("^5.9.0");
  expect(normalizeRange("^5.9.3")).toBe("^5.9.3");
  expect(normalizeRange(">=1.0.0 <2.0.0")).toBe(">=1.0.0 <2.0.0");
});

test("updatePackageJson", () => {
  const pkg = JSON.stringify({
    dependencies: {"foo": "^1.0.0"},
    packageManager: "pnpm@8.0.0",
  }, null, 2);

  const depsKey = `dependencies${fieldSep}foo`;
  const pmKey = `packageManager${fieldSep}pnpm`;

  const result1 = updatePackageJson(pkg, {
    [depsKey]: {old: "^1.0.0", new: "^2.0.0"},
  });
  expect(result1).toContain(`"foo": "^2.0.0"`);

  const result2 = updatePackageJson(pkg, {
    [pmKey]: {old: "8.0.0", new: "9.0.0"},
  });
  expect(result2).toContain(`"packageManager": "pnpm@9.0.0"`);
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

  const nested = JSON.stringify({
    pnpm: {overrides: {"react": "^18.0.0"}},
    overrides: {"react": "^18.0.0"},
  }, null, 2);

  expect(JSON.parse(updatePackageJson(nested, {
    [`overrides${fieldSep}react`]: {old: "^18.0.0", new: "^19.0.0"},
  }))).toEqual({
    pnpm: {overrides: {"react": "^18.0.0"}},
    overrides: {"react": "^19.0.0"},
  });

  const outOfOrder = JSON.stringify({
    dependencies: {"foo": "github:u/r#v1.0.0", "bar": "^1.0.0"},
    optionalDependencies: {"foo": "github:u/r#v1.0.0"},
  }, null, 2);

  expect(JSON.parse(updatePackageJson(outOfOrder, {
    [`dependencies${fieldSep}bar`]: {old: "^1.0.0", new: "^1.1.0"},
    [`dependencies${fieldSep}foo`]: {old: "github:u/r#v1.0.0", new: "github:u/r#v2.0.0"},
    [`optionalDependencies${fieldSep}foo`]: {old: "github:u/r#v1.0.0", new: "github:u/r#v2.0.0"},
  }))).toEqual({
    dependencies: {"foo": "github:u/r#v2.0.0", "bar": "^1.1.0"},
    optionalDependencies: {"foo": "github:u/r#v2.0.0"},
  });
});

const modeCtx = (props: Record<string, unknown>): ModeContext => ({fetchTimeout, ...props} as unknown as ModeContext);
const forgeCtx = (props: Record<string, unknown>) => modeCtx({forgeApiUrl: "https://api.github.com", ...props});
const textRes = (body: unknown) => Promise.resolve({ok: true, text: () => Promise.resolve(JSON.stringify(body)), headers: new Headers()});
const jsonRes = (body: unknown) => Promise.resolve({ok: true, json: () => Promise.resolve(body), headers: new Headers()});

test("fetchJsrInfo", async () => {
  const jsrData = {latest: "1.0.0", versions: {"1.0.0": {createdAt: "2025-01-01T00:00:00Z"}, "0.9.0": {createdAt: "2024-06-01T00:00:00Z"}}};
  const ctx = modeCtx({jsrApiUrl: "https://jsr.io", doFetch: () => textRes(jsrData)});
  const [data, registry] = await fetchJsrInfo("@std/semver", ctx);
  expect(registry).toBe("https://jsr.io");
  expect(data.name).toBe("@std/semver");
  expect(data["dist-tags"].latest).toBe("1.0.0");
  expect(Object.keys(data.versions)).toEqual(["1.0.0", "0.9.0"]);
  expect(data.time["1.0.0"]).toBe("2025-01-01T00:00:00Z");
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
  await fetchNpmInfo("@babel/core", "resolutions", {}, {}, ctx);
  expect(fetchedUrl.endsWith("/@babel%2fcore")).toBe(true);
  await fetchNpmInfo("yarn", "packageManager", {}, {}, ctx, undefined, "4.9.2");
  expect(fetchedUrl.endsWith("/@yarnpkg%2fcli")).toBe(true);
  await fetchNpmInfo("yarn", "packageManager", {}, {}, ctx, undefined, "1.22.22");
  expect(fetchedUrl.endsWith("/yarn")).toBe(true);
  await fetchNpmInfo("noty@3", "overrides", {}, {}, ctx);
  expect(fetchedUrl.endsWith("/noty")).toBe(true);
});

test.each([
  ["npmrc scoped registry", {
    ".npmrc": "registry=https://default.test\n@myorg:registry=https://private.test\n",
  }, ["https://private.test/@myorg%2fpkg", "https://default.test/lodash"]],
  ["pnpm workspace registries", {
    "pnpm-workspace.yaml": "registry: https://pnpm.test\nregistries:\n  '@myorg': https://scope.pnpm.test\n",
  }, ["https://scope.pnpm.test/@myorg%2fpkg", "https://pnpm.test/lodash"]],
])("fetchNpmInfo honors %s", async (_name, files, expected) => {
  const dir = mkdtempSync(join(tmpdir(), "updates-registry-"));
  const urls: Array<string> = [];
  const ctx = modeCtx({noCache: true, doFetch: (url: string) => {
    urls.push(url);
    return textRes({});
  }});
  try {
    for (const [filename, content] of Object.entries(files)) writeFileSync(join(dir, filename), content);
    await fetchNpmInfo("@myorg/pkg", "dependencies", {}, {}, ctx, dir);
    await fetchNpmInfo("lodash", "dependencies", {}, {}, ctx, dir);
    expect(urls).toEqual(expected);
  } finally {
    rmSync(dir, {recursive: true});
  }
});

test("fetchNpmInfo never sends unscoped _auth to a repository registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-auth-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  const originalHome = env.HOME;
  const authorizations: Array<string | null> = [];
  const ctx = modeCtx({noCache: true, doFetch: (_url: string, opts: RequestInit) => {
    authorizations.push(new Headers(opts.headers).get("authorization"));
    return textRes({});
  }});
  try {
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(join(home, ".npmrc"), "_auth=dXNlcjpzZWNyZXQ=\n");
    writeFileSync(join(project, ".npmrc"), "registry=https://attacker.example\n");
    env.HOME = home;
    await fetchNpmInfo("untrusted", "dependencies", {}, {}, ctx, project);
    await fetchNpmInfo("trusted", "dependencies", {}, {registry: "https://registry.npmjs.org"}, ctx, project);
    expect(authorizations).toEqual([null, "Basic dXNlcjpzZWNyZXQ="]);
  } finally {
    if (originalHome === undefined) delete env.HOME;
    else env.HOME = originalHome;
    rmSync(dir, {recursive: true});
  }
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
  const result = await getLatestCommit("user", "repo", ctx);
  expect(result.hash).toBe("abc1234567890");
  expect(result.commit.committer.date).toBe("2025-01-01");
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
  const result = await checkUrlDep("key", {old: "github:user/repo#1234567", new: ""}, hashCtx);
  expect(result).not.toBeNull();
  expect(result!.newRange).toBe("github:user/repo#def5678");
  expect(result!.newRef).toBe("def5678");
  expect(result!.newDate).toBe("2025-03-01");
  expect(await checkUrlDep("key", {old: "github:user/repo#abc123", new: ""}, hashCtx)).toBeNull();
  expect(fetches).toBe(1);
  expect(await checkUrlDep("key", {old: "git+https://github.com/user/repo.git#abc1234", new: ""} as any,
    forgeCtx({noCache: true, doFetch: () => textRes([{sha: "abc1234567890", commit: {}}])}))).toBeNull();
});

test.each([
  ["github:user/repo#v1.2.3", "github:user/repo#v2.0.0"],
  ["git+https://github.com/user/repo.git#v1.2.3-beta.1", "git+https://github.com/user/repo.git#v2.0.0"],
  ["git+ssh://git@github.com/user/repo.git#v1.2.3", "git+ssh://git@github.com/user/repo.git#v2.0.0"],
  ["git@github.com:user/repo.git#v1.2.3", "git@github.com:user/repo.git#v2.0.0"],
  ["github:user/repo#semver:^1", "github:user/repo#semver:^2"],
])("checkUrlDep updates %s", async (old, expected) => {
  const tags = [{name: "v1.2.3", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = forgeCtx({noCache: true, doFetch: (url: string) => jsonRes(url.includes("/releases?") ? [] : tags)});
  expect((await checkUrlDep("key", {old, new: ""}, ctx))?.newRange).toBe(expected);
});
