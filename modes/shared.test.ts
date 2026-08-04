import {
  findNewVersion,
  stripv,
  normalizeUrl,
  getFetchOpts,
  isVersionPrerelease,
  isRangePrerelease,
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
  fetchForge,
  fetchActionTags,
  fetchWithEtag,
  fetchImmutable,
  fetchTimeout,
  type ModeContext,
} from "./shared.ts";
import {esc} from "../utils/utils.ts";
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

test("getFetchOpts without auth token", () => {
  const opts = getFetchOpts();
  const headers = opts.headers as Record<string, string>;
  expect(headers["user-agent"]).toBe(`updates/${packageVersion}`);
  expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
  expect(headers["Authorization"]).toBeUndefined();
});

test("getFetchOpts with auth token", () => {
  const opts = getFetchOpts("Bearer", "mytoken123");
  const headers = opts.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer mytoken123");
});

test("isVersionPrerelease detects prereleases", () => {
  expect(isVersionPrerelease("1.0.0-alpha")).toBe(true);
  expect(isVersionPrerelease("1.0.0-beta.1")).toBe(true);
  expect(isVersionPrerelease("1.0.0")).toBe(false);
  expect(isVersionPrerelease("invalid")).toBe(false);
});

test("isRangePrerelease detects prerelease in range", () => {
  expect(isRangePrerelease("^1.0.0-alpha")).toBe(true);
  expect(isRangePrerelease(">=2.0.0-rc.1")).toBe(true);
  expect(isRangePrerelease("^1.0.0")).toBe(false);
  expect(isRangePrerelease("~2.0.0")).toBe(false);
});

