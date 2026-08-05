import {mkdtempSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  isJsr, isLocalDep, isCatalogRef, parseJsrDependency, parseNpmAlias, updateVersionRange, normalizeRange, resolutionsBasePackage,
  updatePackageJson, fetchJsrInfo, getLatestCommit, getTags, checkUrlDep, fetchNpmInfo,
} from "./npm.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

test("isJsr", () => {
  expect(isJsr("npm:@jsr/std__semver@1.0.5")).toBe(true);
  expect(isJsr("jsr:@std/semver@1.0.5")).toBe(true);
  expect(isJsr("jsr:1.0.5")).toBe(true);
  expect(isJsr("^1.0.0")).toBe(false);
  expect(isJsr("npm:something")).toBe(false);
  expect(isJsr("")).toBe(false);
});

test("isLocalDep", () => {
  expect(isLocalDep("link:../foo")).toBe(true);
  expect(isLocalDep("file:./bar")).toBe(true);
  expect(isLocalDep("^1.0.0")).toBe(false);
  expect(isLocalDep("")).toBe(false);
});

test("parseNpmAlias", () => {
  expect(parseNpmAlias("npm:left-pad@^1.2.0")).toEqual({name: "left-pad", range: "^1.2.0"});
  expect(parseNpmAlias("npm:@hapi/hapi@18.3.0")).toEqual({name: "@hapi/hapi", range: "18.3.0"});
  expect(parseNpmAlias("npm:left-pad@latest")).toBeNull(); // a dist-tag is no range to move
  expect(parseNpmAlias("npm:left-pad")).toBeNull();
  expect(parseNpmAlias("^1.2.0")).toBeNull();
});

test("isCatalogRef", () => {
  expect(isCatalogRef("catalog:")).toBe(true);
  expect(isCatalogRef("catalog:tools")).toBe(true);
  expect(isCatalogRef("^1.0.0")).toBe(false);
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
  // partial range bumped to a prerelease: keep the full version (can't shrink past major.minor.patch)
  expect(updateVersionRange("^5.0.0", "6.0.0-beta.1", "^5")).toBe("^6.0.0-beta.1");
  expect(updateVersionRange("~1.2.0", "1.3.0-rc.1", "~1.2")).toBe("~1.3.0-rc.1");
  expect(updateVersionRange(">=5.0.0", "6.0.0-beta.1", ">=5")).toBe(">=6.0.0-beta.1");
  // a strict bound must admit the new version, never land on it
  expect(updateVersionRange("<2.0.0", "2.5.0", undefined)).toBe("<3.0.0");
  expect(updateVersionRange("<2.1.3", "2.5.0", undefined)).toBe("<2.5.1");
  expect(updateVersionRange("< 2.0", "2.5.0", undefined)).toBe("< 2.6");
  expect(updateVersionRange("<2", "2.5.0", undefined)).toBe("<3");
  // a strict lower bound already admits it, so it stays as authored
  expect(updateVersionRange(">1.9.0", "2.5.0", undefined)).toBe(">1.9.0");
  expect(updateVersionRange("1.x", "2.0.1", "1.x")).toBe("2.x");
  expect(updateVersionRange("1.0.x", "1.1.0", "1.0.x")).toBe("1.1.x");
  expect(updateVersionRange("1.*", "2.1.0", "1.*")).toBe("2.*");
  expect(updateVersionRange("18.0.0", "19.1.0", "18.0")).toBe("19.1");
  // build metadata describes the version it was authored with, corepack rejects a stale hash
  expect(updateVersionRange("9.0.0+sha512.0f5b", "11.20.0", "9.0.0+sha512.0f5b")).toBe("11.20.0");
});

test("updateVersionRange widens peer and compound ranges", () => {
  expect(updateVersionRange("^18.0.0", "19.0.0", "^18.0.0", "peerDependencies")).toBe("^18.0.0 || ^19.0.0");
  expect(updateVersionRange("^17.0.0 || ^18.0.0", "19.0.0", "^17.0.0 || ^18.0.0", "peerDependencies")).toBe("^17.0.0 || ^18.0.0 || ^19.0.0");
  expect(updateVersionRange("^4.0.0", "5.9.2", "^4", "peerDependencies")).toBe("^4 || ^5");
  expect(updateVersionRange("^18.0.0", "18.3.1", "^18.0.0", "peerDependencies")).toBe("^18.0.0");
  expect(updateVersionRange("<2.0.0", "2.0.1", "<2.0.0", "peerDependencies")).toBe("<3.0.0");
  // a multi-comparator range widens in every dep type, a replace would drop all but the last
  expect(updateVersionRange(">=1.0.0 <2.0.0", "2.5.0", ">=1.0.0 <2.0.0", "dependencies")).toBe(">=1.0.0 <3.0.0");
  expect(updateVersionRange("^1.0.0 || ^2.0.0", "3.0.1", "^1.0.0 || ^2.0.0", "dependencies")).toBe("^1.0.0 || ^2.0.0 || ^3.0.1");
  expect(updateVersionRange("1.x >2.0.0", "2.1.0", "1.x >2.0.0", "dependencies")).toBe("1.x >2.0.0");
});

