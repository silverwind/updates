import {
  valid, parse, coerce, diff, gt, satisfies, validRange, parsePep440, comparePep440, diffPep440,
  pep440Versioning, semverVersioning,
} from "./semver.ts";

test("valid and parse", () => {
  for (const [input, expected] of [
    ["1.0.0", "1.0.0"], ["v1.0.0", "1.0.0"], ["1.2.3", "1.2.3"],
    ["1.2.3-alpha.1", "1.2.3-alpha.1"], ["1.0.0-beta", "1.0.0-beta"],
    ["1.0.0+build", "1.0.0"], ["1.0.0-alpha+build", "1.0.0-alpha"], [" 1.0.0 ", "1.0.0"],
  ]) expect(valid(input)).toBe(expected);
  for (const input of ["abc", "", "1.0", "1", "1.0.0.0", "01.2.3", "1.2.3-alpha.01", "1.2.3-alpha_1", "9007199254740993.0.0"]) {
    expect(valid(input)).toBeNull();
  }

  expect(parse("1.2.3")).toEqual({major: 1, minor: 2, patch: 3, prerelease: [], build: [], raw: "1.2.3", version: "1.2.3"});
  expect(parse("1.2.3-alpha.1")).toEqual({
    major: 1, minor: 2, patch: 3, prerelease: ["alpha", 1], build: [], raw: "1.2.3-alpha.1", version: "1.2.3-alpha.1",
  });
  expect(parse("1.0.0-0.3.7")!.prerelease).toEqual([0, 3, 7]);
  expect(parse("1.0.0-beta.11")!.prerelease).toEqual(["beta", 11]);
  expect(parse("v2.0.0")!.version).toBe("2.0.0");
  expect(parse("1.2.3+corp.1")).toMatchObject({build: ["corp", "1"], raw: "1.2.3+corp.1", version: "1.2.3"});
  expect(parse("invalid")).toBeNull();
  expect(parse("")).toBeNull();
});

test("coerce, diff, and ordering", () => {
  for (const [input, expected] of [
    ["1.2.3", "1.2.3"], ["v1.2.3", "1.2.3"], ["v1.2", "1.2.0"], ["v1", "1.0.0"],
    ["42.6.7", "42.6.7"], ["foo1.2.3bar", "1.2.3"], ["version3.2", "3.2.0"], ["v10", "10.0.0"],
  ]) expect(coerce(input)).toEqual({version: expected});
  expect(coerce("no version here")).toBeNull();
  expect(coerce("...")).toBeNull();

  for (const [left, right, expected] of [
    ["1.0.0", "2.0.0", "major"], ["1.0.0", "1.1.0", "minor"], ["1.0.0", "1.0.1", "patch"],
    ["1.0.0", "1.0.0", null], ["abc", "1.0.0", null], ["1.0.0", "abc", null],
    ["1.0.0-alpha.1", "1.0.0-alpha.2", "prerelease"], ["1.0.0", "2.0.0-alpha", "premajor"],
    ["1.0.0", "1.1.0-alpha", "preminor"], ["1.0.0", "1.0.1-alpha", "prepatch"],
    ["1.0.0-alpha", "1.0.0", "major"], ["0.0.0-alpha", "1.0.0", "major"],
    ["1.1.0-alpha", "1.1.0", "minor"], ["2.0.0", "1.0.0", "major"], ["1.1.0", "1.0.0", "minor"],
  ] as Array<[string, string, string | null]>) expect(diff(left, right), `${left}, ${right}`).toBe(expected);

  for (const [left, right, expected] of [
    ["2.0.0", "1.0.0", true], ["1.0.0", "2.0.0", false], ["1.0.0", "1.0.0", false],
    ["1.1.0", "1.0.0", true], ["1.0.1", "1.0.0", true], ["1.0.0", "1.0.0-alpha", true],
    ["1.0.0-alpha", "1.0.0", false], ["1.0.0-alpha.2", "1.0.0-alpha.1", true],
    ["1.0.0-beta", "1.0.0-alpha", true], ["1.0.0-alpha", "1.0.0-1", true],
    ["1.0.0-1", "1.0.0-alpha", false], ["abc", "1.0.0", false], ["1.0.0", "abc", false],
  ] as Array<[string, string, boolean]>) expect(gt(left, right), `${left}, ${right}`).toBe(expected);
});

