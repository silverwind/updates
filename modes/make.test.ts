import {
  isMakeFileName,
  parseMakeGoInstalls,
  parseMakeImageValue,
  parseMakeDockerImages,
  moduleRootFromMajor,
  resolveGoModuleRoot,
  fetchMakeInfo,
  fetchMakeDockerInfo,
  updateMakefile,
} from "./make.ts";
import {type ModeContext, fetchTimeout, goProbeTimeout} from "./shared.ts";

const allSemvers = new Set(["patch", "minor", "major"]);
const defaultOpts = {semvers: allSemvers, useGreatest: false, usePre: false, useRel: false, allowDowngrade: false as const};

const sample = `GOLANGCI_PACKAGE ?= github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
AIR_PACKAGE := github.com/air-verse/air@v1.65.1
DLV_PACKAGE = github.com/go-delve/delve/cmd/dlv@v1
GOVULNCHECK_PACKAGE := golang.org/x/vuln/cmd/govulncheck@v1.2.0
# COMMENTED_PACKAGE := github.com/foo/bar@v9.9.9
MISSPELL_PACKAGE ?= github.com/golangci/misspell/cmd/misspell@v0.8.0  # inline note
NOT_GO := some-local-tool@v1.0.0
SOURCE_FILES := $(wildcard *.go)`;

// isMakeFileName
test("isMakeFileName matches make filenames", () => {
  expect(isMakeFileName("Makefile")).toBe(true);
  expect(isMakeFileName("makefile")).toBe(true);
  expect(isMakeFileName("GNUmakefile")).toBe(true);
  expect(isMakeFileName("build.mk")).toBe(true);
  expect(isMakeFileName("go.mod")).toBe(false);
  expect(isMakeFileName("Dockerfile")).toBe(false);
});

