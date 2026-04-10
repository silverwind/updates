import {
  isJsr, isLocalDep, parseJsrDependency, updateVersionRange, normalizeRange,
  updatePackageJson, fetchJsrInfo, getLatestCommit, getTags, checkUrlDep,
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
    [depsKey]: {old: "^1.0.0", new: "^2.0.0"} as any,
  });
  expect(result1).toContain(`"foo": "^2.0.0"`);

  const result2 = updatePackageJson(pkg, {
    [pmKey]: {old: "8.0.0", new: "9.0.0"} as any,
  });
  expect(result2).toContain(`"packageManager": "pnpm@9.0.0"`);
});

// fetchJsrInfo
test("fetchJsrInfo happy path", async () => {
  const jsrData = {latest: "1.0.0", versions: {"1.0.0": {createdAt: "2025-01-01T00:00:00Z"}, "0.9.0": {createdAt: "2024-06-01T00:00:00Z"}}};
  const ctx = {
    jsrApiUrl: "https://jsr.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(jsrData)}),
  } as unknown as ModeContext;
  const [data, type, registry, name] = await fetchJsrInfo("@std/semver", "dependencies", ctx);
  expect(type).toBe("dependencies");
  expect(registry).toBe("https://jsr.io");
  expect(name).toBe("@std/semver");
  expect(data["dist-tags"].latest).toBe("1.0.0");
  expect(Object.keys(data.versions)).toEqual(["1.0.0", "0.9.0"]);
  expect(data.time["1.0.0"]).toBe("2025-01-01T00:00:00Z");
});

test("fetchJsrInfo invalid package name throws", async () => {
  const ctx = {} as unknown as ModeContext;
  await expect(fetchJsrInfo("noscopepkg", "dependencies", ctx)).rejects.toThrow("Invalid JSR package name");
});

test("fetchJsrInfo fetch failure throws", async () => {
  const ctx = {
    jsrApiUrl: "https://jsr.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"}),
  } as unknown as ModeContext;
  await expect(fetchJsrInfo("@std/semver", "dependencies", ctx)).rejects.toThrow("404");
});

// getLatestCommit
test("getLatestCommit happy path", async () => {
  const commitData = [{sha: "abc1234567890", commit: {committer: {date: "2025-01-01"}}}];
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(commitData)}),
  } as unknown as ModeContext;
  const result = await getLatestCommit("user", "repo", ctx);
  expect(result.hash).toBe("abc1234567890");
  expect(result.commit.committer.date).toBe("2025-01-01");
});

test("getLatestCommit fetch failure returns empty", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  expect(await getLatestCommit("user", "repo", ctx)).toEqual({hash: "", commit: {}});
});

test("getLatestCommit fetch throws returns empty", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.reject(new Error("network error")),
  } as unknown as ModeContext;
  expect(await getLatestCommit("user", "repo", ctx)).toEqual({hash: "", commit: {}});
});

// getTags
test("getTags returns tag names", async () => {
  const tagsData = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(tagsData), headers: new Headers()}),
  } as unknown as ModeContext;
  expect(await getTags("user", "repo", ctx)).toEqual(["v1.0.0", "v2.0.0"]);
});

test("getTags fetch failure returns empty", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  expect(await getTags("user", "repo", ctx)).toEqual([]);
});

// checkUrlDep
test("checkUrlDep unparseable URL returns null", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  const dep = {old: "not-a-url", new: ""};
  expect(await checkUrlDep("key", dep as any, false, ctx)).toBeNull();
});

test("checkUrlDep hash-based with update", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve([{sha: "def5678901234", commit: {committer: {date: "2025-03-01"}}}])}),
  } as unknown as ModeContext;
  const dep = {old: "https://github.com/user/repo/abc1234", new: ""};
  const result = await checkUrlDep("key", dep as any, false, ctx);
  expect(result).not.toBeNull();
  expect(result!.newRef).toBe("def5678");
  expect(result!.newDate).toBe("2025-03-01");
});

test("checkUrlDep hash-based no change returns null", async () => {
  const ctx = {
    forgeApiUrl: "https://api.github.com",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve([{sha: "abc1234567890", commit: {}}])}),
  } as unknown as ModeContext;
  const dep = {old: "https://github.com/user/repo/abc1234", new: ""};
  expect(await checkUrlDep("key", dep as any, false, ctx)).toBeNull();
});
