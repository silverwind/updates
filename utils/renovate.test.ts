import {test, expect, afterAll} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadRenovateConfig, makePresetFetcher, type PresetFetcher} from "./renovate.ts";

const fixturesDir = fileURLToPath(new URL("../fixtures/renovate/", import.meta.url));

// Adapt a synchronous URL→body resolver into a PresetFetcher, keeping mocks terse.
const fetcher = (fn: (url: string) => string | null): PresetFetcher => (url) => Promise.resolve(fn(url));

const noFetch = fetcher(() => null);

const emptyPresets = fetcher(() => "{}");

// Both runners run a file's tests concurrently, so the globalThis.fetch swap below has to opt out.
const sequential = test.sequential ?? (test as any).serial ?? test;

const created: Array<string> = [];

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "updates-renovate-"));
  created.push(d);
  return d;
}

afterAll(() => {
  for (const d of created) rmSync(d, {recursive: true, force: true});
});

test.each([
  ["no config at all", null, null, {}],
  ["minimumReleaseAge, which needs --cooldown to opt in", "renovate.json", {minimumReleaseAge: "3 days"}, {}],
  ["ignoreDeps", "renovate.json", {ignoreDeps: ["foo", "bar"]}, {exclude: ["foo", "bar"]}],
  ["a disabled packageRule", "renovate.json",
    {packageRules: [{matchPackageNames: ["foo", "bar"], enabled: false}]}, {exclude: ["foo", "bar"]}],
  // renovate disables everything except @types, which is an allow-list, not a no-op exclude
  ["a disabled rule whose matchers are all negated", "renovate.json",
    {packageRules: [{matchPackageNames: ["!/^@types/"], enabled: false}]}, {include: [/^@types/]}],
  ["allowedVersions", "renovate.json",
    {packageRules: [{matchPackageNames: ["react"], allowedVersions: "^18.0.0"}]},
    {pin: {react: "^18.0.0"}, pinNoDowngrade: true}],
  ["an invalid allowedVersions range", "renovate.json",
    {packageRules: [{matchPackageNames: ["foo"], allowedVersions: "not-a-range"}]}, {}],
  ["a deny-all followed by an allow-list", "renovate.json", {packageRules: [
    {matchPackageNames: ["react"], enabled: false},
    {matchPackageNames: ["*"], enabled: false},
    {matchPackageNames: ["react", "react-dom"], enabled: true}, // clears the earlier exclude too
  ]}, {include: ["react", "react-dom"]}],
  ["a deny-all with no matcher and nothing re-enabled", "renovate.json",
    {packageRules: [{enabled: false}]}, {exclude: ["*"]}],
  ["a later enabled rule, which clears an earlier exclude", "renovate.json", {
    ignoreDeps: ["ignored"],
    packageRules: [
      {matchPackageNames: ["foo", "bar"], enabled: false},
      {matchPackageNames: ["foo"], enabled: true},
      {matchPackageNames: ["ignored"], enabled: true}, // ignoreDeps is not a packageRule, so it stays
    ],
  }, {exclude: ["ignored", "bar"]}],
  ["a later enabled rule, which clears every copy of an earlier exclude", "renovate.json", {packageRules: [
    {matchPackageNames: ["foo"], enabled: false},
    {matchPackageNames: ["foo"], enabled: false},
    {matchPackageNames: ["foo"], enabled: true},
  ]}, {}],
  ["none of the packageRules with non-name matchers", "renovate.json", {packageRules: [
    {matchPackageNames: ["foo"], matchUpdateTypes: ["major"], enabled: false},
    {matchManagers: ["npm"], enabled: false},
    {matchPackageNames: ["webpack"], updateTypes: ["major"], enabled: false},
    {matchPackageNames: ["rollup"], excludeDepNames: ["rollup"], enabled: false},
    {matchPackageNames: ["vite"], depTypeList: ["devDependencies"], allowedVersions: "^1"},
  ]}, {}],
  ["legacy package matchers", "renovate.json", {packageRules: [
    {packageNames: ["foo"], enabled: false},
    {packagePatterns: ["^bar"], enabled: false},
    {matchPackagePrefixes: ["@baz/"], enabled: false},
    {matchPackageNames: ["qux"], excludePackageNames: ["qux"], enabled: false}, // and-not, skipped
  ]}, {exclude: ["foo", /^bar/, "@baz/*"]}],
  // renovate needs a positive and every negation to match, which exclude cannot express
  ["no packageRule mixing positive and negated matchers", "renovate.json",
    {packageRules: [{matchPackageNames: ["@babel/*", "!@babel/core"], enabled: false}]}, {}],
  ["a wider exclude a later rule cannot punch a hole in", "renovate.json", {packageRules: [
    {matchPackageNames: ["@babel/*"], enabled: false},
    {matchPackageNames: ["@babel/core"], enabled: true},
  ]}, {exclude: ["@babel/*"]}],
  ["top-level enabled false, which disables everything", "renovate.json",
    {enabled: false, ignoreDeps: ["foo"]}, {exclude: ["*"]}],
  ["renovate.jsonc, comments and all", "renovate.jsonc", `{\n  // ignore foo\n  "ignoreDeps": ["foo"]\n}`,
    {exclude: ["foo"]}],
])("loadRenovateConfig reads %s", async (_name, file, config, expected) => {
  const dir = makeDir();
  if (file) writeFileSync(join(dir, file), typeof config === "string" ? config : JSON.stringify(config));
  expect(await loadRenovateConfig(dir)).toEqual(expected);
});

