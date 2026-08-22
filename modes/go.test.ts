import {resolve} from "node:path";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {
  type GoProxyEntry,
  parseGoProxy,
  resolveGoProxyChain,
  pickGoListVersion,
  parseGoNoProxy,
  isGoNoProxy,
  encodeGoModulePath,
  extractGoMajor,
  buildGoModulePath,
  goModulePathForVersion,
  parseGoMod,
  parseGoWork,
  resolveGoWorkModule,
  shortenGoModule,
  shortenGoVersion,
  getGoInfoUrl,
  updateGoMod,
  fetchGoProxyInfo,
  rewriteGoImportPaths,
  rewriteGoImports,
} from "./go.ts";
import {type ModeContext, fieldSep, isGoPseudoVersion} from "./shared.ts";

async function withGoProxyEnv(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const orig = process.env.GOPROXY;
  if (value === undefined) delete process.env.GOPROXY;
  else process.env.GOPROXY = value;
  try {
    await fn();
  } finally {
    if (orig === undefined) delete process.env.GOPROXY;
    else process.env.GOPROXY = orig;
  }
}

test("parseGoProxy", () => {
  expect(parseGoProxy("https://a,https://b|https://c")).toEqual([
    {url: "https://a", fallback: ","},
    {url: "https://b", fallback: "|"},
    {url: "https://c", fallback: ","},
  ]);
  expect(parseGoProxy(" https://a/ , direct ")).toEqual([{url: "https://a", fallback: ","}, {url: "direct", fallback: ","}]);
  expect(parseGoProxy("off,https://a")).toEqual([{url: "off", fallback: ","}]);
  expect(parseGoProxy("direct,https://a")).toEqual([{url: "direct", fallback: ","}]);
  expect(parseGoProxy("")).toEqual([]);
  expect(parseGoProxy(",,")).toEqual([]);
  expect(parseGoProxy("proxy.corp/mod")).toEqual([{url: "https://proxy.corp/mod", fallback: ","}]);
});

test("resolveGoProxyChain", async () => {
  await withGoProxyEnv("https://a,https://b", () => {
    expect(resolveGoProxyChain()).toEqual([{url: "https://a", fallback: ","}, {url: "https://b", fallback: ","}]);
    expect(resolveGoProxyChain("http://127.0.0.1:1/")).toEqual([{url: "http://127.0.0.1:1", fallback: ","}]);
  });
  await withGoProxyEnv(",,", () => expect(() => resolveGoProxyChain()).toThrow(/contains no entries/));
  await withGoProxyEnv(undefined, () => expect(resolveGoProxyChain()[0].url).toBe("https://proxy.golang.org"));
  await withGoProxyEnv("direct", () => expect(resolveGoProxyChain()[0].url).toBe("direct"));
  await withGoProxyEnv("off,https://backup.proxy", () => expect(resolveGoProxyChain()[0].url).toBe("off"));
});

test("pickGoListVersion", () => {
  expect(pickGoListVersion("v1.0.0\nv1.2.0\nv1.1.0\n")).toEqual({Version: "v1.2.0", Time: ""});
  expect(pickGoListVersion("v1.0.0 2019-10-16T16:15:28Z\n")).toEqual({Version: "v1.0.0", Time: "2019-10-16T16:15:28Z"});
  expect(pickGoListVersion("v1.3.0-rc.1\nv1.2.0\n")).toEqual({Version: "v1.2.0", Time: ""});
  expect(pickGoListVersion("v0.0.0-20221128193559-754e69321358\nv0.1.0")).toEqual({Version: "v0.1.0", Time: ""});
  expect(pickGoListVersion("v1.3.0-rc.1\nv1.3.0-rc.2\n")).toEqual({Version: "v1.3.0-rc.2", Time: ""});
  expect(pickGoListVersion("\n\ngarbage\n")).toBeNull();
  expect(pickGoListVersion("v1.0.0\nv2.1.0\nv3.0.0\n", 2)).toEqual({Version: "v2.1.0", Time: ""});
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
  expect(isGoNoProxy("github.com/mycorp/secret", ["github.com/mycorp/*"])).toBe(true);
  expect(isGoNoProxy("github.com/mycorp/secret/sub", ["github.com/mycorp/*"])).toBe(true);
  expect(isGoNoProxy("git.corp.example.com/a/b", ["*.corp.example.com"])).toBe(true);
  expect(isGoNoProxy("github.com/other/x", ["github.com/mycorp/*"])).toBe(false);
});

