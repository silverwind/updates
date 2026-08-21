import {
  highlightDiff, parseUvDependencies, parseDuration, matchesAny, commaSeparatedToArray,
  timestamp, textTable, pMap, expandDepTypes, uvTypes, cargoTypes, cargoTargetTypes, patternToRegex,
  npmTypes,
} from "./utils.ts";

const c = (s: string) => `[${s}]`;

test("highlightDiff", () => {
  expect(highlightDiff("1.0.0", "1.0.0", c)).toBe("1.0.0");
  expect(highlightDiff("1.0.0", "2.0.0", c)).toBe("[1.0.0]");
  expect(highlightDiff("2.0.0", "1.0.0", c)).toBe("[2.0.0]");
  expect(highlightDiff("1.0.0", "1.2.0", c)).toBe("1.[0.0]");
  expect(highlightDiff("1.2.0", "1.0.0", c)).toBe("1.[2.0]");
  expect(highlightDiff("1.0.0", "1.0.3", c)).toBe("1.0.[0]");
  expect(highlightDiff("1.0.3", "1.0.0", c)).toBe("1.0.[3]");
  expect(highlightDiff("10.0.0", "12.0.0", c)).toBe("[10.0.0]");
  expect(highlightDiff("12.0.0", "10.0.0", c)).toBe("[12.0.0]");
  expect(highlightDiff("1.10.0", "1.12.0", c)).toBe("1.[10.0]");
  expect(highlightDiff("v5", "v6", c)).toBe("v[5]");
  expect(highlightDiff("v10", "v12", c)).toBe("v[10]");
  expect(highlightDiff("v10.0", "v12.0", c)).toBe("v[10.0]");
  expect(highlightDiff("^4", "^5", c)).toBe("^[4]");
  expect(highlightDiff("^1.0.0", "^2.0.0", c)).toBe("^[1.0.0]");
  expect(highlightDiff("~1.0.0", "~1.5.0", c)).toBe("~1.[0.0]");
  expect(highlightDiff(">=2.0.0", ">=2.6.5", c)).toBe(">=2.[0.0]");
  expect(highlightDiff("4.0.0-alpha.2", "4.0.0-beta.11", c)).toBe("4.0.0-[alpha.2]");
  expect(highlightDiff("537ccb7", "6941e05", c)).toBe("[537ccb7]");
});

test("parseUvDependencies", () => {
  const parsed = parseUvDependencies([
    "tqdm >=4.66.2,<5",
    "torch ==2.2.2",
    "transformers[torch] >=4.39.3",
    "private-depB[extra1, extra2]~=2.4",
    "mollymawk ==0.1.0",
    "types-requests==2.32.0.20240622",
    "types-paramiko==3.4.0.20240423",
    "ty>=0.0.1a15",
    "tomli>=1.1.0; python_version < \"3.11\"",
    "packaging>=20.9,!=22.0",
    "flask <3,>=2.2",
    "importlib-metadata (==8.0.0)",
    "wheel (>=0.40.0); python_version < \"3.8\"",
    "urllib3===1.26.0",
    "certifi!=2024.2.2",
    "idna<4",
    "flask>2.3.0,<3",
    "click==1.4.*",
    "requests",
    "anyio[trio]",
    "typing-extensions; python_version < \"3.8\"",
    "torchvision @ https://example.com/torchvision-0.17.2.whl",
    {"include-group": "lint"},
  ]);
  expect(parsed[0].spec).toBe("tqdm >=4.66.2,<5");
  expect(parsed.map(({name, version}) => ({name, version}))).toEqual([
    {name: "tqdm", version: "4.66.2"},
    {name: "torch", version: "2.2.2"},
    {name: "transformers", version: "4.39.3"},
    {name: "private-depB", version: "2.4"},
    {name: "mollymawk", version: "0.1.0"},
    {name: "types-requests", version: "2.32.0.20240622"},
    {name: "types-paramiko", version: "3.4.0.20240423"},
    {name: "ty", version: "0.0.1a15"},
    {name: "tomli", version: "1.1.0"},
    {name: "packaging", version: "20.9"},
    {name: "flask", version: "2.2"},
    {name: "importlib-metadata", version: "8.0.0"},
    {name: "wheel", version: "0.40.0"},
    {name: "urllib3", version: "1.26.0"},
  ]);
});