// parseMakeGoInstalls
test("parseMakeGoInstalls extracts go install specs across assignment operators", () => {
  expect(parseMakeGoInstalls(sample)).toEqual([
    {installPath: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint", version: "v2.12.2"},
    {installPath: "github.com/air-verse/air", version: "v1.65.1"},
    {installPath: "github.com/go-delve/delve/cmd/dlv", version: "v1"},
    {installPath: "golang.org/x/vuln/cmd/govulncheck", version: "v1.2.0"},
    {installPath: "github.com/golangci/misspell/cmd/misspell", version: "v0.8.0"},
  ]);
});

test("parseMakeGoInstalls skips commented lines and non-go values", () => {
  const paths = parseMakeGoInstalls(sample).map(i => i.installPath);
  expect(paths).not.toContain("github.com/foo/bar"); // full-line comment
  expect(paths).not.toContain("some-local-tool"); // no dotted host
  expect(parseMakeGoInstalls(sample).some(i => i.version === "v9.9.9")).toBe(false);
});

test("parseMakeGoInstalls accepts pseudo-versions, prereleases and +incompatible", () => {
  const content = [
    "PSEUDO := golang.org/x/tools/cmd/goimports@v0.0.0-20200103221440-774c71fcf114",
    "PRE := github.com/foo/bar@v1.2.3-rc.1",
    "INCOMPAT := github.com/foo/baz@v2.0.0+incompatible",
    "TABS\t:=\tgithub.com/foo/qux@v1.0.0",
  ].join("\n");
  expect(parseMakeGoInstalls(content)).toEqual([
    {installPath: "golang.org/x/tools/cmd/goimports", version: "v0.0.0-20200103221440-774c71fcf114"},
    {installPath: "github.com/foo/bar", version: "v1.2.3-rc.1"},
    {installPath: "github.com/foo/baz", version: "v2.0.0+incompatible"},
    {installPath: "github.com/foo/qux", version: "v1.0.0"},
  ]);
});

// moduleRootFromMajor
test("moduleRootFromMajor returns the path up to a /vN segment", () => {
  expect(moduleRootFromMajor("github.com/golangci/golangci-lint/v2/cmd/golangci-lint")).toBe("github.com/golangci/golangci-lint/v2");
  expect(moduleRootFromMajor("git.kcservices.at/libs/go-golangci-config/v13")).toBe("git.kcservices.at/libs/go-golangci-config/v13");
  expect(moduleRootFromMajor("github.com/air-verse/air")).toBeNull();
});

// updateMakefile
test("updateMakefile rewrites version while preserving operator, spacing and comments", () => {
  const updated = updateMakefile(sample, [
    {oldSpec: "github.com/air-verse/air@v1.65.1", newSpec: "github.com/air-verse/air@v1.65.3"},
    {oldSpec: "github.com/golangci/misspell/cmd/misspell@v0.8.0", newSpec: "github.com/golangci/misspell/cmd/misspell@v0.9.0"},
  ]);
  expect(updated).toContain("AIR_PACKAGE := github.com/air-verse/air@v1.65.3");
  expect(updated).toContain("MISSPELL_PACKAGE ?= github.com/golangci/misspell/cmd/misspell@v0.9.0  # inline note");
  expect(updated).toContain("# COMMENTED_PACKAGE := github.com/foo/bar@v9.9.9");
});

test("updateMakefile rewrites the install path on a major bump", () => {
  const updated = updateMakefile(sample, [{
    oldSpec: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2",
    newSpec: "github.com/golangci/golangci-lint/v3/cmd/golangci-lint@v3.0.0",
  }]);
  expect(updated).toContain("GOLANGCI_PACKAGE ?= github.com/golangci/golangci-lint/v3/cmd/golangci-lint@v3.0.0");
});

test("updateMakefile preserves CRLF line endings", () => {
  const crlf = "AIR := github.com/air-verse/air@v1.0.0\r\nFOO := bar\r\n";
  const updated = updateMakefile(crlf, [{
    oldSpec: "github.com/air-verse/air@v1.0.0", newSpec: "github.com/air-verse/air@v1.1.0",
  }]);
  expect(updated).toBe("AIR := github.com/air-verse/air@v1.1.0\r\nFOO := bar\r\n");
});

test("updateMakefile leaves a commented-out install untouched", () => {
  const updated = updateMakefile(sample, [{
    oldSpec: "github.com/foo/bar@v9.9.9", newSpec: "github.com/foo/bar@v10.0.0",
  }]);
  expect(updated).toContain("# COMMENTED_PACKAGE := github.com/foo/bar@v9.9.9");
  expect(updated).not.toContain("v10.0.0");
});

test("updateMakefile rewrites a spec directly followed by a # comment", () => {
  const updated = updateMakefile("IMG := koalaman/app:1.0.0#pinned\n", [{oldSpec: "koalaman/app:1.0.0", newSpec: "koalaman/app:1.1.0"}]);
  expect(updated).toBe("IMG := koalaman/app:1.1.0#pinned\n");
});

test("updateMakefile rewrites a docker image tag and digest in place", () => {
  const content = "SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@sha256:aaa  # renovate: datasource=docker\n";
  const updated = updateMakefile(content, [{
    oldSpec: "docker.io/koalaman/shellcheck:v0.11.0@sha256:aaa",
    newSpec: "docker.io/koalaman/shellcheck:v0.12.0@sha256:bbb",
  }]);
  expect(updated).toBe("SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.12.0@sha256:bbb  # renovate: datasource=docker\n");
});

// resolveGoModuleRoot
test("resolveGoModuleRoot uses the /vN heuristic without a lookup", async () => {
  let fetched = false;
  const ctx = {goProxyUrl: "https://proxy", goProbeTimeout, doFetch: () => { fetched = true; return Promise.resolve({ok: true} as any); }} as unknown as ModeContext;
  expect(await resolveGoModuleRoot("github.com/golangci/golangci-lint/v2/cmd/golangci-lint", ctx)).toBe("github.com/golangci/golangci-lint/v2");
  expect(fetched).toBe(false);
});

test("resolveGoModuleRoot probes prefixes longest-first", async () => {
  const ctx = {
    goProxyUrl: "https://proxy", goProbeTimeout,
    doFetch: (url: string) => Promise.resolve({ok: url.endsWith("golang.org/x/vuln/@latest")} as any),
  } as unknown as ModeContext;
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", ctx)).toBe("golang.org/x/vuln");
});

test("resolveGoModuleRoot returns null when probes error or nothing resolves", async () => {
  const errCtx = {goProxyUrl: "https://proxy", goProbeTimeout, doFetch: () => Promise.reject(new Error("network"))} as unknown as ModeContext;
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", errCtx)).toBeNull();
  const missCtx = {goProxyUrl: "https://proxy", goProbeTimeout, doFetch: () => Promise.resolve({ok: false} as any)} as unknown as ModeContext;
  expect(await resolveGoModuleRoot("golang.org/x/vuln/cmd/govulncheck", missCtx)).toBeNull();
});

// fetchMakeInfo
test("fetchMakeInfo resolves the latest version and preserves the install path", async () => {
  const ctx = {
    fetchTimeout, goProbeTimeout, goProxyUrl: "https://proxy", noCache: true,
    doFetch: (url: string) => Promise.resolve({
      ok: url.includes("golangci-lint/v2/@latest"),
      json: () => Promise.resolve({Version: "v2.15.0", Time: "2026-05-01T00:00:00Z"}),
    } as any),
  } as unknown as ModeContext;
  expect(await fetchMakeInfo("github.com/golangci/golangci-lint/v2/cmd/golangci-lint", "v2.12.2", ".", ctx, [], defaultOpts)).toEqual({
    newInstallPath: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint",
    newVersion: "v2.15.0",
    date: "2026-05-01T00:00:00Z",
    info: "https://github.com/golangci/golangci-lint",
  });
});

test("fetchMakeInfo returns null when the module cannot be resolved", async () => {
  const ctx = {fetchTimeout, goProbeTimeout, goProxyUrl: "https://proxy", doFetch: () => Promise.resolve({ok: false} as any)} as unknown as ModeContext;
  expect(await fetchMakeInfo("golang.org/x/vuln/cmd/govulncheck", "v1.2.0", ".", ctx, [], defaultOpts)).toBeNull();
});

test("fetchMakeInfo does not downgrade a pseudo-version to a lower release", async () => {
  const ctx = {
    fetchTimeout, goProbeTimeout, goProxyUrl: "https://proxy", noCache: true,
    doFetch: (url: string) => Promise.resolve({
      ok: url.includes("pseudopkg/@latest"),
      json: () => Promise.resolve({Version: "v0.4.1", Time: "2026-01-01T00:00:00Z"}),
    } as any),
  } as unknown as ModeContext;
  expect(await fetchMakeInfo("github.com/example/pseudopkg", "v0.4.2-0.20230802210424-5b0b94c5c0d3", ".", ctx, [], defaultOpts)).toBeNull();
});

test("fetchMakeInfo returns null when a partial version stays the same after precision formatting", async () => {
  const ctx = {
    fetchTimeout, goProbeTimeout, goProxyUrl: "https://proxy", noCache: true,
    doFetch: (url: string) => Promise.resolve({
      ok: url.includes("example/dlv/@latest"),
      json: () => Promise.resolve({Version: "v1.25.2", Time: "2026-03-01T00:00:00Z"}),
    } as any),
  } as unknown as ModeContext;
  expect(await fetchMakeInfo("github.com/example/dlv", "v1", ".", ctx, [], defaultOpts)).toBeNull();
});

test("fetchMakeInfo upgrades a pseudo-version to a newer release", async () => {
  const ctx = {
    fetchTimeout, goProbeTimeout, goProxyUrl: "https://proxy", noCache: true,
    doFetch: (url: string) => Promise.resolve({
      ok: url.includes("pseudoupd/@latest"),
      json: () => Promise.resolve({Version: "v1.5.0", Time: "2026-02-01T00:00:00Z"}),
    } as any),
  } as unknown as ModeContext;
  expect(await fetchMakeInfo("github.com/example/pseudoupd", "v0.0.0-20221128193559-754e69321358", ".", ctx, [], defaultOpts)).toEqual({
    newInstallPath: "github.com/example/pseudoupd",
    newVersion: "v1.5.0",
    date: "2026-02-01T00:00:00Z",
    info: "https://github.com/example/pseudoupd",
  });
});

// parseMakeImageValue / parseMakeDockerImages
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

test("parseMakeImageValue parses a Hub image with registry prefix and digest", () => {
  expect(parseMakeImageValue(`docker.io/koalaman/shellcheck:v0.11.0@${digestA}`)).toEqual({
    writtenImage: "docker.io/koalaman/shellcheck",
    ref: {registry: null, namespace: "koalaman", repo: "shellcheck", tag: "v0.11.0", fullImage: "koalaman/shellcheck"},
    digest: digestA,
  });
});

test("parseMakeImageValue skips library images, host:port and non-Hub registries", () => {
  expect(parseMakeImageValue("mysql:3306")).toBeNull(); // host:port, library namespace
  expect(parseMakeImageValue("golang:1.21")).toBeNull(); // bare library image
  expect(parseMakeImageValue("ghcr.io/foo/bar:1.2.3")).toBeNull(); // non-Hub registry
  expect(parseMakeImageValue("plain-no-tag")).toBeNull();
});

test("parseMakeDockerImages extracts only namespaced Hub images, skipping comments", () => {
  const content = [
    `SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@${digestA}  # renovate: datasource=docker`,
    "PLAIN := koalaman/shellcheck:0.9.0",
    "MYSQL_HOST ?= mysql:3306",
    `# DISABLED := koalaman/shellcheck:0.1.0@${digestB}`,
  ].join("\n");
  expect(parseMakeDockerImages(content).map(i => ({image: i.writtenImage, tag: i.ref.tag, digest: i.digest}))).toEqual([
    {image: "docker.io/koalaman/shellcheck", tag: "v0.11.0", digest: digestA},
    {image: "koalaman/shellcheck", tag: "0.9.0", digest: null},
  ]);
});

// fetchMakeDockerInfo
function dockerHubCtx(): ModeContext {
  return {
    dockerApiUrl: "https://hub.docker.com", fetchTimeout, noCache: true,
    doFetch: (url: string) => {
      if (url.includes("/tags/v0.12.0")) return Promise.resolve({ok: true, json: () => Promise.resolve({digest: digestB})} as any);
      if (url.includes("/tags")) return Promise.resolve({ok: true, json: () => Promise.resolve({count: 2, results: [
        {name: "v0.11.0", tag_last_pushed: "2025-01-01T00:00:00Z"},
        {name: "v0.12.0", tag_last_pushed: "2025-06-01T00:00:00Z"},
      ]})} as any);
      return Promise.resolve({ok: false} as any);
    },
  } as unknown as ModeContext;
}

test("fetchMakeDockerInfo bumps the tag and re-resolves the digest", async () => {
  const image = parseMakeImageValue(`docker.io/koalaman/shellcheck:v0.11.0@${digestA}`)!;
  expect(await fetchMakeDockerInfo(image, dockerHubCtx(), defaultOpts)).toEqual({
    newTag: "v0.12.0",
    newDigest: digestB,
    date: "2025-06-01T00:00:00Z",
    info: "https://hub.docker.com/r/koalaman/shellcheck",
  });
});

test("fetchMakeDockerInfo bumps the tag only when no digest is pinned", async () => {
  const image = parseMakeImageValue("koalaman/shellcheck:v0.11.0")!;
  expect(await fetchMakeDockerInfo(image, dockerHubCtx(), defaultOpts)).toEqual({
    newTag: "v0.12.0",
    newDigest: null,
    date: "2025-06-01T00:00:00Z",
    info: "https://hub.docker.com/r/koalaman/shellcheck",
  });
});

test("fetchMakeDockerInfo returns null when the new tag's digest cannot be resolved", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com", fetchTimeout, noCache: true,
    doFetch: (url: string) => {
      if (url.includes("/tags/v0.12.0")) return Promise.resolve({ok: false} as any); // digest lookup fails
      if (url.includes("/tags")) return Promise.resolve({ok: true, json: () => Promise.resolve({count: 2, results: [
        {name: "v0.11.0", tag_last_pushed: "2025-01-01T00:00:00Z"},
        {name: "v0.12.0", tag_last_pushed: "2025-06-01T00:00:00Z"},
      ]})} as any);
      return Promise.resolve({ok: false} as any);
    },
  } as unknown as ModeContext;
  const image = parseMakeImageValue(`docker.io/koalaman/shellcheck:v0.11.0@${digestA}`)!;
  expect(await fetchMakeDockerInfo(image, ctx, defaultOpts)).toBeNull();
});

test("fetchMakeDockerInfo returns null when no newer tag exists", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com", fetchTimeout, noCache: true,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({count: 1, results: [{name: "v0.11.0", tag_last_pushed: "2025-01-01T00:00:00Z"}]})} as any),
  } as unknown as ModeContext;
  expect(await fetchMakeDockerInfo(parseMakeImageValue("koalaman/shellcheck:v0.11.0")!, ctx, defaultOpts)).toBeNull();
});
