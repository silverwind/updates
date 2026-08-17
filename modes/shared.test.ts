import {Buffer} from "node:buffer";
import {
  findNewVersion,
  stripv,
  normalizeUrl,
  getFetchOpts,
  isVersionPrerelease,
  isAllowedVersionTransition,
  coerceToVersion,
  selectTag,
  resolvePackageJsonUrl,
  parseTags,
  throwFetchError,
  formatVersionPrecision,
  getSubDir,
  findVersion,
  getInfoUrl,
  packageVersion,
  getForgeTokens,
  parseExtraheaders,
  fetchForge,
  fetchActionTags,
  fetchWithEtag,
  fetchWithRetry,
  fetchImmutable,
  fetchTimeout,
  getLimiter,
  ForgeError,
  type ModeContext,
} from "./shared.ts";
import {esc} from "../utils/utils.ts";
import {pep440Versioning} from "../utils/semver.ts";
import {flushCacheWrites} from "../utils/fetchCache.ts";

const defaultOpts = {allowDowngrade: false as any};

// npm-mode findNewVersion reads `data` without mutating it, so rows may share fixtures.
const npmOpts = {mode: "npm", useGreatest: false, useRel: false, usePre: false, semvers: new Set(["patch", "minor", "major"]), ...defaultOpts};

// Abbreviated npm metadata: has versions and dist-tags but no time
const tsAbbrev = {name: "typescript", "dist-tags": {latest: "6.0.2"}, versions: {"5.9.2": {}, "5.9.3": {}, "6.0.0": {}, "6.0.1": {}, "6.0.2": {}}};
const tsFull = {...tsAbbrev, time: {
  "5.9.2": "2025-01-01T00:00:00Z",
  "5.9.3": "2025-02-01T00:00:00Z",
  "6.0.0": "2025-03-01T00:00:00Z",
  "6.0.1": "2025-04-01T00:00:00Z",
  "6.0.2": "2025-05-01T00:00:00Z",
}};
const cropper = {name: "cropperjs", "dist-tags": {latest: "2.0.1"}, versions: {"1.6.2": {}, "2.0.0": {}, "2.0.1": {}}};

test.each([
  ["pin downgrade with abbreviated metadata (no time field)", tsAbbrev, {range: "6.0.2", pinnedRange: "^5.9.3"}, "5.9.3"],
  ["pin downgrade with full metadata (has time field)", tsFull, {range: "6.0.2", pinnedRange: "^5.9.3"}, "5.9.3"],
  ["pin selects greatest within range when no time data",
    {name: "typescript", "dist-tags": {latest: "6.0.2"}, versions: {"5.9.2": {}, "5.9.3": {}, "5.9.4": {}, "5.9.5": {}, "6.0.2": {}}},
    {range: "6.0.2", pinnedRange: "^5.9.3"}, "5.9.5"],
  // offers the upgrade within the pinned range (18.2.0 -> 18.3.1) rather than the 19.0.0 latest
  ["pin with no downgrade returns null without allow-downgrade",
    {name: "react", "dist-tags": {latest: "19.0.0"}, versions: {"18.2.0": {}, "18.3.0": {}, "18.3.1": {}, "19.0.0": {}}},
    {range: "18.2.0", pinnedRange: "^18.0.0"}, "18.3.1"],
  // renovate's allowedVersions is a ceiling on newer releases, never a reason to roll back
  ["renovate-derived pin rolls back without the marker", cropper, {range: "^2.0.0", pinnedRange: "^1"}, "1.6.2"],
  ["renovate-derived pin filters but never downgrades", cropper, {range: "^2.0.0", pinnedRange: "^1", pinNoDowngrade: true}, null],
])("%s", (_name, data, opts, expected) => {
  expect(findNewVersion(data, {...npmOpts, ...opts})).toBe(expected);
});

test("stripv removes leading v", () => {
  expect(stripv("v1.0.0")).toBe("1.0.0");
  expect(stripv("1.0.0")).toBe("1.0.0");
  expect(stripv("v0.1.0")).toBe("0.1.0");
});

test("esc escapes regex special chars", () => {
  for (const str of ["foo.bar", "a[b]", "no-special", "plain", "a+b*c?", "(x)|{y}^$"]) {
    expect(new RegExp(`^${esc(str)}$`).test(str)).toBe(true);
  }
  // special chars must match literally, not act as metacharacters
  expect(new RegExp(`^${esc("a.b")}$`).test("axb")).toBe(false);
});

test("normalizeUrl strips trailing slash", () => {
  expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
});

test("getFetchOpts sends an auth header only with a token", () => {
  const headers = getFetchOpts().headers as Record<string, string>;
  expect(headers["user-agent"]).toBe(`updates/${packageVersion}`);
  expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
  expect(headers["Authorization"]).toBeUndefined();
  expect((getFetchOpts("Bearer", "mytoken123").headers as Record<string, string>)["Authorization"]).toBe("Bearer mytoken123");
});

