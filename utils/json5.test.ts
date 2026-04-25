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