test.each([["3 days", 3], ["1 week", 7], ["12 hours", 0.5]])("minimumReleaseAge %s → cooldown", async (age, cooldown) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: age}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown});
});

test("a subdirectory inherits the config of a parent directory", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({ignoreDeps: ["foo"]}));
  mkdirSync(join(dir, "pkg"));
  expect(await loadRenovateConfig(join(dir, "pkg"))).toEqual({exclude: ["foo"]});
});

test("renovate.json5 comments, trailing commas, unquoted keys and single quotes", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json5"), `{
    // pin react
    extends: ['github>sxzz/renovate-config'],
    automerge: true,
    packageRules: [
      {matchPackageNames: ['react'], allowedVersions: '^18.0.0',},
    ],
  }`);
  expect(await loadRenovateConfig(dir, {}, emptyPresets)).toEqual({pin: {react: "^18.0.0"}, pinNoDowngrade: true});
});

test("extends github preset is fetched and merged", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json5"), `{
    extends: ['github>sxzz/renovate-config'],
    ignoreDeps: ['local-dep'],
  }`);
  const fetched: Array<string> = [];
  const fetchText = fetcher((url) => {
    fetched.push(url);
    if (url.endsWith("/default.json")) {
      return JSON.stringify({
        extends: ["config:recommended"], // built-in, skipped without network
        ignoreDeps: ["node"],
        packageRules: [{matchPackageNames: ["react"], allowedVersions: "^18"}],
      });
    }
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({
    exclude: ["node", "local-dep"],
    pin: {react: "^18"},
    pinNoDowngrade: true,
  });
  expect(fetched[0]).toBe("https://raw.githubusercontent.com/sxzz/renovate-config/HEAD/default.json");
});

// Presets keyed by their `org/<key>` path, so a row only spells the graph it needs.
test.each([
  ["recursively", ["github>org/a"],
    {a: {extends: ["github>org/b"], ignoreDeps: ["a"]}, b: {ignoreDeps: ["b"]}}, ["b", "a"]],
  ["without looping on a cycle", ["github>org/a"],
    {a: {extends: ["github>org/b"], ignoreDeps: ["a"]}, b: {extends: ["github>org/a"], ignoreDeps: ["b"]}}, ["b", "a"]],
  // c is reached via both a and b (path-scoped seen), so it contributes on each path
  ["on each path of a diamond", ["github>org/a", "github>org/b"],
    {a: {extends: ["github>org/c"], ignoreDeps: ["a"]}, b: {extends: ["github>org/c"], ignoreDeps: ["b"]},
      c: {ignoreDeps: ["c"]}}, ["c", "a", "c", "b"]],
])("extends resolves %s", async (_name, extendsList, presets: Record<string, unknown>, exclude) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: extendsList}));
  const fetchText = fetcher((url) => {
    const key = /\/org\/(\w+)\//.exec(url)?.[1];
    return key && presets[key] ? JSON.stringify(presets[key]) : null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude});
});

test("named preset is a file in the repo, subpath fetches the file", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["github>org/a:group", "github>org/a:file/key", "gitlab>org/b//path/file", "github>org/c:default"],
  }));
  const urls: Array<string> = [];
  const fetchText = fetcher((url) => {
    urls.push(url);
    // `:group` is group.json, not a `presets` map inside the repo's default.json
    if (url.endsWith("/org/a/HEAD/group.json")) return JSON.stringify({ignoreDeps: ["g"]});
    if (url.endsWith("/org/a/HEAD/file.json")) return JSON.stringify({key: {ignoreDeps: ["k"]}});
    if (url.endsWith("/org/b/-/raw/HEAD/path/file.json")) return JSON.stringify({ignoreDeps: ["f"]});
    if (url.endsWith("/org/c/HEAD/default.json")) return JSON.stringify({ignoreDeps: ["d"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["g", "k", "f", "d"]});
  expect(urls).toContain("https://raw.githubusercontent.com/org/a/HEAD/group.json");
  expect(urls).not.toContain("https://raw.githubusercontent.com/org/a/HEAD/default.json");
});

test("named preset with an explicit extension is fetched verbatim", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: ["github>org/a:group.jsonc"]}));
  const fetchText = fetcher((url) => {
    if (url.endsWith("/org/a/HEAD/group.jsonc")) return `{"ignoreDeps": ["g"]} // comment`;
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["g"]});
});