test("isVersionPrerelease detects prereleases", () => {
  expect(isVersionPrerelease("1.0.0-alpha")).toBe(true);
  expect(isVersionPrerelease("1.0.0-beta.1")).toBe(true);
  expect(isVersionPrerelease("1.0.0")).toBe(false);
  expect(isVersionPrerelease("invalid")).toBe(false);
  // pep440 spells them without a hyphen, which the semver rules read as stable
  expect(isVersionPrerelease("2.0.0b1")).toBe(false);
  expect(isVersionPrerelease("2.0.0b1", pep440Versioning)).toBe(true);
  expect(isVersionPrerelease("1.1.0.dev1", pep440Versioning)).toBe(true);
  expect(isVersionPrerelease("2026.3.post1", pep440Versioning)).toBe(false);
});

test.each([
  ["a pre to a higher release", "1.0.0-alpha", "2.0.0", {}, true],
  ["a pre to a lower release without --release", "2.0.0-alpha", "1.0.0", {}, false],
  ["a pre to a lower release with --release", "2.0.0-alpha", "1.0.0", {useRel: true}, true],
  ["a release to a lower release", "2.0.0", "1.0.0", {}, false],
  ["a release to a lower release with allowDowngrade", "2.0.0", "1.0.0", {allowDowngrade: true}, true],
  ["a release to itself", "1.0.0", "1.0.0", {}, true],
  ["a release to a higher release", "1.0.0", "2.0.0", {}, true],
])("isAllowedVersionTransition %s", (_name, from, to, opts, expected) => {
  expect(isAllowedVersionTransition(from, to, {useRel: false, allowDowngrade: false as any, name: "pkg", ...opts})).toBe(expected);
});

test("coerceToVersion extracts a version, or nothing", () => {
  expect(coerceToVersion("^1.2.3")).toBe("1.2.3");
  expect(coerceToVersion("5")).toBe("5.0.0");
  expect(coerceToVersion("~2.1.0")).toBe("2.1.0");
  expect(coerceToVersion("")).toBe("");
});

// GitHub's /tags has no guaranteed order, and its reverse-chronological default defeats a
// lexicographic one by mixing a shorter v9 with a longer v10.
test.each([
  [["v1.0.0", "v1.1.0", "v2.0.0"], "v1.0.0", "v2.0.0"],
  [["v1.0.0", "v3.0.0", "v2.0.0"], "v1.0.0", "v3.0.0"],
  [["v10.0.0", "v9.0.0", "v2.0.0", "v1.0.0"], "v1.0.0", "v10.0.0"],
  [["v1.0.0", "v10.0.0", "v9.0.0", "v2.0.0"], "v1.0.0", "v10.0.0"],
  [["v1.0.0"], "v1.0.0", null], // no upgrade
  [["v1.0.0"], "not-semver", null],
])("selectTag %s over %s", (tags, oldRef, expected) => {
  expect(selectTag(tags, oldRef)).toBe(expected);
});

test.each([
  ["git+https://github.com/user/repo.git", "https://github.com/user/repo"],
  ["git+ssh://git@github.com/user/repo.git", "https://github.com/user/repo"],
  ["https://github.com/user/repo.git", "https://github.com/user/repo"],
  ["https://github.com/user/repo", "https://github.com/user/repo"],
  ["g:u/r", "https://g.com/u/r"],
  ["gitlab:user/repo", "https://gitlab.com/user/repo"],
  ["u/r", "https://github.com/u/r"],
  ["user/repo", "https://github.com/user/repo"],
])("resolvePackageJsonUrl %s", (input, expected) => {
  expect(resolvePackageJsonUrl(input)).toBe(expected);
});

test("parseTags transforms tag data, commit or not", () => {
  const data = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}, {name: "v3.0.0"}];
  expect(parseTags(data)).toEqual([
    {name: "v1.0.0", commitSha: "abc"},
    {name: "v2.0.0", commitSha: "def"},
    {name: "v3.0.0", commitSha: ""},
  ]);
});

test("throwFetchError names the status, or the package when there is none", () => {
  const res = {status: 404, statusText: "Not Found"} as Response;
  expect(() => throwFetchError(res, "https://example.com", "pkg", "npm")).toThrow("Received 404 Not Found from https://example.com");
  expect(() => throwFetchError(undefined, "https://example.com", "pkg", "npm")).toThrow("Unable to fetch pkg from npm");
});

test.each([
  ["2.0.0", "1", undefined, "2"],
  ["2.1.0", "1.0", undefined, "2.1"],
  ["2.1.3", "1.0.0", undefined, "2.1.3"],
  ["2.0.0", "v1", undefined, "v2"],
  ["2.0.0", "1", "-alpine", "2-alpine"],
])("formatVersionPrecision %s at the precision of %s", (newVersion, oldVersion, suffix, expected) => {
  expect(formatVersionPrecision(newVersion, oldVersion, suffix)).toBe(expected);
});

test.each([
  ["https://bitbucket.org/user/repo", "src/HEAD"],
  ["https://github.com/user/repo", "tree/HEAD"],
])("getSubDir %s", (url, expected) => {
  expect(getSubDir(url)).toBe(expected);
});

const findVersionOpts = {range: "1.0.0", semvers: new Set(["major", "minor", "patch"]), usePre: false, useRel: false};
const cooldownTimes = {"1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-04-10T00:00:00Z",
  "1.2.0": "2026-04-22T00:00:00Z", "1.3.0": "2026-04-24T00:00:00Z"};
const cooldownNow = {cooldownDays: 5, now: Date.parse("2026-04-25T00:00:00Z")};

