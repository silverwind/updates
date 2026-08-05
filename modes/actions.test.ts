import {resolve} from "node:path";
import {
  parseActionRef,
  getForgeApiBaseUrl,
  formatActionVersion,
  isWorkflowFile,
  updateWorkflowFile,
  fetchActionTagDate,
  resolveWorkflowFiles,
  parseUsesLine,
} from "./actions.ts";
import {type ModeContext, fetchTimeout, hashRe, isVersionLikeRef} from "./shared.ts";

// parseActionRef
test.each([
  ["standard ref", "actions/checkout@v4", {host: null, owner: "actions", repo: "checkout", ref: "v4", name: "actions/checkout", isHash: false}],
  ["hash ref", "actions/checkout@abc1234567890", {host: null, owner: "actions", repo: "checkout", ref: "abc1234567890", name: "actions/checkout", isHash: true}],
  ["sub-path", "actions/cache/restore@v4", {host: null, owner: "actions", repo: "cache", ref: "v4", name: "actions/cache/restore", isHash: false}],
  ["URL with host", "https://gitea.example.com/owner/repo@v1", {host: "gitea.example.com", owner: "owner", repo: "repo", ref: "v1", name: "gitea.example.com/owner/repo", isHash: false}],
  ["docker prefix", "docker://node:18", null],
  ["local path", "./actions/my-action", null],
  ["no @", "actions/checkout", null],
  ["empty ref", "actions/checkout@", null],
])("parseActionRef %s", (_name, uses, expected) => {
  expect(parseActionRef(uses)).toEqual(expected);
});

// getForgeApiBaseUrl
test.each([
  ["falls back to the configured forge without a host", null, "https://gitea.example.com/api/v1", "https://gitea.example.com/api/v1"],
  ["lets a github host win over the configured forge", "github.com", "https://gitea.example.com/api/v1", "https://api.github.com"],
  ["lets a gitea host win over the configured forge", "gitea.example.com", "https://api.github.com", "https://gitea.example.com/api/v1"],
])("getForgeApiBaseUrl %s", (_name, host, configured, expected) => {
  expect(getForgeApiBaseUrl(host, configured)).toBe(expected);
});

test.each([
  ["strips a v prefix off the new version", "v5.0.0", "v4", "v5"],
  ["keeps a ref that never carried one bare", "5.0.0", "4", "5"],
])("formatActionVersion %s", (_name, newVersion, oldRef, expected) => {
  expect(formatActionVersion(newVersion, oldRef)).toBe(expected);
});

// isWorkflowFile
test.each([
  [".github/workflows/ci.yml", true],
  [".github/workflows/deploy.yaml", true],
  [".github\\workflows\\ci.yml", true], // windows backslashes
  [".github/actions/my-action/action.yml", true],
  [".github/actions/my-action/action.yaml", true],
  [".github/actions/group/sub/action.yml", true],
  [".github/action.yml", true],
  [".gitea/workflows/ci.yml", true],
  [".gitea/actions/my-action/action.yml", true],
  [".forgejo/workflows/ci.yml", true],
  [".forgejo/actions/my-action/action.yml", true],
  ["ci.yml", false],
  [".github/ci.yml", false],
  [".github/actions/my-action/other.yml", false], // only action.yml counts as a composite action
  ["actions/my-action/action.yml", false], // and only inside a forge dir
])("isWorkflowFile %s", (path, expected) => {
  expect(isWorkflowFile(path)).toBe(expected);
});