test("updateVersionRange never writes a range the new version fails", () => {
  const orChain = updateVersionRange("^0.4.0||^1.0.0", "2.0.0", "^0.4.0||^1.0.0", "peerDependencies");
  expect(orChain).toBe("^0.4.0||^1.0.0 || ^2.0.0");
  expect(updateVersionRange(orChain, "2.0.0", orChain, "peerDependencies")).toBe(orChain);

  // `<V.0.0-0` is what `^` and `~` desugar to, so it has to clear the major it excludes
  expect(updateVersionRange(">=5.0.0 <7.0.0-0", "7.0.0", ">=5.0.0 <7.0.0-0", "dependencies")).toBe(">=5.0.0 <8.0.0-0");

  expect(updateVersionRange("<1.x", "2.0.0", "<1.x", "dependencies")).toBe("<1.x");
  expect(updateVersionRange(">1.0.0", "2.0.0-rc.1", ">1.0.0", "peerDependencies")).toBe(">1.0.0");

  expect(updateVersionRange("^1.0.0 <1.5.0", "2.0.0", "^1.0.0 <1.5.0", "dependencies")).toBe("^1.0.0 <1.5.0");
  expect(updateVersionRange("~1.0.0 <1.5.0", "2.0.0", "~1.0.0 <1.5.0", "dependencies")).toBe("~1.0.0 <1.5.0");
  expect(updateVersionRange(">=1.0.0 <1.5.0", "2.0.0", ">=1.0.0 <1.5.0", "dependencies")).toBe(">=1.0.0 <2.0.1");

  expect(updateVersionRange("1.2.3 - 2.3.4", "1.0.1", "1.2.3 - 2.3.4", "dependencies")).toBe("1.2.3 - 2.3.4");
  expect(updateVersionRange("1.2.3 - 2.3.4", "3.0.0", "1.2.3 - 2.3.4", "dependencies")).toBe("1.2.3 - 3.0.0");
});

test("updateVersionRange keeps an authored v prefix", () => {
  expect(updateVersionRange("^v1.0.0", "2.0.0", "^v1.0.0")).toBe("^v2.0.0");
  expect(updateVersionRange("~v1.2.0", "1.3.0-rc.1", "~v1.2.0")).toBe("~v1.3.0-rc.1");
});

test("resolutionsBasePackage", () => {
  expect(resolutionsBasePackage("@babel/core")).toBe("@babel/core");
  expect(resolutionsBasePackage("config/glob")).toBe("glob");
  expect(resolutionsBasePackage("**/@angular/cli")).toBe("@angular/cli");
  expect(resolutionsBasePackage("@cypress/request/qs@~6.14.1")).toBe("qs");
  expect(resolutionsBasePackage("foo/bar@1.0.0")).toBe("bar");
  expect(resolutionsBasePackage("@verdaccio/core/ajv@8.17.1")).toBe("ajv");
  expect(resolutionsBasePackage("foo/@babel/core@7.0.0")).toBe("@babel/core");
});

test("normalizeRange", () => {
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
});

