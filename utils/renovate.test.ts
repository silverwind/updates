import {test, expect, afterAll, vi} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadRenovateConfig, makePresetFetcher, type PresetFetcher} from "./renovate.ts";

const fixturesDir = fileURLToPath(new URL("../fixtures/renovate/", import.meta.url));

// Adapt a synchronous URL→body resolver into a PresetFetcher, keeping mocks terse.
const fetcher = (fn: (url: string) => string | null): PresetFetcher => (url) => Promise.resolve(fn(url));

// Default preset fetcher for tests: resolves nothing, so no network is hit.
const noFetch = fetcher(() => null);

const created: Array<string> = [];

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "updates-renovate-"));
  created.push(d);
  return d;
}

afterAll(() => {
  for (const d of created) rmSync(d, {recursive: true, force: true});
});

test("no config returns empty", async () => {
  expect(await loadRenovateConfig(makeDir())).toEqual({});
});

test("minimumReleaseAge skipped without opt-in", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "3 days"}));
  expect(await loadRenovateConfig(dir)).toEqual({});
});

test("minimumReleaseAge → cooldown (days)", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "3 days"}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 3});
});

test("minimumReleaseAge weeks", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "1 week"}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 7});
});

test("minimumReleaseAge hours", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "12 hours"}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown: 0.5});
});

test("ignoreDeps → exclude", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({ignoreDeps: ["foo", "bar"]}));
  expect(await loadRenovateConfig(dir)).toEqual({exclude: ["foo", "bar"]});
});

test("packageRules disabled → exclude", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    packageRules: [{matchPackageNames: ["foo", "bar"], enabled: false}],
  }));
  expect(await loadRenovateConfig(dir)).toEqual({exclude: ["foo", "bar"]});
});

test("packageRules allowedVersions → pin", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    packageRules: [{matchPackageNames: ["react"], allowedVersions: "^18.0.0"}],
  }));
  expect(await loadRenovateConfig(dir)).toEqual({pin: {react: "^18.0.0"}});
});

test("packageRules with non-name matchers are skipped", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    packageRules: [
      {matchPackageNames: ["foo"], matchUpdateTypes: ["major"], enabled: false},
      {matchManagers: ["npm"], enabled: false},
    ],
  }));
  expect(await loadRenovateConfig(dir)).toEqual({});
});

test("invalid allowedVersions range is ignored", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    packageRules: [{matchPackageNames: ["foo"], allowedVersions: "not-a-range"}],
  }));
  expect(await loadRenovateConfig(dir)).toEqual({});
});

