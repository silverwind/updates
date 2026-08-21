import {
  isMakeFileName,
  parseMakeGoInstalls,
  parseMakeImageValue,
  parseMakeDockerImages,
  resolveGoModuleRoot,
  updateMakefile,
} from "./make.ts";
import {type ExecFile, type GoProxyEntry, type ModeContext, fetchTimeout} from "./shared.ts";

const sample = `GOLANGCI_PACKAGE ?= github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
AIR_PACKAGE := github.com/air-verse/air@v1.65.1
DLV_PACKAGE = github.com/go-delve/delve/cmd/dlv@v1
GOVULNCHECK_PACKAGE := golang.org/x/vuln/cmd/govulncheck@v1.2.0
# COMMENTED_PACKAGE := github.com/foo/bar@v9.9.9
MISSPELL_PACKAGE ?= github.com/golangci/misspell/cmd/misspell@v0.8.0  # inline note
NOT_GO := some-local-tool@v1.0.0
SOURCE_FILES := $(wildcard *.go)
PSEUDO := golang.org/x/tools/cmd/goimports@v0.0.0-20200103221440-774c71fcf114
PRE := github.com/foo/bar@v1.2.3-rc.1
INCOMPAT := github.com/foo/baz@v2.0.0+incompatible
TABS	:=	github.com/foo/qux@v1.0.0
TOOLS += \\
  'github.com/foo/quoted@v1.2.3' github.com/foo/aggregate@v2.0.0`;

test("isMakeFileName matches make filenames", () => {
  expect(isMakeFileName("Makefile")).toBe(true);
  expect(isMakeFileName("makefile")).toBe(true);
  expect(isMakeFileName("GNUmakefile")).toBe(true);
  expect(isMakeFileName("build.mk")).toBe(true);
  expect(isMakeFileName("go.mod")).toBe(false);
  expect(isMakeFileName("Dockerfile")).toBe(false);
});

