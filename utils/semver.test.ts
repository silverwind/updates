import {valid, parse, coerce, diff, gt, satisfies, validRange, parsePep440, comparePep440, diffPep440, pep440Versioning, semverVersioning} from "./semver.ts";

test("valid", () => {
  expect(valid("1.0.0")).toBe("1.0.0");
  expect(valid("v1.0.0")).toBe("1.0.0");
  expect(valid("1.2.3")).toBe("1.2.3");
  expect(valid("1.2.3-alpha.1")).toBe("1.2.3-alpha.1");
  expect(valid("1.0.0-beta")).toBe("1.0.0-beta");
  expect(valid("1.0.0+build")).toBe("1.0.0");
  expect(valid("1.0.0-alpha+build")).toBe("1.0.0-alpha");
  expect(valid(" 1.0.0 ")).toBe("1.0.0");
  expect(valid("abc")).toBeNull();
  expect(valid("")).toBeNull();
  expect(valid("1.0")).toBeNull();
  expect(valid("1")).toBeNull();
  expect(valid("1.0.0.0")).toBeNull();
});

test("parse", () => {
  const result = parse("1.2.3");
  expect(result).toEqual({major: 1, minor: 2, patch: 3, prerelease: [], version: "1.2.3"});

  const prerelease = parse("1.2.3-alpha.1");
  expect(prerelease).toEqual({major: 1, minor: 2, patch: 3, prerelease: ["alpha", 1], version: "1.2.3-alpha.1"});

  const numericPre = parse("1.0.0-0.3.7");
  expect(numericPre!.prerelease).toEqual([0, 3, 7]);

  const mixedPre = parse("1.0.0-beta.11");
  expect(mixedPre!.prerelease).toEqual(["beta", 11]);

  expect(parse("v2.0.0")!.version).toBe("2.0.0");
  expect(parse("invalid")).toBeNull();
  expect(parse("")).toBeNull();
});

test("coerce", () => {
  expect(coerce("1.2.3")).toEqual({version: "1.2.3"});
  expect(coerce("v1.2.3")).toEqual({version: "1.2.3"});
  expect(coerce("v1.2")).toEqual({version: "1.2.0"});
  expect(coerce("v1")).toEqual({version: "1.0.0"});
  expect(coerce("42.6.7")).toEqual({version: "42.6.7"});
  expect(coerce("foo1.2.3bar")).toEqual({version: "1.2.3"});
  expect(coerce("version3.2")).toEqual({version: "3.2.0"});
  expect(coerce("v10")).toEqual({version: "10.0.0"});
  expect(coerce("no version here")).toBeNull();
  expect(coerce("...")).toBeNull();
});