test("ranges", () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.5.0", "^1.2.3", true], ["1.2.3", "^1.2.3", true], ["1.9.9", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false], ["1.2.2", "^1.2.3", false], ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false], ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false],
    ["0.5.0", "^0", true], ["0.0.0", "^0", true], ["1.0.0", "^0", false],
    ["1.2.3-beta.1", "^1.2.3-alpha.0", true], ["1.2.4-beta.1", "^1.2.3-alpha.0", false],
    ["1.2.5", "^1.2.3-alpha.0", true], ["1.2.5", "~1.2.3", true], ["1.2.3", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false], ["1.2.2", "~1.2.3", false], ["1.5.0", "~1", true],
    ["1.0.0", "~1", true], ["2.0.0", "~1", false], ["1.5.0", "1.0.0 - 2.0.0", true],
    ["1.0.0", "1.0.0 - 2.0.0", true], ["2.0.0", "1.0.0 - 2.0.0", true],
    ["3.0.0", "1.0.0 - 2.0.0", false], ["0.9.9", "1.0.0 - 2.0.0", false],
    ["1.5.0", "1.x", true], ["1.0.0", "1.x", true], ["2.0.0", "1.x", false],
    ["1.5.0", "1.x.x", true], ["2.0.0", "1.x.x", false], ["999.0.0", "*", true], ["0.0.0", "*", true],
    ["1.2.3-alpha", "*", false], ["1.2.3-alpha", "x", false], ["1.2.3-alpha", "*.*.*", false],
    ["1.2.3-alpha", "", false], ["1.2.3-alpha", "|| >2.0.0", false],
    ["1.2.3-alpha", ">2.0.0 ||", false], ["1.2.3-alpha", "|| >=1.2.3-alpha", true],
    ["2.0.0", ">=1.5.0", true], ["1.5.0", ">=1.5.0", true], ["1.4.9", ">=1.5.0", false],
    ["1.0.0", ">1.0.0", false], ["1.0.1", ">1.0.0", true], ["1.0.0", "<2.0.0", true],
    ["2.0.0", "<2.0.0", false], ["2.0.0", "<=2.0.0", true], ["3.1.0", ">= 3.1", true],
    ["1.0.0", "1.0.0", true], ["1.0.1", "1.0.0", false], ["2.0.0", "^1.0.0 || ^2.0.0", true],
    ["1.5.0", "^1.0.0 || ^2.0.0", true], ["3.0.0", "^1.0.0 || ^2.0.0", false],
    ["1.0.0", ">=1.0.0 <2.0.0", true], ["1.9.9", ">=1.0.0 <2.0.0", true],
    ["2.0.0", ">=1.0.0 <2.0.0", false], ["0.9.9", ">=1.0.0 <2.0.0", false],
    ["1.0.0-alpha.2", ">=1.0.0-alpha.1", true], ["1.0.0-alpha.1", ">=1.0.0-alpha.1", true],
    ["2.0.0-alpha.1", ">=1.0.0", false], ["1.2.5", "1.2", true], ["1.2.0", "1.2", true],
    ["1.3.0", "1.2", false], ["abc", "^1.0.0", false], ["1.0.0", "not valid!!", false],
    ["1.2.0", "1.2.x", true], ["1.2.5", "1.2.x", true], ["1.3.0", "1.2.x", false],
    ["1.1.9", "1.2.x", false], ["1.5.0", "1", true], ["1.0.0", "1", true],
    ["1.99.99", "1", true], ["2.0.0", "1", false], ["0.9.9", "1", false], ["5.0.0", "1", false],
    ["2.3.9", "1.2.3 - 2.3", true], ["2.4.0", "1.2.3 - 2.3", false],
    ["2.99.99", "1.2.3 - 2", true], ["3.0.0", "1.2.3 - 2", false],
    ["1.0.0", "^1.x", true], ["1.9.9", "^1.x", true], ["2.0.0", "^1.x", false],
    ["1.5.0", "^1.x.x", true], ["2.0.0", "^1.x.x", false], ["1.2.0", "^1.2.x", true],
    ["1.3.0", "^1.2.x", true], ["1.9.9", "^1.2.x", true], ["2.0.0", "^1.2.x", false],
    ["1.1.9", "^1.2.x", false], ["0.9.9", "^0.x", true], ["1.0.0", "^0.x", false],
    ["1.9.9", "~1.x", true], ["2.0.0", "~1.x", false], ["1.2.0", "~1.2.x", true],
    ["1.2.9", "~1.2.x", true], ["1.3.0", "~1.2.x", false], ["1.5.0", ">=1.2.x", true],
    ["1.2.0", ">=1.2.x", true], ["1.1.0", ">=1.2.x", false], ["1.5.0", ">=1.2.x <2.0.0", true],
    ["2.0.0", ">=1.2.x <2.0.0", false], ["1.1.0", ">=1.2.x <2.0.0", false],
    ["0.9.9", ">=1.x", false], ["3.0.0", ">=1.x", true], ["1.2.9", "<=1.2.x", true],
    ["1.3.0", "<=1.2.x", false], ["1.9.9", ">1.x", false], ["2.0.0", ">1.x", true],
    ["1.2.4", "~>1.2.3", true], ["2.3.9", "1.2.3 - 2.3.x", true],
  ];
  for (const [version, range, expected] of cases) expect(satisfies(version, range)).toBe(expected);

  for (const range of [
    "^1.0.0", ">=1.0.0 <2.0.0", "1.0.0 - 2.0.0", "*", "~>1.2.3", "1.2.3+build",
    "^1.2.3+build", "*.*.*", "1.2.3 - 2.3.x", "1.2.x", "^1.x", "^1.x.x", "^1.2.x", "^0.x",
    "~1.x", "~1.2.x", ">=1.2.x", ">=1.2.x <2.0.0",
  ]) expect(validRange(range)).toBe(range);
  expect(validRange("1.*.3")).toBeNull();
  expect(validRange("not valid!!")).toBeNull();
  expect(validRange(undefined as any)).toBeNull();
  expect(validRange(null as any)).toBeNull();
});