test("parseMakeGoInstalls extracts go install specs across assignment operators", () => {
  expect(parseMakeGoInstalls(sample)).toEqual([
    {installPath: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint", version: "v2.12.2"},
    {installPath: "github.com/air-verse/air", version: "v1.65.1"},
    {installPath: "github.com/go-delve/delve/cmd/dlv", version: "v1"},
    {installPath: "golang.org/x/vuln/cmd/govulncheck", version: "v1.2.0"},
    {installPath: "github.com/golangci/misspell/cmd/misspell", version: "v0.8.0"},
    {installPath: "golang.org/x/tools/cmd/goimports", version: "v0.0.0-20200103221440-774c71fcf114"},
    {installPath: "github.com/foo/bar", version: "v1.2.3-rc.1"},
    {installPath: "github.com/foo/baz", version: "v2.0.0+incompatible"},
    {installPath: "github.com/foo/qux", version: "v1.0.0"},
    {installPath: "github.com/foo/quoted", version: "v1.2.3"},
    {installPath: "github.com/foo/aggregate", version: "v2.0.0"},
  ]);
});

test("updateMakefile rewrites versions and install paths while preserving comments", () => {
  const updated = updateMakefile(sample, [
    {oldSpec: "github.com/air-verse/air@v1.65.1", newSpec: "github.com/air-verse/air@v1.65.3"},
    {oldSpec: "github.com/golangci/misspell/cmd/misspell@v0.8.0", newSpec: "github.com/golangci/misspell/cmd/misspell@v0.9.0"},
    {
      oldSpec: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2",
      newSpec: "github.com/golangci/golangci-lint/v3/cmd/golangci-lint@v3.0.0",
    },
    {oldSpec: "github.com/foo/bar@v9.9.9", newSpec: "github.com/foo/bar@v10.0.0"},
  ]);
  expect(updated).toContain("AIR_PACKAGE := github.com/air-verse/air@v1.65.3");
  expect(updated).toContain("MISSPELL_PACKAGE ?= github.com/golangci/misspell/cmd/misspell@v0.9.0  # inline note");
  expect(updated).toContain("# COMMENTED_PACKAGE := github.com/foo/bar@v9.9.9");
  expect(updated).not.toContain("v10.0.0");
  expect(updated).toContain("GOLANGCI_PACKAGE ?= github.com/golangci/golangci-lint/v3/cmd/golangci-lint@v3.0.0");
});

test.each([
  ["preserves CRLF", "AIR := github.com/air-verse/air@v1.0.0\r\nFOO := bar\r\n",
    [{oldSpec: "github.com/air-verse/air@v1.0.0", newSpec: "github.com/air-verse/air@v1.1.0"}],
    "AIR := github.com/air-verse/air@v1.1.0\r\nFOO := bar\r\n"],
  ["rewrites quoted and comment-adjacent specs", "QUOTED := \"koalaman/app:1.0.0\"\nCOMMENTED := koalaman/app:1.0.0#pinned\n",
    [{oldSpec: "koalaman/app:1.0.0", newSpec: "koalaman/app:1.1.0"}],
    "QUOTED := \"koalaman/app:1.1.0\"\nCOMMENTED := koalaman/app:1.1.0#pinned\n"],
  ["rewrites every spec on a line",
    "\tgo install github.com/air-verse/air@v1.60.0 github.com/golangci/golangci-lint/cmd/golangci-lint@v1.60.0  # tools\n",
    [
      {oldSpec: "github.com/air-verse/air@v1.60.0", newSpec: "github.com/air-verse/air@v1.62.0"},
      {oldSpec: "github.com/golangci/golangci-lint/cmd/golangci-lint@v1.60.0", newSpec: "github.com/golangci/golangci-lint/cmd/golangci-lint@v1.62.0"},
    ],
    "\tgo install github.com/air-verse/air@v1.62.0 github.com/golangci/golangci-lint/cmd/golangci-lint@v1.62.0  # tools\n"],
  ["keeps two tags apart", "OLD := koalaman/shellcheck:v0.11.0\nNEW := koalaman/shellcheck:v0.12.0\n", [
    {oldSpec: "koalaman/shellcheck:v0.11.0", newSpec: "koalaman/shellcheck:v0.12.0"},
    {oldSpec: "koalaman/shellcheck:v0.12.0", newSpec: "koalaman/shellcheck:v0.13.0"},
  ], "OLD := koalaman/shellcheck:v0.12.0\nNEW := koalaman/shellcheck:v0.13.0\n"],
  ["does not match inside a registry prefix", "PREFIXED := docker.io/koalaman/shellcheck:v0.11.0\n",
    [{oldSpec: "koalaman/shellcheck:v0.11.0", newSpec: "koalaman/shellcheck:v0.12.0"}],
    "PREFIXED := docker.io/koalaman/shellcheck:v0.11.0\n"],
  ["rewrites tag and digest", "SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@sha256:aaa  # renovate: datasource=docker\n",
    [{oldSpec: "docker.io/koalaman/shellcheck:v0.11.0@sha256:aaa", newSpec: "docker.io/koalaman/shellcheck:v0.12.0@sha256:bbb"}],
    "SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.12.0@sha256:bbb  # renovate: datasource=docker\n"],
])("updateMakefile %s", (_name, content, rewrites, expected) => {
  expect(updateMakefile(content, rewrites)).toBe(expected);
});

const execFileFails: ExecFile = () => Promise.reject(new Error("no such file or directory"));
const rootCtx = (
  doFetch: (url: string) => Promise<any>, goProxyUrl = "https://proxy", execFile: ExecFile = execFileFails,
  goProxyChain: Array<GoProxyEntry> = [{url: goProxyUrl, fallback: ","}],
) => ({goProxyUrl, goProxyChain, fetchTimeout, doFetch, execFile}) as unknown as ModeContext;
const rootHit = (path: string) => (url: string) => Promise.resolve({
  ok: url.endsWith(`${path}/@latest`), status: 404, json: () => Promise.resolve({Version: "v1.1.4"}),
} as any);
const goListMiss = (candidate: string) => Promise.resolve({stdout: JSON.stringify({
  Path: candidate,
  Version: "latest",
  Error: {Err: `module ${candidate}: no matching versions for query "latest"`},
  Origin: {VCS: "git", URL: "https://example.com/repo"},
}), stderr: ""});

test("resolveGoModuleRoot takes the /vN heuristic, else the longest prefix that resolves", async () => {
  let fetched = false;
  const ctx = rootCtx(url => { fetched = true; return rootHit("golang.org/x/vuln")(url); });
  expect(await resolveGoModuleRoot("github.com/golangci/golangci-lint/v2/cmd/golangci-lint", ".", ctx, [])).toBe("github.com/golangci/golangci-lint/v2");
  expect(fetched).toBe(false);
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", ".", ctx, [])).toBe("golang.org/x/vuln");
});

test("resolveGoModuleRoot applies GOPROXY comma and pipe error fallbacks", async () => {
  const resolveWith = (fallback: GoProxyEntry["fallback"], seen: Array<string>) => {
    const chain: Array<GoProxyEntry> = [{url: "https://broken", fallback}, {url: "https://backup", fallback: ","}];
    return resolveGoModuleRoot("example.com/mod/cmd/tool", ".", rootCtx(url => {
      seen.push(url);
      const ok = url === "https://backup/example.com/mod/@latest";
      return Promise.resolve({
        ok,
        status: ok ? 200 : url.startsWith("https://broken/") ? 500 : 404,
        statusText: "failed",
        json: () => Promise.resolve({Version: "v1.2.0"}),
      } as any);
    }, chain[0].url, execFileFails, chain), []);
  };
  const pipeSeen: Array<string> = [];
  await expect(resolveWith("|", pipeSeen)).resolves.toBe("example.com/mod");
  expect(pipeSeen).toContain("https://backup/example.com/mod/@latest");
  const commaSeen: Array<string> = [];
  await expect(resolveWith(",", commaSeen)).rejects.toThrow("500");
  expect(commaSeen.some(url => url.startsWith("https://backup/"))).toBe(false);
});

test("resolveGoModuleRoot falls through when a proxy omits @latest", async () => {
  const chain: Array<GoProxyEntry> = [
    {url: "https://without-latest", fallback: "|"},
    {url: "https://backup", fallback: ","},
  ];
  const seen: Array<string> = [];
  const ctx = rootCtx(url => {
    seen.push(url);
    const ok = url === "https://backup/example.com/mod/@latest";
    return Promise.resolve({
      ok, status: ok ? 200 : 404, json: () => Promise.resolve({Version: "v1.2.0"}),
    } as any);
  }, chain[0].url, execFileFails, chain);
  expect(await resolveGoModuleRoot("example.com/mod/cmd/tool", ".", ctx, [])).toBe("example.com/mod");
  expect(seen).toContain("https://without-latest/example.com/mod/@latest");
  expect(seen).toContain("https://backup/example.com/mod/@latest");
});

test("resolveGoModuleRoot returns null when nothing resolves and throws when a probe fails", async () => {
  const path = "golang.org/x/vuln/cmd/govulncheck";
  expect(await resolveGoModuleRoot(path, ".", rootCtx(rootHit("nothing")), [])).toBeNull();
  const rateLimited = rootCtx(() => Promise.resolve({ok: false, status: 429, statusText: "Too Many Requests"} as any));
  await expect(resolveGoModuleRoot(path, ".", rateLimited, [])).rejects.toThrow("429");
  await expect(resolveGoModuleRoot(path, ".", rootCtx(() => Promise.reject(new Error("network"))), [])).rejects.toThrow("network");
  let calls = 0;
  const slow = rootCtx(url => ++calls === 1 ?
    Promise.reject(Object.assign(new Error("timeout"), {transient: true})) :
    rootHit(path)(url));
  expect(await resolveGoModuleRoot(path, ".", slow, [])).toBe(path);
});

test("resolveGoModuleRoot uses VCS origin metadata through a direct fallback", async () => {
  const moduleRoot = "golang.org/x/vuln";
  const seen: Array<string> = [];
  const execFile = (_file: string, args: Array<string>, opts: Record<string, any>) => {
    expect(args.slice(0, 4)).toEqual(["list", "-m", "-e", "-json"]);
    expect(opts.env.GOPROXY).toBe("direct");
    const candidate = args.at(-1)!.replace(/@latest$/, "");
    return candidate === moduleRoot ? Promise.resolve({stdout: JSON.stringify({Path: candidate, Version: "v1.2.0"}), stderr: ""}) : goListMiss(candidate);
  };
  const chain: Array<GoProxyEntry> = [{url: "https://empty", fallback: ","}, {url: "direct", fallback: ","}];
  const ctx = rootCtx(url => {
    seen.push(url);
    return Promise.resolve({ok: false, status: 404} as any);
  }, chain[0].url, execFile, chain);
  expect(await resolveGoModuleRoot(`${moduleRoot}/cmd/govulncheck`, ".", ctx, [])).toBe(moduleRoot);
  expect(seen).toContain(`https://empty/${moduleRoot}/@latest`);
});

test("resolveGoModuleRoot never builds a proxy URL for off, direct or a GONOPROXY match", async () => {
  let fetched = false;
  const execFile = (_file: string, args: Array<string>) => goListMiss(args.at(-1)!.replace(/@latest$/, ""));
  const ctx = (goProxyUrl: string) => rootCtx(() => { fetched = true; return Promise.resolve({ok: true} as any); }, goProxyUrl, execFile);
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", ".", ctx("off"), [])).toBeNull();
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", ".", ctx("direct"), [])).toBeNull();
  expect(await resolveGoModuleRoot("git.corp.example/x/cmd/tool", ".", ctx("https://proxy"), ["git.corp.example"])).toBeNull();
  expect(fetched).toBe(false);
});

test("resolveGoModuleRoot surfaces direct and GONOPROXY lookup failures", async () => {
  const failure = (reason: string) => Promise.resolve({stdout: JSON.stringify({
    Path: "git.corp.example/x/cmd/tool", Version: "latest", Error: {Err: reason},
  }), stderr: ""});
  const direct = rootCtx(() => Promise.resolve({ok: true} as any), "direct", () => failure("dial tcp: lookup failed"));
  await expect(resolveGoModuleRoot("git.corp.example/x/cmd/tool", ".", direct, [])).rejects.toThrow("lookup failed");
  const noProxy = rootCtx(() => Promise.resolve({ok: true} as any), "https://proxy", () => failure("authentication required"));
  await expect(resolveGoModuleRoot("git.corp.example/x/cmd/tool", ".", noProxy, ["git.corp.example"])).rejects.toThrow("authentication required");
});

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

test("parseMakeImageValue parses a Hub image with registry prefix and digest", () => {
  expect(parseMakeImageValue(`docker.io/koalaman/shellcheck:v0.11.0@${digestA}`)).toEqual({
    writtenImage: "docker.io/koalaman/shellcheck",
    ref: {registry: null, namespace: "koalaman", repo: "shellcheck", tag: "v0.11.0", fullImage: "koalaman/shellcheck"},
    digest: digestA,
  });
  expect(parseMakeImageValue("mysql:3306")).toBeNull();
  expect(parseMakeImageValue("golang:1.21")).toBeNull();
  expect(parseMakeImageValue("ghcr.io/foo/bar:1.2.3")).toBeNull();
  expect(parseMakeImageValue("plain-no-tag")).toBeNull();
});

test("parseMakeDockerImages extracts only namespaced Hub images, skipping comments", () => {
  const content = [
    `SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@${digestA}  # renovate: datasource=docker`,
    "PLAIN := koalaman/shellcheck:0.9.0",
    "IMAGES += \\",
    "  \"koalaman/shellcheck:0.10.0\" koalaman/shellcheck:0.11.0",
    "MYSQL_HOST ?= mysql:3306",
    `# DISABLED := koalaman/shellcheck:0.1.0@${digestB}`,
  ].join("\n");
  expect(parseMakeDockerImages(content).map(i => ({image: i.writtenImage, tag: i.ref.tag, digest: i.digest}))).toEqual([
    {image: "docker.io/koalaman/shellcheck", tag: "v0.11.0", digest: digestA},
    {image: "koalaman/shellcheck", tag: "0.9.0", digest: null},
    {image: "koalaman/shellcheck", tag: "0.10.0", digest: null},
    {image: "koalaman/shellcheck", tag: "0.11.0", digest: null},
  ]);
});