test("isAllowedVersionTransition pre to higher release", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg"};
  expect(isAllowedVersionTransition("1.0.0-alpha", "2.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition pre to lower release without --release", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg"};
  expect(isAllowedVersionTransition("2.0.0-alpha", "1.0.0", opts)).toBe(false);
});

test("isAllowedVersionTransition pre to lower release with useRel", () => {
  const opts = {useRel: true, allowDowngrade: false as any, name: "pkg"};
  expect(isAllowedVersionTransition("2.0.0-alpha", "1.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition release to lower release without allowDowngrade", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg"};
  expect(isAllowedVersionTransition("2.0.0", "1.0.0", opts)).toBe(false);
});

test("isAllowedVersionTransition release to lower release with allowDowngrade", () => {
  const opts = {useRel: false, allowDowngrade: true as any, name: "pkg"};
  expect(isAllowedVersionTransition("2.0.0", "1.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition same or higher release", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg"};
  expect(isAllowedVersionTransition("1.0.0", "1.0.0", opts)).toBe(true);
  expect(isAllowedVersionTransition("1.0.0", "2.0.0", opts)).toBe(true);
});

test("coerceToVersion extracts version", () => {
  expect(coerceToVersion("^1.2.3")).toBe("1.2.3");
  expect(coerceToVersion("5")).toBe("5.0.0");
  expect(coerceToVersion("~2.1.0")).toBe("2.1.0");
});

test("coerceToVersion returns empty for invalid", () => {
  expect(coerceToVersion("")).toBe("");
});

test("selectTag returns highest semver tag", () => {
  expect(selectTag(["v1.0.0", "v1.1.0", "v2.0.0"], "v1.0.0")).toBe("v2.0.0");
  expect(selectTag(["v1.0.0", "v3.0.0", "v2.0.0"], "v1.0.0")).toBe("v3.0.0");
});

test("selectTag handles unsorted tags (GitHub /tags returns no guaranteed order)", () => {
  // Reverse-chronological (newest-first) is GitHub's typical default, and the
  // tag list mixes shorter v9 with longer v10 to defeat lexicographic ordering.
  expect(selectTag(["v10.0.0", "v9.0.0", "v2.0.0", "v1.0.0"], "v1.0.0")).toBe("v10.0.0");
  expect(selectTag(["v1.0.0", "v10.0.0", "v9.0.0", "v2.0.0"], "v1.0.0")).toBe("v10.0.0");
});

test("selectTag returns null when no upgrade", () => {
  expect(selectTag(["v1.0.0"], "v1.0.0")).toBe(null);
});

test("selectTag returns null for invalid oldRef", () => {
  expect(selectTag(["v1.0.0"], "not-semver")).toBe(null);
});

test("resolvePackageJsonUrl git+https", () => {
  expect(resolvePackageJsonUrl("git+https://github.com/user/repo.git")).toBe("https://github.com/user/repo");
});

test("resolvePackageJsonUrl git+ssh protocol", () => {
  expect(resolvePackageJsonUrl("git+ssh://git@github.com/user/repo.git")).toBe("https://github.com/user/repo");
});

test("resolvePackageJsonUrl https with .git", () => {
  expect(resolvePackageJsonUrl("https://github.com/user/repo.git")).toBe("https://github.com/user/repo");
});

test("resolvePackageJsonUrl already clean", () => {
  expect(resolvePackageJsonUrl("https://github.com/user/repo")).toBe("https://github.com/user/repo");
});

test("parseTags transforms tag data", () => {
  const data = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  expect(parseTags(data)).toEqual([
    {name: "v1.0.0", commitSha: "abc"},
    {name: "v2.0.0", commitSha: "def"},
  ]);
});

test("parseTags handles missing commit", () => {
  expect(parseTags([{name: "v1.0.0"}])).toEqual([{name: "v1.0.0", commitSha: ""}]);
});

test("throwFetchError throws with status info", () => {
  const res = {status: 404, statusText: "Not Found"} as Response;
  expect(() => throwFetchError(res, "https://example.com", "pkg", "npm")).toThrow("Received 404 Not Found from https://example.com");
});

test("throwFetchError throws generic message when no status", () => {
  expect(() => throwFetchError(undefined, "https://example.com", "pkg", "npm")).toThrow("Unable to fetch pkg from npm");
});

test("formatVersionPrecision 1-part", () => {
  expect(formatVersionPrecision("2.0.0", "1")).toBe("2");
});

test("formatVersionPrecision 2-part", () => {
  expect(formatVersionPrecision("2.1.0", "1.0")).toBe("2.1");
});

test("formatVersionPrecision 3-part", () => {
  expect(formatVersionPrecision("2.1.3", "1.0.0")).toBe("2.1.3");
});

test("formatVersionPrecision v-prefix", () => {
  expect(formatVersionPrecision("2.0.0", "v1")).toBe("v2");
});

test("formatVersionPrecision suffix", () => {
  expect(formatVersionPrecision("2.0.0", "1", "-alpine")).toBe("2-alpine");
});

test("getSubDir bitbucket", () => {
  expect(getSubDir("https://bitbucket.org/user/repo")).toBe("src/HEAD");
});

test("getSubDir github", () => {
  expect(getSubDir("https://github.com/user/repo")).toBe("tree/HEAD");
});

test("findVersion greatest mode picks highest version", () => {
  const data = {versions: {"1.0.0": {}, "2.0.0": {}, "1.5.0": {}}};
  const result = findVersion(data, ["1.0.0", "2.0.0", "1.5.0"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
  });
  expect(result).toBe("2.0.0");
});

test("findVersion greatest mode picks highest prerelease regardless of order", () => {
  const opts = {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: true,
    useRel: false,
    useGreatest: true,
  } as const;
  expect(findVersion({}, ["2.0.0-rc.2", "2.0.0-rc.1"], opts)).toBe("2.0.0-rc.2");
  expect(findVersion({}, ["2.0.0-rc.1", "2.0.0-rc.2"], opts)).toBe("2.0.0-rc.2");
  expect(findVersion({}, ["1.0.0-beta.10", "1.0.0-beta.5", "1.0.0-beta.3"], {...opts, range: "1.0.0-beta.1"})).toBe("1.0.0-beta.10");
  // a prerelease below the authored release is a downgrade, not an upgrade
  expect(findVersion({}, ["1.0.0-beta.10", "1.0.0-beta.5"], opts)).toBe("1.0.0");
  // a release must win over a same-main prerelease
  expect(findVersion({}, ["2.0.0-rc.1", "2.0.0"], opts)).toBe("2.0.0");
  expect(findVersion({}, ["2.0.0", "2.0.0-rc.1"], opts)).toBe("2.0.0");
});

test("findVersion time-based mode picks most recent", () => {
  const data = {
    versions: {"1.1.0": {}, "1.2.0": {}, "1.3.0": {}},
    time: {
      "1.1.0": "2025-03-01T00:00:00Z",
      "1.2.0": "2025-01-01T00:00:00Z",
      "1.3.0": "2025-02-01T00:00:00Z",
    },
  };
  const result = findVersion(data, ["1.1.0", "1.2.0", "1.3.0"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: false,
  });
  expect(result).toBe("1.1.0");
  // a lower version published later is a downgrade, not the most recent upgrade
  expect(findVersion(data, ["1.1.0", "1.2.0", "1.3.0"], {
    range: "1.2.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: false,
  })).toBe("1.3.0");
});

test("findVersion never reports an unpublished release for a prerelease range", () => {
  // every candidate filtered out must leave the authored version untouched, not the
  // release it is a prerelease of
  const data = {versions: {"2.0.0-rc.1": {}, "2.0.0-rc.2": {}}, time: {"2.0.0-rc.1": "2025-01-01T00:00:00Z", "2.0.0-rc.2": "2025-01-02T00:00:00Z"}};
  const versions = ["2.0.0-rc.1", "2.0.0-rc.2"];
  const opts = {range: "^2.0.0-rc.1", usePre: false, useRel: false, useGreatest: false} as const;
  expect(findVersion(data, versions, {...opts, semvers: new Set(["patch"])})).toBe("2.0.0-rc.2");
  expect(findVersion(data, versions, {...opts, semvers: new Set(["patch"]), cooldownDays: 3650, now: Date.parse("2025-01-03T00:00:00Z")})).toBe("2.0.0-rc.1");
});

test("findVersion respects semver filter", () => {
  const data = {versions: {"1.0.1": {}, "2.0.0": {}}};
  const result = findVersion(data, ["1.0.1", "2.0.0"], {
    range: "1.0.0",
    semvers: new Set(["patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
  });
  expect(result).toBe("1.0.1");
});

test("findVersion respects pinnedRange", () => {
  const data = {versions: {"1.1.0": {}, "2.0.0": {}}};
  const result = findVersion(data, ["1.1.0", "2.0.0"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
    pinnedRange: "^1.0.0",
  });
  expect(result).toBe("1.1.0");
});

test("findVersion skips prereleases when usePre=false", () => {
  const data = {versions: {"1.1.0": {}, "1.2.0-alpha": {}}};
  const result = findVersion(data, ["1.1.0", "1.2.0-alpha"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
  });
  expect(result).toBe("1.1.0");
});

test("findVersion cooldown picks older eligible version", () => {
  const now = Date.parse("2026-04-25T00:00:00Z");
  const data = {
    versions: {"1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "1.3.0": {}},
    time: {
      "1.0.0": "2026-01-01T00:00:00Z",
      "1.1.0": "2026-04-10T00:00:00Z", // 15 days old — eligible
      "1.2.0": "2026-04-22T00:00:00Z", // 3 days old — too new
      "1.3.0": "2026-04-24T00:00:00Z", // 1 day old — too new
    },
  };
  const result = findVersion(data, ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
    cooldownDays: 5,
    now,
  });
  expect(result).toBe("1.1.0");
});

test("findVersion cooldown returns no upgrade when all candidates too new", () => {
  const now = Date.parse("2026-04-25T00:00:00Z");
  const data = {
    versions: {"1.1.0": {}, "1.2.0": {}},
    time: {
      "1.1.0": "2026-04-23T00:00:00Z",
      "1.2.0": "2026-04-24T00:00:00Z",
    },
  };
  const result = findVersion(data, ["1.1.0", "1.2.0"], {
    range: "1.0.0",
    semvers: new Set(["major", "minor", "patch"]),
    usePre: false,
    useRel: false,
    useGreatest: true,
    cooldownDays: 5,
    now,
  });
  expect(result).toBe("1.0.0");
});

test("getInfoUrl string repository URL", () => {
  const result = getInfoUrl({repository: "https://github.com/user/repo"}, null, "pkg");
  expect(result).toBe("https://github.com/user/repo");
});

test("getInfoUrl object repository with directory", () => {
  const result = getInfoUrl({
    repository: {type: "git", url: "https://github.com/user/repo", directory: "packages/foo"},
  }, null, "pkg");
  expect(result).toBe("https://github.com/user/repo/tree/HEAD/packages/foo");
});

test("getInfoUrl homepage fallback", () => {
  const result = getInfoUrl({homepage: "https://example.com"}, null, "pkg");
  expect(result).toBe("https://example.com");
});

test("getInfoUrl github pkg registry special case", () => {
  const result = getInfoUrl({}, "https://npm.pkg.github.com", "@user/repo");
  expect(result).toBe("https://github.com/user/repo");
});

test("getInfoUrl pypi info with project_urls", () => {
  const result = getInfoUrl({
    info: {project_urls: {Repository: "https://github.com/user/repo"}},
  }, null, "pkg");
  expect(result).toBe("https://github.com/user/repo");
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
  ["or-chain range returns null", twoVersions, {range: "^1.0.0 || ^2.0.0"}, null],
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
])("findNewVersion %s", (_name, data, opts, expected) => {
  expect(findNewVersion(data, {...npmOpts, ...opts})).toBe(expected);
});

test("findNewVersion go mode cross-major upgrade", () => {
  const data = {
    name: "github.com/foo/bar",
    old: "1.0.0",
    new: "3.0.0",
    sameMajorNew: "1.5.0",
    sameMajorTime: "2025-02-01",
    Time: "2025-03-01",
  };
  const result = findNewVersion(data, {
    mode: "go",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    ...defaultOpts,
  });
  expect(result).toBe("3.0.0");
});

test("findNewVersion go mode same-major fallback", () => {
  const data = {
    name: "github.com/foo/bar",
    old: "1.0.0",
    new: "3.0.0",
    sameMajorNew: "1.5.0",
    sameMajorTime: "2025-02-01",
    Time: "2025-03-01",
  };
  const result = findNewVersion(data, {
    mode: "go",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor"]),
    ...defaultOpts,
  });
  expect(result).toBe("1.5.0");
});

test("findNewVersion go mode moves a prerelease or pseudo-version pin to its release", () => {
  // coercing the pin away would compare 0.4.2-0.2023… against 0.4.2 as equal and stall
  const pseudo = "0.4.2-0.20230802210424-5b0b94c5c0d3";
  const data = {name: "github.com/foo/bar", old: pseudo, new: "0.4.2", Time: "2025-03-01"};
  expect(findNewVersion(data, {
    mode: "go", range: pseudo,
    useGreatest: false, useRel: false, usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    ...defaultOpts,
  })).toBe("0.4.2");

  const rc = {name: "github.com/foo/bar", old: "1.5.0-rc.1", new: "1.5.0", Time: "2025-03-01"};
  expect(findNewVersion(rc, {
    mode: "go", range: "1.5.0-rc.1",
    useGreatest: false, useRel: false, usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    ...defaultOpts,
  })).toBe("1.5.0");
});

test("findNewVersion go mode honors pinnedRange on cross-major target", () => {
  const data = {name: "github.com/foo/bar", old: "1.0.0", new: "3.0.0", Time: "2025-03-01"};
  const result = findNewVersion(data, {
    mode: "go", range: "1.0.0",
    useGreatest: false, useRel: false, usePre: false,
    semvers: new Set(["major"]), pinnedRange: "<2.0.0",
    ...defaultOpts,
  });
  expect(result).toBe(null);
});

test("findNewVersion go mode honors pinnedRange on same-major fallback", () => {
  const data = {
    name: "github.com/foo/bar",
    old: "1.0.0", new: "3.0.0",
    sameMajorNew: "1.7.0", sameMajorTime: "2025-02-01",
    Time: "2025-03-01",
  };
  const result = findNewVersion(data, {
    mode: "go", range: "1.0.0",
    useGreatest: false, useRel: false, usePre: false,
    semvers: new Set(["patch", "minor"]), pinnedRange: "<1.5.0",
    ...defaultOpts,
  });
  expect(result).toBe(null);
});

test("findNewVersion go mode allows pinnedRange-matching version", () => {
  const data = {
    name: "github.com/foo/bar",
    old: "1.0.0", new: "3.0.0",
    sameMajorNew: "1.4.0", sameMajorTime: "2025-02-01",
    Time: "2025-03-01",
  };
  const result = findNewVersion(data, {
    mode: "go", range: "1.0.0",
    useGreatest: false, useRel: false, usePre: false,
    semvers: new Set(["patch", "minor"]), pinnedRange: "<1.5.0",
    ...defaultOpts,
  });
  expect(result).toBe("1.4.0");
});

test("resolvePackageJsonUrl shorthand foo:u/r", () => {
  expect(resolvePackageJsonUrl("g:u/r")).toBe("https://g.com/u/r");
  expect(resolvePackageJsonUrl("gitlab:user/repo")).toBe("https://gitlab.com/user/repo");
});

test("resolvePackageJsonUrl shorthand u/r", () => {
  expect(resolvePackageJsonUrl("u/r")).toBe("https://github.com/u/r");
  expect(resolvePackageJsonUrl("user/repo")).toBe("https://github.com/user/repo");
});

test("getForgeTokens", async () => {
  // empty hostname (unparseable url) -> no token
  expect(await getForgeTokens("", "https://api.github.com")).toEqual([]);

  // foreign forge host without a configured token -> no github fallback
  // (github-host delegation is covered with teeth by the fetchForge test below)
  expect(await getForgeTokens("gitea.example.com", "https://api.github.com")).toEqual([]);
});

test("fetchForge only sends github credentials to github hosts", async () => {
  // Inject a github token deterministically (CI has none). `getGithubTokens`
  // reads env per call, so plain mutation works under both vitest and bun.
  const tokenEnv = ["UPDATES_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];
  const saved = Object.fromEntries(tokenEnv.map(name => [name, process.env[name]]));
  for (const name of tokenEnv) delete process.env[name];
  process.env.GH_TOKEN = "ghp_regression_secret";
  // Restore in `finally` so a failed assertion can't leak env into concurrent
  // sibling tests (isolate: false).
  try {
    const authByHost: Record<string, string | undefined> = {};
    const ctx = {
      fetchTimeout,
      forgeApiUrl: "https://api.github.com",
      doFetch: (url: string, opts: RequestInit) => {
        authByHost[new URL(url).hostname] = (opts.headers as Record<string, string>)?.Authorization;
        return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve([]), headers: new Headers()});
      },
    } as unknown as ModeContext;

    await fetchForge("https://api.github.com/repos/o/r/tags", ctx);
    await fetchForge("https://attacker.example/api/v1/repos/o/r/tags", ctx);

    expect(authByHost["api.github.com"]).toBe("Bearer ghp_regression_secret");
    expect(authByHost["attacker.example"]).toBeUndefined();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// fetchActionTags
test("fetchActionTags single page no link header", async () => {
  const tagsData = [{name: "v1.0.0", commit: {sha: "abc"}}, {name: "v2.0.0", commit: {sha: "def"}}];
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(tagsData), headers: new Headers()}),
  } as unknown as ModeContext;
  const result = await fetchActionTags("https://api.github.com", "actions", "checkout", ctx);
  expect(result).toEqual([{name: "v1.0.0", commitSha: "abc"}, {name: "v2.0.0", commitSha: "def"}]);
});

test("fetchActionTags multi-page with link header", async () => {
  const page1Data = [{name: "v1.0.0", commit: {sha: "aaa"}}];
  const page2Data = [{name: "v2.0.0", commit: {sha: "bbb"}}];
  const page3Data = [{name: "v3.0.0", commit: {sha: "ccc"}}];
  const ctx = {
    fetchTimeout,
    doFetch: (url: string) => {
      if (url.includes("page=2")) return Promise.resolve({ok: true, json: () => Promise.resolve(page2Data), headers: new Headers()});
      if (url.includes("page=3")) return Promise.resolve({ok: true, json: () => Promise.resolve(page3Data), headers: new Headers()});
      return Promise.resolve({ok: true, json: () => Promise.resolve(page1Data), headers: new Headers([["link", `<https://api.github.com/repos/actions/checkout/tags?per_page=100&page=3>; rel="last"`]])});
    },
  } as unknown as ModeContext;
  const result = await fetchActionTags("https://api.github.com", "actions", "checkout", ctx);
  expect(result).toEqual([
    {name: "v1.0.0", commitSha: "aaa"},
    {name: "v2.0.0", commitSha: "bbb"},
    {name: "v3.0.0", commitSha: "ccc"},
  ]);
});

test("fetchActionTags fetch throws returns empty", async () => {
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.reject(new Error("network error")),
  } as unknown as ModeContext;
  expect(await fetchActionTags("https://api.github.com", "actions", "checkout", ctx)).toEqual([]);
});

// Tests use timestamped URLs so each invocation hashes to a unique cache file;
// real-cache side effects are isolated.
test("fetchWithEtag returns body on 200 and sends If-None-Match on second call", async () => {
  let lastHeaders: Record<string, string> | undefined;
  let callCount = 0;
  const ctx = {
    fetchTimeout,
    doFetch: (_url: string, opts: RequestInit) => {
      callCount++;
      lastHeaders = opts.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(`{"ver":${callCount}}`),
        headers: new Headers([["etag", `W/"${callCount}"`]]),
      });
    },
  } as unknown as ModeContext;
  const url = `https://example.test/etag-${Date.now()}`;

  const r1 = await fetchWithEtag(url, ctx);
  expect("body" in r1 && r1.body).toBe(`{"ver":1}`);
  expect(lastHeaders?.["if-none-match"]).toBeUndefined();

  await flushCacheWrites();
  const r2 = await fetchWithEtag(url, ctx);
  expect("body" in r2).toBe(true);
  expect(lastHeaders?.["if-none-match"]).toBe(`W/"1"`);
});

test("fetchWithEtag returns cached body on 304", async () => {
  const url = `https://example.test/304-${Date.now()}`;
  let seenIfNoneMatch: string | undefined;
  const ctx = {
    fetchTimeout,
    doFetch: (_url: string, opts: RequestInit) => {
      seenIfNoneMatch = (opts.headers as Record<string, string> | undefined)?.["if-none-match"];
      if (seenIfNoneMatch) {
        return Promise.resolve({ok: false, status: 304, headers: new Headers()});
      }
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(`{"cached":true}`),
        headers: new Headers([["etag", `"v1"`]]),
      });
    },
  } as unknown as ModeContext;

  await fetchWithEtag(url, ctx);
  await flushCacheWrites();
  const r = await fetchWithEtag(url, ctx);
  expect(seenIfNoneMatch).toBe(`"v1"`);
  expect("body" in r && r.body).toBe(`{"cached":true}`);
});

test("fetchWithEtag returns {res} on non-ok", async () => {
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found", headers: new Headers()}),
  } as unknown as ModeContext;
  const r = await fetchWithEtag("https://example.test/404", ctx);
  expect("body" in r).toBe(false);
  expect(r.res?.status).toBe(404);
});

