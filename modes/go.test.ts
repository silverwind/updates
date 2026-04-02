import {
  resolveGoProxy,
  parseGoNoProxy,
  isGoNoProxy,
  encodeGoModulePath,
  extractGoMajor,
  buildGoModulePath,
  isGoPseudoVersion,
  parseGoMod,
  shortenGoModule,
  shortenGoVersion,
  removeGoReplace,
  getGoInfoUrl,
} from "./go.ts";

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
