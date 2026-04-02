import {isJsr, isLocalDep, parseJsrDependency, updateNpmRange, normalizeRange, updatePackageJson} from "./npm.ts";
import {fieldSep} from "./shared.ts";

test("isJsr", () => {
  expect(isJsr("npm:@jsr/std__semver@1.0.5")).toBe(true);
  expect(isJsr("jsr:@std/semver@1.0.5")).toBe(true);
  expect(isJsr("jsr:1.0.5")).toBe(true);
  expect(isJsr("^1.0.0")).toBe(false);
  expect(isJsr("npm:something")).toBe(false);
  expect(isJsr("")).toBe(false);
});

test("isLocalDep", () => {
  expect(isLocalDep("link:../foo")).toBe(true);
  expect(isLocalDep("file:./bar")).toBe(true);
  expect(isLocalDep("^1.0.0")).toBe(false);
  expect(isLocalDep("")).toBe(false);
});

test("parseJsrDependency", () => {
  expect(parseJsrDependency("npm:@jsr/std__semver@1.0.5")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:@std/semver@1.0.5")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:1.0.5", "@std/semver")).toEqual({scope: "std", name: "semver", version: "1.0.5"});
  expect(parseJsrDependency("jsr:1.0.5")).toEqual({scope: null, name: null, version: ""});
  expect(parseJsrDependency("^1.0.0")).toEqual({scope: null, name: null, version: ""});
  expect(parseJsrDependency("jsr:1.0.5", "noscope")).toEqual({scope: null, name: null, version: ""});
});

test("updateNpmRange", () => {
  expect(updateNpmRange("^1.0.0", "2.0.0", undefined)).toBe("^2.0.0");
  expect(updateNpmRange("~1.0.0", "1.1.0", undefined)).toBe("~1.1.0");
  expect(updateNpmRange(">=1.0.0", "2.0.0", undefined)).toBe(">=2.0.0");
  expect(updateNpmRange("^5.0.0", "6.0.0", "^5")).toBe("^6");
  expect(updateNpmRange("~5.0.0", "6.0.0", "~5")).toBe("~6");
  expect(updateNpmRange(">=5.0.0", "6.0.0", ">= 5")).toBe(">= 6");
  expect(updateNpmRange(">=5.0.0", "6.0.0", ">=5")).toBe(">=6");
  expect(updateNpmRange("^5.9.0", "6.1.0", "^5.9")).toBe("^6.1");
  expect(updateNpmRange("^1.2.3", "1.3.0", undefined)).toBe("^1.3.0");
  expect(updateNpmRange("^1.0.0-alpha.1", "1.0.0-beta.2", undefined)).toBe("^1.0.0-beta.2");
});

test("normalizeRange", () => {
  expect(normalizeRange("^5")).toBe("^5.0.0");
  expect(normalizeRange("^5.9")).toBe("^5.9.0");
  expect(normalizeRange("^5.9.3")).toBe("^5.9.3");
  expect(normalizeRange(">=1.0.0 <2.0.0")).toBe(">=1.0.0 <2.0.0");
});

test("updatePackageJson", () => {
  const pkg = JSON.stringify({
    dependencies: {"foo": "^1.0.0"},
    packageManager: "pnpm@8.0.0",
  }, null, 2);

  const depsKey = `dependencies${fieldSep}foo`;
  const pmKey = `packageManager${fieldSep}pnpm`;

  const result1 = updatePackageJson(pkg, {
    [depsKey]: {old: "^1.0.0", new: "^2.0.0"} as any,
  });
  expect(result1).toContain(`"foo": "^2.0.0"`);

  const result2 = updatePackageJson(pkg, {
    [pmKey]: {old: "8.0.0", new: "9.0.0"} as any,
  });
  expect(result2).toContain(`"packageManager": "pnpm@9.0.0"`);
});
