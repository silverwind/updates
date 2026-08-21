import {mkdtempSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import rc, {parseIni, parseEnvVars} from "./rc.ts";

test("parseIni", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["basic", "key=value", {key: "value"}],
    ["multiple lines", "a=1\nb=2\nc=3", {a: "1", b: "2", c: "3"}],
    ["whitespace", "  key  =  value  ", {key: "value"}],
    ["comments", "# comment\n; comment\nkey=value", {key: "value"}],
    ["empty lines", "\n\nkey=value\n\n", {key: "value"}],
    ["line without equals", "noequals\nkey=value", {key: "value"}],
    ["equals in value", "key=a=b=c", {key: "a=b=c"}],
    ["double quotes", "key=\"value\"", {key: "value"}],
    ["single quotes", "key='value'", {key: "value"}],
    ["mismatched quotes", "key=\"value'", {key: "\"value'"}],
    ["single quote character", "key=\"", {key: "\""}],
    ["Windows lines", "a=1\r\nb=2\r\n", {a: "1", b: "2"}],
    ["JSON", "{\"key\": \"value\"}", {key: "value"}],
    ["empty", "", {}],
    ["only comments", "# comment\n; another", {}],
    ["scoped auth", [
      "@scope:registry=https://npm.test",
      "//registry.npmjs.org/:_authToken=\"npm_token123\"",
      "//npm.test/:_authToken=\"private_token456\"",
    ].join("\n"), {
      "@scope:registry": "https://npm.test",
      "//registry.npmjs.org/:_authToken": "npm_token123",
      "//npm.test/:_authToken": "private_token456",
    }],
    ["basic auth", "//npm.test/:username=user\n//npm.test/:_password=\"cGFzcw==\"", {
      "//npm.test/:username": "user", "//npm.test/:_password": "cGFzcw==",
    }],
    ["legacy auth", "_auth=\"dXNlcjpwYXNz\"", {_auth: "dXNlcjpwYXNz"}],
  ];
  for (const [, input, expected] of cases) expect(parseIni(input)).toEqual(expected);
});

test("project config is found from the supplied directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-rc-"));
  writeFileSync(join(dir, ".npmrc"), "registry=https://from-manifest-dir.test");
  expect(rc("npm", {registry: "https://default.test"}, dir).registry).toBe("https://from-manifest-dir.test");
  expect(rc("npm", {registry: "https://default.test"}).registry).not.toBe("https://from-manifest-dir.test");
});

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

test("parseEnvVars", () => {
  withEnv({testrc_option: "42"}, () => expect(parseEnvVars("testrc_")).toEqual({option: "42"}));
  withEnv({testrc2_someOpt__a: "42", testrc2_someOpt__z: "99"}, () => {
    expect(parseEnvVars("testrc2_")).toEqual({someOpt: {a: "42", z: "99"}});
  });
  withEnv({testrc3_a__b__c: "deep"}, () => expect(parseEnvVars("testrc3_").a.b.c).toBe("deep"));
  withEnv({TESTRC4_upperCase: "187"}, () => expect(parseEnvVars("testrc4_").upperCase).toBe("187"));
  withEnv({testrc5_opt__a: "42", testrc5_opt__a__b: "186"}, () => expect(parseEnvVars("testrc5_").opt.a).toBe("42"));
  withEnv({testrc6_w__w__: "18629"}, () => expect(parseEnvVars("testrc6_").w.w).toBe("18629"));
  withEnv({testrc7___z__i__: "9999"}, () => expect(parseEnvVars("testrc7_").z.i).toBe("9999"));
});
