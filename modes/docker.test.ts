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
  dockerfileFromRe,
  composeImageRe,
} from "./docker.ts";

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
