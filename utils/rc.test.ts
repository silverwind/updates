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

// Each case uses its own prefix so the vars cannot collide across tests.
function withEnv(vars: Record<string, string>, fn: () => void) {
  const originals = Object.keys(vars).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("basic env var", () => {
  withEnv({testrc_option: "42"}, () => {
    expect(parseEnvVars("testrc_")).toEqual({option: "42"});
  });
});

test("nested env vars with __", () => {
  withEnv({testrc2_someOpt__a: "42", testrc2_someOpt__z: "99"}, () => {
    const result = parseEnvVars("testrc2_");
    expect(result.someOpt.a).toBe("42");
    expect(result.someOpt.z).toBe("99");
  });
});

test("deeply nested env vars", () => {
  withEnv({testrc3_a__b__c: "deep"}, () => {
    expect(parseEnvVars("testrc3_").a.b.c).toBe("deep");
  });
});

test("case-insensitive prefix matching", () => {
  withEnv({TESTRC4_upperCase: "187"}, () => {
    expect(parseEnvVars("testrc4_").upperCase).toBe("187");
  });
});

test("scalar value not overridden by deeper key", () => {
  withEnv({testrc5_opt__a: "42", testrc5_opt__a__b: "186"}, () => {
    // Once opt.a is set as scalar, opt.a.b cannot override it
    expect(parseEnvVars("testrc5_").opt.a).toBe("42");
  });
});

test("trailing __ segments are filtered", () => {
  withEnv({testrc6_w__w__: "18629"}, () => {
    expect(parseEnvVars("testrc6_").w.w).toBe("18629");
  });
});

test("leading __ segments are filtered", () => {
  withEnv({testrc7___z__i__: "9999"}, () => {
    expect(parseEnvVars("testrc7_").z.i).toBe("9999");
  });
});
