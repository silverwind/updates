import {readFileSync} from "node:fs";
import {parseToml} from "./toml.ts";

test("basic string value", () => {
  expect(parseToml(`key = "value"`)).toEqual({key: "value"});
});

test("integer value", () => {
  expect(parseToml(`port = 8080`)).toEqual({port: 8080});
});

test("float value", () => {
  expect(parseToml(`pi = 3.14`)).toEqual({pi: 3.14});
});

test("boolean values", () => {
  expect(parseToml(`enabled = true\ndebug = false`)).toEqual({enabled: true, debug: false});
});

test("table header", () => {
  expect(parseToml(`[tool]\nname = "x"`)).toEqual({tool: {name: "x"}});
});

test("nested table header", () => {
  expect(parseToml(`[tool.poetry]\nname = "x"`)).toEqual({tool: {poetry: {name: "x"}}});
});

test("dotted keys", () => {
  expect(parseToml(`a.b = "val"`)).toEqual({a: {b: "val"}});
});

test("dotted keys within table", () => {
  expect(parseToml(`[section]\na.b = "val"`)).toEqual({section: {a: {b: "val"}}});
});

test("quoted key preserves dots", () => {
  expect(parseToml(`"dotted.key" = "val"`)).toEqual({"dotted.key": "val"});
});

test("literal string", () => {
  expect(parseToml(`key = 'hello'`)).toEqual({key: "hello"});
});

test("multi-line basic string", () => {
  expect(parseToml(`key = """hello"""`)).toEqual({key: "hello"});
});

test("multi-line literal string", () => {
  expect(parseToml(`key = '''hello'''`)).toEqual({key: "hello"});
});

test("multi-line basic string spanning lines keeps body and leaks no keys", () => {
  expect(parseToml(`a = """\nhello\nworld\n"""\nb = "x"`)).toEqual({a: "hello\nworld\n", b: "x"});
  // a "key = value" line inside the string must not become a phantom dependency
  expect(parseToml(`[dependencies]\nhelp = """\nfoo = bar\n"""\nserde = "1.0"`))
    .toEqual({dependencies: {help: "foo = bar\n", serde: "1.0"}});
});

test("multi-line literal string spanning lines", () => {
  expect(parseToml(`a = '''\nx = 1\n'''\n[dependencies]\nserde = "1"`))
    .toEqual({a: "x = 1\n", dependencies: {serde: "1"}});
});

test("escape sequences in basic strings", () => {
  expect(parseToml(`a = "line1\\nline2"\nb = "col1\\tcol2"`)).toEqual({a: "line1\nline2", b: "col1\tcol2"});
});

test("unicode escape \\uXXXX", () => {
  expect(parseToml(`ch = "\\u0041"`)).toEqual({ch: "A"});
});

test("unicode escape \\UXXXXXXXX", () => {
  expect(parseToml(`ch = "\\U00000041"`)).toEqual({ch: "A"});
});

test("escaped quote and backslash", () => {
  expect(parseToml(`a = "he said \\"hi\\""\nb = "c:\\\\path"`)).toEqual({a: `he said "hi"`, b: "c:\\path"});
});

test("inline array", () => {
  expect(parseToml(`tags = ["a", "b", "c"]`)).toEqual({tags: ["a", "b", "c"]});
});

test("multi-line array", () => {
  const input = `deps = [\n  "foo",\n  "bar",\n]`;
  expect(parseToml(input)).toEqual({deps: ["foo", "bar"]});
});

test("multi-line array with brackets inside strings", () => {
  const input = `deps = [\n  "apispec[marshmallow]==6.10.0",\n  "foo",\n]`;
  expect(parseToml(input)).toEqual({deps: ["apispec[marshmallow]==6.10.0", "foo"]});
});

test("multi-line array of nested arrays", () => {
  expect(parseToml(`a = [\n  [1, 2],\n  [3, 4],\n]`)).toEqual({a: [[1, 2], [3, 4]]});
});

