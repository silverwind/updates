import {
  findNewVersion,
  stripv,
  esc,
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
} from "./shared.ts";

const defaultOpts = {
  allowDowngrade: false as any,
  matchesAny: () => false,
  isGoPseudoVersion: () => false,
};

test("pin downgrade with abbreviated metadata (no time field)", () => {
  // Simulate abbreviated npm metadata: has versions and dist-tags but no time
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "6.0.0": {},
      "6.0.1": {},
      "6.0.2": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.3");
});

test("pin downgrade with full metadata (has time field)", () => {
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "6.0.0": {},
      "6.0.1": {},
      "6.0.2": {},
    },
    time: {
      "5.9.2": "2025-01-01T00:00:00Z",
      "5.9.3": "2025-02-01T00:00:00Z",
      "6.0.0": "2025-03-01T00:00:00Z",
      "6.0.1": "2025-04-01T00:00:00Z",
      "6.0.2": "2025-05-01T00:00:00Z",
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.3");
});

test("pin selects greatest within range when no time data", () => {
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "5.9.4": {},
      "5.9.5": {},
      "6.0.2": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.5");
});

test("pin with no downgrade returns null without allow-downgrade", () => {
  const data = {
    name: "react",
    "dist-tags": {latest: "19.0.0"},
    versions: {
      "18.2.0": {},
      "18.3.0": {},
      "18.3.1": {},
      "19.0.0": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "18.2.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^18.0.0",
  }, defaultOpts);

  // Should offer upgrade within pinned range (18.2.0 -> 18.3.1)
  expect(result).toBe("18.3.1");
});

test("stripv removes leading v", () => {
  expect(stripv("v1.0.0")).toBe("1.0.0");
  expect(stripv("1.0.0")).toBe("1.0.0");
  expect(stripv("v0.1.0")).toBe("0.1.0");
});

test("esc escapes regex special chars", () => {
  expect(esc("foo.bar")).toBe("foo\\.bar");
  expect(esc("a[b]")).toBe("a\\[b\\]");
  expect(esc("no-special")).toBe("no\\-special");
  expect(esc("plain")).toBe("plain");
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
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg", matchesAny: () => false};
  expect(isAllowedVersionTransition("1.0.0-alpha", "2.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition pre to lower release without --release", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg", matchesAny: () => false};
  expect(isAllowedVersionTransition("2.0.0-alpha", "1.0.0", opts)).toBe(false);
});

test("isAllowedVersionTransition pre to lower release with useRel", () => {
  const opts = {useRel: true, allowDowngrade: false as any, name: "pkg", matchesAny: () => false};
  expect(isAllowedVersionTransition("2.0.0-alpha", "1.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition release to lower release without allowDowngrade", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg", matchesAny: () => false};
  expect(isAllowedVersionTransition("2.0.0", "1.0.0", opts)).toBe(false);
});

test("isAllowedVersionTransition release to lower release with allowDowngrade", () => {
  const opts = {useRel: false, allowDowngrade: true as any, name: "pkg", matchesAny: () => false};
  expect(isAllowedVersionTransition("2.0.0", "1.0.0", opts)).toBe(true);
});

test("isAllowedVersionTransition same or higher release", () => {
  const opts = {useRel: false, allowDowngrade: false as any, name: "pkg", matchesAny: () => false};
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

test("selectTag not greatest returns last tag if different", () => {
  expect(selectTag(["v1.0.0", "v1.1.0", "v2.0.0"], "v1.0.0", false)).toBe("v2.0.0");
});

test("selectTag greatest returns highest semver tag", () => {
  expect(selectTag(["v1.0.0", "v3.0.0", "v2.0.0"], "v1.0.0", true)).toBe("v3.0.0");
});

test("selectTag returns null when no upgrade", () => {
  expect(selectTag(["v1.0.0"], "v1.0.0", false)).toBe(null);
  expect(selectTag(["v1.0.0"], "v1.0.0", true)).toBe(null);
});

test("selectTag returns null for invalid oldRef", () => {
  expect(selectTag(["v1.0.0"], "not-semver", false)).toBe(null);
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

test("findNewVersion wildcard range returns null", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "2.0.0": {}},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "*",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBeNull();
});

test("findNewVersion or-chain range returns null", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "2.0.0": {}},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "^1.0.0 || ^2.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBeNull();
});

test("findNewVersion useGreatest returns version directly", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: true,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("2.0.0");
});

test("findNewVersion npm latest dist-tag", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("2.0.0");
});

test("findNewVersion prerelease with usePre", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "1.1.0"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0-beta.1": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0-beta.1": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: true,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("2.0.0-beta.1");
});

test("findNewVersion pre-to-release transition", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "1.1.0"},
    versions: {"1.0.0-alpha": {}, "1.1.0": {}},
    time: {"1.0.0-alpha": "2025-01-01", "1.1.0": "2025-02-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0-alpha",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("1.1.0");
});

test("findNewVersion latestTag blocked by semver filter", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "1.0.1": {}, "2.0.0": {}},
    time: {"1.0.0": "2025-01-01", "1.0.1": "2025-02-01", "2.0.0": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch"]),
  }, defaultOpts);
  expect(result).toBe("1.0.1");
});

test("findNewVersion useRel with prerelease latest", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0-rc.1"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0-rc.1": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0-rc.1": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: true,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("1.1.0");
});

test("findNewVersion latestTag is prerelease, no usePre", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0-beta.1"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0-beta.1": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0-beta.1": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
  }, defaultOpts);
  expect(result).toBe("1.1.0");
});

test("findNewVersion pinnedRange excludes latestTag", () => {
  const data = {
    name: "pkg",
    "dist-tags": {latest: "2.0.0"},
    versions: {"1.0.0": {}, "1.1.0": {}, "2.0.0": {}},
    time: {"1.0.0": "2025-01-01", "1.1.0": "2025-02-01", "2.0.0": "2025-03-01"},
  };
  const result = findNewVersion(data, {
    mode: "npm",
    range: "1.0.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^1.0.0",
  }, defaultOpts);
  expect(result).toBe("1.1.0");
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
  }, defaultOpts);
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
  }, defaultOpts);
  expect(result).toBe("1.5.0");
});

test("resolvePackageJsonUrl shorthand foo:u/r", () => {
  expect(resolvePackageJsonUrl("g:u/r")).toBe("https://g.com/u/r");
});

test("resolvePackageJsonUrl shorthand u/r", () => {
  expect(resolvePackageJsonUrl("u/r")).toBe("https://github.com/u/r");
});