test.each([
  ["the highest version", ["1.0.0", "2.0.0", "1.5.0"], {}, {}, "2.0.0"],
  ["nothing outside the semver filter", ["1.0.1", "2.0.0"], {}, {semvers: new Set(["patch"])}, "1.0.1"],
  ["nothing outside pinnedRange", ["1.1.0", "2.0.0"], {}, {pinnedRange: "^1.0.0"}, "1.1.0"],
  ["no prerelease without --pre", ["1.1.0", "1.2.0-alpha"], {}, {}, "1.1.0"],
  // 1.1.0 is 15 days old and eligible, 1.2.0 and 1.3.0 are 3 and 1 days old, so too new
  ["the newest version past its cooldown", ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], cooldownTimes, cooldownNow, "1.1.0"],
  ["nothing while every candidate is inside the cooldown", ["1.1.0", "1.2.0"],
    {"1.1.0": "2026-04-23T00:00:00Z", "1.2.0": "2026-04-24T00:00:00Z"}, cooldownNow, null],
  ["nothing dateless while a cooldown is active", ["1.1.0", "1.2.0"], {"1.1.0": "2026-01-01T00:00:00Z"}, cooldownNow, "1.1.0"],
  ["nothing at all while a cooldown is active and no date is known", ["1.1.0", "1.2.0"], {}, cooldownNow, null],
  ["dates ignored entirely once the cooldown is off", ["1.1.0", "1.2.0"], {}, {}, "1.2.0"],
])("findVersion picks %s", (_name, versions, time, opts, expected) => {
  const data = {versions: Object.fromEntries(versions.map(version => [version, {}])), time};
  expect(findVersion(data, versions, {...findVersionOpts, ...opts})).toBe(expected);
});

test("findVersion picks the highest prerelease regardless of order", () => {
  const opts = {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: true,
    useRel: false,
  } as const;
  expect(findVersion({}, ["2.0.0-rc.2", "2.0.0-rc.1"], opts)).toBe("2.0.0-rc.2");
  expect(findVersion({}, ["2.0.0-rc.1", "2.0.0-rc.2"], opts)).toBe("2.0.0-rc.2");
  expect(findVersion({}, ["1.0.0-beta.10", "1.0.0-beta.5", "1.0.0-beta.3"], {...opts, range: "1.0.0-beta.1"})).toBe("1.0.0-beta.10");
  // a prerelease below the authored release is a downgrade, not an upgrade
  expect(findVersion({}, ["1.0.0-beta.10", "1.0.0-beta.5"], opts)).toBe(null);
  // a release must win over a same-main prerelease
  expect(findVersion({}, ["2.0.0-rc.1", "2.0.0"], opts)).toBe("2.0.0");
  expect(findVersion({}, ["2.0.0", "2.0.0-rc.1"], opts)).toBe("2.0.0");
});

test("findVersion selects by version even when publish dates disagree", () => {
  const data = {
    versions: {"1.1.0": {}, "1.2.0": {}, "1.3.0": {}},
    time: {
      "1.1.0": "2025-03-01T00:00:00Z", // a backport published after the higher versions
      "1.2.0": "2025-01-01T00:00:00Z",
      "1.3.0": "2025-02-01T00:00:00Z",
    },
  };
  const opts = {
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
  } as const;
  expect(findVersion(data, ["1.1.0", "1.2.0", "1.3.0"], {...opts, range: "1.0.0"})).toBe("1.3.0");
  expect(findVersion(data, ["1.1.0", "1.2.0", "1.3.0"], {...opts, range: "1.2.0"})).toBe("1.3.0");
});

test("findVersion never reports an unpublished release for a prerelease range", () => {
  // every candidate filtered out must leave the authored version untouched, not the
  // release it is a prerelease of
  const data = {versions: {"2.0.0-rc.1": {}, "2.0.0-rc.2": {}}, time: {"2.0.0-rc.1": "2025-01-01T00:00:00Z", "2.0.0-rc.2": "2025-01-02T00:00:00Z"}};
  const versions = ["2.0.0-rc.1", "2.0.0-rc.2"];
  const opts = {range: "^2.0.0-rc.1", usePre: false, useRel: false} as const;
  expect(findVersion(data, versions, {...opts, semvers: new Set(["patch"])})).toBe("2.0.0-rc.2");
  expect(findVersion(data, versions, {...opts, semvers: new Set(["patch"]), cooldownDays: 3650, now: Date.parse("2025-01-03T00:00:00Z")})).toBe(null);
});

test.each([
  ["a string repository URL", {repository: "https://github.com/user/repo"}, null, "pkg", "https://github.com/user/repo"],
  ["an object repository with a directory", {repository: {type: "git", url: "https://github.com/user/repo", directory: "packages/foo"}},
    null, "pkg", "https://github.com/user/repo/tree/HEAD/packages/foo"],
  ["a homepage fallback", {homepage: "https://example.com"}, null, "pkg", "https://example.com"],
  ["the github package registry", {}, "https://npm.pkg.github.com", "@user/repo", "https://github.com/user/repo"],
  ["pypi project_urls", {info: {project_urls: {Repository: "https://github.com/user/repo"}}},
    null, "pkg", "https://github.com/user/repo"],
])("getInfoUrl reads %s", (_name, data, registry, name, expected) => {
  expect(getInfoUrl(data, registry, name)).toBe(expected);
});