test("multi-line array of inline tables with inner arrays", () => {
  expect(parseToml(`a = [\n  { f = ["x"] },\n  { f = ["y"] },\n]`)).toEqual({a: [{f: ["x"]}, {f: ["y"]}]});
});

test("inline array with brackets inside strings", () => {
  expect(parseToml(`deps = ["apispec[marshmallow]==6.10.0", "foo"]`))
    .toEqual({deps: ["apispec[marshmallow]==6.10.0", "foo"]});
});

test("hash inside string is not a comment", () => {
  expect(parseToml(`name = "url#fragment"`)).toEqual({name: "url#fragment"});
});

test("trailing comment after value", () => {
  expect(parseToml(`name = "x" # trailing`)).toEqual({name: "x"});
});

test("array of tables", () => {
  const input = `[[tool.pytest]]\nx = 1\n[[tool.pytest]]\nx = 2`;
  expect(parseToml(input)).toEqual({tool: {pytest: [{x: 1}, {x: 2}]}});
});

test("array of tables does not leak into prior table", () => {
  const input = `[package]\nname = "pkg"\n[[bin]]\nname = "bin"\n[dependencies]\nserde = "1"`;
  expect(parseToml(input)).toEqual({
    package: {name: "pkg"},
    bin: [{name: "bin"}],
    dependencies: {serde: "1"},
  });
});

test("nested arrays", () => {
  expect(parseToml(`a = [[1,2],[3,4]]`)).toEqual({a: [[1, 2], [3, 4]]});
});

test("array of inline tables", () => {
  expect(parseToml(`a = [{x=1},{x=2}]`)).toEqual({a: [{x: 1}, {x: 2}]});
});

test("inline table", () => {
  expect(parseToml(`point = {x = 1, y = 2}`)).toEqual({point: {x: 1, y: 2}});
});

test("comments are stripped", () => {
  expect(parseToml(`key = "value" # comment\n# full line comment\nother = 1`)).toEqual({key: "value", other: 1});
});

test("empty and blank lines are ignored", () => {
  expect(parseToml(`\n\n  \nkey = "value"\n\n`)).toEqual({key: "value"});
});

test("multiple tables", () => {
  const input = `[a]\nx = 1\n[b]\ny = 2`;
  expect(parseToml(input)).toEqual({a: {x: 1}, b: {y: 2}});
});

test("mixed types in array", () => {
  expect(parseToml(`vals = [1, "two", true]`)).toEqual({vals: [1, "two", true]});
});

test("multi-line basic string with escapes", () => {
  expect(parseToml(`key = """hello\\nworld"""`)).toEqual({key: "hello\nworld"});
});

test("multi-line literal string preserves content", () => {
  expect(parseToml(`key = '''raw\\nstring'''`)).toEqual({key: "raw\\nstring"});
});

test("nested inline table within table", () => {
  expect(parseToml(`[section]\npoint = {x = 1, y = 2}`)).toEqual({section: {point: {x: 1, y: 2}}});
});

test("backspace and form feed escape sequences", () => {
  expect(parseToml(`a = "\\b"\nb = "\\f"`)).toEqual({a: "\b", b: "\f"});
});

test("carriage return escape sequence", () => {
  expect(parseToml(`key = "\\r"`)).toEqual({key: "\r"});
});

test("real-world pyproject.toml", () => {
  const content = readFileSync("fixtures/uv/pyproject.toml", "utf8");
  const result = parseToml(content);
  expect(result.project).toEqual({
    name: "uvproject",
    version: "0.0.0",
    description: "",
    "requires-python": ">=3.12",
    dependencies: ["djlint==1.30.0", "ty>=0.0.1a15"],
  });
  expect(result["dependency-groups"]).toEqual({
    dev: ["PyYAML==1.0", "types-requests>=2.32.0.20240622", "types-paramiko==3.4.0.20240423"],
  });
});