test("updatePackageJson only rewrites the dep's own section", () => {
  const sections = ["dependencies", "peerDependencies", "overrides", "scripts", "resolutions", "invented"];
  const pkg = JSON.stringify({
    ...Object.fromEntries(sections.map(section => [section, {"react": "^18.0.0"}])),
    pnpm: {overrides: {"react": "^18.0.0"}},
    packageManager: "pnpm@9.0.0+sha512.0f5b",
  }, null, 2);

  const result = updatePackageJson(pkg, {
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

  // url deps are re-inserted after the regular ones, so a section's cursor can already be past
  // the pair a later dep needs.
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

// fetchJsrInfo
test("fetchJsrInfo happy path", async () => {
  const jsrData = {latest: "1.0.0", versions: {"1.0.0": {createdAt: "2025-01-01T00:00:00Z"}, "0.9.0": {createdAt: "2024-06-01T00:00:00Z"}}};
  const ctx = modeCtx({jsrApiUrl: "https://jsr.io", doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(jsrData)})});
  const [data, registry] = await fetchJsrInfo("@std/semver", ctx);
  expect(registry).toBe("https://jsr.io");
  expect(data.name).toBe("@std/semver");
  expect(data["dist-tags"].latest).toBe("1.0.0");
  expect(Object.keys(data.versions)).toEqual(["1.0.0", "0.9.0"]);
  expect(data.time["1.0.0"]).toBe("2025-01-01T00:00:00Z");
});

test("fetchJsrInfo invalid package name throws", async () => {
  const ctx = {} as unknown as ModeContext;
  await expect(fetchJsrInfo("noscopepkg", ctx)).rejects.toThrow("Invalid JSR package name");
});

test("fetchJsrInfo fetch failure throws", async () => {
  const ctx = modeCtx({jsrApiUrl: "https://jsr.io",
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"})});
  await expect(fetchJsrInfo("@std/semver", ctx)).rejects.toThrow("404");
});

// fetchNpmInfo
test("fetchNpmInfo resolutions key keeps scope", async () => {
  let fetchedUrl = "";
  const ctx = modeCtx({noCache: true, doFetch: (url: string) => {
    fetchedUrl = url;
    return textRes({});
  }});
  await fetchNpmInfo("@babel/core", "resolutions", {}, {}, ctx);
  // the scope must survive: fetch @babel/core, never the unscoped `core`
  expect(fetchedUrl.endsWith("/@babel%2fcore")).toBe(true);
});

test("fetchNpmInfo reads .npmrc from the manifest dir and honors an uncredentialed scoped registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-npmrc-"));
  writeFileSync(join(dir, ".npmrc"), "registry=https://default.test\n@myorg:registry=https://private.test\n");
  const urls: Array<string> = [];
  const ctx = modeCtx({noCache: true, doFetch: (url: string) => {
    urls.push(url);
    return textRes({});
  }});
  await fetchNpmInfo("@myorg/pkg", "dependencies", {}, {}, ctx, dir);
  await fetchNpmInfo("lodash", "dependencies", {}, {}, ctx, dir);
  expect(urls).toEqual(["https://private.test/@myorg%2fpkg", "https://default.test/lodash"]);
});

test("fetchNpmInfo requests the full doc only when dates are needed, never reusing the abbreviated one", async () => {
  // the abbreviated doc omits the `time` map, which would make cooldown a silent no-op
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

// getLatestCommit
test("getLatestCommit happy path", async () => {
  const ctx = forgeCtx({noCache: true, doFetch: () => textRes([{sha: "abc1234567890", commit: {committer: {date: "2025-01-01"}}}])});
  const result = await getLatestCommit("user", "repo", ctx);
  expect(result.hash).toBe("abc1234567890");
  expect(result.commit.committer.date).toBe("2025-01-01");
});

test.each([
  ["a repository with no commits", () => textRes([])],
  ["a repository that is gone", () => Promise.resolve({ok: false})],
])("getLatestCommit returns empty for %s", async (_name, doFetch) => {
  expect(await getLatestCommit("user", "repo", forgeCtx({doFetch}))).toEqual({hash: "", commit: {}});
});

test("getLatestCommit throws on a fetch failure", async () => {
  const ctx = forgeCtx({doFetch: () => Promise.reject(new Error("network error"))});
  await expect(getLatestCommit("user", "repo", ctx)).rejects.toThrow(/network error/);
});

// getTags
test("getTags returns tag names, or none when the fetch fails", async () => {
  const tagsData = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = forgeCtx({doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(tagsData), headers: new Headers()})});
  expect(await getTags("user", "repo", "v1.0.0", ctx)).toEqual(["v1.0.0", "v2.0.0"]);
  expect(await getTags("user", "repo", "v1.0.0", forgeCtx({doFetch: () => Promise.resolve({ok: false})}))).toEqual([]);
});

// checkUrlDep
test("checkUrlDep unparseable URL returns null", async () => {
  const ctx = forgeCtx({doFetch: () => Promise.resolve({ok: false})});
  expect(await checkUrlDep("key", {old: "not-a-url", new: ""} as any, ctx)).toBeNull();
});

test("checkUrlDep hash-based with update", async () => {
  const ctx = forgeCtx({noCache: true, doFetch: () => textRes([{sha: "def5678901234", commit: {committer: {date: "2025-03-01"}}}])});
  const result = await checkUrlDep("key", {old: "https://github.com/user/repo/abc1234", new: ""}, ctx);
  expect(result).not.toBeNull();
  expect(result!.newRef).toBe("def5678");
  expect(result!.newDate).toBe("2025-03-01");
});

test("checkUrlDep hash-based no change returns null", async () => {
  const ctx = forgeCtx({noCache: true, doFetch: () => textRes([{sha: "abc1234567890", commit: {}}])});
  expect(await checkUrlDep("key", {old: "https://github.com/user/repo/abc1234", new: ""} as any, ctx)).toBeNull();
});
