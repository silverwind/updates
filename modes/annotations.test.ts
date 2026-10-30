import {parseAnnotations, updateAnnotatedLines} from "./annotations.ts";

test.each([
  ["the updates alias above a blank line and a commented value",
    "# updates: datasource=github-releases depName=mvdan/gofumpt\n\nGOFUMPT_VERSION := v0.12.0 # pinned\n", [[2, 19, "v0.12.0"]]],
  ["a YAML list item comment", "- # renovate: datasource=repology depName=postgresql\n  PG_VERSION: \"14.24\"\n", [[1, 15, "14.24"]]],
  ["an XML comment", "<!-- renovate: datasource=github-releases depName=o/r -->\n<r.version>0.3.0</r.version>\r\n", [[1, 11, "0.3.0"]]],
  ["a PEP 440 version after an @", "uvx ruff@0.66b1 check # renovate: datasource=pypi depName=ruff\n", [[0, 9, "0.66b1"]]],
  ["shell default expansions", `# renovate: datasource=pypi depName=jumpstarter\nV="\${V:-0.9.0}"\nG="\${G:-v0.11.0}" # renovate: datasource=go depName=mvdan.cc/gofumpt\n`,
    [[1, 8, "0.9.0"], [2, 8, "v0.11.0"]]],
  ["a package version before an unrelated number",
    "uvx black@24.1.0 --workers 2 . # renovate: datasource=pypi depName=black\n", [[0, 10, "24.1.0"]]],
  ["a packageName version after ==",
    "uvx black==24.1.0 --workers 2 . # renovate: datasource=pypi depName=alias packageName=black\n", [[0, 11, "24.1.0"]]],
  ["an escaped quote before a quoted delimiter",
    'x = "release \\" # stable"; version = "1.0.0" // renovate: datasource=npm depName=foo\n', [[0, 38, "1.0.0"]]],
  ["an adjacent XML comment",
    "<version>1.0.0</version><!-- renovate: datasource=npm depName=foo -->\n", [[0, 9, "1.0.0"]]],
  ["an adjacent // comment", 'x = "1.0.0";// renovate: datasource=npm depName=foo\n', [[0, 5, "1.0.0"]]],
  ["an annotation after a URL fragment and a shell word",
    "VERSION=1.0.0 https://example.com/#fragment foo#bar # renovate: datasource=npm depName=foo\n", [[0, 8, "1.0.0"]]],
  ["an unpaired apostrophe before the annotation", "name: it's 1.0.0 # renovate: datasource=npm depName=foo\n", [[0, 11, "1.0.0"]]],
  ["a // comment without a space", "//renovate: datasource=pypi depName=barman\nbarmanVersion = \"3.20.1\"\n", [[1, 17, "3.20.1"]]],
  ["an unnamed go install", "TOOL ?= github.com/o/r/cmd/t@v1.2.3 # renovate: datasource=go\n", [[0, 8, "github.com/o/r/cmd/t@v1.2.3"]]],
  ["an image on an IPv6 registry", "IMAGE=[2001:db8::1]:5000/o/tool:1.0.0 # updates: datasource=docker\n", [[0, 6, "[2001:db8::1]:5000/o/tool:1.0.0"]]],
  ["a PyPI package spelled differently", "uvx foo_bar==1.0.0 --workers 2 # updates: datasource=pypi depName=Foo-Bar\n", [[0, 13, "1.0.0"]]],
  ["nothing without a datasource", "ARG CHROMIUM_VERSION=150.0 # renovate: depName=chromium\n", []],
  ["nothing without a name", "VERSION: 1.2.3 # renovate: datasource=npm\n", []],
  ["nothing for a floating docker tag", `IMAGE: nginx:alpine@sha256:${"a".repeat(64)} # renovate: datasource=docker\n`, []],
  ["nothing for ambiguous assignments", "BLACK_VERSION=24.1.0 WORKERS=2 # renovate: datasource=pypi depName=black\n", []],
  ["nothing from a URL scheme", "VERSION=1.0.0 https://renovate: datasource=npm depName=foo\n", []],
  ["nothing from a quoted marker", 'x = "1.0.0 # renovate: datasource=npm depName=foo"\n', []],
  ["nothing below a value-less line", "V := $(VERSION) # renovate: datasource=npm depName=x\nW := 1.2.3\n", []],
  ["nothing from a comment line", "# renovate: datasource=npm depName=x\n# V: 1.2.3\n", []],
  ["nothing inside another comment", "# e.g. V=1.0.0 # renovate: datasource=npm depName=x\nW=1.2.3\n", []],
])("parseAnnotations reads %s", (_name, content, expected) => {
  expect(parseAnnotations(content).map(({line, column, value}) => [line, column, value])).toEqual(expected);
});

test("updateAnnotatedLines applies same-line edits right to left and leaves values that moved or grew", () => {
  expect(updateAnnotatedLines("B: 1.0.0\nC: 10\nD: 1 2\n", [
    {line: 0, column: 4, oldValue: "1.0.0", newValue: "1.1.0"},
    {line: 1, column: 3, oldValue: "1", newValue: "2"},
    {line: 2, column: 3, oldValue: "1", newValue: "10"},
    {line: 2, column: 5, oldValue: "2", newValue: "3"},
  ])).toBe("B: 1.0.0\nC: 10\nD: 10 3\n");
});
