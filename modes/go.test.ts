import {resolve} from "node:path";
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
  shortenGoModule,
  shortenGoVersion,
  getGoInfoUrl,
  updateGoMod,
  fetchGoProxyInfo,
  probeMajorVersions,
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
  await withGoProxyEnv(",,", () => expect(resolveGoProxyChain()).toEqual([{url: "https://proxy.golang.org", fallback: ","}]));
  await withGoProxyEnv(undefined, () => expect(resolveGoProxyChain()[0].url).toBe("https://proxy.golang.org"));
  await withGoProxyEnv("direct", () => expect(resolveGoProxyChain()[0].url).toBe("direct"));
  await withGoProxyEnv("off,https://backup.proxy", () => expect(resolveGoProxyChain()[0].url).toBe("off"));
});

test("pickGoListVersion", () => {
  expect(pickGoListVersion("v1.0.0\nv1.2.0\nv1.1.0\n")).toEqual({Version: "v1.2.0", Time: ""});
  expect(pickGoListVersion("v1.0.0 2019-10-16T16:15:28Z\n")).toEqual({Version: "v1.0.0", Time: "2019-10-16T16:15:28Z"});
  // a release outranks any prerelease, pseudo-versions included
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
  // go matches these with path.Match, so globs stay inside one path element
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

test("extractGoMajor", () => {
  expect(extractGoMajor("github.com/foo/bar")).toBe(1);
  expect(extractGoMajor("github.com/foo/bar/v2")).toBe(2);
  expect(extractGoMajor("github.com/foo/bar/v15")).toBe(15);
  expect(extractGoMajor("gopkg.in/yaml.v2")).toBe(2);
});

test("buildGoModulePath", () => {
  expect(buildGoModulePath("github.com/foo/bar/v2", 3)).toBe("github.com/foo/bar/v3");
  expect(buildGoModulePath("github.com/foo/bar/v2", 1)).toBe("github.com/foo/bar");
  expect(buildGoModulePath("github.com/foo/bar", 2)).toBe("github.com/foo/bar/v2");
  expect(buildGoModulePath("github.com/foo/bar", 1)).toBe("github.com/foo/bar");
  // gopkg.in encodes the major on the last element and has no unsuffixed form
  expect(buildGoModulePath("gopkg.in/yaml.v2", 3)).toBe("gopkg.in/yaml.v3");
  expect(buildGoModulePath("gopkg.in/yaml.v2", 1)).toBe("gopkg.in/yaml.v1");
});

test("goModulePathForVersion", () => {
  expect(goModulePathForVersion("github.com/foo/bar/v2", "3.0.0")).toBe("github.com/foo/bar/v3");
  expect(goModulePathForVersion("github.com/foo/bar", "2.1.0")).toBe("github.com/foo/bar/v2");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "2.5.0")).toBe("github.com/foo/bar/v2");
  expect(goModulePathForVersion("github.com/foo/bar", "1.4.0")).toBe("github.com/foo/bar");
  expect(goModulePathForVersion("github.com/foo/bar", "3.0.0+incompatible")).toBe("github.com/foo/bar");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "garbage")).toBe("github.com/foo/bar/v2"); // non-numeric major → unchanged
  expect(goModulePathForVersion("gopkg.in/yaml.v2", "3.0.1")).toBe("gopkg.in/yaml.v3");
  expect(goModulePathForVersion("github.com/foo/bar/v2", "1.5.0")).toBe("github.com/foo/bar"); // major downgrade drops the suffix
});

test("isGoPseudoVersion", () => {
  expect(isGoPseudoVersion("v0.0.0-20221128193559-754e69321358")).toBe(true);
  expect(isGoPseudoVersion("v1.2.3")).toBe(false);
  expect(isGoPseudoVersion("v0.0.0-20221128193559")).toBe(false);
});