test("expandDepTypes", () => {
  const pyproject = {
    project: {
      "dependencies": ["requests>=2.0.0"],
      "optional-dependencies": {"cli": ["click>=8.0.0"], "extra.one": ["sphinx>=7.0.0"]},
    },
    "dependency-groups": {"docs": ["mkdocs>=1.6.0"], "test.unit": [{"include-group": "docs"}]},
  };
  expect(expandDepTypes(uvTypes, pyproject)).toEqual([
    ["project.dependencies", pyproject.project.dependencies],
    ["project.optional-dependencies.cli", pyproject.project["optional-dependencies"].cli],
    ["project.optional-dependencies.extra.one", pyproject.project["optional-dependencies"]["extra.one"]],
    ["dependency-groups.docs", pyproject["dependency-groups"].docs],
    ["dependency-groups.test.unit", pyproject["dependency-groups"]["test.unit"]],
  ]);
  expect(expandDepTypes(uvTypes, {})).toEqual([]);

  const cargo = {
    dependencies: {serde: "1.0"},
    target: {
      "cfg(unix)": {dependencies: {nix: "0.29"}},
      "cfg(feature = \"foo.bar\")": {dependencies: {feature: "1"}},
      "x86_64-pc-windows-msvc": {"dependencies": {winapi: "0.3"}, "build-dependencies": {cc: "1.0"}},
    },
  };
  expect(expandDepTypes([...cargoTypes, ...cargoTargetTypes], cargo).map(([type]) => type)).toEqual([
    "dependencies",
    `["target","cfg(unix)","dependencies"]`,
    `["target","cfg(feature = \\"foo.bar\\")","dependencies"]`,
    `["target","x86_64-pc-windows-msvc","dependencies"]`,
    `["target","x86_64-pc-windows-msvc","build-dependencies"]`,
  ]);
});

test("default npm dependency types", () => {
  expect(npmTypes).toContain("overrides");
  expect(npmTypes).toContain("pnpm.overrides");
});

test.each([
  ["foo*", ["FOO", "foo.bar", "foo/bar"], [true, true, false]],
  ["foo/**/bar", ["foo/bar", "foo/a/bar", ".foo/bar"], [true, true, false]],
  ["file?.[jt]s", ["file1.js", "fileA.ts", "file10.js"], [true, true, false]],
  ["{foo,bar}/@(one|two)", ["foo/one", "bar/two", "baz/one"], [true, true, false]],
  ["v{1..3}", ["v1", "v3", "v4"], [true, true, false]],
  ["?(foo)", ["", "foo", "foofoo"], [true, true, false]],
  ["*(foo)", ["", "foo", "foofoo", "foofoofoo"], [true, true, true, true]],
  ["+(foo)", ["", "foo", "foofoo"], [false, true, true]],
  ["!(foo)", ["foo", "bar"], [false, true]],
  ["/Foo/", ["Foo", "foo"], [true, false]],
  ["!/foo/i", ["FOO", "bar"], [false, true]],
])("patternToRegex supports %s", (pattern, values, expected) => {
  expect(values.map(value => patternToRegex(pattern).test(value))).toEqual(expected);
});

test("patternToRegex avoids extglob backtracking", () => {
  const start = performance.now();
  expect(patternToRegex("+(a|aa)").test(`${"a".repeat(40)}b`)).toBe(false);
  expect(performance.now() - start).toBeLessThan(100);
});

test("matchesAny", () => {
  expect([
    matchesAny("foo", new Set([/foo/])), matchesAny("bar", new Set([/foo/])), matchesAny("foobar", new Set([/^foo/])),
    matchesAny("foo", new Set([/bar/, /foo/])), matchesAny("foo", false), matchesAny("foo", true), matchesAny("foo", new Set()),
  ]).toEqual([true, false, true, true, false, true, false]);
});

test("commaSeparatedToArray", () => {
  expect(["a,b,c", "a", "", "a,,b"].map(commaSeparatedToArray))
    .toEqual([["a", "b", "c"], ["a"], [], ["a", "b"]]);
});

test("timestamp", () => {
  const ts = timestamp();
  expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test("textTable", () => {
  expect(textTable([["a", "bb"], ["ccc", "d"]], value => value.length)).toBe("a   bb\nccc d");
  expect(textTable([["x"]], value => value.length)).toBe("x");
});

test("parseDuration", () => {
  expect(["7", "2y", "3m", "1w", "2d", "12h", "6h", "86400s"].map(parseDuration))
    .toEqual([7, 730, 90, 7, 2, 0.5, 0.25, 1]);
  expect(parseDuration("10s")).toBeCloseTo(10 / 86400);
  expect(() => parseDuration("abc")).toThrow("Invalid cooldown value");
  expect(() => parseDuration("12x")).toThrow("Invalid cooldown value");
});

test("pMap", async () => {
  expect(await pMap([1, 2, 3], n => Promise.resolve(n * 2))).toEqual([2, 4, 6]);
  expect(await pMap([10, 20, 30], n => Promise.resolve(n + 1), {concurrency: 2})).toEqual([11, 21, 31]);
  expect(await pMap([], (n: number) => Promise.resolve(n))).toEqual([]);
});