test("encodeGoModulePath", () => {
  expect(encodeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
  expect(encodeGoModulePath("github.com/foo/bar")).toBe("github.com/foo/bar");
  expect(encodeGoModulePath("github.com/Azure/azure-sdk")).toBe("github.com/!azure/azure-sdk");
});

test("Go module path transforms", () => {
  expect(extractGoMajor("github.com/foo/bar")).toBe(1);
  expect(extractGoMajor("github.com/foo/bar/v2")).toBe(2);
  expect(extractGoMajor("github.com/foo/bar/v15")).toBe(15);
  expect(extractGoMajor("gopkg.in/yaml.v2")).toBe(2);
  expect(buildGoModulePath("github.com/foo/bar/v2", 3)).toBe("github.com/foo/bar/v3");
  expect(buildGoModulePath("github.com/foo/bar/v2", 1)).toBe("github.com/foo/bar");
  expect(buildGoModulePath("github.com/foo/bar", 2)).toBe("github.com/foo/bar/v2");
  expect(buildGoModulePath("github.com/foo/bar", 1)).toBe("github.com/foo/bar");
  expect(buildGoModulePath("gopkg.in/yaml.v2", 3)).toBe("gopkg.in/yaml.v3");
  expect(buildGoModulePath("gopkg.in/yaml.v2", 1)).toBe("gopkg.in/yaml.v1");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "3.0.0")).toBe("github.com/foo/bar/v3");
  expect(goModulePathForVersion("github.com/foo/bar", "2.1.0")).toBe("github.com/foo/bar/v2");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "2.5.0")).toBe("github.com/foo/bar/v2");
  expect(goModulePathForVersion("github.com/foo/bar", "1.4.0")).toBe("github.com/foo/bar");
  expect(goModulePathForVersion("github.com/foo/bar", "3.0.0+incompatible")).toBe("github.com/foo/bar");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "garbage")).toBe("github.com/foo/bar/v2");
  expect(goModulePathForVersion("gopkg.in/yaml.v2", "3.0.1")).toBe("gopkg.in/yaml.v3");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "1.5.0")).toBe("github.com/foo/bar");
});

test("isGoPseudoVersion", () => {
  expect(isGoPseudoVersion("v0.0.0-20221128193559-754e69321358")).toBe(true);
  expect(isGoPseudoVersion("v1.2.3")).toBe(false);
  expect(isGoPseudoVersion("v0.0.0-20221128193559")).toBe(false);
});