test.each([
  ["sorts requires, indirects, replaces and tools",
    ["module example.com/mymod", "", "go 1.21", "", "require (", "\tgithub.com/foo/bar v1.2.3",
      "\tgithub.com/baz/qux v0.5.0 // indirect", ")", "",
      "replace github.com/old/mod => github.com/new/mod v1.0.0", "", "tool github.com/foo/bar/cmd/tool"],
    {deps: {}, indirect: {"github.com/baz/qux": "v0.5.0"}, replace: {"github.com/new/mod": "v1.0.0"},
      tool: {"github.com/foo/bar": "v1.2.3"}}],
  ["a single-line require", ["module example.com/mod", "", "require foo v1.0.0"],
    {deps: {"foo": "v1.0.0"}, indirect: {}, replace: {}, tool: {}}],
  ["replace block syntax",
    ["module example.com/mod", "", "require (", "\tgithub.com/orig/mod v1.0.0", ")", "",
      "replace (", "\tgithub.com/orig/mod => github.com/fork/mod v2.0.0", ")"],
    {deps: {}, indirect: {}, replace: {"github.com/fork/mod": "v2.0.0"}, tool: {}}],
  // the local checkout is what builds, so the require version is inert; leaving it in deps
  // meant an update bumped it and stripped the replace, silently un-forking the dependency
  ["a local replace, which takes its require out of play",
    ["module example.com/mod", "", "require github.com/foo/bar v1.2.3", "", "replace github.com/foo/bar => ../local/bar"],
    {deps: {}, indirect: {}, replace: {}, tool: {}}],
  // the replace only redirects v1.0.0, so the required v1.2.3 is live
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

test("shortenGoModule", () => {
  expect(shortenGoModule("github.com/foo/bar/v2")).toBe("github.com/foo/bar");
  expect(shortenGoModule("github.com/foo/bar/v10")).toBe("github.com/foo/bar");
  expect(shortenGoModule("github.com/foo/bar")).toBe("github.com/foo/bar");
});

test("shortenGoVersion", () => {
  expect(shortenGoVersion("v0.0.0-20221128193559-754e69321358")).toBe("v0.0.0-2022112");
  expect(shortenGoVersion("v1.2.3")).toBe("v1.2.3");
});

test("getGoInfoUrl", () => {
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
  // a replace target's version has to match its path's major or go refuses to parse the file
  ["both sides of a self-replace across a major",
    goMod("replace (", "\tgithub.com/grpc-ecosystem/grpc-gateway => github.com/grpc-ecosystem/grpc-gateway v1.16.0", ")", ""),
    {[`replace${fieldSep}github.com/grpc-ecosystem/grpc-gateway`]: {old: "1.16.0", new: "2.28.0"}},
    goMod("replace (", "\tgithub.com/grpc-ecosystem/grpc-gateway/v2 => github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0", ")", ""), {}],
  // go applies the replacement only to the path the require names, so a stale require does nothing
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
  // without `oldOrig` the shortened `old` partial-matches the full version and corrupts the tail
  ["a pseudo-version to a release, anchored on oldOrig",
    goMod("require github.com/foo/bar v0.0.0-20221128193559-754e69321358 // indirect"),
    {[`indirect${fieldSep}github.com/foo/bar`]: {old: "v0.0.0-2022112", oldOrig: "0.0.0-20221128193559-754e69321358", new: "1.2.3"}},
    goMod("require github.com/foo/bar v1.2.3 // indirect"), {}],
  ["a tool's major, in the require and the tool block alike",
    goMod("require (", "\tgithub.com/foo/bar/v2 v2.1.0", ")", "", "tool (", "\tgithub.com/foo/bar/v2/cmd/mytool", ")"),
    {[`tool${fieldSep}github.com/foo/bar/v2`]: {old: "2.1.0", new: "3.0.0"}},
    goMod("require (", "\tgithub.com/foo/bar/v3 v3.0.0", ")", "", "tool (", "\tgithub.com/foo/bar/v3/cmd/mytool", ")"),
    {"github.com/foo/bar/v2": "github.com/foo/bar/v3"}],
])("updateGoMod rewrites %s", (_name, content, deps, expected, expectedRewrites) => {
  const [result, rewrites] = updateGoMod(content, deps);
  expect(result).toBe(expected);
  expect(rewrites).toEqual(expectedRewrites);
});

// probeMajorVersions
const probeOf = (major: number, pre = false) => ({Version: `v${major}.0.0${pre ? "-rc.1" : ""}`, Time: "", path: `mod/v${major}`});
const makeProbe = (existing: Array<number>, prerelease: Array<number>) =>
  (major: number) => Promise.resolve(existing.includes(major) ? probeOf(major, prerelease.includes(major)) : null);

test.each([
  ["returns null when firstProbe is null", null, [99], null],
  ["returns firstProbe when no higher major exists", probeOf(2), [], probeOf(2)],
  ["finds the highest major", probeOf(2), [2, 3, 4, 5], probeOf(5)],
  ["finds the highest major across a large gap", probeOf(2), Array.from({length: 19}, (_, idx) => idx + 2), probeOf(20)],
  // v2 exists but v3 does not — exponential search hits v3 first and stops
  ["stops at the first gap in the exponential search", probeOf(2), [2, 4], probeOf(2)],
  // a prerelease-only top major would hide the released one below it, and stands in only alone
  ["skips a prerelease-only highest major", probeOf(2), [2, 3, 4], probeOf(3), [4]],
  ["keeps a prerelease-only major when no probed one has a release", probeOf(2, true), [2], probeOf(2, true), [2]],
])("probeMajorVersions %s", async (_name, firstProbe, existing, expected, prerelease = []) => {
  expect(await probeMajorVersions(1, firstProbe, makeProbe(existing, prerelease))).toEqual(expected);
});

const goProxyBase = "https://proxy";

// A route value is either a response body (200) or a bare status, anything unrouted 404s.
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
  const [data] = await infoFor(makeGoCtx({
    [`${goProxyBase}/${modPath}/@v/list`]: "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n",
    [`${goProxyBase}/${modPath}/@v/v1.2.0.info`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
  }, seen));
  expect(data).toMatchObject({name: modPath, old: "1.0.0", new: "1.2.0", Time: "2024-01-01T00:00:00Z"});
  // the major probe cannot trust a 404 from an endpoint this proxy does not serve
  expect(seen).toContain(`${goProxyBase}/${modPath}/v2/@v/list`);
});

test("fetchGoProxyInfo keeps a single request per module when @latest is served", async () => {
  const seen: Array<string> = [];
  const [data] = await infoFor(makeGoCtx({
    [`${goProxyBase}/${modPath}/@latest`]: JSON.stringify({Version: "v1.2.0", Time: "2024-01-01T00:00:00Z"}),
  }, seen));
  expect(data.new).toBe("1.2.0");
  expect(seen).toEqual([`${goProxyBase}/${modPath}/@latest`, `${goProxyBase}/${modPath}/v2/@latest`]);
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

// `direct` routes to a VCS lookup the 1ms timeout kills, and neither token may reach a proxy.
test.each([
  ["off", ".", /disabled by GOPROXY=off/],
  ["direct", resolve("."), /go list -m github.com\/foo\/bar@latest failed/],
])("fetchGoProxyInfo fails without contacting a proxy for GOPROXY=%s", async (value, cwd, message) => {
  const seen: Array<string> = [];
  const ctx = {...makeGoCtx({}, seen, parseGoProxy(value)), fetchTimeout: 1, goProbeTimeout: 1};
  await expect(infoFor(ctx, cwd)).rejects.toThrow(message);
  expect(seen).toEqual([]);
});

// parseGoWork
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
  ["with toolchain ignored",
    ["go 1.24", "toolchain go1.24.2", "", "use ./app"],
    {use: ["./app"], replace: {}}],
  ["replace block syntax",
    ["go 1.24", "", "use ./app", "", "replace (", "\tgithub.com/old/a => github.com/new/a v1.0.0",
      "\tgithub.com/old/b v1.2.0 => github.com/new/b v2.0.0", ")"],
    {use: ["./app"], replace: {"github.com/new/a": "v1.0.0", "github.com/new/b": "v2.0.0"}}],
])("parseGoWork %s", (_name, lines, expected) => {
  expect(parseGoWork(lines.join("\n"))).toEqual(expected);
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
