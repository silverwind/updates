import {join} from "node:path";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {npmEcosystemCooldown} from "./pmCooldown.ts";

const globalExpect = expect;
const mkdir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test("npmrc min-release-age in days", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-npm-");
  writeFileSync(join(dir, ".npmrc"), "registry=https://example.com\nmin-release-age=3\n");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(3);
  expect(exclude.size).toBe(0);
});

test("npmrc min-release-age-exclude", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-npm-ex-");
  writeFileSync(join(dir, ".npmrc"), "min-release-age=7\nmin-release-age-exclude=react, @scope/pkg\n");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(7);
  expect(Array.from(exclude).sort()).toEqual(["@scope/pkg", "react"]);
});

test("npmrc pnpm minimum-release-age in minutes", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-npm-min-");
  writeFileSync(join(dir, ".npmrc"), "minimum-release-age=2880\n");
  const {days} = npmEcosystemCooldown(dir);
  expect(days).toBe(2); // 2880 minutes = 2 days
});

test("pnpm-workspace.yaml minimumReleaseAge with block exclude", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-pnpm-");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), [
    "packages:",
    "  - 'packages/*'",
    "minimumReleaseAge: 1440",
    "minimumReleaseAgeExclude:",
    "  - react",
    "  - '@myorg/*'",
  ].join("\n"));
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(1); // 1440 minutes = 1 day
  expect(Array.from(exclude).sort()).toEqual(["@myorg/*", "react"]);
});

test("pnpm-workspace.yaml inline array exclude", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-pnpm-inline-");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "minimumReleaseAge: 720\nminimumReleaseAgeExclude: ['react', \"vue\"]\n");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(0.5); // 720 minutes = half a day
  expect(Array.from(exclude).sort()).toEqual(["react", "vue"]);
});

test("pnpm-workspace.yaml quoted minimumReleaseAge", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-pnpm-quoted-");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "minimumReleaseAge: \"2880\"\n");
  const {days} = npmEcosystemCooldown(dir);
  expect(days).toBe(2); // 2880 minutes = 2 days, even when quoted
});

test("bunfig.toml minimumReleaseAge in seconds with excludes", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-bun-");
  writeFileSync(join(dir, "bunfig.toml"), "[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = [\"react\", \"left-pad\"]\n");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(3); // 259200 seconds = 3 days
  expect(Array.from(exclude).sort()).toEqual(["left-pad", "react"]);
});

test(".yarnrc.yml npmMinimalAgeGate in minutes with preapproved", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-yarn-");
  writeFileSync(join(dir, ".yarnrc.yml"), "npmMinimalAgeGate: 4320\nnpmPreapprovedPackages:\n  - react\n  - \"@myorg/*\"\n");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(3); // 4320 minutes = 3 days
  expect(Array.from(exclude).sort()).toEqual(["@myorg/*", "react"]);
});

test(".yarnrc.yml npmMinimalAgeGate as duration string", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-yarn-dur-");
  writeFileSync(join(dir, ".yarnrc.yml"), "npmMinimalAgeGate: \"7d\"\n");
  const {days} = npmEcosystemCooldown(dir);
  expect(days).toBe(7);
});

test("most conservative value and union of excludes across managers", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-all-");
  writeFileSync(join(dir, ".npmrc"), "min-release-age=2\nmin-release-age-exclude=a\n");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "minimumReleaseAge: 14400\nminimumReleaseAgeExclude:\n  - b\n"); // 10 days
  writeFileSync(join(dir, "bunfig.toml"), "[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = [\"c\"]\n"); // 5 days
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(10); // max(2, 10, 5)
  expect(Array.from(exclude).sort()).toEqual(["a", "b", "c"]);
});

test("no config files yields no constraint", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-none-");
  const {days, exclude} = npmEcosystemCooldown(dir);
  expect(days).toBe(0);
  expect(exclude.size).toBe(0);
});

test("garbage files contribute nothing", ({expect = globalExpect}: any = {}) => {
  const dir = mkdir("pmcd-garbage-");
  writeFileSync(join(dir, ".npmrc"), "min-release-age=not-a-number\n");
  writeFileSync(join(dir, "bunfig.toml"), "this is = [ not valid toml\n");
  const {days} = npmEcosystemCooldown(dir);
  expect(days).toBe(0);
});