test("diff", () => {
  expect(diff("1.0.0", "2.0.0")).toBe("major");
  expect(diff("1.0.0", "1.1.0")).toBe("minor");
  expect(diff("1.0.0", "1.0.1")).toBe("patch");
  expect(diff("1.0.0", "1.0.0")).toBeNull();
  expect(diff("abc", "1.0.0")).toBeNull();
  expect(diff("1.0.0", "abc")).toBeNull();
  expect(diff("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe("prerelease");
  expect(diff("1.0.0", "2.0.0-alpha")).toBe("premajor");
  expect(diff("1.0.0", "1.1.0-alpha")).toBe("preminor");
  expect(diff("1.0.0", "1.0.1-alpha")).toBe("prepatch");
  // low has prerelease, high doesn't: minor=0,patch=0 means "major"
  expect(diff("1.0.0-alpha", "1.0.0")).toBe("major");
  expect(diff("0.0.0-alpha", "1.0.0")).toBe("major");
  expect(diff("1.1.0-alpha", "1.1.0")).toBe("minor");
  // argument order shouldn't matter for the type
  expect(diff("2.0.0", "1.0.0")).toBe("major");
  expect(diff("1.1.0", "1.0.0")).toBe("minor");
});

test("gt", () => {
  expect(gt("2.0.0", "1.0.0")).toBe(true);
  expect(gt("1.0.0", "2.0.0")).toBe(false);
  expect(gt("1.0.0", "1.0.0")).toBe(false);
  expect(gt("1.1.0", "1.0.0")).toBe(true);
  expect(gt("1.0.1", "1.0.0")).toBe(true);
  // release beats prerelease
  expect(gt("1.0.0", "1.0.0-alpha")).toBe(true);
  expect(gt("1.0.0-alpha", "1.0.0")).toBe(false);
  // prerelease ordering
  expect(gt("1.0.0-alpha.2", "1.0.0-alpha.1")).toBe(true);
  expect(gt("1.0.0-beta", "1.0.0-alpha")).toBe(true);
  // numbers sort before strings
  expect(gt("1.0.0-alpha", "1.0.0-1")).toBe(true);
  expect(gt("1.0.0-1", "1.0.0-alpha")).toBe(false);
  // invalid input
  expect(gt("abc", "1.0.0")).toBe(false);
  expect(gt("1.0.0", "abc")).toBe(false);
});

test("satisfies caret ranges", () => {
  expect(satisfies("1.5.0", "^1.2.3")).toBe(true);
  expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
  expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
  expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
  expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
  // ^0.x behavior
  expect(satisfies("0.2.5", "^0.2.3")).toBe(true);
  expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
  // ^0.0.x behavior
  expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
  expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  // ^0 (no minor/patch)
  expect(satisfies("0.5.0", "^0")).toBe(true);
  expect(satisfies("0.0.0", "^0")).toBe(true);
  expect(satisfies("1.0.0", "^0")).toBe(false);
  // prerelease in caret: must share same major.minor.patch with comparator
  expect(satisfies("1.2.3-beta.1", "^1.2.3-alpha.0")).toBe(true);
  expect(satisfies("1.2.4-beta.1", "^1.2.3-alpha.0")).toBe(false);
  expect(satisfies("1.2.5", "^1.2.3-alpha.0")).toBe(true);
});

test("satisfies tilde ranges", () => {
  expect(satisfies("1.2.5", "~1.2.3")).toBe(true);
  expect(satisfies("1.2.3", "~1.2.3")).toBe(true);
  expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
  expect(satisfies("1.2.2", "~1.2.3")).toBe(false);
  // ~1 (no minor)
  expect(satisfies("1.5.0", "~1")).toBe(true);
  expect(satisfies("1.0.0", "~1")).toBe(true);
  expect(satisfies("2.0.0", "~1")).toBe(false);
});

test("satisfies hyphen ranges", () => {
  expect(satisfies("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
  expect(satisfies("1.0.0", "1.0.0 - 2.0.0")).toBe(true);
  expect(satisfies("2.0.0", "1.0.0 - 2.0.0")).toBe(true);
  expect(satisfies("3.0.0", "1.0.0 - 2.0.0")).toBe(false);
  expect(satisfies("0.9.9", "1.0.0 - 2.0.0")).toBe(false);
});

test("satisfies x-ranges", () => {
  expect(satisfies("1.5.0", "1.x")).toBe(true);
  expect(satisfies("1.0.0", "1.x")).toBe(true);
  expect(satisfies("2.0.0", "1.x")).toBe(false);
  expect(satisfies("1.5.0", "1.x.x")).toBe(true);
  expect(satisfies("2.0.0", "1.x.x")).toBe(false);
  // star matches everything
  expect(satisfies("999.0.0", "*")).toBe(true);
  expect(satisfies("0.0.0", "*")).toBe(true);
});

test("satisfies comparison operators", () => {
  expect(satisfies("2.0.0", ">=1.5.0")).toBe(true);
  expect(satisfies("1.5.0", ">=1.5.0")).toBe(true);
  expect(satisfies("1.4.9", ">=1.5.0")).toBe(false);
  expect(satisfies("1.0.0", ">1.0.0")).toBe(false);
  expect(satisfies("1.0.1", ">1.0.0")).toBe(true);
  expect(satisfies("1.0.0", "<2.0.0")).toBe(true);
  expect(satisfies("2.0.0", "<2.0.0")).toBe(false);
  expect(satisfies("2.0.0", "<=2.0.0")).toBe(true);
  // spaces in operator
  expect(satisfies("3.1.0", ">= 3.1")).toBe(true);
});

test("satisfies exact version", () => {
  expect(satisfies("1.0.0", "1.0.0")).toBe(true);
  expect(satisfies("1.0.1", "1.0.0")).toBe(false);
});

test("satisfies OR groups", () => {
  expect(satisfies("2.0.0", "^1.0.0 || ^2.0.0")).toBe(true);
  expect(satisfies("1.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
  expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
});

test("satisfies AND groups", () => {
  expect(satisfies("1.0.0", ">=1.0.0 <2.0.0")).toBe(true);
  expect(satisfies("1.9.9", ">=1.0.0 <2.0.0")).toBe(true);
  expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  expect(satisfies("0.9.9", ">=1.0.0 <2.0.0")).toBe(false);
});

test("satisfies prerelease versions", () => {
  expect(satisfies("1.0.0-alpha.2", ">=1.0.0-alpha.1")).toBe(true);
  expect(satisfies("1.0.0-alpha.1", ">=1.0.0-alpha.1")).toBe(true);
  // prerelease on different major.minor.patch tuple excluded
  expect(satisfies("2.0.0-alpha.1", ">=1.0.0")).toBe(false);
});

test("satisfies bare partials", () => {
  expect(satisfies("1.2.5", "1.2")).toBe(true);
  expect(satisfies("1.2.0", "1.2")).toBe(true);
  expect(satisfies("1.3.0", "1.2")).toBe(false);
});

test("satisfies invalid input", () => {
  expect(satisfies("abc", "^1.0.0")).toBe(false);
  expect(satisfies("1.0.0", "not valid!!")).toBe(false);
});

test("validRange", () => {
  expect(validRange("^1.0.0")).toBe("^1.0.0");
  expect(validRange(">=1.0.0 <2.0.0")).toBe(">=1.0.0 <2.0.0");
  expect(validRange("1.0.0 - 2.0.0")).toBe("1.0.0 - 2.0.0");
  expect(validRange("*")).toBe("*");
  expect(validRange("not valid!!")).toBeNull();
});

test("satisfies 1.2.x pattern", () => {
  expect(satisfies("1.2.0", "1.2.x")).toBe(true);
  expect(satisfies("1.2.5", "1.2.x")).toBe(true);
  expect(satisfies("1.3.0", "1.2.x")).toBe(false);
  expect(satisfies("1.1.9", "1.2.x")).toBe(false);
  expect(validRange("1.2.x")).toBe("1.2.x");
});

test("satisfies bare single number partial", () => {
  expect(satisfies("1.5.0", "1")).toBe(true);
  expect(satisfies("1.0.0", "1")).toBe(true);
  expect(satisfies("1.99.99", "1")).toBe(true);
  expect(satisfies("2.0.0", "1")).toBe(false);
  expect(satisfies("0.9.9", "1")).toBe(false);
  expect(satisfies("5.0.0", "1")).toBe(false);
});

test("validRange non-string input", () => {
  expect(validRange(undefined as any)).toBeNull();
  expect(validRange(null as any)).toBeNull();
});

test("satisfies partial hyphen ranges", () => {
  // 1.2.3 - 2.3 := >=1.2.3 <2.4.0-0
  expect(satisfies("2.3.9", "1.2.3 - 2.3")).toBe(true);
  expect(satisfies("2.4.0", "1.2.3 - 2.3")).toBe(false);
  // 1.2.3 - 2 := >=1.2.3 <3.0.0-0
  expect(satisfies("2.99.99", "1.2.3 - 2")).toBe(true);
  expect(satisfies("3.0.0", "1.2.3 - 2")).toBe(false);
});

test("satisfies caret with trailing wildcard", () => {
  // ^1.x := >=1.0.0 <2.0.0-0
  expect(validRange("^1.x")).toBe("^1.x");
  expect(satisfies("1.0.0", "^1.x")).toBe(true);
  expect(satisfies("1.9.9", "^1.x")).toBe(true);
  expect(satisfies("2.0.0", "^1.x")).toBe(false);
  // ^1.x.x := >=1.0.0 <2.0.0-0
  expect(validRange("^1.x.x")).toBe("^1.x.x");
  expect(satisfies("1.5.0", "^1.x.x")).toBe(true);
  expect(satisfies("2.0.0", "^1.x.x")).toBe(false);
  // ^1.2.x := >=1.2.0 <2.0.0-0 (caret keeps the major-level upper bound)
  expect(validRange("^1.2.x")).toBe("^1.2.x");
  expect(satisfies("1.2.0", "^1.2.x")).toBe(true);
  expect(satisfies("1.3.0", "^1.2.x")).toBe(true);
  expect(satisfies("1.9.9", "^1.2.x")).toBe(true);
  expect(satisfies("2.0.0", "^1.2.x")).toBe(false);
  expect(satisfies("1.1.9", "^1.2.x")).toBe(false);
  // ^0.x := >=0.0.0 <1.0.0-0
  expect(validRange("^0.x")).toBe("^0.x");
  expect(satisfies("0.9.9", "^0.x")).toBe(true);
  expect(satisfies("1.0.0", "^0.x")).toBe(false);
});

test("satisfies tilde with trailing wildcard", () => {
  // ~1.x := >=1.0.0 <2.0.0-0
  expect(validRange("~1.x")).toBe("~1.x");
  expect(satisfies("1.9.9", "~1.x")).toBe(true);
  expect(satisfies("2.0.0", "~1.x")).toBe(false);
  // ~1.2.x := >=1.2.0 <1.3.0-0 (tilde keeps the minor-level upper bound)
  expect(validRange("~1.2.x")).toBe("~1.2.x");
  expect(satisfies("1.2.0", "~1.2.x")).toBe(true);
  expect(satisfies("1.2.9", "~1.2.x")).toBe(true);
  expect(satisfies("1.3.0", "~1.2.x")).toBe(false);
});

test("parsePep440 normalizes every release form", () => {
  expect(parsePep440("26.3")).toMatchObject({epoch: 0, release: [26, 3], pre: null, post: null, dev: null, local: null});
  expect(parsePep440("1!1.0")).toMatchObject({epoch: 1, release: [1, 0]});
  expect(parsePep440("2.32.0.20250602")).toMatchObject({release: [2, 32, 0, 20250602]});
  expect(parsePep440("17.04.0")).toMatchObject({release: [17, 4, 0]}); // zero-padded segments are numbers
  expect(parsePep440("2.9.0.post0")).toMatchObject({post: 0});
  expect(parsePep440("1.0-1")).toMatchObject({release: [1, 0], post: 1}); // implicit post syntax
  expect(parsePep440("1.1.0.dev1")).toMatchObject({dev: 1});
  expect(parsePep440("0.0.1a19")).toMatchObject({pre: ["a", 19]});
  expect(parsePep440("1.0.0+ubuntu.1")).toMatchObject({local: ["ubuntu", 1]});
  expect(parsePep440("v1.2.3")).toMatchObject({release: [1, 2, 3]});
  expect(parsePep440("not_a_version")).toBeNull();
  for (const [input, letter] of [["1.0alpha", "a"], ["1.0.beta2", "b"], ["1.0c1", "rc"], ["1.0-pre", "rc"], ["1.0_preview3", "rc"], ["1.0RC4", "rc"]] as const) {
    expect(parsePep440(input)!.pre![0]).toBe(letter);
  }
  expect(parsePep440("1.0alpha")!.pre![1]).toBe(0);
});

test("comparePep440 orders epoch, release, pre, post, dev and local", () => {
  const cmp = (a: string, b: string) => Math.sign(comparePep440(parsePep440(a)!, parsePep440(b)!));
  expect(cmp("1.0", "1.0.0")).toBe(0); // trailing zeros are insignificant
  expect(cmp("1!1.0", "2.0")).toBe(1); // an epoch outranks the release segment
  expect(cmp("26.3", "26.2")).toBe(1);
  expect(cmp("2.32.4.20250611", "2.32.0.20250602")).toBe(1);
  expect(cmp("1.0", "1.0rc1")).toBe(1);
  expect(cmp("1.0rc1", "1.0b1")).toBe(1);
  expect(cmp("1.0b1", "1.0a1")).toBe(1);
  expect(cmp("1.0a10", "1.0a9")).toBe(1);
  expect(cmp("1.0.post1", "1.0")).toBe(1);
  expect(cmp("1.0", "1.0.dev1")).toBe(1);
  expect(cmp("1.0a1", "1.0.dev1")).toBe(1); // a bare dev release precedes every pre-release
  expect(cmp("1.0.post1.dev1", "1.0")).toBe(1); // but a post-dev release still follows the release
  expect(cmp("1.0+local", "1.0")).toBe(1);
  expect(cmp("1.0+1", "1.0+abc")).toBe(1); // numeric local segments sort after alphanumeric ones
});

test("diffPep440 buckets by release level with a pre prefix for unstable candidates", () => {
  const d = (a: string, b: string) => diffPep440(parsePep440(a)!, parsePep440(b)!);
  expect(d("1.0", "1.0.0")).toBe(null);
  expect(d("1.0", "6.0")).toBe("major");
  expect(d("3.4.0.20240423", "3.5.0.20250801")).toBe("minor");
  expect(d("2.32.0.20240622", "2.32.4.20250611")).toBe("patch");
  // renovate buckets everything below the minor as a patch, so a fourth segment has no level of its own
  expect(d("3.4.0.20240103", "3.4.0.20240423")).toBe("patch");
  expect(d("0.0.1a15", "0.0.1a19")).toBe("prerelease");
  expect(d("1.0", "2.0b1")).toBe("premajor");
  expect(d("1.0", "1.1.0.dev1")).toBe("preminor");
  expect(d("1.0rc1", "1.0")).toBe("patch");
});

test("semverVersioning reads the prerelease off a range's comparator", () => {
  expect(["^1.0.0-alpha", ">=2.0.0-rc.1"].every(range => semverVersioning.isRangePrerelease(range))).toBe(true);
  expect(["^1.0.0", "~2.0.0"].some(range => semverVersioning.isRangePrerelease(range))).toBe(false);
});

test("pep440Versioning classifies prereleases the semver rules miss", () => {
  for (const version of ["2.0.0b1", "1.0rc1", "0.0.1a19", "1.1.0.dev1"]) {
    expect(pep440Versioning.isRangePrerelease(version)).toBe(true);
    expect(pep440Versioning.isPrerelease(pep440Versioning.parse(version)!)).toBe(true);
  }
  for (const version of ["6.0", "2026.3.post1", "2.32.4.20250611"]) {
    expect(pep440Versioning.isRangePrerelease(version)).toBe(false);
  }
  expect(pep440Versioning.parseRange(">=2.28.0")!.release).toEqual([2, 28, 0]);
  // --pin takes a semver range, matched against the first three release segments
  expect(pep440Versioning.satisfiesRange(pep440Versioning.parse("6.0")!, "^6.0.0")).toBe(true);
  expect(pep440Versioning.satisfiesRange(pep440Versioning.parse("2.32.4.20250611")!, "^2.33.0")).toBe(false);
});

test("satisfies operator-prefixed x-ranges", () => {
  // >=1.2.x := >=1.2.0
  expect(validRange(">=1.2.x")).toBe(">=1.2.x");
  expect(satisfies("1.5.0", ">=1.2.x")).toBe(true);
  expect(satisfies("1.2.0", ">=1.2.x")).toBe(true);
  expect(satisfies("1.1.0", ">=1.2.x")).toBe(false);
  // >=1.2.x <2.0.0 := >=1.2.0 <2.0.0
  expect(validRange(">=1.2.x <2.0.0")).toBe(">=1.2.x <2.0.0");
  expect(satisfies("1.5.0", ">=1.2.x <2.0.0")).toBe(true);
  expect(satisfies("2.0.0", ">=1.2.x <2.0.0")).toBe(false);
  expect(satisfies("1.1.0", ">=1.2.x <2.0.0")).toBe(false);
  // >=1.x := >=1.0.0
  expect(satisfies("0.9.9", ">=1.x")).toBe(false);
  expect(satisfies("3.0.0", ">=1.x")).toBe(true);
  // <=1.2.x := <1.3.0-0 (any 1.2.z passes)
  expect(satisfies("1.2.9", "<=1.2.x")).toBe(true);
  expect(satisfies("1.3.0", "<=1.2.x")).toBe(false);
  // >1.x := >=2.0.0 (greater than the whole 1.x line)
  expect(satisfies("1.9.9", ">1.x")).toBe(false);
  expect(satisfies("2.0.0", ">1.x")).toBe(true);
});
