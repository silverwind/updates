import {test, expect, afterAll} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadRenovateConfig} from "./renovate.ts";
import {esc, patternToRegex} from "./utils.ts";

const created: Array<string> = [];
const exact = (name: string) => new RegExp(`^${esc(name)}$`);

type ExpectedImport = Record<string, unknown> & {$disabled?: Array<string>, $enabled?: Array<string>};

function expectImport(actual: Record<string, any>, {$disabled = [], $enabled = [], ...expected}: ExpectedImport): void {
  const enabled = (name: string) => {
    if (actual.exclude?.some((pattern: string | RegExp) => patternToRegex(pattern).test(name))) return false;
    return !actual.include?.length || actual.include.some((pattern: string | RegExp) => patternToRegex(pattern).test(name));
  };
  for (const name of $disabled) expect(enabled(name), `${name} should be disabled`).toBe(false);
  for (const name of $enabled) expect(enabled(name), `${name} should be enabled`).toBe(true);
  const {include: _include, exclude: _exclude, ...rest} = actual;
  expect(rest).toEqual(expected);
}

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
  ["ignoreDeps", "renovate.json", {ignoreDeps: ["foo", "bar"]}, {$disabled: ["foo", "bar"], $enabled: ["Foo", "foo*"]}],
  ["a disabled packageRule", "renovate.json",
    {packageRules: [{matchPackageNames: ["foo", "bar"], enabled: false}]}, {$disabled: ["foo", "bar"], $enabled: ["baz"]}],
  ["a disabled rule whose matchers are all negated", "renovate.json",
    {packageRules: [{matchPackageNames: ["!/^@types/"], enabled: false}]}, {$disabled: ["react"], $enabled: ["@types/node"]}],
  ["allowedVersions", "renovate.json",
    {packageRules: [{matchPackageNames: ["react"], allowedVersions: "^18.0.0"}]},
    {pin: {react: "^18.0.0"}, pinNoDowngrade: true,
      renovateVersionRules: [{matchPackageNames: ["react"], allowedVersions: "^18.0.0"}]}],
  ["later glob and regex allowedVersions rules replace literal pins", "renovate.json", {packageRules: [
    {matchPackageNames: ["react"], allowedVersions: "^18"},
    {matchPackageNames: ["*"], allowedVersions: "^19"},
    {matchPackageNames: ["vue"], allowedVersions: "^2"},
    {matchPackageNames: ["/^vue$/"], allowedVersions: "^3"},
  ]}, {
    pin: {react: "^19", vue: "^3"},
    pinNoDowngrade: true,
    renovateVersionRules: [
      {matchPackageNames: ["react"], allowedVersions: "^18"},
      {matchPackageNames: ["*"], allowedVersions: "^19"},
      {matchPackageNames: ["vue"], allowedVersions: "^2"},
      {matchPackageNames: [/^vue$/], allowedVersions: "^3"},
    ],
  }],
  ["a deny-all followed by an allow-list", "renovate.json", {packageRules: [
    {matchPackageNames: ["react"], enabled: false},
    {matchPackageNames: ["*"], enabled: false},
    {matchPackageNames: ["react", "react-dom"], enabled: true},
  ]}, {$disabled: ["vue"], $enabled: ["react", "react-dom"]}],
  ["a deny-all with no matcher and nothing re-enabled", "renovate.json",
    {packageRules: [{enabled: false}]}, {$disabled: ["foo"]}],
  ["a later enabled rule, which clears an earlier exclude", "renovate.json", {
    ignoreDeps: ["ignored"],
    packageRules: [
      {matchPackageNames: ["foo", "bar"], enabled: false},
      {matchPackageNames: ["foo"], enabled: true},
      {matchPackageNames: ["ignored"], enabled: true},
    ],
  }, {$disabled: ["ignored", "bar"], $enabled: ["foo"]}],
  ["a later enabled rule, which clears every copy of an earlier exclude", "renovate.json", {packageRules: [
    {matchPackageNames: ["foo"], enabled: false},
    {matchPackageNames: ["foo"], enabled: false},
    {matchPackageNames: ["foo"], enabled: true},
  ]}, {$enabled: ["foo"]}],
  ["none of the packageRules with non-name matchers", "renovate.json", {packageRules: [
    {matchPackageNames: ["foo"], matchUpdateTypes: ["major"], enabled: false},
    {matchManagers: ["npm"], enabled: false},
    {matchPackageNames: ["webpack"], updateTypes: ["major"], enabled: false},
    {matchPackageNames: ["rollup"], excludeDepNames: ["rollup"], enabled: false},
    {matchPackageNames: ["vite"], depTypeList: ["devDependencies"], allowedVersions: "^1"},
  ]}, {$enabled: ["foo", "webpack", "rollup", "vite"]}],
  ["legacy package matchers", "renovate.json", {packageRules: [
    {packageName: "singular", enabled: false},
    {packagePattern: "^pattern", enabled: false},
    {packageNames: ["foo"], enabled: false},
    {packagePatterns: ["^bar"], enabled: false},
    {matchPackagePrefixes: ["@baz/"], enabled: false},
    {matchPackageNames: ["qux"], excludePackageNames: ["qux"], enabled: false},
    {matchPackageNames: ["@qux/{/,}**"], enabled: false},
  ]}, {$disabled: ["singular", "patterned", "foo", "barrel", "@baz/pkg", "@qux/pkg"], $enabled: ["qux"]}],
  ["a packageRule mixing positive and negated matchers", "renovate.json",
    {packageRules: [{matchPackageNames: ["@babel/*", "!@babel/core"], enabled: false}]},
    {$disabled: ["@babel/parser"], $enabled: ["@babel/core", "react"]}],
  ["a wider exclude can be re-enabled by a later rule", "renovate.json", {packageRules: [
    {matchPackageNames: ["@babel/*"], enabled: false},
    {matchPackageNames: ["@babel/core"], enabled: true},
  ]}, {$disabled: ["@babel/parser"], $enabled: ["@babel/core"]}],
  ["top-level enabled false, which disables everything", "renovate.json",
    {enabled: false, ignoreDeps: ["foo"]}, {$disabled: ["foo", "bar"]}],
  ["only a literal renovate.json", "renovate.jsonc", {ignoreDeps: ["foo"]}, {$enabled: ["foo"]}],
])("loadRenovateConfig reads %s", async (_name, file, config, expected) => {
  const dir = makeDir();
  if (file) writeFileSync(join(dir, file), typeof config === "string" ? config : JSON.stringify(config));
  expectImport(await loadRenovateConfig(dir), expected);
});

