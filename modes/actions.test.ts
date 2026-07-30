import {resolve} from "node:path";
import {
  parseActionRef,
  getForgeApiBaseUrl,
  formatActionVersion,
  isWorkflowFile,
  updateWorkflowFile,
  fetchActionTagDate,
  resolveWorkflowFiles,
} from "./actions.ts";
import {type ModeContext, fetchTimeout, hashRe, isVersionLikeRef} from "./shared.ts";

// parseActionRef
test("parseActionRef standard ref", () => {
  expect(parseActionRef("actions/checkout@v4")).toEqual({host: null, owner: "actions", repo: "checkout", ref: "v4", name: "actions/checkout", isHash: false});
});

test("parseActionRef hash ref", () => {
  expect(parseActionRef("actions/checkout@abc1234567890")).toEqual({host: null, owner: "actions", repo: "checkout", ref: "abc1234567890", name: "actions/checkout", isHash: true});
});

test("parseActionRef sub-path", () => {
  expect(parseActionRef("actions/cache/restore@v4")).toEqual({host: null, owner: "actions", repo: "cache", ref: "v4", name: "actions/cache/restore", isHash: false});
});

test("parseActionRef URL with host", () => {
  expect(parseActionRef("https://gitea.example.com/owner/repo@v1")).toEqual({host: "gitea.example.com", owner: "owner", repo: "repo", ref: "v1", name: "gitea.example.com/owner/repo", isHash: false});
});

test("parseActionRef docker prefix returns null", () => {
  expect(parseActionRef("docker://node:18")).toBeNull();
});

test("parseActionRef local path returns null", () => {
  expect(parseActionRef("./actions/my-action")).toBeNull();
});

test("parseActionRef no @ returns null", () => {
  expect(parseActionRef("actions/checkout")).toBeNull();
});

test("parseActionRef empty ref returns null", () => {
  expect(parseActionRef("actions/checkout@")).toBeNull();
});

// getForgeApiBaseUrl
test("getForgeApiBaseUrl falls back to the configured forge without a host", () => {
  expect(getForgeApiBaseUrl(null, "https://gitea.example.com/api/v1")).toBe("https://gitea.example.com/api/v1");
});

test("getForgeApiBaseUrl lets a host in the ref win over the configured forge", () => {
  expect(getForgeApiBaseUrl("github.com", "https://gitea.example.com/api/v1")).toBe("https://api.github.com");
  expect(getForgeApiBaseUrl("gitea.example.com", "https://api.github.com")).toBe("https://gitea.example.com/api/v1");
});

// formatActionVersion
test("formatActionVersion 1-part precision", () => {
  expect(formatActionVersion("5.0.0", "v4")).toBe("v5");
});

test("formatActionVersion 2-part precision", () => {
  expect(formatActionVersion("5.1.0", "v4.1")).toBe("v5.1");
});

test("formatActionVersion 3-part precision", () => {
  expect(formatActionVersion("5.1.2", "v4.1.0")).toBe("v5.1.2");
});

test("formatActionVersion no v prefix", () => {
  expect(formatActionVersion("5.0.0", "4")).toBe("5");
});

test("formatActionVersion v-prefixed input", () => {
  expect(formatActionVersion("v5.0.0", "v4")).toBe("v5");
});

// isWorkflowFile
test("isWorkflowFile yml", () => {
  expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
});

test("isWorkflowFile yaml", () => {
  expect(isWorkflowFile(".github/workflows/deploy.yaml")).toBe(true);
});

test("isWorkflowFile rejects plain yml", () => {
  expect(isWorkflowFile("ci.yml")).toBe(false);
});

test("isWorkflowFile rejects wrong subdir", () => {
  expect(isWorkflowFile(".github/ci.yml")).toBe(false);
});

test("isWorkflowFile windows backslashes", () => {
  expect(isWorkflowFile(".github\\workflows\\ci.yml")).toBe(true);
});

test("isWorkflowFile composite action", () => {
  expect(isWorkflowFile(".github/actions/my-action/action.yml")).toBe(true);
});

test("isWorkflowFile composite action yaml", () => {
  expect(isWorkflowFile(".github/actions/my-action/action.yaml")).toBe(true);
});

test("isWorkflowFile composite action nested", () => {
  expect(isWorkflowFile(".github/actions/group/sub/action.yml")).toBe(true);
});

test("isWorkflowFile composite action at root of .github", () => {
  expect(isWorkflowFile(".github/action.yml")).toBe(true);
});

test("isWorkflowFile rejects non-action yml in .github subdir", () => {
  expect(isWorkflowFile(".github/actions/my-action/other.yml")).toBe(false);
});

test("isWorkflowFile rejects action.yml outside .github", () => {
  expect(isWorkflowFile("actions/my-action/action.yml")).toBe(false);
});