const twoVersions = {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {}, "2.0.0": {}}};
const threeVersions = {
  name: "pkg",
  "dist-tags": {latest: "2.0.0"},
  versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {}},
  time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0": "2025-03-01"},
};
const preLatest = (latest: string) => ({
  name: "pkg",
  "dist-tags": {latest},
  versions: {"1.0.0": {}, "1.1.0": {}, [latest]: {}},
  time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", [latest]: "2025-03-01"},
});

test.each([
  ["wildcard range returns null", twoVersions, {range: "*"}, null],
  // Ranked against the last branch, so 2.0.0 is the authored version and 1.1.0 no upgrade
  ["or-chain resolves against its newest branch", threeVersions, {range: "^1.0.0 || ^2.0.0", semvers: new Set(["minor"])}, "2.0.0"],
  ["compound range resolves", threeVersions, {range: ">=1.0.0 <2.0.0"}, "2.0.0"],
  ["useGreatest returns version directly", threeVersions, {range: "1.0.0", useGreatest: true}, "2.0.0"],
  ["npm latest dist-tag", threeVersions, {range: "1.0.0"}, "2.0.0"],
  ["pinnedRange excludes latestTag", threeVersions, {range: "1.0.0", pinnedRange: "^1.0.0"}, "1.1.0"],
  ["prerelease with usePre",
    {name: "pkg", "dist-tags": {latest: "1.1.0"}, versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0-beta.1": {}},
      time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0-beta.1": "2025-03-01"}},
    {range: "1.0.0", usePre: true}, "2.0.0-beta.1"],
  ["pre-to-release transition",
    {name: "pkg", "dist-tags": {latest: "1.1.0"}, versions: {"1.0.0-alpha": {}, "1.1.0": {}},
      time: {"1.0.0-alpha": "2025-01-01", "1.1.0": "2025-02-01"}},
    {range: "1.0.0-alpha"}, "1.1.0"],
  ["latestTag blocked by semver filter",
    {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {}, "1.0.1": {}, "2.0.0": {}},
      time: {"1.0.0": "2025-01-01", "1.0.1": "2025-02-01", "2.0.0": "2025-03-01"}},
    {range: "1.0.0", semvers: new Set(["patch"])}, "1.0.1"],
  ["useRel with prerelease latest", preLatest("2.0.0-rc.1"), {range: "1.0.0", useRel: true}, "1.1.0"],
  ["latestTag is prerelease, no usePre", preLatest("2.0.0-beta.1"), {range: "1.0.0"}, "1.1.0"],
  // Abbreviated metadata (no time field) so findVersion picks the greatest in-range candidate.
  // latest dist-tag (1.9.9) is below the installed 2.0.0, so the downgrade guard must not
  // discard the valid 2.0.1 upgrade.
  ["falls back to in-range upgrade when latest dist-tag is a lower release",
    {name: "pkg", "dist-tags": {latest: "1.9.9"}, versions: {"1.9.9": {}, "2.0.0": {}, "2.0.1": {}}},
    {range: "2.0.0"}, "2.0.1"],
  ["npm cooldown picks older eligible version",
    {name: "pkg", "dist-tags": {latest: "1.3.0"}, versions: {"1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "1.3.0": {}},
      time: {"1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-04-10T00:00:00Z",
        "1.2.0": "2026-04-22T00:00:00Z", "1.3.0": "2026-04-24T00:00:00Z"}},
    {range: "1.0.0", cooldownDays: 5, now: Date.parse("2026-04-25T00:00:00Z")}, "1.1.0"],
  ["deprecated latest is skipped",
    {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {deprecated: true}}},
    {range: "1.0.0"}, "1.1.0"],
  ["deprecated versions stay in reach of a version that is itself deprecated",
    {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {deprecated: true}, "1.1.0": {}, "2.0.0": {deprecated: true}}},
    {range: "1.0.0"}, "2.0.0"],
  // a deprecated tag is still the ceiling, so the 3.0.0 the maintainer never tagged stays out of
  // reach, and the releases below it are no downgrade target either
  ["a deprecated latest does not promote an off-tag release",
    {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {deprecated: true}, "3.0.0": {}}},
    {range: "1.0.0"}, "1.1.0"],
  ["a deprecated latest is no downgrade target",
    {name: "pkg", "dist-tags": {latest: "2.0.0"}, versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {deprecated: true}, "3.0.0": {}}},
    {range: "3.0.0", allowDowngrade: true}, null],
  // `^10` coerces to a version the package never published, so the exemption above cannot fire
  ["a wholly deprecated package keeps its newest release for a range naming no published version",
    {name: "pkg", "dist-tags": {latest: "10.1.0"}, versions: {"10.0.1": {deprecated: true}, "10.1.0": {deprecated: true}}},
    {range: "^10"}, "10.1.0"],
])("findNewVersion %s", (_name, data, opts, expected) => {
  expect(findNewVersion(data, {...npmOpts, ...opts})).toBe(expected);
});