// bun 1.3.14 deadlocks when these rejections are asserted from concurrent tests, so run them in order.
sequential.each([
  ["a named preset the file does not carry", ["github>org/a:file/foo"],
    fetcher((url) => url.endsWith("/file.json") ? JSON.stringify({other: {ignoreDeps: ["nope"]}}) : null),
    "Unable to resolve renovate preset github>org/a:file/foo: no preset foo in file"],
  ["a preset that resolves to nothing", ["github>org/a"], noFetch,
    "Unable to resolve renovate preset github>org/a: not found"],
  ["an unreachable preset host", ["github>org/a"], () => Promise.reject(new Error("connect ECONNREFUSED")),
    "Unable to resolve renovate preset github>org/a: connect ECONNREFUSED"],
  ["an unparseable preset", ["github>org/a"], fetcher(() => "{bad json"),
    "Unable to resolve renovate preset github>org/a: invalid JSON in https://raw.githubusercontent.com/org/a/HEAD/default.json"],
])("%s is fatal", async (_name, extendsList, fetchText, message) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: extendsList, ignoreDeps: ["own"]}));
  await expect(loadRenovateConfig(dir, {}, fetchText)).rejects.toThrow(message);
});

test.each([
  ["built-in and unresolvable presets", ["config:recommended", ":pinVersions", "local>org/a", "bitbucket>org/b"]],
  ["inherited-key forges", ["__proto__>org/a", "constructor>org/b"]],
])("%s are skipped without fetching", async (_name, extendsList) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: extendsList, ignoreDeps: ["own"]}));
  let called = false;
  const fetchText = fetcher(() => { called = true; return null; });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["own"]});
  expect(called).toBe(false);
});