test("fetchWithEtag bypasses disk cache when noCache is set", async () => {
  const url = `https://example.test/nocache-${Date.now()}`;
  let seenIfNoneMatch: string | undefined;
  let calls = 0;
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: (_url: string, opts: RequestInit) => {
      calls++;
      seenIfNoneMatch = (opts.headers as Record<string, string> | undefined)?.["if-none-match"];
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(`{"n":${calls}}`),
        headers: new Headers([["etag", `"x"`]]),
      });
    },
  } as unknown as ModeContext;

  await fetchWithEtag(url, ctx);
  await fetchWithEtag(url, ctx);
  expect(seenIfNoneMatch).toBeUndefined();
  expect(calls).toBe(2);
});

test("fetchImmutable serves cached body without fetching on second call", async () => {
  const url = `https://example.test/immutable-${Date.now()}`;
  let calls = 0;
  const ctx = {
    fetchTimeout,
    doFetch: () => {
      calls++;
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(`{"version":"1.0.0"}`),
        headers: new Headers(),
      });
    },
  } as unknown as ModeContext;

  const r1 = await fetchImmutable(url, ctx);
  await flushCacheWrites();
  const r2 = await fetchImmutable(url, ctx);
  expect("body" in r1 && r1.body).toBe(`{"version":"1.0.0"}`);
  expect("body" in r2 && r2.body).toBe(`{"version":"1.0.0"}`);
  expect(calls).toBe(1);
});

test("fetchImmutable refetches every call when noCache is set", async () => {
  const url = `https://example.test/immutable-nocache-${Date.now()}`;
  let calls = 0;
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => {
      calls++;
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(`{"n":${calls}}`),
        headers: new Headers(),
      });
    },
  } as unknown as ModeContext;

  await fetchImmutable(url, ctx);
  await fetchImmutable(url, ctx);
  expect(calls).toBe(2);
});

