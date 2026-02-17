import {parseIni, parseEnvVars} from "./rc.ts";

// --- parseIni ---

test("basic key=value", () => {
  expect(parseIni("key=value")).toEqual({key: "value"});
});

test("multiple lines", () => {
  expect(parseIni("a=1\nb=2\nc=3")).toEqual({a: "1", b: "2", c: "3"});
});

test("whitespace around keys and values", () => {
  expect(parseIni("  key  =  value  ")).toEqual({key: "value"});
});

test("comments with # and ;", () => {
  expect(parseIni("# comment\n; comment\nkey=value")).toEqual({key: "value"});
});

test("empty lines are skipped", () => {
  expect(parseIni("\n\nkey=value\n\n")).toEqual({key: "value"});
});

test("lines without = are skipped", () => {
  expect(parseIni("noequals\nkey=value")).toEqual({key: "value"});
});

test("values with = in them", () => {
  expect(parseIni("key=a=b=c")).toEqual({key: "a=b=c"});
});

test("double-quoted values have quotes stripped", () => {
  expect(parseIni("key=\"value\"")).toEqual({key: "value"});
});

test("single-quoted values have quotes stripped", () => {
  expect(parseIni("key='value'")).toEqual({key: "value"});
});

test("mismatched quotes are preserved", () => {
  expect(parseIni("key=\"value'")).toEqual({key: "\"value'"});
});

test("single quote character is preserved", () => {
  expect(parseIni("key=\"")).toEqual({key: "\""});
});

test("npmrc registry-scoped auth tokens with quotes", () => {
  const content = [
    "@scope:registry=https://npm.test",
    "//registry.npmjs.org/:_authToken=\"npm_token123\"",
    "//npm.test/:_authToken=\"private_token456\"",
  ].join("\n");
  const result = parseIni(content);
  expect(result["@scope:registry"]).toBe("https://npm.test");
  expect(result["//registry.npmjs.org/:_authToken"]).toBe("npm_token123");
  expect(result["//npm.test/:_authToken"]).toBe("private_token456");
});

test("windows line endings", () => {
  expect(parseIni("a=1\r\nb=2\r\n")).toEqual({a: "1", b: "2"});
});

test("JSON content", () => {
  expect(parseIni("{\"key\": \"value\"}")).toEqual({key: "value"});
});

test("JSON and INI produce same result for simple object", () => {
  const obj = {hello: "true"};
  const json = parseIni(JSON.stringify(obj));
  const ini = parseIni("hello=true");
  expect(json).toEqual(ini);
});

test("empty string", () => {
  expect(parseIni("")).toEqual({});
});

test("only comments", () => {
  expect(parseIni("# comment\n; another")).toEqual({});
});

test("npmrc basic auth with quoted password", () => {
  const content = [
    "//npm.test/:username=user",
    "//npm.test/:_password=\"cGFzcw==\"",
  ].join("\n");
  const result = parseIni(content);
  expect(result["//npm.test/:username"]).toBe("user");
  expect(result["//npm.test/:_password"]).toBe("cGFzcw==");
});

test("npmrc legacy _auth", () => {
  const result = parseIni("_auth=\"dXNlcjpwYXNz\"");
  expect(result["_auth"]).toBe("dXNlcjpwYXNz");
});

// --- parseEnvVars ---

test("basic env var", () => {
  const original = process.env.testrc_option;
  process.env.testrc_option = "42";
  try {
    expect(parseEnvVars("testrc_")).toEqual({option: "42"});
  } finally {
    if (original === undefined) delete process.env.testrc_option;
    else process.env.testrc_option = original;
  }
});

test("nested env vars with __", () => {
  const keys = [
    "testrc2_someOpt__a",
    "testrc2_someOpt__z",
  ];
  const originals = keys.map(k => process.env[k]);
  process.env.testrc2_someOpt__a = "42";
  process.env.testrc2_someOpt__z = "99";
  try {
    const result = parseEnvVars("testrc2_");
    expect(result.someOpt.a).toBe("42");
    expect(result.someOpt.z).toBe("99");
  } finally {
    for (const [i, k] of keys.entries()) {
      if (originals[i] === undefined) delete process.env[k];
      else process.env[k] = originals[i];
    }
  }
});

test("deeply nested env vars", () => {
  const key = "testrc3_a__b__c";
  const original = process.env[key];
  process.env[key] = "deep";
  try {
    const result = parseEnvVars("testrc3_");
    expect(result.a.b.c).toBe("deep");
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("case-insensitive prefix matching", () => {
  const key = "TESTRC4_upperCase";
  const original = process.env[key];
  process.env[key] = "187";
  try {
    const result = parseEnvVars("testrc4_");
    expect(result.upperCase).toBe("187");
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("scalar value not overridden by deeper key", () => {
  const keys = ["testrc5_opt__a", "testrc5_opt__a__b"];
  const originals = keys.map(k => process.env[k]);
  process.env.testrc5_opt__a = "42";
  process.env.testrc5_opt__a__b = "186";
  try {
    const result = parseEnvVars("testrc5_");
    // Once opt.a is set as scalar, opt.a.b cannot override it
    expect(result.opt.a).toBe("42");
  } finally {
    for (const [i, k] of keys.entries()) {
      if (originals[i] === undefined) delete process.env[k];
      else process.env[k] = originals[i];
    }
  }
});

test("trailing __ segments are filtered", () => {
  const key = "testrc6_w__w__";
  const original = process.env[key];
  process.env[key] = "18629";
  try {
    const result = parseEnvVars("testrc6_");
    expect(result.w.w).toBe("18629");
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("leading __ segments are filtered", () => {
  const key = "testrc7___z__i__";
  const original = process.env[key];
  process.env[key] = "9999";
  try {
    const result = parseEnvVars("testrc7_");
    expect(result.z.i).toBe("9999");
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});