test("isWorkflowFile gitea workflow", () => {
  expect(isWorkflowFile(".gitea/workflows/ci.yml")).toBe(true);
});

test("isWorkflowFile gitea composite action", () => {
  expect(isWorkflowFile(".gitea/actions/my-action/action.yml")).toBe(true);
});

test("isWorkflowFile forgejo workflow", () => {
  expect(isWorkflowFile(".forgejo/workflows/ci.yml")).toBe(true);
});

test("isWorkflowFile forgejo composite action", () => {
  expect(isWorkflowFile(".forgejo/actions/my-action/action.yml")).toBe(true);
});

// updateWorkflowFile
test("updateWorkflowFile single replacement", () => {
  const content = "    uses: actions/checkout@v3\n";
  const result = updateWorkflowFile(content, [{name: "actions/checkout", oldRef: "v3", newRef: "v4"}]);
  expect(result).toBe("    uses: actions/checkout@v4\n");
});

test("updateWorkflowFile multiple replacements", () => {
  const content = "    uses: actions/checkout@v3\n    uses: actions/setup-node@v3\n";
  const result = updateWorkflowFile(content, [
    {name: "actions/checkout", oldRef: "v3", newRef: "v4"},
    {name: "actions/setup-node", oldRef: "v3", newRef: "v4"},
  ]);
  expect(result).toBe("    uses: actions/checkout@v4\n    uses: actions/setup-node@v4\n");
});

test("updateWorkflowFile moves the version comment along with the sha", () => {
  const content = "    uses: actions/checkout@11bd719 # v4.2.2\n    uses: actions/checkout@11bd719\n";
  const result = updateWorkflowFile(content, [
    {name: "actions/checkout", oldRef: "11bd719", newRef: "3d3c42e", newComment: "v7.0.1"},
  ]);
  expect(result).toBe("    uses: actions/checkout@3d3c42e # v7.0.1\n    uses: actions/checkout@3d3c42e\n");
});

// isVersionLikeRef
test("isVersionLikeRef separates versions from branches and other tag schemes", () => {
  expect(isVersionLikeRef("v4")).toBe(true);
  expect(isVersionLikeRef("4.1.2")).toBe(true);
  expect(isVersionLikeRef("v1.2.3-rc.1")).toBe(true);
  expect(isVersionLikeRef("release/v1")).toBe(false);
  expect(isVersionLikeRef("codeql-bundle-v2.20.3")).toBe(false);
  expect(isVersionLikeRef("main")).toBe(false);
});

// hashRe
test("hashRe accepts short shas but not all-numeric tags", () => {
  expect(hashRe.test("3d3c42")).toBe(true);
  expect(hashRe.test("11bd71901bbe5b1630ceea73d27597364c9af683")).toBe(true);
  expect(hashRe.test("20240115")).toBe(false);
});

// fetchActionTagDate
test("fetchActionTagDate returns committer date", async () => {
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({committer: {date: "2025-01-01T00:00:00Z"}, author: {date: "2024-12-01T00:00:00Z"}})}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("2025-01-01T00:00:00Z");
});

test("fetchActionTagDate falls back to author date", async () => {
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({author: {date: "2024-12-01T00:00:00Z"}})}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("2024-12-01T00:00:00Z");
});

test("fetchActionTagDate returns empty on failure", async () => {
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("");
});

test("fetchActionTagDate returns empty on throw", async () => {
  const ctx = {
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.reject(new Error("network error")),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("");
});

// resolveWorkflowFiles
test("resolveWorkflowFiles finds yaml files", () => {
  const dir = resolve("fixtures/docker-actions/.github");
  const result = resolveWorkflowFiles(dir);
  expect(result.length).toBe(1);
  expect(result[0]).toContain("ci.yaml");
});

test("resolveWorkflowFiles returns empty for non-existent dir", () => {
  expect(resolveWorkflowFiles("/nonexistent/path")).toEqual([]);
});

test("resolveWorkflowFiles returns empty for dir without yaml", () => {
  expect(resolveWorkflowFiles(resolve("fixtures/cargo"))).toEqual([]);
});

test("resolveWorkflowFiles finds composite actions", () => {
  const dir = resolve("fixtures/actions-composite/.github");
  const result = resolveWorkflowFiles(dir);
  const names = result.map(f => f.slice(dir.length + 1).replace(/\\/g, "/"));
  expect(names.sort()).toEqual([
    "actions/my-action/action.yml",
    "actions/nested/sub/action.yaml",
    "workflows/ci.yml",
  ]);
});

test("updateWorkflowFile quoted uses", () => {
  const content = "    uses: 'actions/checkout@v3'\n";
  const result = updateWorkflowFile(content, [{name: "actions/checkout", oldRef: "v3", newRef: "v4"}]);
  expect(result).toBe("    uses: 'actions/checkout@v4'\n");
});
