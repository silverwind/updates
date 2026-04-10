import {resolve} from "node:path";
import {
  resolveGoProxy,
  parseGoNoProxy,
  isGoNoProxy,
  encodeGoModulePath,
  extractGoMajor,
  buildGoModulePath,
  isGoPseudoVersion,
  parseGoMod,
  parseGoWork,
  shortenGoModule,
  shortenGoVersion,
  removeGoReplace,
  getGoInfoUrl,
  updateGoMod,
  probeMajorVersions,
  rewriteGoImports,
} from "./go.ts";
import {fieldSep} from "./shared.ts";

test("resolveGoProxy", () => {
  const origProxy = process.env.GOPROXY;

  delete process.env.GOPROXY;
  expect(resolveGoProxy()).toBe("https://proxy.golang.org");

  process.env.GOPROXY = "https://custom.proxy";
  expect(resolveGoProxy()).toBe("https://custom.proxy");

  process.env.GOPROXY = "https://custom.proxy/";
  expect(resolveGoProxy()).toBe("https://custom.proxy");

  process.env.GOPROXY = "direct";
  expect(resolveGoProxy()).toBe("https://proxy.golang.org");

  process.env.GOPROXY = "off,https://backup.proxy";
  expect(resolveGoProxy()).toBe("https://backup.proxy");

  if (origProxy === undefined) delete process.env.GOPROXY;
  else process.env.GOPROXY = origProxy;
});

test("parseGoNoProxy", () => {
  const origNoProxy = process.env.GONOPROXY;
  const origPrivate = process.env.GOPRIVATE;

  delete process.env.GONOPROXY;
  delete process.env.GOPRIVATE;
  expect(parseGoNoProxy()).toEqual([]);

  process.env.GONOPROXY = "github.com/private";
  expect(parseGoNoProxy()).toEqual(["github.com/private"]);

  process.env.GONOPROXY = "a.com/x, b.com/y";
  expect(parseGoNoProxy()).toEqual(["a.com/x", "b.com/y"]);

  if (origNoProxy === undefined) delete process.env.GONOPROXY;
  else process.env.GONOPROXY = origNoProxy;
  if (origPrivate === undefined) delete process.env.GOPRIVATE;
  else process.env.GOPRIVATE = origPrivate;
});

test("isGoNoProxy", () => {
  expect(isGoNoProxy("github.com/private", ["github.com/private"])).toBe(true);
  expect(isGoNoProxy("github.com/private/sub", ["github.com/private"])).toBe(true);
  expect(isGoNoProxy("github.com/public", ["github.com/private"])).toBe(false);
  expect(isGoNoProxy("anything", [])).toBe(false);
});