test.each([
  ["sorts requires, indirects, replaces and tools",
    ["module example.com/mymod", "", "require (", "\tgithub.com/foo/bar v1.2.3",
      "\tgithub.com/baz/qux v0.5.0 // indirect", ")", "",
      "replace github.com/old/mod => github.com/new/mod v1.0.0", "", "exclude (", "\tgithub.com/foo/bar v1.3.0",
      "\tgithub.com/foo/bar v1.4.0", ")", "", "tool (", "\tgithub.com/foo/bar/cmd/tool // build tool", ")"],
    {deps: {}, indirect: {"github.com/baz/qux": "v0.5.0"}, replace: {"github.com/new/mod": "v1.0.0"},
      tool: {"github.com/foo/bar": "v1.2.3"}, exclude: {"github.com/foo/bar": ["v1.3.0", "v1.4.0"]}}],
  ["a single-line require", ["module example.com/mod", "", "require foo v1.0.0"],
    {deps: {"foo": "v1.0.0"}, indirect: {}, replace: {}, tool: {}}],
  ["replace block syntax",
    ["module example.com/mod", "", "require (", "\tgithub.com/orig/mod v1.0.0", ")", "",
      "replace (", "\tgithub.com/orig/mod => github.com/fork/mod v2.0.0", ")"],
    {deps: {}, indirect: {}, replace: {"github.com/fork/mod": "v2.0.0"}, tool: {}}],
  ["a local replace, which takes its require out of play",
    ["module example.com/mod", "", "require github.com/foo/bar v1.2.3", "", "replace github.com/foo/bar => ../local/bar"],
    {deps: {}, indirect: {}, replace: {}, tool: {}}],
  ["a version-specific replace, which leaves its require updatable",
    ["module example.com/mod", "", "require github.com/foo/bar v1.2.3", "",
      "replace github.com/foo/bar v1.0.0 => github.com/fork/bar v1.0.1"],
    {deps: {"github.com/foo/bar": "v1.2.3"}, indirect: {}, replace: {"github.com/fork/bar": "v1.0.1"}, tool: {}}],
  ["quoted module paths",
    ["module example.com/mod", "", "require (", `\t"gopkg.in/src-d/go-billy.v4" v4.2.0`, ")", "",
      `replace "github.com/old/mod" => "github.com/new/mod" v1.0.0`],
    {deps: {"gopkg.in/src-d/go-billy.v4": "v4.2.0"}, indirect: {}, replace: {"github.com/new/mod": "v1.0.0"}, tool: {}}],
  ["an empty tool block",
    ["module example.com/mod", "", "require github.com/a/b v1.0.0", "", "tool (", ")"],
    {deps: {"github.com/a/b": "v1.0.0"}, indirect: {}, replace: {}, tool: {}}],
])("parseGoMod %s", (_name, lines, expected) => {
  expect(parseGoMod(lines.join("\n"))).toEqual(expected);
});

test("Go display transforms", () => {
  expect(shortenGoModule("github.com/foo/bar/v2")).toBe("github.com/foo/bar");
  expect(shortenGoModule("github.com/foo/bar/v10")).toBe("github.com/foo/bar");
  expect(shortenGoModule("github.com/foo/bar")).toBe("github.com/foo/bar");
  expect(shortenGoVersion("v0.0.0-20221128193559-754e69321358")).toBe("v0.0.0-2022112");
  expect(shortenGoVersion("v1.2.3")).toBe("v1.2.3");
  expect(getGoInfoUrl("github.com/foo/bar")).toBe("https://github.com/foo/bar");
  expect(getGoInfoUrl("github.com/foo/bar/v2")).toBe("https://github.com/foo/bar");
  expect(getGoInfoUrl("github.com/foo/bar/pkg/sub")).toBe("https://github.com/foo/bar/tree/HEAD/pkg/sub");
});

const goMod = (...lines: Array<string>) => `module example.com/mod\n\n${lines.join("\n")}\n`;