const pypiOpts = {mode: "pypi", useGreatest: false, useRel: false, usePre: false, semvers: new Set(["patch", "minor", "major"]), ...defaultOpts};
const pypiDoc = (latest: string, versions: Array<string>, yanked: Array<string> = []) => ({
  name: "pkg",
  info: {name: "pkg", version: latest},
  releases: Object.fromEntries(versions.map(version => [version, [{
    upload_time_iso_8601: "2025-01-01T00:00:00.000000Z",
    ...(yanked.includes(version) && {yanked: true}),
  }]])),
});

test.each([
  ["two-segment latest", pypiDoc("6.0", ["1.0", "5.4b1", "5.4.1", "6.0b1", "6.0"]), {range: "1.0"}, "6.0"],
  ["two-segment latest with greatest", pypiDoc("6.0", ["1.0", "5.4.1", "6.0"]), {range: "1.0", useGreatest: true}, "6.0"],
  ["four-segment release", pypiDoc("2.32.4.20250611", ["2.32.0.20240622", "2.32.0.20250602", "2.32.4.20250611"]),
    {range: "2.32.0.20240622"}, "2.32.4.20250611"],
  ["post release", pypiDoc("2026.3.post1", ["2026.2", "2026.3", "2026.3.post1"]), {range: "2026.2"}, "2026.3.post1"],
  ["epoch outranks the release segment", pypiDoc("1!1.0", ["1.0", "1!1.0"]), {range: "1.0"}, "1!1.0"],
  ["prerelease train stays on its own release", pypiDoc("0.0.1a19", ["0.0.1a15", "0.0.1a19"]), {range: "0.0.1a15"}, "0.0.1a19"],
  ["release-only skips a prerelease latest", pypiDoc("2.0.0b1", ["1.0.0", "2.0.0b1"]), {range: "1.0.0", useRel: true}, null],
  ["dev release is not stable", pypiDoc("1.1.0.dev1", ["1.0.0", "1.1.0.dev1"]), {range: "1.0.0"}, null],
  ["yanked release is skipped", pypiDoc("1.0.1", ["1.0.0", "1.0.1", "1.1.0"], ["1.1.0"]), {range: "1.0.0", useGreatest: true}, "1.0.1"],
  ["yanked latest is not trusted", pypiDoc("1.1.0", ["1.0.0", "1.0.1", "1.1.0"], ["1.1.0"]), {range: "1.0.0"}, "1.0.1"],
  ["missing releases returns null", {name: "pkg", info: {version: "2.0.0"}}, {range: "1.0.0"}, null],
])("findNewVersion pypi %s", (_name, data, opts, expected) => {
  expect(findNewVersion(data, {...pypiOpts, ...opts} as any)).toBe(expected);
});

test("findNewVersion does not follow an unstable train across a major", () => {
  const data = {
    name: "react",
    "dist-tags": {latest: "18.2.0"},
    versions: {"17.0.0-rc.0": {}, "17.0.0-rc.1": {}, "17.0.0": {}, "18.2.0": {}, "18.3.0-next-fecc288b": {}},
  };
  const opts = {...npmOpts, range: "17.0.0-rc.0"};
  expect(findNewVersion(data, opts)).toBe("18.2.0");
  expect(findNewVersion(data, {...opts, useGreatest: true})).toBe("18.2.0");
  expect(findNewVersion(data, {...opts, usePre: true})).toBe("18.3.0-next-fecc288b");
  expect(findNewVersion({...data, "dist-tags": {latest: "17.0.0-rc.1"}, versions: {"17.0.0-rc.0": {}, "17.0.0-rc.1": {}}}, opts)).toBe("17.0.0-rc.1");
});

test("findNewVersion tolerates a packument missing versions or naming an absent latest", () => {
  expect(findNewVersion({name: "pkg", "dist-tags": {latest: "2.0.0"}}, {...npmOpts, range: "1.0.0"})).toBe(null);
  // a latest dist-tag the registry does not carry would write a version npm cannot resolve
  expect(findNewVersion({name: "pkg", "dist-tags": {latest: "9.9.9"}, versions: {"1.0.0": {}, "1.1.0": {}}},
    {...npmOpts, range: "1.0.0"})).toBe("1.1.0");
});

// go mode reads the resolved versions off `data` rather than a packument
const goOpts = {mode: "go", useGreatest: false, useRel: false, usePre: false,
  semvers: new Set(["patch", "minor", "major"]), ...defaultOpts};
const goData = {name: "github.com/foo/bar", old: "1.0.0", new: "3.0.0", Time: "2025-03-01"};
const goSameMajor = (sameMajorNew: string) => ({...goData, sameMajorNew, sameMajorTime: "2025-02-01"});
// coercing a prerelease pin away would compare 0.4.2-0.2023… against 0.4.2 as equal and stall
const pseudo = "0.4.2-0.20230802210424-5b0b94c5c0d3";

