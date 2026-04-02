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
