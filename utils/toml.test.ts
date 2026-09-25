import {readFileSync} from "node:fs";
import {parseToml} from "./toml.ts";

test("TOML syntax", () => {
  const cases: Array<[string, string, unknown]> = [
    ["float", `num = 1.5`, {num: 1.5}],
    ["booleans", `enabled = true\ndebug = false`, {enabled: true, debug: false}],
    ["table", `[tool]\nname = "x"`, {tool: {name: "x"}}],
    ["nested table", `[tool.poetry]\nname = "x"`, {tool: {poetry: {name: "x"}}}],
    ["prototype key", `[__proto__.poetry]\nname = "x"`, {["__proto__"]: {poetry: {name: "x"}}}],
    ["prototype array table under a nested array", `a = [[1]]\n[[a.__proto__]]\nz = "polluted"`, {a: {["__proto__"]: [{z: "polluted"}]}}],
    ["dotted key in table", `[section]\na.b = "val"`, {section: {a: {b: "val"}}}],
    ["quoted dotted key", `"dotted.key" = "val"`, {"dotted.key": "val"}],
    ["escaped quotes in target key", `[target."cfg(target_os = \\"windows\\")".dependencies]\nserde = "1"`,
      {target: {[`cfg(target_os = "windows")`]: {dependencies: {serde: "1"}}}}],
    ["literal string", `key = 'hello'`, {key: "hello"}],
    ["multiline basic string", `a = """\nhello\nworld\n"""\nb = "x"`, {a: "hello\nworld\n", b: "x"}],
    ["key text in multiline string", `[dependencies]\nhelp = """\nfoo = bar\n"""\nserde = "1.0"`,
      {dependencies: {help: "foo = bar\n", serde: "1.0"}}],
    ["multiline literal string", `a = '''\nx = 1\n'''\n[dependencies]\nserde = "1"`,
      {a: "x = 1\n", dependencies: {serde: "1"}}],
    ["basic escapes", `a = "line1\\nline2"\nb = "col1\\tcol2"`, {a: "line1\nline2", b: "col1\tcol2"}],
    ["short unicode escape", `ch = "\\u0041"`, {ch: "A"}],
    ["long unicode escape", `ch = "\\U00000041"`, {ch: "A"}],
    ["quote and slash escapes", `a = "he said \\"hi\\""\nb = "c:\\\\path"`, {a: `he said "hi"`, b: "c:\\path"}],
    ["multiline array with brackets in strings", `deps = [\n  "apispec[marshmallow]==6.10.0",\n  "foo",\n]`,
      {deps: ["apispec[marshmallow]==6.10.0", "foo"]}],
    ["multiline nested arrays", `a = [\n  [1, 2],\n  [3, 4],\n]`, {a: [[1, 2], [3, 4]]}],
    ["multiline inline tables", `a = [\n  { f = ["x"] },\n  { f = ["y"] },\n]`, {a: [{f: ["x"]}, {f: ["y"]}]}],
    ["inline array with brackets in strings", `deps = ["apispec[marshmallow]==6.10.0", "foo"]`,
      {deps: ["apispec[marshmallow]==6.10.0", "foo"]}],
    ["hash in string", `name = "url#fragment"`, {name: "url#fragment"}],
    ["array of tables", `[[tool.pytest]]\nx = 1\n[[tool.pytest]]\nx = 2`, {tool: {pytest: [{x: 1}, {x: 2}]}}],
    ["array of tables after table", `[package]\nname = "pkg"\n[[bin]]\nname = "bin"\n[dependencies]\nserde = "1"`,
      {package: {name: "pkg"}, bin: [{name: "bin"}], dependencies: {serde: "1"}}],
    ["array of inline tables", `a = [{x=1},{x=2}]`, {a: [{x: 1}, {x: 2}]}],
    ["inline table", `point = {x = 1, y = 2}`, {point: {x: 1, y: 2}}],
    ["comments", `key = "value" # comment\n# full line comment\nother = 1`, {key: "value", other: 1}],
    ["blank lines", `\n\n  \nkey = "value"\n\n`, {key: "value"}],
    ["multiple tables", `[a]\nx = 1\n[b]\ny = 2`, {a: {x: 1}, b: {y: 2}}],
    ["mixed array", `vals = [1, "two", true]`, {vals: [1, "two", true]}],
    ["multiline basic escapes", `key = """hello\\nworld"""`, {key: "hello\nworld"}],
    ["multiline literal content", `key = '''raw\\nstring'''`, {key: "raw\\nstring"}],
    ["backspace and form feed", `a = "\\b"\nb = "\\f"`, {a: "\b", b: "\f"}],
    ["carriage return", `key = "\\r"`, {key: "\r"}],
  ];
  for (const [_name, input, expected] of cases) expect(parseToml(input)).toEqual(expected);
  expect(({} as Record<string, unknown>).poetry).toBeUndefined();
});

test("real pyproject.toml", () => {
  const result = parseToml(readFileSync("fixtures/uv/pyproject.toml", "utf8"));
  expect(result.project).toEqual({
    name: "uvproject",
    version: "0.0.0",
    description: "",
    "requires-python": ">=3.12",
    dependencies: ["djlint==1.30.0", "ty>=0.0.1a15"],
  });
  expect(result["dependency-groups"]).toEqual({
    dev: ["PyYAML==1.0", "types-requests>=2.32.0.20240622,<3 ; python_version >= '3.9'", "types-paramiko==3.4.0.20240423"],
  });
});