test.each([
  ["a cross-major upgrade", goSameMajor("1.5.0"), {range: "1.0.0"}, "3.0.0"],
  ["the same-major fallback when major is filtered out", goSameMajor("1.5.0"),
    {range: "1.0.0", semvers: new Set(["patch", "minor"])}, "1.5.0"],
  ["a pseudo-version pin moved to its release", {...goData, old: pseudo, new: "0.4.2"}, {range: pseudo}, "0.4.2"],
  ["a prerelease pin moved to its release", {...goData, old: "1.5.0-rc.1", new: "1.5.0"}, {range: "1.5.0-rc.1"}, "1.5.0"],
  ["nothing when pinnedRange excludes the cross-major target", goData,
    {range: "1.0.0", semvers: new Set(["major"]), pinnedRange: "<2.0.0"}, null],
  ["nothing when pinnedRange excludes the same-major fallback", goSameMajor("1.7.0"),
    {range: "1.0.0", semvers: new Set(["patch", "minor"]), pinnedRange: "<1.5.0"}, null],
  ["the same-major fallback pinnedRange admits", goSameMajor("1.4.0"),
    {range: "1.0.0", semvers: new Set(["patch", "minor"]), pinnedRange: "<1.5.0"}, "1.4.0"],
])("findNewVersion go mode returns %s", (_name, data, opts, expected) => {
  expect(findNewVersion(data, {...goOpts, ...opts})).toBe(expected);
});

// UPDATES_FORGE_TOKENS is one process-wide slot, and the two tests below hold a value of their
// own across awaits, so neither may run while the other does, under either runner's concurrency.
const sequential = test.sequential ?? (test as any).serial ?? test;

sequential("getForgeTokens", async () => {
  // empty host (unparseable url) -> no token
  expect(await getForgeTokens("", "https://api.github.com")).toEqual([]);

  // foreign forge host without a configured token -> no github fallback
  // (github-host delegation is covered with teeth by the fetchForge test below)
  expect(await getForgeTokens("gitea.example.com", "https://api.github.com")).toEqual([]);

  const forHost = (host: string) => getForgeTokens(host, "https://api.github.com");
  const saved = process.env.UPDATES_FORGE_TOKENS;
  process.env.UPDATES_FORGE_TOKENS = "localhost:3500:ported,git.example.com:bare";
  try {
    // a port-qualified entry must not be split at the first colon
    expect(await forHost("localhost:3500")).toEqual(["ported"]);
    expect(await forHost("git.example.com")).toEqual(["bare"]);
    // another port on a configured host is a different endpoint, and must not inherit its token
    expect(await forHost("localhost:9999")).toEqual([]);
    expect(await forHost("git.example.com:8080")).toEqual([]);
    // nor may the bare host claim a ported entry, which would hand back `3500:ported`
    expect(await forHost("localhost")).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.UPDATES_FORGE_TOKENS;
    else process.env.UPDATES_FORGE_TOKENS = saved;
  }
});

test("parseExtraheaders reads a CI token per host", () => {
  const enc = (token: string) => Buffer.from(`x-access-token:${token}`).toString("base64");
  const tokens = parseExtraheaders([
    `http.https://github.com/.extraheader AUTHORIZATION: basic ${enc("gh-tok")}`,
    `http.https://gitea.example.com:8443/.extraheader AUTHORIZATION: basic ${enc("gitea-tok")}`,
    "http.https://other.example.com/.extraheader AUTHORIZATION: bearer not-basic",
  ].join("\n"));
  expect(tokens.get("github.com")).toEqual("gh-tok");
  // a ported instance is its own endpoint, and only `basic` carries the base64 credential
  expect(tokens.get("gitea.example.com:8443")).toEqual("gitea-tok");
  expect(tokens.has("gitea.example.com")).toEqual(false);
  expect(tokens.has("other.example.com")).toEqual(false);
});

const modeCtx = (props: Record<string, unknown>): ModeContext => ({fetchTimeout, ...props} as unknown as ModeContext);

test("fetchForge only sends github credentials to github hosts", async () => {
  // Inject a github token deterministically. `getGithubTokens` reads env per call, so plain
  // mutation works under both vitest and bun. The forge host is unique to this test because
  // workingTokenCache is module-level: on a CI runner an earlier fetch caches the extraheader
  // credential under api.github.com and would short-circuit the injected token.
  const tokenEnv = ["UPDATES_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];
  const saved = Object.fromEntries(tokenEnv.map(name => [name, process.env[name]]));
  for (const name of tokenEnv) delete process.env[name];
  process.env.GH_TOKEN = "ghp_regression_secret";
  // Restore in `finally` so a failed assertion can't leak env into concurrent
  // sibling tests (isolate: false).
  try {
    const authByHost: Record<string, string | undefined> = {};
    const ctx = modeCtx({forgeApiUrl: "https://forge.regression.test",
      doFetch: (url: string, opts: RequestInit) => {
        authByHost[new URL(url).hostname] = (opts.headers as Record<string, string>)?.Authorization;
        return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve([]), headers: new Headers()});
      }});

    await fetchForge("https://forge.regression.test/repos/o/r/tags", ctx);
    await fetchForge("https://attacker.example/api/v1/repos/o/r/tags", ctx);

    expect(authByHost["forge.regression.test"]).toBe("Bearer ghp_regression_secret");
    expect(authByHost["attacker.example"]).toBeUndefined();
    // GitHub's own API hostname still resolves the github credentials
    expect(await getForgeTokens("api.github.com", "https://api.github.com")).toContain("ghp_regression_secret");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// One tag per page, with page 1 announcing `lastPage` through the link header.
const tagPage = (url: string, lastPage: number) => {
  const page = Number(new URL(url).searchParams.get("page"));
  return {
    ok: true,
    json: () => Promise.resolve([{name: `v${page}.0.0`, commit: {sha: `sha${page}`}}]),
    headers: new Headers(page === 1 ? [["link", `<https://api.github.com/repos/o/r/tags?per_page=100&page=${lastPage}>; rel="last"`]] : []),
  };
};

test("fetchActionTags single page no link header", async () => {
  const tagsData = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = modeCtx({doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(tagsData), headers: new Headers()})});
  const result = await fetchActionTags("https://api.github.com", "actions", "checkout", ctx);
  expect(result).toEqual([{name: "v1.0.0", commitSha: "abc"}, {name: "v2.0.0", commitSha: "def"}]);
});