test.each([
  ["a simple version bump",
    goMod("require (", "\tgithub.com/foo/bar v1.0.0", ")"),
    {[`deps${fieldSep}github.com/foo/bar`]: {old: "1.0.0", new: "1.1.0"}},
    goMod("require (", "\tgithub.com/foo/bar v1.1.0", ")"), {}],
  ["an indirect dep bump",
    goMod("require (", "\tgithub.com/foo/bar v1.0.0 // indirect", ")"),
    {[`indirect${fieldSep}github.com/foo/bar`]: {old: "1.0.0", new: "1.2.0"}},
    goMod("require (", "\tgithub.com/foo/bar v1.2.0 // indirect", ")"), {}],
  ["an indirect dep major bump",
    goMod("require github.com/foo/bar v1.0.0 // indirect"),
    {[`indirect${fieldSep}github.com/foo/bar`]: {old: "1.0.0", new: "2.0.0"}},
    goMod("require github.com/foo/bar/v2 v2.0.0 // indirect"),
    {"github.com/foo/bar": "github.com/foo/bar/v2"}],
  ["a replace dep bump",
    goMod("require (", "\tgithub.com/orig/mod v1.0.0", ")", "", "replace github.com/orig/mod => github.com/new/mod v1.0.0"),
    {[`replace${fieldSep}github.com/new/mod`]: {old: "1.0.0", new: "1.5.0"}},
    goMod("require (", "\tgithub.com/orig/mod v1.0.0", ")", "", "replace github.com/orig/mod => github.com/new/mod v1.5.0"), {}],
  ["a require whose module also carries a version-specific replace",
    goMod("require github.com/foo/bar v1.2.3", "", "replace github.com/foo/bar v1.0.0 => github.com/fork/bar v1.0.1"),
    {[`deps${fieldSep}github.com/foo/bar`]: {old: "1.2.3", new: "1.3.0"}},
    goMod("require github.com/foo/bar v1.3.0", "", "replace github.com/foo/bar v1.0.0 => github.com/fork/bar v1.0.1"), {}],
  ["a quoted module path",
    goMod("require (", `\t"gopkg.in/src-d/go-billy.v4" v4.2.0`, ")"),
    {[`deps${fieldSep}gopkg.in/src-d/go-billy.v4`]: {old: "4.2.0", new: "5.0.0"}},
    goMod("require (", `\t"gopkg.in/src-d/go-billy.v5" v5.0.0`, ")"),
    {"gopkg.in/src-d/go-billy.v4": "gopkg.in/src-d/go-billy.v5"}],
  ["a quoted replace target",
    goMod(`replace "github.com/old/mod" => "github.com/new/mod" v1.0.0`),
    {[`replace${fieldSep}github.com/new/mod`]: {old: "1.0.0", new: "1.5.0"}},
    goMod(`replace "github.com/old/mod" => "github.com/new/mod" v1.5.0`), {}],
  ["both sides of a self-replace across a major",
    goMod("replace (", "\tgithub.com/grpc-ecosystem/grpc-gateway => github.com/grpc-ecosystem/grpc-gateway v1.16.0", ")", ""),
    {[`replace${fieldSep}github.com/grpc-ecosystem/grpc-gateway`]: {old: "1.16.0", new: "2.28.0"}},
    goMod("replace (", "\tgithub.com/grpc-ecosystem/grpc-gateway/v2 => github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0", ")", ""), {}],
  ["the require a self-replace across a major applies to",
    goMod("require github.com/grpc-ecosystem/grpc-gateway v1.16.0", "",
      "replace github.com/grpc-ecosystem/grpc-gateway => github.com/grpc-ecosystem/grpc-gateway v1.16.0"),
    {[`replace${fieldSep}github.com/grpc-ecosystem/grpc-gateway`]: {old: "1.16.0", new: "2.28.0"}},
    goMod("require github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0", "",
      "replace github.com/grpc-ecosystem/grpc-gateway/v2 => github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0"),
    {"github.com/grpc-ecosystem/grpc-gateway": "github.com/grpc-ecosystem/grpc-gateway/v2"}],
  ["only the target of a replace whose left-hand module differs",
    goMod("replace github.com/old/mod => github.com/new/mod v1.0.0"),
    {[`replace${fieldSep}github.com/new/mod`]: {old: "1.0.0", new: "2.0.0"}},
    goMod("replace github.com/old/mod => github.com/new/mod/v2 v2.0.0"), {}],
  ["a major version, path included",
    goMod("require (", "\tgithub.com/foo/bar/v2 v2.1.0", ")"),
    {[`deps${fieldSep}github.com/foo/bar/v2`]: {old: "2.1.0", new: "3.0.0"}},
    goMod("require (", "\tgithub.com/foo/bar/v3 v3.0.0", ")"),
    {"github.com/foo/bar/v2": "github.com/foo/bar/v3"}],
  ["a pseudo-version to a release, anchored on oldOrig",
    goMod("require github.com/foo/bar v0.0.0-20221128193559-754e69321358 // indirect"),
    {[`indirect${fieldSep}github.com/foo/bar`]: {old: "v0.0.0-2022112", oldOrig: "0.0.0-20221128193559-754e69321358", new: "1.2.3"}},
    goMod("require github.com/foo/bar v1.2.3 // indirect"), {}],
  ["a tool's major, in the require and the tool block alike",
    goMod("require (", "\tgithub.com/foo/bar/v2 v2.1.0", ")", "", "tool (", "\tgithub.com/foo/bar/v2/cmd/mytool // tool", ")"),
    {[`tool${fieldSep}github.com/foo/bar/v2`]: {old: "2.1.0", new: "3.0.0"}},
    goMod("require (", "\tgithub.com/foo/bar/v3 v3.0.0", ")", "", "tool (", "\tgithub.com/foo/bar/v3/cmd/mytool // tool", ")"),
    {"github.com/foo/bar/v2": "github.com/foo/bar/v3"}],
  ["only the matching require directive",
    goMod("require foo v1.0.0", "exclude foo v1.0.0", "replace other => foo v1.0.0"),
    {[`deps${fieldSep}foo`]: {old: "1.0.0", new: "1.1.0"}},
    goMod("require foo v1.1.0", "exclude foo v1.0.0", "replace other => foo v1.0.0"), {}],
  ["a directive in a file with mixed line endings",
    "module x\n\nrequire example.com/dep v1.0.0\r\n",
    {[`deps${fieldSep}example.com/dep`]: {old: "1.0.0", new: "1.1.0"}},
    "module x\n\nrequire example.com/dep v1.1.0\r\n", {}],
])("updateGoMod rewrites %s", (_name, content, deps, expected, expectedRewrites) => {
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toBe(expected);
  expect(rewrites).toEqual(expectedRewrites);
});

