import {
  parseDockerImageRef,
  parseDockerTag,
  formatDockerVersion,
  isComposeFile,
  isDockerfile,
  isDockerFileName,
  getDockerInfoUrl,
  extractDockerRefs,
  findDockerVersion,
  updateDockerfile,
  updateComposeFile,
  updateWorkflowDockerImages,
  getExtractionRegex,
  dockerfileFromRe,
  composeImageRe,
  fetchDockerHubTags,
  fetchDockerInfo,
} from "./docker.ts";
import {type ModeContext, fieldSep} from "./shared.ts";

// parseDockerImageRef
test("parseDockerImageRef simple library image", () => {
  expect(parseDockerImageRef("node:18")).toEqual({registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"});
});

test("parseDockerImageRef namespaced image", () => {
  expect(parseDockerImageRef("myorg/myapp:1.0.0")).toEqual({registry: null, namespace: "myorg", repo: "myapp", tag: "1.0.0", fullImage: "myorg/myapp"});
});

test("parseDockerImageRef with registry", () => {
  expect(parseDockerImageRef("ghcr.io/owner/repo:v1.2.3")).toEqual({registry: "ghcr.io", namespace: "owner", repo: "repo", tag: "v1.2.3", fullImage: "ghcr.io/owner/repo"});
});

test("parseDockerImageRef strips docker:// prefix", () => {
  expect(parseDockerImageRef("docker://node:18")).toEqual({registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"});
});

test("parseDockerImageRef returns null for digest", () => {
  expect(parseDockerImageRef("node@sha256:abc123")).toBeNull();
});

test("parseDockerImageRef returns null for no tag", () => {
  expect(parseDockerImageRef("node")).toBeNull();
});

test("parseDockerImageRef returns null for non-semver tags", () => {
  expect(parseDockerImageRef("node:latest")).toBeNull();
  expect(parseDockerImageRef("node:bullseye")).toBeNull();
});

test("parseDockerImageRef tag with suffix", () => {
  const result = parseDockerImageRef("node:18-alpine");
  expect(result).toEqual({registry: null, namespace: "library", repo: "node", tag: "18-alpine", fullImage: "node"});
});

test("parseDockerImageRef full semver with suffix", () => {
  const result = parseDockerImageRef("node:18.19.1-bookworm");
  expect(result).toEqual({registry: null, namespace: "library", repo: "node", tag: "18.19.1-bookworm", fullImage: "node"});
});

// parseDockerTag
test("parseDockerTag major only", () => {
  expect(parseDockerTag("18")).toEqual({version: "18", suffix: ""});
});

test("parseDockerTag full semver", () => {
  expect(parseDockerTag("18.19.1")).toEqual({version: "18.19.1", suffix: ""});
});

test("parseDockerTag with suffix", () => {
  expect(parseDockerTag("18-alpine")).toEqual({version: "18", suffix: "-alpine"});
});

test("parseDockerTag v-prefix", () => {
  expect(parseDockerTag("v1.2.3")).toEqual({version: "v1.2.3", suffix: ""});
});

test("parseDockerTag returns null for non-semver", () => {
  expect(parseDockerTag("latest")).toBeNull();
  expect(parseDockerTag("bullseye")).toBeNull();
});

// formatDockerVersion
test("formatDockerVersion 1-part precision", () => {
  expect(formatDockerVersion("20.0.0", "18")).toBe("20");
});

test("formatDockerVersion 2-part precision", () => {
  expect(formatDockerVersion("20.0.0", "18.19")).toBe("20.0");
});

test("formatDockerVersion 3-part precision", () => {
  expect(formatDockerVersion("20.0.0", "18.19.1")).toBe("20.0.0");
});

test("formatDockerVersion preserves suffix", () => {
  expect(formatDockerVersion("20.0.0", "18-alpine")).toBe("20-alpine");
});

test("formatDockerVersion preserves v-prefix", () => {
  expect(formatDockerVersion("2.0.0", "v1.2.3")).toBe("v2.0.0");
});

test("formatDockerVersion returns oldTag for invalid tag", () => {
  expect(formatDockerVersion("2.0.0", "latest")).toBe("latest");
});

// isComposeFile
test("isComposeFile matches compose files", () => {
  expect(isComposeFile("docker-compose.yml")).toBe(true);
  expect(isComposeFile("docker-compose.yaml")).toBe(true);
  expect(isComposeFile("docker-stack.yml")).toBe(true);
});

test("isComposeFile rejects non-compose files", () => {
  expect(isComposeFile("Dockerfile")).toBe(false);
  expect(isComposeFile("random.yml")).toBe(false);
});

// isDockerfile
test("isDockerfile matches Dockerfiles", () => {
  expect(isDockerfile("Dockerfile")).toBe(true);
  expect(isDockerfile("Dockerfile.dev")).toBe(true);
  expect(isDockerfile("Dockerfile.prod")).toBe(true);
});

test("isDockerfile rejects non-Dockerfiles", () => {
  expect(isDockerfile("docker-compose.yml")).toBe(false);
  expect(isDockerfile("Makefile")).toBe(false);
});

// isDockerFileName
test("isDockerFileName matches both types", () => {
  expect(isDockerFileName("Dockerfile")).toBe(true);
  expect(isDockerFileName("Dockerfile.dev")).toBe(true);
  expect(isDockerFileName("docker-compose.yml")).toBe(true);
  expect(isDockerFileName("docker-stack.yaml")).toBe(true);
});

test("isDockerFileName rejects unrelated files", () => {
  expect(isDockerFileName("Makefile")).toBe(false);
  expect(isDockerFileName("random.yml")).toBe(false);
});

// getDockerInfoUrl
test("getDockerInfoUrl library image", () => {
  expect(getDockerInfoUrl({registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"})).toBe("https://hub.docker.com/_/node");
});

test("getDockerInfoUrl user image", () => {
  expect(getDockerInfoUrl({registry: null, namespace: "myorg", repo: "myapp", tag: "1.0", fullImage: "myorg/myapp"})).toBe("https://hub.docker.com/r/myorg/myapp");
});

test("getDockerInfoUrl custom registry returns empty", () => {
  expect(getDockerInfoUrl({registry: "ghcr.io", namespace: "owner", repo: "repo", tag: "v1", fullImage: "ghcr.io/owner/repo"})).toBe("");
});

// extractDockerRefs
test("extractDockerRefs with Dockerfile content", () => {
  const content = "FROM node:18\nFROM --platform=linux/amd64 nginx:1.25.3\nFROM ubuntu:latest\n";
  const results = extractDockerRefs(content, dockerfileFromRe);
  expect(results).toHaveLength(2);
  expect(results[0].ref.repo).toBe("node");
  expect(results[0].ref.tag).toBe("18");
  expect(results[1].ref.repo).toBe("nginx");
  expect(results[1].ref.tag).toBe("1.25.3");
});

test("extractDockerRefs with compose content", () => {
  const content = "services:\n  web:\n    image: node:20.11.1\n  db:\n    image: postgres:16.2\n";
  const results = extractDockerRefs(content, composeImageRe);
  expect(results).toHaveLength(2);
  expect(results[0].match).toBe("node:20.11.1");
  expect(results[1].match).toBe("postgres:16.2");
});

// findDockerVersion
test("findDockerVersion finds upgrade with same suffix", () => {
  const tagMap: Record<string, string> = {
    "18": "2024-01-01",
    "20": "2024-06-01",
    "20-alpine": "2024-06-01",
    "18-alpine": "2024-01-01",
  };
  const result = findDockerVersion(tagMap, "18", new Set(["patch", "minor", "major"]));
  expect(result).toEqual({newTag: "20", date: "2024-06-01"});
});

test("findDockerVersion returns null when no upgrade", () => {
  const tagMap: Record<string, string> = {"18": "2024-01-01"};
  expect(findDockerVersion(tagMap, "18", new Set(["patch", "minor", "major"]))).toBeNull();
});

test("findDockerVersion filters by suffix", () => {
  const tagMap: Record<string, string> = {
    "18-alpine": "2024-01-01",
    "20": "2024-06-01",
    "20-alpine": "2024-06-01",
  };
  const result = findDockerVersion(tagMap, "18-alpine", new Set(["patch", "minor", "major"]));
  expect(result).toEqual({newTag: "20-alpine", date: "2024-06-01"});
});

test("findDockerVersion returns null for invalid tag", () => {
  expect(findDockerVersion({"20": "2024-01-01"}, "latest", new Set(["patch", "minor", "major"]))).toBeNull();
});

test("findDockerVersion handles partial version tags", () => {
  const tagMap: Record<string, string> = {
    "18": "2024-01-01",
    "20": "2024-06-01",
    "20.11": "2024-06-01",
    "20.11.1": "2024-06-15",
  };
  // Tags "20", "20.11", "20.11.1" all coerce; highest coerced (20.11.1) wins
  const result = findDockerVersion(tagMap, "18", new Set(["patch", "minor", "major"]));
  expect(result).toEqual({newTag: "20", date: "2024-06-15"});
});

// updateDockerfile
test("updateDockerfile replaces FROM image tag", () => {
  const content = "FROM node:18\nRUN echo hello\n";
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20"}};
  expect(updateDockerfile(content, deps)).toBe("FROM node:20\nRUN echo hello\n");
});

test("updateDockerfile replaces FROM with platform", () => {
  const content = "FROM --platform=linux/amd64 nginx:1.25.3\n";
  const deps = {[`docker${fieldSep}nginx`]: {old: "1.25.3", new: "1.27.0"}};
  expect(updateDockerfile(content, deps)).toBe("FROM --platform=linux/amd64 nginx:1.27.0\n");
});

test("updateDockerfile uses oldOrig when present", () => {
  const content = "FROM node:18\n";
  const deps = {[`docker${fieldSep}node`]: {old: "18.0.0", new: "20", oldOrig: "18"}};
  expect(updateDockerfile(content, deps)).toBe("FROM node:20\n");
});

// updateComposeFile
test("updateComposeFile replaces image tag", () => {
  const content = "services:\n  web:\n    image: node:20.11.1\n";
  const deps = {[`docker${fieldSep}node`]: {old: "20.11.1", new: "22.0.0"}};
  expect(updateComposeFile(content, deps)).toBe("services:\n  web:\n    image: node:22.0.0\n");
});

test("updateComposeFile replaces quoted image tag", () => {
  const content = "services:\n  db:\n    image: 'postgres:16.2'\n";
  const deps = {[`docker${fieldSep}postgres`]: {old: "16.2", new: "17.0"}};
  expect(updateComposeFile(content, deps)).toBe("services:\n  db:\n    image: 'postgres:17.0'\n");
});

// updateWorkflowDockerImages
test("updateWorkflowDockerImages replaces container shorthand", () => {
  const content = "jobs:\n  build:\n    container: node:18\n";
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20"}};
  expect(updateWorkflowDockerImages(content, deps)).toBe("jobs:\n  build:\n    container: node:20\n");
});

test("updateWorkflowDockerImages replaces uses docker://", () => {
  const content = "steps:\n  - uses: docker://node:18\n";
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20"}};
  expect(updateWorkflowDockerImages(content, deps)).toBe("steps:\n  - uses: docker://node:20\n");
});

// getExtractionRegex
test("getExtractionRegex returns dockerfileFromRe for Dockerfile", () => {
  expect(getExtractionRegex("Dockerfile")).toBe(dockerfileFromRe);
  expect(getExtractionRegex("Dockerfile.dev")).toBe(dockerfileFromRe);
});

test("getExtractionRegex returns composeImageRe for compose files", () => {
  expect(getExtractionRegex("docker-compose.yml")).toBe(composeImageRe);
  expect(getExtractionRegex("docker-compose.yaml")).toBe(composeImageRe);
});

// fetchDockerHubTags
test("fetchDockerHubTags single page", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({count: 2, results: [{name: "18", tag_last_pushed: "2024-01-01"}, {name: "20", tag_last_pushed: "2024-06-01"}]})}),
  } as unknown as ModeContext;
  const tags = await fetchDockerHubTags("library", "node", ctx);
  expect(tags).toEqual({"18": "2024-01-01", "20": "2024-06-01"});
});

test("fetchDockerHubTags multi-page", async () => {
  const pages: Record<string, any> = {
    "page=1": {count: 250, results: [{name: "18", tag_last_pushed: "2024-01-01"}]},
    "page=2": {count: 250, results: [{name: "20", tag_last_pushed: "2024-06-01"}]},
    "page=3": {count: 250, results: [{name: "22", tag_last_pushed: "2025-01-01"}]},
  };
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: (url: string) => {
      for (const [key, data] of Object.entries(pages)) {
        if (url.includes(key)) return Promise.resolve({ok: true, json: () => Promise.resolve(data)});
      }
      return Promise.resolve({ok: true, json: () => Promise.resolve({count: 0, results: []})});
    },
  } as unknown as ModeContext;
  const tags = await fetchDockerHubTags("library", "node", ctx);
  expect(tags).toEqual({"18": "2024-01-01", "20": "2024-06-01", "22": "2025-01-01"});
});

test("fetchDockerHubTags first page fails", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: () => Promise.resolve({ok: false}),
  } as unknown as ModeContext;
  expect(await fetchDockerHubTags("library", "node", ctx)).toEqual({});
});

