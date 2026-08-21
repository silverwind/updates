import {
  composeImageRe, dockerExactFileNames, dockerfileFromRe, dockerImageNames, extractDockerRefs, fetchDockerHubTags,
  fetchDockerInfo, fetchDockerTagDigest, filterStableTags, findDockerVersion, formatDockerVersion, getDockerInfoUrl,
  getExtractionRegex, isComposeFile, isDockerfile, isDockerFileName, parseDockerImageRef, parseDockerTag,
  updateComposeFile, updateDockerfile, updateWorkflowDockerImages,
} from "./docker.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

const allSemvers = new Set(["patch", "minor", "major"]);
const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;

test.each([
  ["simple library image", "node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"}],
  ["namespaced image", "myorg/myapp:1.0.0", {registry: null, namespace: "myorg", repo: "myapp", tag: "1.0.0", fullImage: "myorg/myapp"}],
  ["a registry", "ghcr.io/owner/repo:v1.2.3", {registry: "ghcr.io", namespace: "owner", repo: "repo", tag: "v1.2.3", fullImage: "ghcr.io/owner/repo"}],
  ["a docker:// prefix", "docker://node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"}],
  ["docker.io", "docker.io/library/node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "docker.io/library/node"}],
  ["index.docker.io", "index.docker.io/myorg/myapp:1.0.0", {registry: null, namespace: "myorg", repo: "myapp", tag: "1.0.0", fullImage: "index.docker.io/myorg/myapp"}],
  ["registry-1.docker.io", "registry-1.docker.io/node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "registry-1.docker.io/node"}],
  ["a deep Hub path", "org/team/image:1.2.3", {registry: null, namespace: "org/team", repo: "image", tag: "1.2.3", fullImage: "org/team/image"}],
  ["localhost registry", "localhost/owner/image:1.2.3", {registry: "localhost", namespace: "owner", repo: "image", tag: "1.2.3", fullImage: "localhost/owner/image"}],
  ["a tag with suffix", "node:18-alpine", {registry: null, namespace: "library", repo: "node", tag: "18-alpine", fullImage: "node"}],
  ["full semver with suffix", "node:18.19.1-bookworm", {registry: null, namespace: "library", repo: "node", tag: "18.19.1-bookworm", fullImage: "node"}],
  ["a digest", "node@sha256:abc123", {registry: null, namespace: "library", repo: "node", tag: "latest", fullImage: "node", digest: "sha256:abc123", digestOnly: true}],
  ["a tag and digest", "node:18@sha256:abc123", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node", digest: "sha256:abc123"}],
  ["a non-version tag and digest", "node:latest@sha256:abc123", {registry: null, namespace: "library", repo: "node", tag: "latest", fullImage: "node", digest: "sha256:abc123"}],
  ["no tag", "node", null],
  ["a non-semver tag", "node:latest", null],
  ["a non-semver word tag", "node:bullseye", null],
])("parseDockerImageRef %s", (_name, ref, expected) => {
  expect(parseDockerImageRef(ref)).toEqual(expected);
});

test("dockerImageNames", () => {
  const hub = ["mysql", "library/mysql", "docker.io/mysql", "docker.io/library/mysql"];
  expect(dockerImageNames("mysql")).toEqual(hub);
  expect(dockerImageNames("docker.io/mysql")).toEqual([
    "docker.io/mysql", ...hub.filter(name => name !== "docker.io/mysql"),
  ]);
  expect(dockerImageNames("index.docker.io/library/mysql")).toEqual(["index.docker.io/library/mysql", ...hub]);
  expect(dockerImageNames("grafana/grafana")).toEqual(["grafana/grafana", "docker.io/grafana/grafana"]);
  expect(dockerImageNames("ghcr.io/foo/bar")).toEqual(["ghcr.io/foo/bar"]);
});

test.each([
  ["18", {version: "18", prerelease: "", suffix: ""}],
  ["18.19.1", {version: "18.19.1", prerelease: "", suffix: ""}],
  ["18-alpine", {version: "18", prerelease: "", suffix: "-alpine"}],
  ["v1.2.3", {version: "v1.2.3", prerelease: "", suffix: ""}],
  ["1.2.3.4-alpine", {version: "1.2.3.4", prerelease: "", suffix: "-alpine"}],
  ["1.27-rc", {version: "1.27", prerelease: "", suffix: "-rc"}],
  ["1.27rc3", {version: "1.27", prerelease: "rc3", suffix: ""}],
  ["1.27rc3-alpine", {version: "1.27", prerelease: "rc3", suffix: "-alpine"}],
  ["latest", null],
  ["bullseye", null],
])("parseDockerTag %s", (tag, expected) => {
  expect(parseDockerTag(tag)).toEqual(expected);
});

test.each([
  ["splits the suffix off the tag and puts it back", "20.0.0", "18-alpine", "20-alpine"],
  ["returns oldTag for an unparseable tag", "2.0.0", "latest", "latest"],
])("formatDockerVersion %s", (_name, newSemver, oldTag, expected) => {
  expect(formatDockerVersion(newSemver, oldTag)).toBe(expected);
});

test.each([
  ["docker-compose.yml", true, false],
  ["docker-compose.yaml", true, false],
  ["docker-stack.yml", true, false],
  ["docker-stack.yaml", true, false],
  ["compose.yaml", true, false],
  ["compose.prod.yaml", true, false],
  ["compose.json", false, false],
  ["Dockerfile", false, true],
  ["Dockerfile.dev", false, true],
  ["Dockerfile.prod", false, true],
  ["Makefile", false, false],
  ["random.yml", false, false],
])("docker file predicates on %s", (name, compose, dockerfile) => {
  expect(isComposeFile(name)).toBe(compose);
  expect(isDockerfile(name)).toBe(dockerfile);
  expect(isDockerFileName(name)).toBe(compose || dockerfile);
});

test("dockerExactFileNames stay within isDockerFileName", () => {
  expect(dockerExactFileNames.every(isDockerFileName)).toBe(true);
  expect(dockerExactFileNames).toContain("compose.yaml");
});

test.each([
  ["library image", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"}, "https://hub.docker.com/_/node"],
  ["user image", {registry: null, namespace: "myorg", repo: "myapp", tag: "1.0", fullImage: "myorg/myapp"}, "https://hub.docker.com/r/myorg/myapp"],
  ["custom registry", {registry: "ghcr.io", namespace: "owner", repo: "repo", tag: "v1", fullImage: "ghcr.io/owner/repo"}, ""],
])("getDockerInfoUrl %s", (_name, ref, expected) => {
  expect(getDockerInfoUrl(ref)).toBe(expected);
});

test("extractDockerRefs", () => {
  const dockerfile = [
    "ARG NODE_VERSION=18",
    `FROM node:\${NODE_VERSION}`,
    "FROM --platform=$BUILDPLATFORM \\",
    "  nginx:1.25.3@sha256:abc123",
    "FROM ubuntu:latest",
    "",
  ].join("\n");
  const dockerfileRefs = extractDockerRefs(dockerfile, dockerfileFromRe);
  expect(dockerfileRefs).toHaveLength(2);
  expect(dockerfileRefs[0].ref.repo).toBe("node");
  expect(dockerfileRefs[0].ref.tag).toBe("18");
  expect(dockerfileRefs[1].ref.repo).toBe("nginx");
  expect(dockerfileRefs[1].ref.tag).toBe("1.25.3");
  expect(dockerfileRefs[1].ref.digest).toBe("sha256:abc123");
  const compose = "services:\n  web:\n    image: node:20.11.1\n  db:\n    image: postgres:16.2\n    build: .\n";
  const composeRefs = extractDockerRefs(compose, composeImageRe);
  expect(composeRefs).toHaveLength(1);
  expect(composeRefs[0].match).toBe("node:20.11.1");
});

test("findDockerVersion basic selection", () => {
  const tagMap: Record<string, string> = {
    "18": "2024-01-01",
    "20": "2024-06-01",
    "20-alpine": "2024-06-01",
    "18-alpine": "2024-01-01",
  };
  const result = findDockerVersion(tagMap, "18", allSemvers);
  expect(result).toEqual({newTag: "20", date: "2024-06-01"});
  expect(findDockerVersion({"18": "2024-01-01"}, "18", allSemvers)).toBeNull();
  expect(findDockerVersion({"20": "2024-01-01"}, "latest", allSemvers)).toBeNull();
});

test("findDockerVersion filters by suffix", () => {
  const tagMap: Record<string, string> = {
    "18-alpine": "2024-01-01",
    "20": "2024-06-01",
    "20-alpine": "2024-06-01",
  };
  expect(findDockerVersion(tagMap, "18-alpine", allSemvers)).toEqual({newTag: "20-alpine", date: "2024-06-01"});
  expect(findDockerVersion({"18": "2024-01-01", "20-alpine": "2024-06-01"}, "18", allSemvers)).toBeNull();
  const suffixed: Record<string, string> = {
    "1.2.3-alpine3.19": "2024-01-01",
    "1.3.0-alpine": "2024-06-01",
    "1.3.0-alpine3.20": "2024-06-01",
    "1.3.0-alpine3.19": "2024-06-02",
    "1.3.0-nanoserver-1809": "2024-06-03",
  };
  expect(findDockerVersion(suffixed, "1.2.3-alpine3.19", allSemvers)).toEqual({newTag: "1.3.0-alpine3.19", date: "2024-06-02"});
  expect(findDockerVersion(suffixed, "1.2.3-nanoserver-1809", allSemvers)).toEqual({newTag: "1.3.0-nanoserver-1809", date: "2024-06-03"});
});

test("findDockerVersion keeps the authored precision", () => {
  const tagMap: Record<string, string> = {
    "18": "2024-01-01",
    "20": "2024-06-01",
    "20.11": "2024-06-10",
    "20.11.1": "2024-06-15",
  };
  expect(findDockerVersion(tagMap, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-01"});
  expect(findDockerVersion(tagMap, "18.19", allSemvers)).toEqual({newTag: "20.11", date: "2024-06-10"});
  expect(findDockerVersion({"18": "2024-01-01", "20.11.1": "2024-06-15"}, "18", allSemvers)).toBeNull();
  expect(findDockerVersion({"24.04": "2024-04-01", "26.04": "2026-04-01"}, "24.04", allSemvers))
    .toEqual({newTag: "26.04", date: "2026-04-01"});
  expect(findDockerVersion({"1.2.3.4-alpine": "2024-01-01", "1.2.3.5-alpine": "2024-06-01"}, "1.2.3.4-alpine", allSemvers))
    .toEqual({newTag: "1.2.3.5-alpine", date: "2024-06-01"});
});

test("findDockerVersion ignores tags from another versioning scheme", () => {
  const tagMap: Record<string, string> = {
    "3": "2026-06-16",
    "3.24": "2026-06-16",
    "3.24.1": "2026-06-16",
    "20260127": "2026-01-28",
  };
  expect(findDockerVersion(tagMap, "3.24", allSemvers)).toBeNull();
  expect(findDockerVersion(tagMap, "3", allSemvers)).toBeNull();
  expect(findDockerVersion(tagMap, "20251224", allSemvers)).toEqual({newTag: "20260127", date: "2026-01-28"});
  expect(findDockerVersion({"9": "2020-01-01", "10": "2020-06-01"}, "9", allSemvers)).toEqual({newTag: "10", date: "2020-06-01"});
});

test("findDockerVersion cooldown needs a timestamp", () => {
  const now = Date.parse("2024-07-01");
  const tagMap: Record<string, string> = {"18": "2024-01-01", "20": "2024-06-25", "19": ""};
  expect(findDockerVersion(tagMap, "18", allSemvers, 30, now)).toBeNull();
  expect(findDockerVersion(tagMap, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-25"});
});

test("findDockerVersion respects pinnedRange", () => {
  expect(findDockerVersion({
    "8.0": "2024-01-01",
    "8.0.41": "2024-06-01",
    "9.7": "2024-12-01",
  }, "8.0", allSemvers, undefined, undefined, "8.0")).toBeNull();
  expect(findDockerVersion({
    "8.0.0": "2024-01-01",
    "8.0.41": "2024-06-01",
    "9.7": "2024-12-01",
  }, "8.0.0", allSemvers, undefined, undefined, "8.0")).toEqual({newTag: "8.0.41", date: "2024-06-01"});
});

test.each([
  ["updateDockerfile replaces a FROM image tag", updateDockerfile,
    "FROM node:18\nRUN echo hello\n", "node", {old: "18", new: "20"}, "FROM node:20\nRUN echo hello\n"],
  ["updateDockerfile replaces a lowercase from", updateDockerfile,
    "from node:18\n", "node", {old: "18", new: "20"}, "from node:20\n"],
  ["updateDockerfile replaces a FROM with platform", updateDockerfile,
    "FROM --platform=linux/amd64 nginx:1.25.3\n", "nginx", {old: "1.25.3", new: "1.27.0"}, "FROM --platform=linux/amd64 nginx:1.27.0\n"],
  ["updateDockerfile uses oldOrig when present", updateDockerfile,
    "FROM node:18\n", "node", {old: "18.0.0", new: "20", oldOrig: "18"}, "FROM node:20\n"],
  ["updateComposeFile replaces an image tag", updateComposeFile,
    "services:\n  web:\n    image: node:20.11.1\n", "node", {old: "20.11.1", new: "22.0.0"}, "services:\n  web:\n    image: node:22.0.0\n"],
  ["updateComposeFile replaces a quoted image tag", updateComposeFile,
    "services:\n  db:\n    image: 'postgres:16.2'\n", "postgres", {old: "16.2", new: "17.0"}, "services:\n  db:\n    image: 'postgres:17.0'\n"],
  ["updateWorkflowDockerImages replaces a container shorthand", updateWorkflowDockerImages,
    "jobs:\n  build:\n    container: node:18\n", "node", {old: "18", new: "20"}, "jobs:\n  build:\n    container: node:20\n"],
  ["updateWorkflowDockerImages replaces a uses docker://", updateWorkflowDockerImages,
    "steps:\n  - uses: docker://node:18\n", "node", {old: "18", new: "20"}, "steps:\n  - uses: docker://node:20\n"],
  ["updateDockerfile replaces an uppercase tag", updateDockerfile,
    "FROM foo/bar:1.0-RC1\n", "foo/bar", {old: "1.0", oldOrig: "1.0-RC1", new: "1.1-RC1"}, "FROM foo/bar:1.1-RC1\n"],
  ["updateComposeFile replaces an uppercase tag", updateComposeFile,
    "    image: foo/bar:1.0-RC1\n", "foo/bar", {old: "1.0", oldOrig: "1.0-RC1", new: "1.1-RC1"}, "    image: foo/bar:1.1-RC1\n"],
  ["updateWorkflowDockerImages replaces an uppercase container tag", updateWorkflowDockerImages,
    "    container: foo/bar:1.0-RC1\n", "foo/bar", {old: "1.0", oldOrig: "1.0-RC1", new: "1.1-RC1"}, "    container: foo/bar:1.1-RC1\n"],
  ["updateWorkflowDockerImages replaces an uppercase uses tag", updateWorkflowDockerImages,
    "      - uses: docker://foo/bar:1.0-RC1\n", "foo/bar", {old: "1.0", oldOrig: "1.0-RC1", new: "1.1-RC1"},
    "      - uses: docker://foo/bar:1.1-RC1\n"],
])("%s", (_name, update, content, image, dep, expected) => {
  expect(update(content, {[`docker${fieldSep}${image}`]: dep})).toBe(expected);
});

test("updateDockerfile rewrites tag and digest atomically", () => {
  const content = `FROM node:18 AS build\nFROM node:18@${oldDigest}\nFROM node:18+build\n`;
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20", oldDigest, newDigest}};
  expect(updateDockerfile(content, deps)).toBe(`FROM node:18 AS build\nFROM node:20@${newDigest}\nFROM node:18+build\n`);
  expect(updateDockerfile(content, {[`docker${fieldSep}node`]: {old: "18", new: "20"}}))
    .toBe(`FROM node:20 AS build\nFROM node:18@${oldDigest}\nFROM node:18+build\n`);
});

test("Docker image writers rewrite digest references atomically", () => {
  const tagged = {[`docker${fieldSep}node`]: {old: "18", new: "20", oldDigest, newDigest}};
  expect(updateComposeFile(`services:\n  app:\n    image: node:18@${oldDigest}\n`, tagged))
    .toBe(`services:\n  app:\n    image: node:20@${newDigest}\n`);
  expect(updateWorkflowDockerImages(`steps:\n  - uses: docker://node:18@${oldDigest}\n`, tagged))
    .toBe(`steps:\n  - uses: docker://node:20@${newDigest}\n`);
  const digestOnly = {[`docker${fieldSep}node`]: {old: "latest", new: "latest", oldDigest, newDigest, digestOnly: true}};
  expect(updateWorkflowDockerImages(`steps:\n  - uses: docker://node@${oldDigest}\n`, digestOnly))
    .toBe(`steps:\n  - uses: docker://node@${newDigest}\n`);
});

test("updateDockerfile rewrites the ARG owning a multiline FROM version", () => {
  const version = "$" + "{VERSION}";
  const content = `ARG VERSION=18\nFROM --platform=$BUILDPLATFORM \\\n  node:${version}\n`;
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20"}};
  expect(updateDockerfile(content, deps)).toBe(`ARG VERSION=20\nFROM --platform=$BUILDPLATFORM \\\n  node:${version}\n`);
});

test("updateDockerfile rewrites an ARG and digest atomically", () => {
  const version = "$" + "{VERSION}";
  const content = `ARG VERSION=18\nFROM node:${version}@${oldDigest}\n`;
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20", oldDigest, newDigest}};
  expect(updateDockerfile(content, deps)).toBe(`ARG VERSION=20\nFROM node:${version}@${newDigest}\n`);
});

test("updateComposeFile leaves locally built service images alone", () => {
  const content = "services:\n  built:\n    image: node:18\n    build: .\n  pulled:\n    image: node:18\n";
  const deps = {[`docker${fieldSep}node`]: {old: "18", new: "20"}};
  expect(updateComposeFile(content, deps)).toBe("services:\n  built:\n    image: node:18\n    build: .\n  pulled:\n    image: node:20\n");
});

test("updateDockerfile rewrites one image at several tags without cascading", () => {
  const content = "FROM node:18 AS build\nFROM node:18-alpine\nFROM node:20\n";
  const deps = {
    [`docker${fieldSep}node${fieldSep}18`]: {old: "18", new: "20"},
    [`docker${fieldSep}node${fieldSep}18-alpine`]: {old: "18-alpine", new: "20-alpine"},
    [`docker${fieldSep}node${fieldSep}20`]: {old: "20", new: "22"},
  };
  expect(updateDockerfile(content, deps)).toBe("FROM node:20 AS build\nFROM node:20-alpine\nFROM node:22\n");
});

test.each([
  ["Dockerfile", dockerfileFromRe],
  ["Dockerfile.dev", dockerfileFromRe],
  ["docker-compose.yml", composeImageRe],
  ["docker-compose.yaml", composeImageRe],
])("getExtractionRegex %s", (name, expected) => {
  expect(getExtractionRegex(name)).toBe(expected);
});

const hubCtx = (doFetch: (url: string) => Promise<any>, extra: Record<string, unknown> = {}): ModeContext =>
  ({dockerApiUrl: "https://hub.docker.com", fetchTimeout, doFetch, ...extra} as unknown as ModeContext);
const hubBody = (body: any) => () => Promise.resolve(Response.json(body));
const hubPages = (pages: Record<string, any>, seen: Array<string> = []) => (url: string) => {
  const page = /page=\d+/.exec(url)![0];
  seen.push(page);
  return hubBody(pages[page] ?? {count: 0, results: []})();
};

test.each([
  ["reads tag_last_pushed", [{name: "18", tag_last_pushed: "2024-01-01"}, {name: "20", tag_last_pushed: "2024-06-01"}],
    {"18": "2024-01-01", "20": "2024-06-01"}],
  ["falls back to last_updated", [{name: "18", last_updated: "2024-01-01"}], {"18": "2024-01-01"}],
])("fetchDockerHubTags %s", async (_name, results, expected) => {
  const ctx = hubCtx(hubBody({count: results.length, results}));
  expect(await fetchDockerHubTags("library", "node", ctx)).toEqual(expected);
});

test("fetchDockerHubTags walks every page", async () => {
  const ctx = hubCtx(hubPages({
    "page=1": {count: 1, next: "?page=2", results: [{name: "18", tag_last_pushed: "2024-01-01"}]},
    "page=2": {count: 1, next: "?page=3", results: [{name: "20", tag_last_pushed: "2024-06-01"}]},
    "page=3": {count: 2500, results: [{name: "22", tag_last_pushed: "2025-01-01"}]},
  }));
  expect(await fetchDockerHubTags("library", "node", ctx)).toEqual({"18": "2024-01-01", "20": "2024-06-01", "22": "2025-01-01"});
});

test("fetchDockerHubTags walks past pages older than the authored tag", async () => {
  const fetched: Array<string> = [];
  const ctx = hubCtx(hubPages({
    "page=1": {count: 4000, results: [{name: "18", tag_last_pushed: "2026-01-01"}]},
    "page=2": {count: 4000, results: [{name: "17", tag_last_pushed: "2025-06-01"}]},
    "page=3": {count: 4000, results: [{name: "16", tag_last_pushed: "2025-01-01"}]},
    "page=4": {count: 4000, results: [{name: "20", tag_last_pushed: "2024-06-01"}]},
  }, fetched), {concurrency: 1});

  const tags = await fetchDockerHubTags("library", "node", ctx);
  expect(fetched).toEqual(["page=1", "page=2", "page=3", "page=4"]);
  expect(findDockerVersion(tags, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-01"});
});

test("fetchDockerHubTags caps count and next pagination at 20 pages", async () => {
  const fetched: Array<number> = [];
  const ctx = hubCtx((url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    fetched.push(page);
    return hubBody({count: 1000000, next: `?page=${page + 1}`, results: [{name: String(page)}]})();
  }, {noCache: true});
  await fetchDockerHubTags("library", "bounded", ctx);
  expect(fetched).toEqual(Array.from({length: 20}, (_, index) => index + 1));
});

test("fetchDockerHubTags reports registry failures instead of no update", async () => {
  const ctxFor = (res: any) => hubCtx(() => typeof res === "function" ? res() : Promise.resolve(res));
  expect(await fetchDockerHubTags("library", "node", ctxFor({ok: false, status: 404, statusText: "Not Found"}))).toEqual({});
  expect(await fetchDockerHubTags("library", "node", ctxFor({ok: false, status: 401, statusText: "Unauthorized"}))).toEqual({});
  await expect(fetchDockerHubTags("library", "node", ctxFor({ok: false, status: 429, statusText: "Too Many Requests"})))
    .rejects.toThrow("Received 429 Too Many Requests");
  await expect(fetchDockerHubTags("library", "node", ctxFor({ok: false, status: 500, statusText: "Internal Server Error"})))
    .rejects.toThrow("Received 500 Internal Server Error");
  await expect(fetchDockerHubTags("library", "node", ctxFor(() => Promise.reject(new Error("connect ECONNREFUSED")))))
    .rejects.toThrow("ECONNREFUSED");
});

test("fetchDockerTagDigest returns the registry digest and reports failures", async () => {
  await expect(fetchDockerTagDigest("library", "node", "20", hubCtx(hubBody({digest: newDigest}))))
    .resolves.toBe(newDigest);
  await expect(fetchDockerTagDigest("library", "node", "20", hubCtx(() => Promise.resolve({
    ok: false, status: 429, statusText: "Too Many Requests",
  })))).rejects.toThrow("Received 429 Too Many Requests");
  await expect(fetchDockerTagDigest("library", "node", "20", hubCtx(hubBody({}))))
    .rejects.toThrow("Malformed Docker Hub tag response");
});

test("fetchDockerInfo library image", async () => {
  const ctx = hubCtx(hubBody({count: 1, results: [{name: "18", tag_last_pushed: "2024-01-01"}]}));
  const [data] = await fetchDockerInfo("node", ctx);
  expect(data.name).toBe("node");
  expect(data.tags).toEqual({"18": "2024-01-01"});
});

test("filterStableTags drops the ubuntu development series", () => {
  const tags: Record<string, string> = {
    "22.04": "2026-08-04", "24.04": "2026-08-04", "26.04": "2026-08-04",
    "25.04": "2025-10-13", "25.10": "2026-06-19", "26.10": "2026-07-16", "28.04": "2027-11-01",
    latest: "2026-08-04", devel: "2026-07-16",
  };
  const now = Date.UTC(2026, 7, 4);
  expect(Object.keys(filterStableTags("ubuntu", tags, now))).toEqual(["22.04", "24.04", "26.04", "latest", "devel"]);
  expect(filterStableTags("node", tags, now)).toBe(tags);
});

test("fetchDockerInfo non-Docker-Hub registry throws", async () => {
  const ctx = {} as unknown as ModeContext;
  await expect(fetchDockerInfo("ghcr.io/owner/repo", ctx)).rejects.toThrow("not yet supported");
});