const goProxyBase = "https://proxy";

function makeGoCtx(routes: Record<string, string | number>, seen: Array<string> = [], goProxyChain: Array<GoProxyEntry> = [{url: goProxyBase, fallback: ","}]): ModeContext {
  return {
    fetchTimeout: 100,
    goProbeTimeout: 100,
    goProxyUrl: goProxyChain[0].url,
    goProxyChain,
    doFetch: (url: string) => {
      seen.push(url);
      const route = routes[url] ?? 404;
      const status = typeof route === "number" ? route : 200;
      const body = typeof route === "string" ? route : "";
      return Promise.resolve({
        ok: status < 400,
        status,
        statusText: `status ${status}`,
        json: () => Promise.resolve(JSON.parse(body)),
        text: () => Promise.resolve(body),
      } as unknown as Response);
    },
  } as unknown as ModeContext;
}

const modPath = "github.com/foo/bar";
const infoFor = (ctx: ModeContext, cwd = ".") => fetchGoProxyInfo(modPath, "deps", "1.0.0", cwd, ctx, []);

test("fetchGoProxyInfo falls back to @v/list when the proxy omits @latest", async () => {
  const seen: Array<string> = [];
  const ctx = makeGoCtx({
    [`${goProxyBase}/${modPath}/@v/list`]: "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n",
    [`${goProxyBase}/${modPath}/@v/v1.2.0.info`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
  }, seen);
  const [[data], [sameData]] = await Promise.all([infoFor(ctx), infoFor(ctx)]);
  expect(data).toMatchObject({name: modPath, old: "1.0.0", new: "1.2.0", Time: "2024-01-01T00:00:00Z"});
  expect(sameData).toEqual(data);
  expect(seen).toContain(`${goProxyBase}/${modPath}/v2/@v/list`);
  expect(new Set(seen).size).toBe(seen.length);
});

test("primary and probe Go lookups keep their retry semantics separate", async () => {
  const seen: Array<string> = [];
  const ctx = makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""}),
    [`${goProxyBase}/${modPath}/v2/@latest`]: 500,
  }, seen);
  const [root, major] = await Promise.allSettled([
    infoFor(ctx),
    fetchGoProxyInfo(`${modPath}/v2`, "deps", "2.0.0", ".", ctx, []),
  ]);
  expect(root.status).toBe("fulfilled");
  expect(major).toMatchObject({status: "rejected", reason: expect.any(Error)});
  expect(seen.filter(url => url === `${goProxyBase}/${modPath}/v2/@latest`)).toHaveLength(4);
});

test("fetchGoProxyInfo stops major probing at the first absent major", async () => {
  const seen: Array<string> = [];
  const [data] = await infoFor(makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
  }, seen));
  expect(data.new).toBe("1.2.0");
  expect(seen).toHaveLength(2);
  expect(seen).toContain(`${goProxyBase}/${modPath}/@latest`);
  expect(seen).toContain(`${goProxyBase}/${modPath}/v2/@latest`);
  expect(seen.some(url => url.endsWith("/@v/list"))).toBe(false);
});