test("fetchActionTags walks until the authored ref turns up, and no further", async () => {
  const lastPage = 40;
  // [tags read, pages fetched]
  const walk = async (refs: Array<string>) => {
    let fetched = 0;
    const ctx = modeCtx({noCache: true, doFetch: (url: string) => {
      fetched++;
      return Promise.resolve(tagPage(url, lastPage));
    }});
    return [(await fetchActionTags("https://api.github.com", "actions", "checkout", ctx, refs)).length, fetched];
  };
  expect(await walk([])).toEqual([lastPage, lastPage]); // no ref to look for, so the whole list
  expect(await walk(["v1.0.0"])).toEqual([1, 1]);
  // waves of 1, 2, 4 and 8 reach page 11, so the walk reads 16 pages to resolve a sha on it
  expect(await walk(["sha11"])).toEqual([16, 16]);
});

test("every request shares the run's one socket budget", async () => {
  const lastPage = 20;
  let inFlight = 0;
  let peak = 0;
  const ctx = modeCtx({noCache: true, concurrency: 3, doFetch: async (url: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve)); // every admitted request is in flight by now
    inFlight--;
    return tagPage(url, lastPage);
  }});
  // Each fan already runs inside the fan over dependencies, so a budget of its own would multiply.
  // The last group is the docker walk's shape, a slot taken above one it must pass straight through.
  const limit = getLimiter(ctx);
  const [tags] = await Promise.all([
    fetchActionTags("https://api.github.com", "o", "r", ctx),
    ...Array.from({length: 20}, (_, idx) => fetchForge(`https://api.github.com/repos/o/r/git/commits/sha${idx}`, ctx)),
    ...Array.from({length: 20}, (_, idx) => limit(() => fetchWithRetry(ctx, `https://hub.docker.test/page${idx}`))),
  ]);
  expect(tags).toHaveLength(lastPage);
  expect(peak).toBe(3);
});

sequential("fetchForge classifies rate limits and server faults, fetchActionTags lets them through", async () => {
  const reset = Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000);
  // keyed by hostname label so each case gets a host of its own, as workingTokenCache is module-level
  const responses: Record<string, Partial<Response>> = {
    limited: {status: 403, headers: new Headers([["x-ratelimit-remaining", "0"], ["x-ratelimit-reset", String(reset)]])},
    secondary: {status: 403, headers: new Headers(), json: () => Promise.resolve({message: "You have exceeded a secondary rate limit"})},
    retryafter: {status: 429, headers: new Headers([["retry-after", "60"]])},
    down: {status: 502, statusText: "Bad Gateway", headers: new Headers()},
    forbidden: {status: 403, headers: new Headers(), json: () => Promise.resolve({message: "Resource not accessible by integration"})},
    tokened: {status: 403, headers: new Headers([["x-ratelimit-remaining", "0"]])},
  };
  let calls = 0;
  const ctx = modeCtx({noCache: true, forgeApiUrl: "https://api.github.com", doFetch: (url: string) => {
    calls++;
    return Promise.resolve({ok: false, ...responses[new URL(url).hostname.split(".")[0]]});
  }});
  const failureOf = async (label: string): Promise<any> => {
    try {
      return await fetchForge(`https://${label}.forge.test/repos/o/r/tags`, ctx);
    } catch (err) {
      return err;
    }
  };

  const limited = await failureOf("limited");
  expect(limited).toBeInstanceOf(ForgeError);
  expect([limited.kind, limited.host, limited.status, limited.reset]).toEqual(["rateLimit", "limited.forge.test", 403, reset]);
  expect(limited.message).toContain("UPDATES_FORGE_TOKENS");
  expect((await failureOf("secondary")).kind).toBe("rateLimit");
  expect((await failureOf("retryafter")).kind).toBe("rateLimit");
  expect((await failureOf("down")).kind).toBe("server");
  expect(await fetchActionTags("https://forbidden.forge.test", "o", "r", ctx)).toEqual([]);
  await expect(fetchActionTags("https://limited.forge.test", "o", "r", ctx)).rejects.toThrow(ForgeError);

  const saved = process.env.UPDATES_FORGE_TOKENS;
  process.env.UPDATES_FORGE_TOKENS = "tokened.forge.test:tok";
  try {
    calls = 0;
    const tokened = await failureOf("tokened");
    expect(tokened.kind).toBe("rateLimit");
    expect(calls).toBe(1);
    expect(tokened.message).not.toContain("UPDATES_FORGE_TOKENS");
  } finally {
    if (saved === undefined) delete process.env.UPDATES_FORGE_TOKENS;
    else process.env.UPDATES_FORGE_TOKENS = saved;
  }
});