test("encodeGoModulePath", () => {
  expect(encodeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
  expect(encodeGoModulePath("github.com/foo/bar")).toBe("github.com/foo/bar");
  expect(encodeGoModulePath("github.com/Azure/azure-sdk")).toBe("github.com/!azure/azure-sdk");
});

test("extractGoMajor", () => {
  expect(extractGoMajor("github.com/foo/bar")).toBe(1);
  expect(extractGoMajor("github.com/foo/bar/v2")).toBe(2);
  expect(extractGoMajor("github.com/foo/bar/v15")).toBe(15);
});

test("buildGoModulePath", () => {
  expect(buildGoModulePath("github.com/foo/bar/v2", 3)).toBe("github.com/foo/bar/v3");
  expect(buildGoModulePath("github.com/foo/bar/v2", 1)).toBe("github.com/foo/bar");
  expect(buildGoModulePath("github.com/foo/bar", 2)).toBe("github.com/foo/bar/v2");
  expect(buildGoModulePath("github.com/foo/bar", 1)).toBe("github.com/foo/bar");
});

test("isGoPseudoVersion", () => {
  expect(isGoPseudoVersion("v0.0.0-20221128193559-754e69321358")).toBe(true);
  expect(isGoPseudoVersion("v1.2.3")).toBe(false);
  expect(isGoPseudoVersion("v0.0.0-20221128193559")).toBe(false);
});

test("parseGoMod", () => {
  const content = [
    "module example.com/mymod",
    "",
    "go 1.21",
    "",
    "require (",
    "\tgithub.com/foo/bar v1.2.3",
    "\tgithub.com/baz/qux v0.5.0 // indirect",
    ")",
    "",
    "replace github.com/old/mod => github.com/new/mod v1.0.0",
    "",
    "tool github.com/foo/bar/cmd/tool",
  ].join("\n");

  const result = parseGoMod(content);
  expect(result.deps).toEqual({});
  expect(result.indirect).toEqual({"github.com/baz/qux": "v0.5.0"});
  expect(result.replace).toEqual({"github.com/new/mod": "v1.0.0"});
  expect(result.tool).toEqual({"github.com/foo/bar": "v1.2.3"});
});

test("parseGoMod single-line require", () => {
  const content = "module example.com/mod\n\nrequire foo v1.0.0\n";
  const result = parseGoMod(content);
  expect(result.deps).toEqual({"foo": "v1.0.0"});
});

test("parseGoMod replace block syntax", () => {
  const content = [
    "module example.com/mod",
    "",
    "require (",
    "\tgithub.com/orig/mod v1.0.0",
    ")",
    "",
    "replace (",
    "\tgithub.com/orig/mod => github.com/fork/mod v2.0.0",
    ")",
  ].join("\n");

  const result = parseGoMod(content);
  expect(result.deps).toEqual({});
  expect(result.replace).toEqual({"github.com/fork/mod": "v2.0.0"});
});

test("parseGoMod empty tool block", () => {
  const content = [
    "module example.com/mod",
    "",
    "require github.com/a/b v1.0.0",
    "",
    "tool (",
    ")",
  ].join("\n");

  const result = parseGoMod(content);
  expect(result.deps).toEqual({"github.com/a/b": "v1.0.0"});
  expect(result.tool).toEqual({});
});

test("shortenGoModule", () => {
  expect(shortenGoModule("github.com/foo/bar/v2")).toBe("github.com/foo/bar");
  expect(shortenGoModule("github.com/foo/bar")).toBe("github.com/foo/bar");
});

test("shortenGoVersion", () => {
  expect(shortenGoVersion("v0.0.0-20221128193559-754e69321358")).toBe("v0.0.0-2022112");
  expect(shortenGoVersion("v1.2.3")).toBe("v1.2.3");
});

test("removeGoReplace single-line", () => {
  const content = "module example.com/mod\n\nreplace github.com/old => github.com/new v1.0.0\n\nrequire foo v1.0.0\n";
  const result = removeGoReplace(content, "github.com/old");
  expect(result).toBe("module example.com/mod\n\nrequire foo v1.0.0\n");
});

test("removeGoReplace block entry", () => {
  const content = "replace (\n\tgithub.com/old => github.com/new v1.0.0\n)\n";
  const result = removeGoReplace(content, "github.com/old");
  expect(result).toBe("");
});

test("removeGoReplace empty block cleanup", () => {
  const content = "replace (\n)\n";
  const result = removeGoReplace(content, "github.com/anything");
  expect(result).toBe("");
});

test("getGoInfoUrl", () => {
  expect(getGoInfoUrl("github.com/foo/bar")).toBe("https://github.com/foo/bar");
  expect(getGoInfoUrl("github.com/foo/bar/v2")).toBe("https://github.com/foo/bar");
  expect(getGoInfoUrl("github.com/foo/bar/pkg/sub")).toBe("https://github.com/foo/bar/tree/HEAD/pkg/sub");
});

// updateGoMod
test("updateGoMod simple version bump", () => {
  const content = "module example.com/mod\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n";
  const deps = {[`deps${fieldSep}github.com/foo/bar`]: {old: "1.0.0", new: "1.1.0"}};
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toContain("github.com/foo/bar v1.1.0");
  expect(result).not.toContain("v1.0.0");
  expect(rewrites).toEqual({});
});

test("updateGoMod indirect dep bump", () => {
  const content = "module example.com/mod\n\nrequire (\n\tgithub.com/foo/bar v1.0.0 // indirect\n)\n";
  const deps = {[`indirect${fieldSep}github.com/foo/bar`]: {old: "1.0.0", new: "1.2.0"}};
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toContain("github.com/foo/bar v1.2.0");
  expect(rewrites).toEqual({});
});

test("updateGoMod replace dep bump", () => {
  const content = "module example.com/mod\n\nrequire (\n\tgithub.com/orig/mod v1.0.0\n)\n\nreplace github.com/orig/mod => github.com/new/mod v1.0.0\n";
  const deps = {[`replace${fieldSep}github.com/new/mod`]: {old: "1.0.0", new: "1.5.0"}};
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toContain("=> github.com/new/mod v1.5.0");
  expect(result).not.toContain("=> github.com/new/mod v1.0.0");
  expect(rewrites).toEqual({});
});

test("updateGoMod major version rewrite", () => {
  const content = "module example.com/mod\n\nrequire (\n\tgithub.com/foo/bar/v2 v2.1.0\n)\n";
  const deps = {[`deps${fieldSep}github.com/foo/bar/v2`]: {old: "2.1.0", new: "3.0.0"}};
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toContain("github.com/foo/bar/v3 v3.0.0");
  expect(result).not.toContain("/v2");
  expect(rewrites).toEqual({"github.com/foo/bar/v2": "github.com/foo/bar/v3"});
});

test("updateGoMod tool major version rewrite", () => {
  const content = [
    "module example.com/mod",
    "",
    "require (",
    "\tgithub.com/foo/bar/v2 v2.1.0",
    ")",
    "",
    "tool (",
    "\tgithub.com/foo/bar/v2/cmd/mytool",
    ")",
  ].join("\n");
  const deps = {[`tool${fieldSep}github.com/foo/bar/v2`]: {old: "2.1.0", new: "3.0.0"}};
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toContain("github.com/foo/bar/v3 v3.0.0");
  expect(result).toContain("github.com/foo/bar/v3/cmd/mytool");
  expect(result).not.toContain("/v2");
  expect(rewrites).toEqual({"github.com/foo/bar/v2": "github.com/foo/bar/v3"});
});

// probeMajorVersions
function makeProbe(existing: Set<number>) {
  return (major: number) => Promise.resolve(
    existing.has(major) ? {Version: `v${major}.0.0`, Time: "", path: `mod/v${major}`} : null,
  );
}

test("probeMajorVersions returns null when firstProbe is null", async () => {
  expect(await probeMajorVersions(1, null, makeProbe(new Set([99])))).toBeNull();
});

test("probeMajorVersions returns firstProbe when no higher versions exist", async () => {
  const firstProbe = {Version: "v2.0.0", Time: "2024-01-01", path: "mod/v2"};
  expect(await probeMajorVersions(1, firstProbe, makeProbe(new Set()))).toEqual(firstProbe);
});

test("probeMajorVersions finds highest major version", async () => {
  const firstProbe = {Version: "v2.0.0", Time: "", path: "mod/v2"};
  const result = await probeMajorVersions(1, firstProbe, makeProbe(new Set([2, 3, 4, 5])));
  expect(result).toEqual({Version: "v5.0.0", Time: "", path: "mod/v5"});
});

test("probeMajorVersions finds correct version with large gap", async () => {
  const existing = new Set(Array.from({length: 19}, (_, idx) => idx + 2));
  const firstProbe = {Version: "v2.0.0", Time: "", path: "mod/v2"};
  const result = await probeMajorVersions(1, firstProbe, makeProbe(existing));
  expect(result).toEqual({Version: "v20.0.0", Time: "", path: "mod/v20"});
});

test("probeMajorVersions stops at first gap in exponential search", async () => {
  // v2 exists but v3 does not — exponential search hits v3 first and stops
  const firstProbe = {Version: "v2.0.0", Time: "", path: "mod/v2"};
  const result = await probeMajorVersions(1, firstProbe, makeProbe(new Set([2, 4])));
  expect(result).toEqual(firstProbe);
});

// parseGoWork
test("parseGoWork block use", () => {
  const content = [
    "go 1.24",
    "",
    "use (",
    "\t./app",
    "\t./lib",
    ")",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./app", "./lib"]);
  expect(result.replace).toEqual({});
});

test("parseGoWork single-line use", () => {
  const content = "go 1.24\n\nuse ./mymod\n";
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./mymod"]);
});

test("parseGoWork with replace", () => {
  const content = [
    "go 1.24",
    "",
    "use ./app",
    "",
    "replace github.com/old/mod => github.com/new/mod v1.0.0",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./app"]);
  expect(result.replace).toEqual({"github.com/new/mod": "v1.0.0"});
});

test("parseGoWork skips local path replace", () => {
  const content = [
    "go 1.24",
    "",
    "use (",
    "\t./app",
    "\t./lib",
    ")",
    "",
    "replace github.com/foo/bar => ../local/bar",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./app", "./lib"]);
  expect(result.replace).toEqual({});
});

test("parseGoWork use with inline comment", () => {
  const content = [
    "go 1.24",
    "",
    "use (",
    "\t./app // main application",
    "\t./lib",
    ")",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./app", "./lib"]);
});

test("parseGoWork with toolchain ignored", () => {
  const content = [
    "go 1.24",
    "toolchain go1.24.2",
    "",
    "use ./app",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.use).toEqual(["./app"]);
});

test("parseGoWork replace block syntax", () => {
  const content = [
    "go 1.24",
    "",
    "use ./app",
    "",
    "replace (",
    "\tgithub.com/old/a => github.com/new/a v1.0.0",
    "\tgithub.com/old/b v1.2.0 => github.com/new/b v2.0.0",
    ")",
  ].join("\n");
  const result = parseGoWork(content);
  expect(result.replace).toEqual({
    "github.com/new/a": "v1.0.0",
    "github.com/new/b": "v2.0.0",
  });
});

// rewriteGoImports
test("rewriteGoImports empty map does nothing", () => {
  rewriteGoImports(resolve("fixtures/go"), {}, () => { throw new Error("unexpected write"); });
});

test("rewriteGoImports no .go files does nothing", () => {
  rewriteGoImports(resolve("fixtures/cargo"), {"github.com/old": "github.com/new"}, () => { throw new Error("unexpected write"); });
});

test("rewriteGoImports rewrites matching imports", () => {
  let written = "";
  rewriteGoImports(resolve("fixtures/go"), {"github.com/google/uuid": "github.com/google/uuid/v2"}, (_, content) => { written = content; });
  expect(written).toContain(`"github.com/google/uuid/v2"`);
  expect(written).not.toContain(`"github.com/google/uuid"`);
});