test.each([
  ["indirect", "1.0.0"],
  ["deps", "v0.0.0-20221128193559-754e69321358"],
])("fetchGoProxyInfo probes major versions for %s dependencies", async (type, currentVersion) => {
  const seen: Array<string> = [];
  const ctx = makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""}),
    [`${goProxyBase}/${modPath}/v2/@latest`]: JSON.stringify({Version: "v2.0.0", Time: ""}),
  }, seen);
  const [data] = await fetchGoProxyInfo(modPath, type, currentVersion, ".", ctx, []);
  expect(data).toMatchObject({new: "2.0.0", newPath: `${modPath}/v2`});
});

test("fetchGoProxyInfo rejects an excluded latest version from root and workspace member manifests", async () => {
  const projectDir = mkdtempSync(resolve(tmpdir(), "updates-go-"));
  try {
    mkdirSync(resolve(projectDir, "app"));
    for (const [type, memberPath] of [["deps", ""], ["deps|./app", "app"]]) {
      writeFileSync(resolve(projectDir, memberPath, "go.mod"), goMod(`exclude ${modPath} v1.3.0`));
      const [data] = await fetchGoProxyInfo(modPath, type, "1.0.0", projectDir, makeGoCtx({
        [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.3.0", Time: ""}),
        [`${goProxyBase}/${modPath}/@v/list`]: "v1.1.0\nv1.2.0\nv1.3.0\n",
        [`${goProxyBase}/${modPath}/@v/v1.2.0.info`]: JSON.stringify({Version: "v1.2.0", Time: ""}),
      }), []);
      expect(data.new).toBe("1.2.0");
    }
  } finally {
    rmSync(projectDir, {recursive: true});
  }
});

test("fetchGoProxyInfo raises once no proxy in the chain has the module", async () => {
  await expect(infoFor(makeGoCtx({}))).rejects.toThrow(/Unable to find github.com\/foo\/bar/);
});

test("fetchGoProxyInfo throws on a proxy failure instead of reporting up to date", async () => {
  await expect(infoFor(makeGoCtx({[`${goProxyBase}/${modPath}/@latest`]: 500}))).rejects.toThrow(/Received 500/);
});

test("fetchGoProxyInfo walks the GOPROXY list", async () => {
  const seen: Array<string> = [];
  const [data] = await infoFor(makeGoCtx({[`https://b/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""})},
    seen, parseGoProxy("https://a,https://b")));
  expect(data.new).toBe("1.2.0");
  expect(seen).toContain(`https://a/${modPath}/@latest`);
});

test("fetchGoProxyInfo short-circuits a `,` list on a proxy failure", async () => {
  const seen: Array<string> = [];
  const ctx = makeGoCtx({[`https://a/${modPath}/@latest`]: 500}, seen, parseGoProxy("https://a,https://b"));
  await expect(infoFor(ctx)).rejects.toThrow(/Received 500/);
  expect(seen.some(url => url.startsWith("https://b"))).toBe(false);
});

test("fetchGoProxyInfo falls through a `|` list on a proxy failure", async () => {
  const [data] = await infoFor(makeGoCtx({
    [`https://a/${modPath}/@latest`]: 500,
    [`https://b/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""}),
  }, [], parseGoProxy("https://a|https://b")));
  expect(data.new).toBe("1.2.0");
});

test.each([
  ["off", ".", /disabled by GOPROXY=off/],
  ["direct", resolve("."), /go list -m github.com\/foo\/bar@latest failed: no such host/],
])("fetchGoProxyInfo fails without contacting a proxy for GOPROXY=%s", async (value, cwd, message) => {
  const seen: Array<string> = [];
  let subprocessGoProxy = "";
  const execFile = (_file: string, _args: Array<string>, options: Record<string, any>) => {
    subprocessGoProxy = options.env?.GOPROXY ?? "";
    return Promise.reject(Object.assign(new Error("Command failed"), {stderr: "no such host"}));
  };
  const ctx = {...makeGoCtx({}, seen, parseGoProxy(value)), execFile};
  await expect(infoFor(ctx, cwd)).rejects.toThrow(message);
  expect(seen).toEqual([]);
  if (value === "direct") expect(subprocessGoProxy).toBe("direct");
});

test.each([
  ["block use",
    ["go 1.24", "", "use (", "\t./app", "\t./lib", ")"],
    {use: ["./app", "./lib"], replace: {}}],
  ["single-line use",
    ["go 1.24", "", "use ./mymod", ""],
    {use: ["./mymod"], replace: {}}],
  ["with replace",
    ["go 1.24", "", "use ./app", "", "replace github.com/old/mod => github.com/new/mod v1.0.0"],
    {use: ["./app"], replace: {"github.com/new/mod": "v1.0.0"}}],
  ["skips local path replace",
    ["go 1.24", "", "use (", "\t./app", "\t./lib", ")", "", "replace github.com/foo/bar => ../local/bar"],
    {use: ["./app", "./lib"], replace: {}}],
  ["use with inline comment",
    ["go 1.24", "", "use (", "\t./app // main application", "\t./lib", ")"],
    {use: ["./app", "./lib"], replace: {}}],
  ["replace block syntax",
    ["go 1.24", "", "use ./app", "", "replace (", "\tgithub.com/old/a => github.com/new/a v1.0.0",
      "\tgithub.com/old/b v1.2.0 => github.com/new/b v2.0.0", ")"],
    {use: ["./app"], replace: {"github.com/new/a": "v1.0.0", "github.com/new/b": "v2.0.0"}}],
])("parseGoWork %s", (_name, lines, expected) => {
  expect(parseGoWork(lines.join("\n"))).toEqual(expected);
});

test("resolveGoWorkModule resolves an out-of-tree member", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "updates-go-work-"));
  try {
    const root = resolve(parent, "project");
    const outside = resolve(parent, "shared");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(resolve(outside, "go.mod"), "module example.com/shared\n");
    expect(resolveGoWorkModule(root, "../shared")).toBe(realpathSync(resolve(outside, "go.mod")));
  } finally {
    rmSync(parent, {recursive: true});
  }
});

test("resolveGoWorkModule skips a member with a resolution error", () => {
  const root = mkdtempSync(resolve(tmpdir(), "updates-go-work-"));
  try {
    symlinkSync("loop", resolve(root, "loop"));
    expect(resolveGoWorkModule(root, "loop")).toBeNull();
  } finally {
    rmSync(root, {recursive: true});
  }
});

test("rewriteGoImports rewrites matching imports and skips empty work", () => {
  rewriteGoImports(resolve("fixtures/go"), {}, () => { throw new Error("unexpected write"); });
  rewriteGoImports(resolve("fixtures/cargo"), {"github.com/old": "github.com/new"}, () => { throw new Error("unexpected write"); });
  let written = "";
  rewriteGoImports(resolve("fixtures/go"), {"github.com/google/uuid": "github.com/google/uuid/v2"}, (_, content) => { written = content; });
  expect(written).toContain(`"github.com/google/uuid/v2"`);
  expect(written).not.toContain(`"github.com/google/uuid"`);
});

test("rewriteGoImportPaths only rewrites import declarations", () => {
  const content = `package main

// import "github.com/old/comment"
import (
  alias "github.com/old/sub"
  _ \`github.com/old/raw\`
  // "github.com/old/comment"
)
import "github.com/old"

var ordinary = "github.com/old/string"
`;
  expect(rewriteGoImportPaths(content, {"github.com/old": "github.com/new/v2"})).toBe(content
    .replace('"github.com/old/sub"', '"github.com/new/v2/sub"')
    .replace("`github.com/old/raw`", "`github.com/new/v2/raw`")
    .replace('import "github.com/old"', 'import "github.com/new/v2"'));
});

test("rewriteGoImportPaths handles a 10 MB unterminated block comment", () => {
  const content = `/*${"a".repeat(10 * 1024 * 1024)}`;
  expect(rewriteGoImportPaths(content, {"github.com/old": "github.com/new/v2"})).toBe(content);
});
