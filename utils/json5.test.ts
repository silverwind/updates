import {test, expect} from "vitest";
import {parseJsonish} from "./json5.ts";

test("plain JSON", () => {
  expect(parseJsonish(`{"a":1,"b":[2,3]}`)).toEqual({a: 1, b: [2, 3]});
});

test("line comments", () => {
  expect(parseJsonish(`{
    // top
    "a": 1 // trailing
  }`)).toEqual({a: 1});
});

test("block comments", () => {
  expect(parseJsonish(`{ /* x */ "a": /* y */ 1 }`)).toEqual({a: 1});
});

test("trailing commas", () => {
  expect(parseJsonish(`{"a": [1, 2,], "b": 3,}`)).toEqual({a: [1, 2], b: 3});
});

test("comment-like content inside strings is preserved", () => {
  expect(parseJsonish(`{"a": "// not a comment", "b": "/* nope */"}`)).toEqual({a: "// not a comment", b: "/* nope */"});
});

test("escaped quotes inside strings", () => {
  expect(parseJsonish(`{"a": "he said \\"hi\\""}`)).toEqual({a: 'he said "hi"'});
});

test("unquoted identifier keys", () => {
  expect(parseJsonish(`{a: 1, $schema: "x", b_2: true, nil: null}`))
    .toEqual({a: 1, $schema: "x", b_2: true, nil: null});
});

test("single-quoted strings", () => {
  expect(parseJsonish(`{'a': 'x', b: ['y', 'z']}`)).toEqual({a: "x", b: ["y", "z"]});
});

test("escapes inside single-quoted strings", () => {
  expect(parseJsonish(`{a: 'it\\'s', b: 'a"b', c: 'x\\ty'}`)).toEqual({a: "it's", b: 'a"b', c: "x\ty"});
});

test("identifier followed by colon across comment is quoted", () => {
  expect(parseJsonish(`{a /* k */: 1}`)).toEqual({a: 1});
});

test("bare literals as values are not quoted", () => {
  expect(parseJsonish(`{a: true, b: false, c: null}`)).toEqual({a: true, b: false, c: null});
});

test("full JSON5 renovate config", () => {
  const text = `{
    // renovate
    extends: ['github>sxzz/renovate-config'],
    automerge: true,
    packageRules: [
      {
        matchManagers: ['github-actions'],
        enabled: false,
      },
    ],
  }`;
  expect(parseJsonish(text)).toEqual({
    extends: ["github>sxzz/renovate-config"],
    automerge: true,
    packageRules: [{matchManagers: ["github-actions"], enabled: false}],
  });
});

test("JSONC (mixed comments + trailing commas)", () => {
  const text = `{
    // a comment
    "minimumReleaseAge": "3 days",
    /* block
       comment */
    "ignoreDeps": [
      "foo",
      "bar",
    ],
  }`;
  expect(parseJsonish(text)).toEqual({minimumReleaseAge: "3 days", ignoreDeps: ["foo", "bar"]});
});
