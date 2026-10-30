import {resolve} from "node:path";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {
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
import {
  fieldSep, isGoPseudoVersion, findNewVersion, goPinAllowsDowngrade, goVersionPredicate,
  type GoProxyEntry, type ModeContext,
} from "./shared.ts";
import {rejection, withEnv} from "../utils/testing.ts";

test("parseGoProxy", () => {
  expect(parseGoProxy("https://a,https://b|https://c")).toEqual([
    {url: "https://a", fallback: ","},
    {url: "https://b", fallback: "|"},
    {url: "https://c", fallback: ","},
  ]);
  expect(parseGoProxy(" https://a/ , direct ")).toEqual([{url: "https://a", fallback: ","}, {url: "direct", fallback: ","}]);
  expect(["off,https://a", "direct,https://a", "", ",,", "proxy.corp/mod"].map(parseGoProxy)).toEqual([
    [{url: "off", fallback: ","}], [{url: "direct", fallback: ","}], [], [], [{url: "https://proxy.corp/mod", fallback: ","}],
  ]);
});

test("resolveGoProxyChain", async () => {
  await withEnv({GOPROXY: "https://a,https://b"}, () => {
    expect(resolveGoProxyChain()).toEqual([{url: "https://a", fallback: ","}, {url: "https://b", fallback: ","}]);
    expect(resolveGoProxyChain("http://127.0.0.1:1/")).toEqual([{url: "http://127.0.0.1:1", fallback: ","}]);
  });
  await withEnv({GOPROXY: ",,"}, () => expect(() => resolveGoProxyChain()).toThrow(/contains no entries/));
  for (const [value, url] of [[undefined, "https://proxy.golang.org"], ["direct", "direct"], ["off,https://backup.proxy", "off"]]) {
    await withEnv({GOPROXY: value}, () => expect(resolveGoProxyChain()[0].url).toBe(url));
  }
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

test("parseGoNoProxy", async () => {
  for (const [value, expected] of [[undefined, []], ["github.com/private", ["github.com/private"]], ["a.com/x, b.com/y", ["a.com/x", "b.com/y"]]] as const) {
    await withEnv({GONOPROXY: value, GOPRIVATE: undefined}, () => expect(parseGoNoProxy()).toEqual(expected));
  }
});

test("isGoNoProxy", () => {
  expect(["github.com/private", "github.com/private/sub", "github.com/public"].map(path => isGoNoProxy(path, ["github.com/private"])))
    .toEqual([true, true, false]);
  expect(["github.com/mycorp/secret", "github.com/mycorp/secret/sub", "github.com/other/x"].map(path => isGoNoProxy(path, ["github.com/mycorp/*"])))
    .toEqual([true, true, false]);
  expect([isGoNoProxy("anything", []), isGoNoProxy("git.corp.example.com/a/b", ["*.corp.example.com"])]).toEqual([false, true]);
});

test("encodeGoModulePath", () => {
  expect(["github.com/BurntSushi/toml", "github.com/foo/bar", "github.com/Azure/azure-sdk"].map(encodeGoModulePath))
    .toEqual(["github.com/!burnt!sushi/toml", "github.com/foo/bar", "github.com/!azure/azure-sdk"]);
});

test("Go module path transforms", () => {
  expect(["github.com/foo/bar", "github.com/foo/bar/v2", "github.com/foo/bar/v15", "gopkg.in/yaml.v2"].map(name => extractGoMajor(name)))
    .toEqual([1, 2, 15, 2]);
  for (const [path, major, expected] of [
    ["github.com/foo/bar/v2", 3, "github.com/foo/bar/v3"], ["github.com/foo/bar/v2", 1, "github.com/foo/bar"],
    ["github.com/foo/bar", 2, "github.com/foo/bar/v2"], ["github.com/foo/bar", 1, "github.com/foo/bar"],
    ["gopkg.in/yaml.v2", 3, "gopkg.in/yaml.v3"], ["gopkg.in/yaml.v2", 1, "gopkg.in/yaml.v1"],
  ] as const) expect(buildGoModulePath(path, major)).toBe(expected);
  for (const [path, version, expected] of [
    ["github.com/foo/bar/v2", "3.0.0", "github.com/foo/bar/v3"], ["github.com/foo/bar", "2.1.0", "github.com/foo/bar/v2"],
    ["github.com/foo/bar/v2", "2.5.0", "github.com/foo/bar/v2"], ["github.com/foo/bar", "1.4.0", "github.com/foo/bar"],
    ["github.com/foo/bar", "3.0.0+incompatible", "github.com/foo/bar"], ["github.com/foo/bar/v2", "garbage", "github.com/foo/bar/v2"],
    ["gopkg.in/yaml.v2", "3.0.1", "gopkg.in/yaml.v3"], ["github.com/foo/bar/v2", "1.5.0", "github.com/foo/bar"],
  ]) expect(goModulePathForVersion(path, version)).toBe(expected);
});

test("isGoPseudoVersion", () => {
  expect(["v0.0.0-20221128193559-754e69321358", "v20.10.0-beta1.0.20201110211921-af34b94a78a1+incompatible", "v1.2.3", "v0.0.0-20221128193559"]
    .map(isGoPseudoVersion)).toEqual([true, true, false, false]);
});

test.each([
  ["sorts requires, indirects, replaces and tools",
    ["module example.com/mymod", "", "require (", "\tgithub.com/foo/bar v1.2.3",
      "\tgithub.com/baz/qux v0.5.0 // indirect", ")", "",
      "replace github.com/old/mod => github.com/new/mod v1.0.0", "", "exclude (", "\tgithub.com/foo/bar v1.3.0",
      "\tgithub.com/foo/bar v1.4.0", ")", "", "tool (", "\tgithub.com/foo/bar/cmd/tool // build tool", ")"],
    {deps: {}, indirect: {"github.com/baz/qux": "v0.5.0"}, replace: {"github.com/new/mod": "v1.0.0"},
      tool: {"github.com/foo/bar": "v1.2.3"}, exclude: new Map([["github.com/foo/bar", new Set(["v1.3.0", "v1.4.0"])]])}],
  ["a single-line require", ["module example.com/mod", "", "require foo v1.0.0"],
    {deps: {"foo": "v1.0.0"}, indirect: {}, replace: {}, tool: {}}],
  ["invalid and placeholder versions are not update candidates",
    ["module example.com/mod", "", "require (", "\texample.com/a v1.2",
      "\texample.com/b v0.0.0-00010101000000-000000000000",
      "\texample.com/c v0.0.0-20210101000000-000000000000", "\texample.com/d/v2 v2.0.0-00010101000000-000000000000", ")",
      "replace example.com/x => example.com/fork v1.2",
      "replace example.com/y => example.com/fork-placeholder v2.0.0-00010101000000-000000000000"],
    {deps: {"example.com/c": "v0.0.0-20210101000000-000000000000"}, indirect: {}, replace: {}, tool: {}}],
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
  ["overlapping requirements and repeated tool paths",
    ["module example.com/mod", "", "require (", "\tgithub.com/a v1.0.0", "\tgithub.com/a/b v1.1.0", ")", "",
      "tool (", "\tgithub.com/a/b/cmd/first", "\tgithub.com/a/b/cmd/second", ")"],
    {deps: {"github.com/a": "v1.0.0"}, indirect: {}, replace: {}, tool: {"github.com/a/b": "v1.1.0"}}],
  ["a direct tool module named constructor",
    ["require constructor v1.0.0", "tool constructor/cmd/tool"],
    {deps: {}, indirect: {}, replace: {}, tool: {constructor: "v1.0.0"}}],
  ["exclusions named like inherited properties",
    ["exclude constructor v1.0.0", "exclude __proto__ v1.0.0", "exclude __proto__ v1.1.0"],
    {deps: {}, indirect: {}, replace: {}, tool: {},
      exclude: new Map([["constructor", new Set(["v1.0.0"])], ["__proto__", new Set(["v1.0.0", "v1.1.0"])]])}],
])("parseGoMod %s", (_name, lines, expected) => {
  expect(parseGoMod(lines.join("\n"))).toEqual(expected);
});

test("parseGoMod preserves __proto__ module paths in dependency tables", () => {
  for (const [type, content] of [
    ["deps", "require __proto__ v1.0.0"],
    ["indirect", "require __proto__ v1.0.0 // indirect"],
    ["replace", "replace example.com/original => __proto__ v1.0.0"],
    ["tool", "require __proto__ v1.0.0\ntool __proto__/cmd/tool"],
  ] as const) expect(Object.entries(parseGoMod(content)[type])).toEqual([["__proto__", "v1.0.0"]]);
});

test("Go display transforms", () => {
  expect(["github.com/foo/bar/v2", "github.com/foo/bar/v10", "github.com/foo/bar"].map(shortenGoModule))
    .toEqual(["github.com/foo/bar", "github.com/foo/bar", "github.com/foo/bar"]);
  expect(["v0.0.0-20221128193559-754e69321358", "v1.2.3"].map(shortenGoVersion)).toEqual(["v0.0.0-2022112", "v1.2.3"]);
  expect(["github.com/foo/bar", "github.com/foo/bar/v2", "github.com/foo/bar/pkg/sub"].map(getGoInfoUrl))
    .toEqual(["https://github.com/foo/bar", "https://github.com/foo/bar", "https://github.com/foo/bar/tree/HEAD/pkg/sub"]);
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
  ["a __proto__ module's major version and import mapping",
    goMod("require __proto__ v1.0.0"),
    {[`deps${fieldSep}__proto__`]: {old: "1.0.0", new: "2.0.0"}},
    goMod("require __proto__/v2 v2.0.0"), {["__proto__"]: "__proto__/v2"}],
])("updateGoMod rewrites %s", (_name, content, deps, expected, expectedRewrites) => {
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toBe(expected);
  expect(Object.fromEntries(rewrites)).toEqual(expectedRewrites);
});

const goProxyBase = "https://proxy";

function makeGoCtx(routes: Record<string, string | number>, seen: Array<string> = [], goProxyChain: Array<GoProxyEntry> = [{url: goProxyBase, fallback: ","}]): ModeContext {
  return {
    fetchTimeout: 100,
    goProbeTimeout: 100,
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
const infoFor = (ctx: ModeContext, cwd = ".", constraints?: Parameters<typeof fetchGoProxyInfo>[6]) =>
  fetchGoProxyInfo(modPath, "deps", "1.0.0", cwd, ctx, [], constraints);

type GoModuleFixture = {Version: string, Versions: Array<string>, Times?: Record<string, string>};

function makeGoVersionCtx(source: string, modules: Record<string, GoModuleFixture>, seen: Array<string> = []): ModeContext {
  if (source === "proxy") return makeGoCtx(Object.fromEntries(Object.entries(modules).flatMap(([path, data]) => [
    [`${goProxyBase}/${path}/@latest`, JSON.stringify({...data, Time: data.Times?.[data.Version]})],
    [`${goProxyBase}/${path}/@v/list`, data.Versions.join("\n")],
    ...data.Versions.map(Version => [`${goProxyBase}/${path}/@v/${Version}.info`, JSON.stringify({Version, Time: data.Times?.[Version]})]),
  ])), seen);
  return {
    fetchTimeout: 100, goProbeTimeout: 100, goProxyChain: parseGoProxy("direct"),
    execFile: (_file: string, args: Array<string>) => {
      seen.push(args.at(-1)!);
      const [path, version] = args.at(-1)!.split("@");
      const resolved = version === "latest" ? modules[path]?.Version : version;
      return modules[path] ? Promise.resolve({
        stdout: JSON.stringify({...modules[path], Version: resolved, Time: modules[path].Times?.[resolved]}), stderr: "",
      }) : Promise.reject(new Error("missing module"));
    },
  } as unknown as ModeContext;
}

test("fetchGoProxyInfo falls back to @v/list when the proxy omits @latest", async () => {
  const seen: Array<string> = [];
  let inspectedVersions = 0;
  const accepts = (version: string) => { inspectedVersions++; return version === "1.2.0"; };
  const ctx = makeGoCtx({
    [`${goProxyBase}/${modPath}/@v/list`]: "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n",
    [`${goProxyBase}/${modPath}/@v/v1.2.0.info`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
  }, seen);
  const [[data], [sameData], [cachedData]] = await Promise.all([
    infoFor(ctx),
    fetchGoProxyInfo(modPath, "deps", "1.0.0", ".", ctx, [], {accepts}),
    fetchGoProxyInfo(modPath, "deps", "1.0.0", ".", ctx, [], {accepts}),
  ]);
  expect(data).toMatchObject({name: modPath, old: "1.0.0", new: "1.2.0", Time: "2024-01-01T00:00:00Z"});
  expect(sameData).toEqual(data);
  expect(cachedData).toEqual(data);
  expect(inspectedVersions).toBe(2);
  expect(seen).toContain(`${goProxyBase}/${modPath}/v2/@v/list`);
  expect(new Set(seen).size).toBe(seen.length);
});

test("fetchGoProxyInfo keeps the @v/list pick undated when its .info is missing but fails on a .info server error", async () => {
  const routes = {[`${goProxyBase}/${modPath}/@v/list`]: "v1.2.0\n", [`${goProxyBase}/${modPath}/v2/@v/list`]: 500};
  const [data] = await infoFor(makeGoCtx(routes));
  expect(data).toMatchObject({new: "1.2.0", Time: ""});
  expect((await rejection(infoFor(makeGoCtx({...routes, [`${goProxyBase}/${modPath}/@v/v1.2.0.info`]: 500}))))?.message).toMatch(/Received 500/);
});

test.each(["proxy", "direct"])("fetchGoProxyInfo steps back to the newest version past its cooldown within a bounded number of lookups through %s", async source => {
  const Times = {"v1.1.0": "2026-01-01T00:00:00Z", "v1.2.0": "2026-04-24T00:00:00Z", "v1.3.0": "2026-04-24T00:00:00Z",
    "v1.4.0": "2026-04-24T00:00:00Z", "v1.5.0": "2026-04-24T00:00:00Z", "v2.0.0": "2026-04-24T00:00:00Z"};
  const opts = {range: "1.0.0", semvers: new Set(["major", "minor", "patch"]), useGreatest: false, usePre: false, useRel: false,
    cooldownDays: 5, now: Date.parse("2026-04-25T00:00:00Z")};
  for (const [versions, expected] of [[["v1.1.0", "v1.4.0", "v1.5.0"], "1.1.0"], [["v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0", "v1.5.0"], null]] as const) {
    const seen: Array<string> = [];
    const ctx = makeGoVersionCtx(source, {
      [modPath]: {Version: "v1.5.0", Versions: [...versions], Times},
      [`${modPath}/v2`]: {Version: "v2.0.0", Versions: ["v2.0.0"], Times},
    }, seen);
    const [data] = await fetchGoProxyInfo(modPath, "deps", "1.0.0", ".", ctx, [], {accepts: goVersionPredicate(opts), ...opts});
    expect(findNewVersion(data, {...opts, mode: "go"})).toBe(expected);
    expect(seen.filter(request => /v1\.\d\.0(\.info)?$/.test(request))).toHaveLength(expected ? 2 : 3);
  }
});

test("fetchGoProxyInfo probes past a rejected major whose @v/list fails", async () => {
  const [data] = await infoFor(makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.1.0"}),
    [`${goProxyBase}/${modPath}/v2/@latest`]: JSON.stringify({Version: "v2.0.0-beta.1"}),
    [`${goProxyBase}/${modPath}/v2/@v/list`]: 500,
    [`${goProxyBase}/${modPath}/v3/@latest`]: JSON.stringify({Version: "v3.0.0"}),
  }), ".", {accepts: version => !version.includes("-")});
  expect(data.new).toBe("3.0.0");
});

test.each(["proxy", "direct"])("fetchGoProxyInfo applies version constraints and skips forbidden major probes through %s", async source => {
  for (const [currentVersion, latest, versions, pinnedRange, usePre, expected, allowDowngrade = false] of [
    ["1.5.0", "1.5.0", ["1.3.0", "1.4.0", "1.5.0"], "1.3.0", false, "1.3.0"],
    ["1.5.0", "1.3.0", ["1.3.0", "1.4.0", "1.5.0"], "1.3.0", false, "1.3.0"],
    ["1.0.0", "1.3.0", ["1.1.0", "1.2.0", "1.3.0"], "<1.3.0", false, "1.2.0"],
    ["1.0.0", "1.3.0", ["1.1.0", "1.2.0-beta.1", "1.3.0"], "<1.3.0", true, "1.2.0-beta.1"],
    ["1.2.0", "1.2.0", ["1.1.0", "1.2.0"], "", false, null, true],
    ["1.0.0-beta.1", "1.0.0-beta.1", ["1.0.0-beta.0", "1.0.0-beta.1"], "^1.0.0", false, null],
  ] as const) {
    const seen: Array<string> = [];
    const ctx = makeGoVersionCtx(source, {[modPath]: {Version: `v${latest}`, Versions: versions.map(version => `v${version}`)}}, seen);
    const opts = {range: currentVersion, semvers: new Set(["major", "minor", "patch"]),
      useGreatest: false, usePre, useRel: false, pinnedRange, allowDowngrade};
    const [data] = await fetchGoProxyInfo(modPath, "deps", currentVersion, ".", ctx, [], {
      accepts: goVersionPredicate(opts), allowMajor: false, pinAllowsDowngrade: goPinAllowsDowngrade(opts, currentVersion),
    });
    expect(data.new).toBe(expected || latest);
    expect(findNewVersion(data, {...opts, mode: "go"})).toBe(expected);
    expect(seen.every(request => request.startsWith(source === "direct" ? `${modPath}@` : `${goProxyBase}/${modPath}/@`))).toBe(true);
  }
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

test.each([
  ["absent", {}],
  ["mismatched", {[`${goProxyBase}/${modPath}/v2/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""})}],
])("fetchGoProxyInfo stops major probing at the first %s major", async (_name, routes) => {
  const seen: Array<string> = [];
  const [data] = await infoFor(makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
    ...routes,
  }, seen));
  expect(data.new).toBe("1.2.0");
  expect(data.newPath).toBeUndefined();
  expect(seen.toSorted()).toEqual([`${goProxyBase}/${modPath}/@latest`, `${goProxyBase}/${modPath}/v2/@latest`]);
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

test.each(["proxy", "direct"])("fetchGoProxyInfo rejects excluded and constrained latest versions from root and workspace member manifests, keeping the non-excluded latest when nothing is accepted, through %s", async source => {
  const projectDir = mkdtempSync(resolve(tmpdir(), "updates-go-"));
  try {
    mkdirSync(resolve(projectDir, "app"));
    const seen: Array<string> = [];
    const ctx = makeGoVersionCtx(source, {[modPath]: {Version: "v1.3.0", Versions: ["v1.1.0", "v1.2.0", "v1.3.0"]}}, seen);
    for (const [type, memberPath, expected] of [["deps", "", "1.2.0"], ["deps|./app", "app", "1.1.0"]]) {
      writeFileSync(resolve(projectDir, memberPath, "go.mod"), goMod(`exclude ${modPath} v1.3.0`,
        ...(memberPath ? [`exclude ${modPath} v1.2.0`] : [])));
      const [data] = await fetchGoProxyInfo(modPath, type, "1.0.0", projectDir, ctx, []);
      expect(data.new).toBe(expected);
      const [constrained] = await fetchGoProxyInfo(modPath, type, "1.0.0", projectDir, ctx, [], {
        accepts: version => version === "1.1.0",
      });
      expect(constrained.new).toBe("1.1.0");
      const [rejected] = await fetchGoProxyInfo(modPath, type, "1.0.0", projectDir, ctx, [], {accepts: () => false});
      expect(rejected.new).toBe(expected);
    }
    if (source === "proxy") expect(new Set(seen).size).toBe(seen.length);
  } finally {
    rmSync(projectDir, {recursive: true});
  }
});

test.each(["proxy", "direct"])("fetchGoProxyInfo keeps accepted majors and continues through rejected intermediate majors through %s", async source => {
  const ctx = makeGoVersionCtx(source, Object.fromEntries([1, 2, 3].map(major => [
    major === 1 ? modPath : `${modPath}/v${major}`, {Version: `v${major}.1.0`, Versions: [`v${major}.1.0`]},
  ])));
  const constraints = {accepts: (version: string) => !version.startsWith("3.")};
  const [data] = await fetchGoProxyInfo(modPath, "deps", "1.0.0", ".", ctx, [], constraints);
  const [primary] = await fetchGoProxyInfo(`${modPath}/v3`, "deps", "3.0.0", ".", ctx, [], constraints);
  expect([data.new, primary.new]).toEqual(["2.1.0", "3.1.0"]);
  const [laterMajor] = await fetchGoProxyInfo(modPath, "deps", "1.0.0", ".", ctx, [], {
    accepts: version => version.startsWith("3."),
  });
  expect(laterMajor).toMatchObject({new: "3.1.0", newPath: `${modPath}/v3`});
});

test("fetchGoProxyInfo raises once no proxy in the chain has the module", async () => {
  await expect(infoFor(makeGoCtx({}))).rejects.toThrow(/Unable to find github.com\/foo\/bar/);
});

test.each([
  ["failed", 500, `Received 500 status 500 from ${goProxyBase}//team@feed/${modPath}/@latest`],
  ["invalid", "{}", `Invalid response from ${goProxyBase}//team@feed/${modPath}/@latest`],
])("fetchGoProxyInfo reports %s proxy responses without URL credentials", async (_name, response, message) => {
  for (const authority of ["proxy", "test-user:test%40password@proxy", "test-user:first@second@proxy"]) {
    await expect(infoFor(makeGoCtx({[`${goProxyBase}//team@feed/${modPath}/@latest`]: response}, [],
      parseGoProxy(`https://${authority}//team@feed`)))).rejects.toThrow(message);
  }
});

test.each([
  ["without credentials", "https://a,https://b", null, ""],
  ["with URL credentials", "https://test-user:test%40password@a,https://test-user:test%40password@b", "Basic dGVzdC11c2VyOnRlc3RAcGFzc3dvcmQ=", ""],
  ["with an at-sign in the path", "https://a//team@feed,https://b//team@feed", null, "//team@feed"],
])("fetchGoProxyInfo walks the GOPROXY list %s", async (_name, proxies, authorization, suffix) => {
  const seen: Array<string> = [];
  const ctx = makeGoCtx({[`https://b${suffix}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: ""})}, seen, parseGoProxy(proxies));
  const doFetch = ctx.doFetch;
  ctx.doFetch = (url, options) => {
    expect(new Request(url, options).headers.get("authorization")).toBe(authorization);
    return doFetch(url, options);
  };
  const [data] = await infoFor(ctx);
  expect(data.new).toBe("1.2.0");
  expect(seen).toContain(`https://a${suffix}/${modPath}/@latest`);
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
  const execFile = (_file: string, args: Array<string>, options: Record<string, any>) => {
    expect(args.slice(0, -1)).toEqual(["list", "-m", "-mod=readonly", "-versions", "-json", "--"]);
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
  ["preserves a __proto__ replace target",
    ["use ./app", "replace example.com/original => __proto__ v1.0.0"],
    {use: ["./app"], replace: {["__proto__"]: "v1.0.0"}}],
])("parseGoWork %s", (_name, lines, expected) => {
  expect(parseGoWork(lines.join("\n"))).toEqual(expected);
});

test("resolveGoWorkModule resolves valid members and skips resolution errors", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "updates-go-work-"));
  try {
    const root = resolve(parent, "project");
    const outside = resolve(parent, "shared");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(resolve(outside, "go.mod"), "module example.com/shared\n");
    expect(resolveGoWorkModule(root, "../shared")).toBe(realpathSync(resolve(outside, "go.mod")));
    symlinkSync("loop", resolve(root, "loop"));
    expect(resolveGoWorkModule(root, "loop")).toBeNull();
  } finally {
    rmSync(parent, {recursive: true});
  }
});

test("rewriteGoImports rewrites matching imports and skips empty work", () => {
  rewriteGoImports(resolve("fixtures/go"), new Map(), () => { throw new Error("unexpected write"); });
  rewriteGoImports(resolve("fixtures/cargo"), new Map([["github.com/old", "github.com/new"]]), () => { throw new Error("unexpected write"); });
  let written = "";
  rewriteGoImports(resolve("fixtures/go"), new Map([["github.com/google/uuid", "github.com/google/uuid/v2"]]), (_, content) => { written = content; });
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
  expect(rewriteGoImportPaths(content, new Map([["github.com/old", "github.com/new/v2"]]))).toBe(content
    .replace('"github.com/old/sub"', '"github.com/new/v2/sub"')
    .replace("`github.com/old/raw`", "`github.com/new/v2/raw`")
    .replace('import "github.com/old"', 'import "github.com/new/v2"'));
});

test("rewriteGoImportPaths handles a 10 MB unterminated block comment", () => {
  const content = `/*${"a".repeat(10 * 1024 * 1024)}`;
  expect(rewriteGoImportPaths(content, new Map([["github.com/old", "github.com/new/v2"]]))).toBe(content);
});