// updateWorkflowFile
test.each([
  ["a plain ref", {name: "actions/checkout", oldRef: "v3", newRef: "v4"},
    "    uses: actions/checkout@v3\n", "    uses: actions/checkout@v4\n"],
  ["a quoted ref", {name: "actions/checkout", oldRef: "v3", newRef: "v4"},
    "    uses: 'actions/checkout@v3'\n", "    uses: 'actions/checkout@v4'\n"],
  ["a host-qualified ref, keeping its url scheme", {name: "gitea.example.com/owner/repo", oldRef: "v1", newRef: "v2"},
    "    uses: https://gitea.example.com/owner/repo@v1\n", "    uses: https://gitea.example.com/owner/repo@v2\n"],
  ["only the ref that matches whole", {name: "actions/checkout", oldRef: "v1", newRef: "v4"},
    "    uses: actions/checkout@v1\n    uses: actions/checkout@v1.2\n",
    "    uses: actions/checkout@v4\n    uses: actions/checkout@v1.2\n"],
])("updateWorkflowFile replaces %s", (_name, replacement, content, expected) => {
  expect(updateWorkflowFile(content, [replacement])).toBe(expected);
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

test.each([
  ["single-quoted ref", "'actions/checkout@11bd719' # v4.2.2", "'actions/checkout@3d3c42e' # v7.0.1"],
  ["double-quoted ref", '"actions/checkout@11bd719" # v4.2.2', '"actions/checkout@3d3c42e" # v7.0.1'],
  ["tag= prefix", "actions/checkout@11bd719 # tag=v4.2.2", "actions/checkout@3d3c42e # v7.0.1"],
  ["pin prefix", "actions/checkout@11bd719 # pin v4.2.2", "actions/checkout@3d3c42e # v7.0.1"],
  ["renovate prefix", "actions/checkout@11bd719 # renovate: tag=v4.2.2", "actions/checkout@3d3c42e # v7.0.1"],
  ["ratchet prefix", "actions/checkout@11bd719 # ratchet:actions/checkout@v4.2.2", "actions/checkout@3d3c42e # v7.0.1"],
  ["no space before hash", "actions/checkout@11bd719 #v4.2.2", "actions/checkout@3d3c42e # v7.0.1"],
  ["text after the version", "actions/checkout@11bd719 # v4.2.2 (keep me)", "actions/checkout@3d3c42e # v7.0.1 (keep me)"],
  ["comment naming no version", "actions/checkout@11bd719 # ratchet:exclude", "actions/checkout@3d3c42e # ratchet:exclude"],
])("updateWorkflowFile rewrites the comment of a %s", (_name, oldLine, newLine) => {
  const result = updateWorkflowFile(`      - uses: ${oldLine}\n`, [
    {name: "actions/checkout", oldRef: "11bd719", newRef: "3d3c42e", newComment: "v7.0.1"},
  ]);
  expect(result).toBe(`      - uses: ${newLine}\n`);
});

test.each([
  ["a commented-out step", "      # - uses: actions/checkout@v3"],
  ["a shell string", '      - run: echo "uses: actions/checkout@v3"'],
  ["a run block line", "          echo uses: actions/checkout@v3"],
])("updateWorkflowFile leaves %s alone", (_name, line) => {
  expect(updateWorkflowFile(`${line}\n`, [{name: "actions/checkout", oldRef: "v3", newRef: "v4"}])).toBe(`${line}\n`);
});

test("updateWorkflowFile keeps crlf line endings", () => {
  const content = "    uses: actions/checkout@11bd719 # v4.2.2\r\n    uses: actions/checkout@11bd719\r\n";
  const result = updateWorkflowFile(content, [
    {name: "actions/checkout", oldRef: "11bd719", newRef: "3d3c42e", newComment: "v7.0.1"},
  ]);
  expect(result).toBe("    uses: actions/checkout@3d3c42e # v7.0.1\r\n    uses: actions/checkout@3d3c42e\r\n");
});

test("parseUsesLine splits a quoted sha pin from its prefixed comment", () => {
  expect(parseUsesLine(`      - uses: "actions/checkout@11bd719"  # tag=v4.2.2 rest`)).toEqual({
    prefix: "      - uses: ",
    quote: '"',
    value: "actions/checkout@11bd719",
    gap: "  ",
    comment: "# tag=v4.2.2 rest",
    pinnedVersion: "v4.2.2",
    pinnedEnd: 12,
  });
});

test("parseUsesLine ignores lines the reader ignores", () => {
  expect(parseUsesLine("      - run: echo uses: actions/checkout@v3")).toBeNull();
  expect(parseUsesLine("      # uses: actions/checkout@v3")).toBeNull();
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
test.each([
  ["returns committer date", "https://api.github.com",
    () => Promise.resolve({ok: true, json: () => Promise.resolve({committer: {date: "2025-01-01T00:00:00Z"}, author: {date: "2024-12-01T00:00:00Z"}})}),
    "2025-01-01T00:00:00Z"],
  ["falls back to author date", "https://api.github.com",
    () => Promise.resolve({ok: true, json: () => Promise.resolve({author: {date: "2024-12-01T00:00:00Z"}})}),
    "2024-12-01T00:00:00Z"],
  ["reads the gitea shape", "https://gitea.com/api/v1",
    () => Promise.resolve({ok: true, json: () => Promise.resolve({commit: {committer: {date: "2025-02-01T00:00:00Z"}, author: {date: "2025-01-15T00:00:00Z"}}})}),
    "2025-02-01T00:00:00Z"],
  ["returns empty when the commit carries no date", "https://api.github.com",
    () => Promise.resolve({ok: true, json: () => Promise.resolve({})}), ""],
  ["returns empty when the commit is gone", "https://api.github.com", () => Promise.resolve({ok: false, status: 404}), ""],
  ["returns undefined on an unclassified failure", "https://api.github.com", () => Promise.resolve({ok: false, status: 401}), undefined],
  ["returns undefined on a malformed body", "https://api.github.com",
    () => Promise.resolve({ok: true, json: () => Promise.reject(new Error("bad json"))}), undefined],
])("fetchActionTagDate %s", async (_name, apiUrl, doFetch, expected) => {
  const ctx = {fetchTimeout, noCache: true, doFetch} as unknown as ModeContext;
  expect(await fetchActionTagDate(apiUrl, "actions", "checkout", "abc123", ctx)).toBe(expected);
});

// Passing a forge failure off as an unknown date would let a cooldown read it as "held back".
test.each([
  ["a server fault", () => Promise.resolve({ok: false, status: 500, statusText: "Server Error"}), /Received 500/],
  ["a network failure", () => Promise.reject(new Error("network error")), /network error/],
])("fetchActionTagDate throws on %s", async (_name, doFetch, expected) => {
  const ctx = {fetchTimeout, noCache: true, doFetch} as unknown as ModeContext;
  await expect(fetchActionTagDate("https://api.github.com", "actions", "checkout", "abc123", ctx)).rejects.toThrow(expected);
});

// resolveWorkflowFiles
test.each([
  ["yaml files", "fixtures/docker-actions/.github", ["workflows/ci.yaml"]],
  ["composite actions", "fixtures/actions-composite/.github",
    ["actions/my-action/action.yml", "actions/nested/sub/action.yaml", "workflows/ci.yml"]],
  ["nothing in a dir without yaml", "fixtures/cargo", []],
  ["nothing in a non-existent dir", "/nonexistent/path", []],
])("resolveWorkflowFiles finds %s", (_name, path, expected) => {
  const dir = path.startsWith("/") ? path : resolve(path);
  const names = resolveWorkflowFiles(dir).map(file => file.slice(dir.length + 1).replace(/\\/g, "/"));
  expect(names.sort()).toEqual(expected);
});