test("fetchActionTags reports an unreachable forge instead of an empty tag list", async () => {
  const ctx = modeCtx({noCache: true, doFetch: () => Promise.reject(new Error("network error"))});
  await expect(fetchActionTags("https://api.github.com", "actions", "checkout", ctx))
    .rejects.toMatchObject({name: "ForgeError", kind: "network"});
});

// Tests use timestamped URLs so each invocation hashes to a unique cache file;
// real-cache side effects are isolated.
const ifNoneMatch = (opts: RequestInit) => (opts.headers as Record<string, string> | undefined)?.["if-none-match"];

test("fetchWithEtag returns body on 200 and sends If-None-Match on second call", async () => {
  let lastIfNoneMatch: string | undefined;
  let callCount = 0;
  const ctx = modeCtx({doFetch: (_url: string, opts: RequestInit) => {
    callCount++;
    lastIfNoneMatch = ifNoneMatch(opts);
    return Promise.resolve({ok: true, status: 200, text: () => Promise.resolve(`{"ver":${callCount}}`),
      headers: new Headers([["etag", `W/"${callCount}"`]])});
  }});
  const url = `https://example.test/etag-${Date.now()}`;

  const r1 = await fetchWithEtag(url, ctx);
  expect("body" in r1 && r1.body).toBe(`{"ver":1}`);
  expect(lastIfNoneMatch).toBeUndefined();

  await flushCacheWrites();
  const r2 = await fetchWithEtag(url, ctx);
  expect("body" in r2).toBe(true);
  expect(lastIfNoneMatch).toBe(`W/"1"`);
});

test("fetchWithEtag returns cached body on 304", async () => {
  const url = `https://example.test/304-${Date.now()}`;
  let seenIfNoneMatch: string | undefined;
  const ctx = modeCtx({doFetch: (_url: string, opts: RequestInit) => {
    seenIfNoneMatch = ifNoneMatch(opts);
    if (seenIfNoneMatch) return Promise.resolve({ok: false, status: 304, headers: new Headers()});
    return Promise.resolve({ok: true, status: 200, text: () => Promise.resolve(`{"cached":true}`),
      headers: new Headers([["etag", `"v1"`]])});
  }});

  await fetchWithEtag(url, ctx);
  await flushCacheWrites();
  const r = await fetchWithEtag(url, ctx);
  expect(seenIfNoneMatch).toBe(`"v1"`);
  expect("body" in r && r.body).toBe(`{"cached":true}`);
});

test("fetchWithEtag keeps flavors of one url in separate cache entries", async () => {
  const url = `https://example.test/flavor-${Date.now()}`;
  let seenIfNoneMatch: string | undefined;
  const ctx = modeCtx({doFetch: (_url: string, opts: RequestInit) => {
    seenIfNoneMatch = ifNoneMatch(opts);
    return Promise.resolve({ok: true, status: 200, text: () => Promise.resolve(`{"full":false}`),
      headers: new Headers([["etag", `"abbreviated"`]])});
  }});

  await fetchWithEtag(url, ctx);
  await flushCacheWrites();
  // a registry that etags per url alone would revalidate the abbreviated body into this call
  await fetchWithEtag(url, ctx, {}, undefined, `${url}\0dates`);
  expect(seenIfNoneMatch).toBeUndefined();
});

test("fetchWithEtag returns {res} on non-ok", async () => {
  const ctx = modeCtx({noCache: true,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found", headers: new Headers()})});
  const r = await fetchWithEtag("https://example.test/404", ctx);
  expect("body" in r).toBe(false);
  expect(r.res?.status).toBe(404);
});

test("fetchImmutable serves cached body without fetching on second call", async () => {
  const url = `https://example.test/immutable-${Date.now()}`;
  let calls = 0;
  const ctx = modeCtx({doFetch: () => {
    calls++;
    return Promise.resolve({ok: true, status: 200, text: () => Promise.resolve(`{"version":"1.0.0"}`), headers: new Headers()});
  }});

  const r1 = await fetchImmutable(url, ctx);
  await flushCacheWrites();
  const r2 = await fetchImmutable(url, ctx);
  expect("body" in r1 && r1.body).toBe(`{"version":"1.0.0"}`);
  expect("body" in r2 && r2.body).toBe(`{"version":"1.0.0"}`);
  expect(calls).toBe(1);
});

test.each([["fetchWithEtag", fetchWithEtag], ["fetchImmutable", fetchImmutable]])(
  "%s bypasses the disk cache when noCache is set", async (name, fetchFn) => {
    const url = `https://example.test/nocache-${name}-${Date.now()}`;
    let seenIfNoneMatch: string | undefined;
    let calls = 0;
    const ctx = modeCtx({noCache: true, doFetch: (_url: string, opts: RequestInit) => {
      calls++;
      seenIfNoneMatch = ifNoneMatch(opts);
      return Promise.resolve({ok: true, status: 200, text: () => Promise.resolve(`{"n":${calls}}`),
        headers: new Headers([["etag", `"x"`]])});
    }});

    await fetchFn(url, ctx);
    await fetchFn(url, ctx);
    expect(seenIfNoneMatch).toBeUndefined();
    expect(calls).toBe(2);
  });

