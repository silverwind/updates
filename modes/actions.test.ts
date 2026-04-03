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
import {type ModeContext, fetchTimeout} from "./shared.ts";

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
test("getForgeApiBaseUrl null host passes through forgeApiUrl", () => {
  expect(getForgeApiBaseUrl(null, "https://api.github.com")).toBe("https://api.github.com");
});

test("getForgeApiBaseUrl github.com", () => {
  expect(getForgeApiBaseUrl("github.com", "anything")).toBe("https://api.github.com");
});

test("getForgeApiBaseUrl custom host", () => {
  expect(getForgeApiBaseUrl("gitea.example.com", "anything")).toBe("https://gitea.example.com/api/v1");
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

// fetchActionTagDate
test("fetchActionTagDate returns committer date", async () => {
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({committer: {date: "2025-01-01T00:00:00Z"}, author: {date: "2024-12-01T00:00:00Z"}})}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("2025-01-01T00:00:00Z");
});

test("fetchActionTagDate falls back to author date", async () => {
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({author: {date: "2024-12-01T00:00:00Z"}})}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("2024-12-01T00:00:00Z");
});

test("fetchActionTagDate returns empty on failure", async () => {
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("");
});

test("fetchActionTagDate returns empty on throw", async () => {
  const ctx = {
    fetchTimeout,
    doFetch: () => Promise.reject(new Error("network error")),
  } as unknown as ModeContext;
  expect(await fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).toBe("");
});

// resolveWorkflowFiles
test("resolveWorkflowFiles finds yaml files", () => {
  const dir = resolve("fixtures/docker-actions/.github/workflows");
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

test("updateWorkflowFile quoted uses", () => {
  const content = "    uses: 'actions/checkout@v3'\n";
  const result = updateWorkflowFile(content, [{name: "actions/checkout", oldRef: "v3", newRef: "v4"}]);
  expect(result).toBe("    uses: 'actions/checkout@v4'\n");
});
