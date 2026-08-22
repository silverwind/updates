import {test, expect} from "vitest";
import {parseJsonish} from "./json5.ts";

test.each([
  ["plain JSON", `{"a":1,"b":[2,3]}`, {a: 1, b: [2, 3]}],
  ["comments and trailing commas", `{ // line
    a: [1, 2,], /* block */ b: 3,
  }`, {a: [1, 2], b: 3}],
  ["single-quoted strings", `{'a': 'it\\'s', b: 'a"b'}`, {a: "it's", b: 'a"b'}],
  ["bare literals", `{enabled: true, disabled: false, value: null}`, {enabled: true, disabled: false, value: null}],
  ["comment-like strings", `{"line": "// text", "block": "/* text */"}`,
    {line: "// text", block: "/* text */"}],
])("parseJsonish parses %s", (_name, input, expected) => {
  expect(parseJsonish(input)).toEqual(expected);
});

test.each(["[1/* comment */2]", "1// comment\n2"])("parseJsonish rejects adjacent values in %s", input => {
  expect(() => parseJsonish(input)).toThrow();
});