test("renovate.json5 with comments and trailing commas", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json5"), `{
    // pin react
    "packageRules": [
      {"matchPackageNames": ["react"], "allowedVersions": "^18.0.0",},
    ],
  }`);
  expect(await loadRenovateConfig(dir)).toEqual({pin: {react: "^18.0.0"}});
});

test("renovate.json5 with unquoted keys and single-quoted strings", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json5"), `{
    extends: ['github>sxzz/renovate-config'],
    automerge: true,
    packageRules: [
      {
        matchPackageNames: ['react'],
        allowedVersions: '^18.0.0',
      },
    ],
  }`);
  expect(await loadRenovateConfig(dir, {}, noFetch)).toEqual({pin: {react: "^18.0.0"}});
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
  });
  expect(fetched[0]).toBe("https://raw.githubusercontent.com/sxzz/renovate-config/HEAD/default.json");
});

test("extends resolves recursively across presets", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: ["github>org/a"]}));
  const fetchText = fetcher((url) => {
    if (url.includes("/org/a/")) return JSON.stringify({extends: ["github>org/b"], ignoreDeps: ["a"]});
    if (url.includes("/org/b/")) return JSON.stringify({ignoreDeps: ["b"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["b", "a"]});
});

test("named preset reads presets[name] from the repo config, subpath fetches the file", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["github>org/a:group", "gitlab>org/b//path/file"],
  }));
  const urls: Array<string> = [];
  const fetchText = fetcher((url) => {
    urls.push(url);
    // named preset `:group` comes from the repo's default.json presets map, not group.json
    if (url.endsWith("/org/a/HEAD/default.json")) return JSON.stringify({presets: {group: {ignoreDeps: ["g"]}}});
    if (url.endsWith("/org/b/-/raw/HEAD/path/file.json")) return JSON.stringify({ignoreDeps: ["f"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["g", "f"]});
  expect(urls).toContain("https://raw.githubusercontent.com/org/a/HEAD/default.json");
  expect(urls).toContain("https://gitlab.com/org/b/-/raw/HEAD/path/file.json");
  expect(urls).not.toContain("https://raw.githubusercontent.com/org/a/HEAD/group.json");
});

test("named preset missing from the config is skipped (does not fall back to whole config)", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["github>org/a:foo"],
    ignoreDeps: ["own"],
  }));
  const fetchText = fetcher((url) => {
    // default.json exists but has no `foo` preset → Renovate would not apply the whole config
    if (url.endsWith("/default.json")) return JSON.stringify({ignoreDeps: ["should-not-apply"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["own"]});
});

test("built-in and unresolvable presets are skipped without fetching", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["config:recommended", "local>org/a", "gitea>org/b", "forgejo>org/c"],
    ignoreDeps: ["own"],
  }));
  let called = false;
  const fetchText = fetcher(() => { called = true; return null; });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["own"]});
  expect(called).toBe(false);
});

test("unreachable preset is skipped, local config still applies", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["github>org/a"],
    ignoreDeps: ["own"],
  }));
  expect(await loadRenovateConfig(dir, {}, noFetch)).toEqual({exclude: ["own"]}); // every fetch fails
});

test("extends cycles terminate", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: ["github>org/a"]}));
  const fetchText = fetcher((url) => {
    if (url.includes("/org/a/")) return JSON.stringify({extends: ["github>org/b"], ignoreDeps: ["a"]});
    if (url.includes("/org/b/")) return JSON.stringify({extends: ["github>org/a"], ignoreDeps: ["b"]});
    return null;
  });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["b", "a"]});
});

test("inherited-key forges (__proto__, constructor) are skipped, not fetched", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({
    extends: ["__proto__>org/a", "constructor>org/b"],
    ignoreDeps: ["own"],
  }));
  let called = false;
  const fetchText = fetcher(() => { called = true; return null; });
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["own"]});
  expect(called).toBe(false);
});

test("diamond extends resolves the shared preset on each path", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({extends: ["github>org/a", "github>org/b"]}));
  const fetchText = fetcher((url) => {
    if (url.includes("/org/a/")) return JSON.stringify({extends: ["github>org/c"], ignoreDeps: ["a"]});
    if (url.includes("/org/b/")) return JSON.stringify({extends: ["github>org/c"], ignoreDeps: ["b"]});
    if (url.includes("/org/c/")) return JSON.stringify({ignoreDeps: ["c"]});
    return null;
  });
  // c is reached via both a and b (path-scoped seen), so it contributes on each path.
  expect(await loadRenovateConfig(dir, {}, fetchText)).toEqual({exclude: ["c", "a", "c", "b"]});
});

test("makePresetFetcher returns null (not throw) when the body read fails", async () => {
  const fetchText = makePresetFetcher({noCache: true});
  vi.stubGlobal("fetch", () => Promise.resolve({
    ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error("reset")),
  }));
  expect(await fetchText("https://example.com/x")).toBe(null);
  vi.unstubAllGlobals();
});

test("makePresetFetcher returns null on a non-ok response with no cache", async () => {
  const fetchText = makePresetFetcher({noCache: true});
  vi.stubGlobal("fetch", () => Promise.resolve({
    ok: false, status: 503, headers: new Headers(), text: () => Promise.resolve(""),
  }));
  expect(await fetchText("https://example.com/y")).toBe(null);
  vi.unstubAllGlobals();
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
  });
});

test("malformed config throws", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), `{bad json`);
  await expect(loadRenovateConfig(dir)).rejects.toThrow(/Unable to parse renovate config/);
});