test("fetchDockerHubTags falls back to last_updated", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({count: 1, results: [{name: "18", last_updated: "2024-01-01"}]})}),
  } as unknown as ModeContext;
  const tags = await fetchDockerHubTags("library", "node", ctx);
  expect(tags).toEqual({"18": "2024-01-01"});
});

// fetchDockerInfo
test("fetchDockerInfo library image", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({count: 1, results: [{name: "18", tag_last_pushed: "2024-01-01"}]})}),
  } as unknown as ModeContext;
  const [data, , , name] = await fetchDockerInfo("node", "docker", ctx);
  expect(name).toBe("node");
  expect(data.tags).toEqual({"18": "2024-01-01"});
});

test("fetchDockerInfo namespaced image", async () => {
  const ctx = {
    dockerApiUrl: "https://hub.docker.com",
    fetchTimeout: 5000,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({count: 0, results: []})}),
  } as unknown as ModeContext;
  const [data, , , name] = await fetchDockerInfo("myorg/myapp", "docker", ctx);
  expect(name).toBe("myorg/myapp");
  expect(data.name).toBe("myorg/myapp");
});

test("fetchDockerInfo non-Docker-Hub registry throws", async () => {
  const ctx = {} as unknown as ModeContext;
  await expect(fetchDockerInfo("ghcr.io/owner/repo", "docker", ctx)).rejects.toThrow("not yet supported");
});