test("PEP 440 parsing and ordering", () => {
  for (const [version, expected] of [
    ["26.3", {epoch: 0, release: [26, 3], pre: null, post: null, dev: null, local: null}],
    ["1!1.0", {epoch: 1, release: [1, 0]}], ["2.32.0.20250602", {release: [2, 32, 0, 20250602]}],
    ["17.04.0", {release: [17, 4, 0]}], ["2.9.0.post0", {post: 0}],
    ["1.0-1", {release: [1, 0], post: 1}], ["1.1.0.dev1", {dev: 1}], ["0.0.1a19", {pre: ["a", 19]}],
    ["1.0.0+ubuntu.1", {local: ["ubuntu", 1]}], ["v1.2.3", {release: [1, 2, 3]}],
  ] as Array<[string, Record<string, unknown>]>) expect(parsePep440(version)).toMatchObject(expected);
  expect(parsePep440("not_a_version")).toBeNull();
  for (const [input, letter] of [["1.0alpha", "a"], ["1.0.beta2", "b"], ["1.0c1", "rc"], ["1.0-pre", "rc"], ["1.0_preview3", "rc"], ["1.0RC4", "rc"]] as const) {
    expect(parsePep440(input)!.pre![0]).toBe(letter);
  }
  expect(parsePep440("1.0alpha")!.pre![1]).toBe(0);

  const compareVersions = (left: string, right: string) => Math.sign(comparePep440(parsePep440(left)!, parsePep440(right)!));
  for (const [left, right, expected] of [
    ["1.0", "1.0.0", 0], ["1!1.0", "2.0", 1], ["26.3", "26.2", 1],
    ["2.32.4.20250611", "2.32.0.20250602", 1], ["1.0", "1.0rc1", 1], ["1.0rc1", "1.0b1", 1],
    ["1.0b1", "1.0a1", 1], ["1.0a10", "1.0a9", 1], ["1.0.post1", "1.0", 1],
    ["1.0", "1.0.dev1", 1], ["1.0a1", "1.0.dev1", 1], ["1.0.post1.dev1", "1.0", 1],
    ["1.0+local", "1.0", 1], ["1.0+1", "1.0+abc", 1],
  ] as Array<[string, string, number]>) expect(compareVersions(left, right)).toBe(expected);

  const versionDiff = (left: string, right: string) => diffPep440(parsePep440(left)!, parsePep440(right)!);
  for (const [left, right, expected] of [
    ["1.0", "1.0.0", null], ["1.0", "6.0", "major"], ["3.4.0.20240423", "3.5.0.20250801", "minor"],
    ["2.32.0.20240622", "2.32.4.20250611", "patch"], ["3.4.0.20240103", "3.4.0.20240423", "patch"],
    ["0.0.1a15", "0.0.1a19", "prerelease"], ["1.0", "2.0b1", "premajor"],
    ["1.0", "1.1.0.dev1", "preminor"], ["1.0rc1", "1.0", "patch"],
  ] as Array<[string, string, string | null]>) expect(versionDiff(left, right)).toBe(expected);
});

test("versioning adapters", () => {
  expect(["^1.0.0-alpha", ">=2.0.0-rc.1"].every(range => semverVersioning.isRangePrerelease(range))).toBe(true);
  expect(["^1.0.0", "~2.0.0"].some(range => semverVersioning.isRangePrerelease(range))).toBe(false);
  for (const version of ["2.0.0b1", "1.0rc1", "0.0.1a19", "1.1.0.dev1"]) {
    expect(pep440Versioning.isRangePrerelease(version)).toBe(true);
    expect(pep440Versioning.isPrerelease(pep440Versioning.parse(version)!)).toBe(true);
  }
  for (const version of ["6.0", "2026.3.post1", "2.32.4.20250611"]) {
    expect(pep440Versioning.isRangePrerelease(version)).toBe(false);
  }
  expect(pep440Versioning.parseRange(">=2.28.0")!.release).toEqual([2, 28, 0]);
  expect(pep440Versioning.satisfiesRange(pep440Versioning.parse("6.0")!, "^6.0.0")).toBe(true);
  expect(pep440Versioning.satisfiesRange(pep440Versioning.parse("2.32.4.20250611")!, "^2.33.0")).toBe(false);
});