test("regex allowedVersions forms are preserved for release filtering", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({packageRules: [
    {matchPackageNames: ["foo*", "!foobar"], allowedVersions: "/^1\\./"},
    {matchPackageNames: ["bar"], allowedVersions: "!/beta/i"},
  ]}));
  expect(await loadRenovateConfig(dir)).toEqual({renovateVersionRules: [
    {matchPackageNames: ["foo*"], excludePackageNames: ["foobar"], allowedVersions: "/^1\\./"},
    {matchPackageNames: ["bar"], allowedVersions: "!/beta/i"},
  ]});
});

test.each([["3 days", 3], ["1 week", 7], ["12 hours", 0.5]])("minimumReleaseAge %s → cooldown", async (age, cooldown) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({minimumReleaseAge: age}));
  expect(await loadRenovateConfig(dir, {cooldown: true})).toEqual({cooldown});
});

test("a packageRule minimumReleaseAge with no matcher applies to every dependency", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({packageRules: [
    {minimumReleaseAge: "7 days"},
    {matchPackageNames: ["esbuild"], minimumReleaseAge: "1 day"},
  ]}));
  expect(await loadRenovateConfig(dir, {cooldown: true}))
    .toEqual({renovateVersionRules: [{cooldownDays: 7}, {matchPackageNames: ["esbuild"], cooldownDays: 1}]});
});

test("a subdirectory inherits the config of a parent directory", async () => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), JSON.stringify({ignoreDeps: ["foo"]}));
  mkdirSync(join(dir, "pkg"));
  expect(await loadRenovateConfig(join(dir, "pkg"))).toEqual({exclude: [exact("foo")]});
});

test.each([
  ["invalid allowedVersions", {packageRules: [{matchPackageNames: ["foo"], allowedVersions: "not-a-range"}]},
    "Invalid renovate allowedVersions: not-a-range"],
  ["top-level extends", {extends: ["config:recommended"]}, "extends"],
  ["nested extends", {packageRules: [{matchPackageNames: ["foo"], extends: [":disableRenovate"]}]},
    "extends"],
  ["malformed JSON", "{bad json", "Unable to parse renovate config"],
])("%s is rejected", async (_name, config, error) => {
  const dir = makeDir();
  writeFileSync(join(dir, "renovate.json"), typeof config === "string" ? config : JSON.stringify(config));
  await expect(loadRenovateConfig(dir)).rejects.toThrow(error === "extends" ?
    `Renovate extends is unsupported in ${join(dir, "renovate.json")}` : error);
});