test("gitea and forgejo presets resolve against their default endpoints", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["gitea>org/a", "forgejo>org/b"],
  }));
  // Only the exact default-endpoint URLs return content, so a pass proves the URLs.
  const fetchText = fetcher((url) => {
    if (url === "https://gitea.com/api/v1/repos/org/a/raw/default.json?ref=HEAD") return JSON.stringify({ignoreDeps: ["gt"]});
    if (url === "https://code.forgejo.org/api/v1/repos/org/b/raw/default.json?ref=HEAD") return JSON.stringify({ignoreDeps: ["fj"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["gt", "fj"]});
});

test("http preset is fetched directly as a single file", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["https://git.example.com/org/repo/raw/branch/main/renovate.json"],
    ignoreDeps: ["own"],
  }));
  const urls: Array<string> = [];
  const fetchText = fetcher((url) => {
    urls.push(url);
    return JSON.stringify({ignoreDeps: ["remote"]});
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["remote", "own"]});
  expect(urls).toEqual(["https://git.example.com/org/repo/raw/branch/main/renovate.json"]);
});

test("extends accepts a bare string", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: "github>org/a", ignoreDeps: ["own"]}));
  const fetchText = fetcher((url) => url.endsWith("/default.json") ? JSON.stringify({ignoreDeps: ["remote"]}) : null);
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["remote", "own"]});
});

// Swap globalThis.fetch directly (not vi.stubGlobal, which bun's test runner lacks).
async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

sequential.each([
  ["a failed body read", "x", () => Promise.resolve({
    ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error("reset")),
  }), "https://example.com/x: reset"],
  ["a non-ok response", "y", () => Promise.resolve(new Response(null, {status: 503})), "https://example.com/y: HTTP 503"],
  ["an unreachable host", "w", () => Promise.reject(new Error("fetch failed")), "https://example.com/w: fetch failed"],
])("makePresetFetcher throws on %s", async (_name, path, impl, message) => {
  const fetchText = makePresetFetcher({noCache: true});
  await withFetch(impl as unknown as typeof fetch, async () => {
    await expect(fetchText(`https://example.com/${path}`)).rejects.toThrow(message);
  });
});

sequential("makePresetFetcher retries a transient failure rather than failing the run", async () => {
  const fetchText = makePresetFetcher({noCache: true});
  let calls = 0;
  const impl = () => ++calls === 1 ?
    Promise.reject(Object.assign(new Error("socket"), {code: "ECONNRESET"})) :
    Promise.resolve(new Response("{}", {status: 200}));
  await withFetch(impl, async () => {
    expect(await fetchText("https://example.com/r")).toBe("{}");
  });
});

sequential("makePresetFetcher returns null on 404, so another candidate file can be tried", async () => {
  const fetchText = makePresetFetcher({noCache: true});
  await withFetch(() => Promise.resolve(new Response(null, {status: 404})), async () => {
    expect(await fetchText("https://example.com/z")).toBe(null);
  });
});

test.each([".github", ".gitea", ".forgejo", ".gitlab"])("forge dir config in %s", async (forge) => {
  const dir = makeDir();
  mkdirSync(join(dir, forge));
  writeFileSync(join(dir, forge, "renovate.json"), JSON.stringify({minimumReleaseAge: "2 days"}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 2});
});

test("package.json renovate field", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "x",
    renovate: {minimumReleaseAge: "5 days", ignoreDeps: ["foo"]},
  }));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 5, exclude: ["foo"]});
});

test("renovate.json wins over forge config", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "1 day"}));
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "renovate.json"), JSON.stringify({minimumReleaseAge: "9 days"}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 1});
});

test("real-world config", async () => {
  const dir = makeDir();
  copyFileSync(join(fixturesDir, "real-world.json5"), join(dir, "renovate.json5"));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({
    cooldown: 5,
    exclude: [/^@types\//],
    pin: {
      "@mcaptcha/vanilla-glue": "^0.1",
      "cropperjs": "^1",
      "tailwindcss": "^3",
    },
    pinNoDowngrade: true,
  });
});

test("malformed config throws", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), `{bad json`);
  await expect(loadRenovateConfig(dir)).rejects.toThrow(/Unable to parse renovate config/);
});
