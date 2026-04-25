import {test, expect, afterAll} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadRenovateConfig} from "./renovate.ts";

const fixturesDir = fileURLToPath(new URL("../fixtures/renovate/", import.meta.url));

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

test("minimumReleaseAge → cooldown (days)", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "3 days"}));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 3});
});

test("minimumReleaseAge weeks", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "1 week"}));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 7});
});

test("minimumReleaseAge hours", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "12 hours"}));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 0.5});
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

test.each([".github", ".gitea", ".forgejo", ".gitlab"])("forge dir config in %s", async (forge) => {
  const dir = makeDir();
  mkdirSync(join(dir, forge));
  writeFileSync(join(dir, forge, "renovate.json"), JSON.stringify({minimumReleaseAge: "2 days"}));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 2});
});

test("package.json renovate field", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "x",
    renovate: {minimumReleaseAge: "5 days", ignoreDeps: ["foo"]},
  }));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 5, exclude: ["foo"]});
});

test("renovate.json wins over forge config", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: "1 day"}));
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "renovate.json"), JSON.stringify({minimumReleaseAge: "9 days"}));
  expect(await loadRenovateConfig(dir)).toEqual({cooldown: 1});
});

test("real-world config", async () => {
  const dir = makeDir();
  copyFileSync(join(fixturesDir, "real-world.json5"), join(dir, "renovate.json5"));
  expect(await loadRenovateConfig(dir)).toEqual({
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
