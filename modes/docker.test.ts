import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {updates} from "../api.ts";
import {
  composeImageRe, dockerExactFileNames, dockerfileFromRe, dockerImageNames, dockerTagVersion, extractDockerRefs,
  fetchDockerHubTags, fetchDockerInfo, fetchDockerTagDigest, filterStableTags, findDockerVersion, getDockerInfoUrl,
  getExtractionRegex, isComposeFile, isDockerfile, isDockerFileName, parseDockerImageRef, parseDockerTag,
  updateComposeFile, updateDockerfile, updateWorkflowDockerImages,
} from "./docker.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

const allSemvers = new Set(["patch", "minor", "major"]);
const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const nodeDep = {old: "18", new: "20"};
const nodeDigestDep = {...nodeDep, oldDigest, newDigest};
const rcDep = {old: "1.0", oldOrig: "1.0-RC1", new: "1.1-RC1"};
const argVersion = "$" + "{VERSION}";

test.each([
  ["simple library image", "node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"}],
  ["namespaced image", "myorg/myapp:1.0.0", {registry: null, namespace: "myorg", repo: "myapp", tag: "1.0.0", fullImage: "myorg/myapp"}],
  ["a registry", "ghcr.io/owner/repo:v1.2.3", {registry: "ghcr.io", namespace: "owner", repo: "repo", tag: "v1.2.3", fullImage: "ghcr.io/owner/repo"}],
  ["a docker:// prefix", "docker://node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "node"}],
  ["docker.io", "docker.io/library/node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "docker.io/library/node"}],
  ["index.docker.io", "index.docker.io/myorg/myapp:1.0.0", {registry: null, namespace: "myorg", repo: "myapp", tag: "1.0.0", fullImage: "index.docker.io/myorg/myapp"}],
  ["registry-1.docker.io", "registry-1.docker.io/node:18", {registry: null, namespace: "library", repo: "node", tag: "18", fullImage: "registry-1.docker.io/node"}],
  ["a registry without a domain suffix", "org/team/image:1.2.3", {registry: "org", namespace: "team", repo: "image", tag: "1.2.3", fullImage: "org/team/image"}],
  ["localhost registry", "localhost/owner/image:1.2.3", {registry: "localhost", namespace: "owner", repo: "image", tag: "1.2.3", fullImage: "localhost/owner/image"}],
  ["a tag with suffix", "node:18-alpine", {registry: null, namespace: "library", repo: "node", tag: "18-alpine", fullImage: "node"}],
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
  expect(dockerImageNames("REGISTRY/team/image")).toEqual(["REGISTRY/team/image"]);
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
  ["21.0.5_11-jdk-alpine", {version: "21.0.5_11", prerelease: "", suffix: "-jdk-alpine"}],
  ["21_35-jdk", {version: "21_35", prerelease: "", suffix: "-jdk"}],
  ["1_2_3", null],
  ["8f3a2b1", null],
  ["7.0.0RC1", {version: "7.0.0", prerelease: "RC1", suffix: ""}],
  ["V1.2.3", null],
])("parseDockerTag %s", (tag, expected) => {
  expect(parseDockerTag(tag)).toEqual(expected);
});

test.each([
  ["docker-compose.yml", true, false],
  ["docker-compose.yaml", true, false],
  ["docker-stack.yml", true, false],
  ["compose.yaml", true, false],
  ["compose.prod.yaml", true, false],
  ["compose.json", false, false],
  ["Dockerfile", false, true],
  ["Dockerfile.dev", false, true],
  ["Makefile", false, false],
  ["random.yml", false, false],
])("docker file predicates on %s", (name, compose, dockerfile) => {
  expect(isComposeFile(name)).toBe(compose);
  expect(isDockerfile(name)).toBe(dockerfile);
  expect(isDockerFileName(name)).toBe(compose || dockerfile);
  expect(getExtractionRegex(name)).toBe(dockerfile ? dockerfileFromRe : composeImageRe);
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
  expect(extractDockerRefs(dockerfile, dockerfileFromRe).map(({ref}) => ref)).toMatchObject([
    {repo: "node", tag: "18"}, {repo: "nginx", tag: "1.25.3", digest: "sha256:abc123"},
  ]);
  const compose = "services:\n  web:\n    image: node:20.11.1\n  db:\n    image: postgres:16.2\n    build: .\n";
  expect(extractDockerRefs(compose, composeImageRe).map(({match}) => match)).toEqual(["node:20.11.1"]);
  expect(extractDockerRefs("\uFEFFFROM node:18\n", dockerfileFromRe).map(({ref}) => ref.tag)).toEqual(["18"]);
});

test("findDockerVersion basic selection", () => {
  const tagMap = {"18": "2024-01-01", "20": "2024-06-01", "20-alpine": "2024-06-01", "18-alpine": "2024-01-01"};
  expect(findDockerVersion(tagMap, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-01"});
  expect(findDockerVersion({"18": "2024-01-01"}, "18", allSemvers)).toBeNull();
  expect(findDockerVersion({"20": "2024-01-01"}, "latest", allSemvers)).toBeNull();
});

test("findDockerVersion filters by suffix", () => {
  const tagMap = {"18-alpine": "2024-01-01", "20": "2024-06-01", "20-alpine": "2024-06-01"};
  expect(findDockerVersion(tagMap, "18-alpine", allSemvers)).toEqual({newTag: "20-alpine", date: "2024-06-01"});
  expect(findDockerVersion({"18": "2024-01-01", "20-alpine": "2024-06-01"}, "18", allSemvers)).toBeNull();
  const suffixed = {
    "1.2.3-alpine3.19": "2024-01-01", "1.3.0-alpine": "2024-06-01", "1.3.0-alpine3.20": "2024-06-01",
    "1.3.0-alpine3.19": "2024-06-02", "1.3.0-nanoserver-1809": "2024-06-03",
  };
  expect(findDockerVersion(suffixed, "1.2.3-alpine3.19", allSemvers)).toEqual({newTag: "1.3.0-alpine3.19", date: "2024-06-02"});
  expect(findDockerVersion(suffixed, "1.2.3-nanoserver-1809", allSemvers)).toEqual({newTag: "1.3.0-nanoserver-1809", date: "2024-06-03"});
});

test("findDockerVersion keeps the authored precision", () => {
  const tagMap = {"18": "2024-01-01", "20": "2024-06-01", "20.11": "2024-06-10", "20.11.1": "2024-06-15"};
  expect(findDockerVersion(tagMap, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-01"});
  expect(findDockerVersion(tagMap, "18.19", allSemvers)).toEqual({newTag: "20.11", date: "2024-06-10"});
  expect(findDockerVersion({"18": "2024-01-01", "20.11.1": "2024-06-15"}, "18", allSemvers)).toBeNull();
  expect(findDockerVersion({"24.04": "2024-04-01", "26.04": "2026-04-01"}, "24.04", allSemvers))
    .toEqual({newTag: "26.04", date: "2026-04-01"});
  expect(findDockerVersion({"1.2.3.4-alpine": "2024-01-01", "1.2.3.5-alpine": "2024-06-01"}, "1.2.3.4-alpine", allSemvers))
    .toEqual({newTag: "1.2.3.5-alpine", date: "2024-06-01"});
});

test("findDockerVersion ignores tags from another versioning scheme", () => {
  const tagMap = {"3": "2026-06-16", "3.24": "2026-06-16", "3.24.1": "2026-06-16", "20260127": "2026-01-28"};
  expect(findDockerVersion(tagMap, "3.24", allSemvers)).toBeNull();
  expect(findDockerVersion(tagMap, "3", allSemvers)).toBeNull();
  expect(findDockerVersion(tagMap, "20251224", allSemvers)).toEqual({newTag: "20260127", date: "2026-01-28"});
  expect(findDockerVersion({"9": "2020-01-01", "10": "2020-06-01"}, "9", allSemvers)).toEqual({newTag: "10", date: "2020-06-01"});
  expect(findDockerVersion({"20260127": "2026-01-27", "9999999999999999999": "2026-02-01"}, "20260127", allSemvers)).toBeNull();
});

test("findDockerVersion cooldown needs a timestamp", () => {
  const now = Date.parse("2024-07-01");
  const tagMap = {"18": "2024-01-01", "20": "2024-06-25", "19": ""};
  expect(findDockerVersion(tagMap, "18", allSemvers, 30, now)).toBeNull();
  expect(findDockerVersion(tagMap, "18", allSemvers)).toEqual({newTag: "20", date: "2024-06-25"});
});

test("findDockerVersion respects pinnedRange", () => {
  expect(findDockerVersion({"8.0": "2024-01-01", "8.0.41": "2024-06-01", "9.7": "2024-12-01"}, "8.0", allSemvers,
    undefined, undefined, "8.0")).toBeNull();
  expect(findDockerVersion({"8.0.0": "2024-01-01", "8.0.41": "2024-06-01", "9.7": "2024-12-01"}, "8.0.0", allSemvers,
    undefined, undefined, "8.0")).toEqual({newTag: "8.0.41", date: "2024-06-01"});
  const extended = {"10.4.1.88267": "2024-01-01", "10.5.0.89998": "2024-06-01", "25.1.0.102122": "2024-12-01"};
  expect(findDockerVersion(extended, "10.4.1.88267", allSemvers, undefined, undefined, "<25"))
    .toEqual({newTag: "10.5.0.89998", date: "2024-06-01"});
  expect(findDockerVersion(extended, "10.4.1.88267", allSemvers))
    .toEqual({newTag: "25.1.0.102122", date: "2024-12-01"});
});

test("dockerTagVersion matches ranges on the release, with docker's own coercion", () => {
  expect(["1.27rc3", "21_35", "latest"].map(dockerTagVersion)).toEqual(["1.27.0", "21.35.0", ""]);
});

test("findDockerVersion keeps underscore builds verbatim and apart from dotted tags", () => {
  const tagMap = {
    "21.0.5_11-jdk": "2024-01-01", "21.0.6_9-jdk": "2024-06-01", "21.0.6.9-jdk": "2024-06-02",
    "21_35-jdk": "2024-01-01", "22_36-jdk": "2024-06-01",
  };
  expect(findDockerVersion(tagMap, "21.0.5_11-jdk", allSemvers)).toEqual({newTag: "21.0.6_9-jdk", date: "2024-06-01"});
  expect(findDockerVersion(tagMap, "21_35-jdk", allSemvers)).toEqual({newTag: "22_36-jdk", date: "2024-06-01"});
});

test("findDockerVersion applies pinnedRange to prereleases", () => {
  expect(findDockerVersion({"1.2.0": "2024-01-01", "1.3.0rc1": "2024-06-01"}, "1.2.0", allSemvers, undefined, undefined, "^1.2.0", true))
    .toBeNull();
});

test.each([
  ["updateDockerfile replaces a lowercase from", updateDockerfile, "from node:18\n", "node", nodeDep, "from node:20\n"],
  ["updateDockerfile replaces a FROM with platform", updateDockerfile,
    "FROM --platform=linux/amd64 nginx:1.25.3\n", "nginx", {old: "1.25.3", new: "1.27.0"}, "FROM --platform=linux/amd64 nginx:1.27.0\n"],
  ["updateDockerfile uses oldOrig when present", updateDockerfile,
    "FROM node:18\n", "node", {old: "18.0.0", new: "20", oldOrig: "18"}, "FROM node:20\n"],
  ["updateComposeFile replaces a quoted image tag", updateComposeFile,
    "services:\n  db:\n    image: 'postgres:16.2'\n", "postgres", {old: "16.2", new: "17.0"}, "services:\n  db:\n    image: 'postgres:17.0'\n"],
  ["updateDockerfile skips comments and shell text", updateDockerfile,
    "# FROM node:18\nRUN echo FROM node:18\nFROM node:18\n", "node", nodeDep, "# FROM node:18\nRUN echo FROM node:18\nFROM node:20\n"],
  ["updateComposeFile skips a commented image", updateComposeFile,
    "services:\n  a:\n    # image: node:18\n    image: node:18\n", "node", nodeDep, "services:\n  a:\n    # image: node:18\n    image: node:20\n"],
  ["updateWorkflowDockerImages skips a commented container", updateWorkflowDockerImages,
    "jobs:\n  a:\n    # container: node:18\n    container: node:18\n", "node", nodeDep,
    "jobs:\n  a:\n    # container: node:18\n    container: node:20\n"],
  ["updateComposeFile replaces a flow-style image", updateComposeFile,
    "services:\n  web:\n    image: node:18\n  api: {image: node:18}\n", "node", nodeDep,
    "services:\n  web:\n    image: node:20\n  api: {image: node:20}\n"],
  ["updateComposeFile leaves locally built service images alone", updateComposeFile,
    "services:\n  built:\n    image: node:18\n    build: .\n  pulled:\n    image: node:18\n", "node", nodeDep,
    "services:\n  built:\n    image: node:18\n    build: .\n  pulled:\n    image: node:20\n"],
  ["updateDockerfile replaces an uppercase tag", updateDockerfile, "FROM foo/bar:1.0-RC1\n", "foo/bar", rcDep, "FROM foo/bar:1.1-RC1\n"],
  ["updateComposeFile replaces an uppercase tag", updateComposeFile, "    image: foo/bar:1.0-RC1\n", "foo/bar", rcDep, "    image: foo/bar:1.1-RC1\n"],
  ["updateWorkflowDockerImages replaces an uppercase container tag", updateWorkflowDockerImages,
    "    container: foo/bar:1.0-RC1\n", "foo/bar", rcDep, "    container: foo/bar:1.1-RC1\n"],
  ["updateWorkflowDockerImages replaces an uppercase uses tag", updateWorkflowDockerImages,
    "      - uses: docker://foo/bar:1.0-RC1\n", "foo/bar", rcDep, "      - uses: docker://foo/bar:1.1-RC1\n"],
  ["updateDockerfile rewrites a tag and digest atomically", updateDockerfile, `FROM node:18 AS build\nFROM node:18@${oldDigest}\nFROM node:18+build\n`,
    "node", nodeDigestDep, `FROM node:18 AS build\nFROM node:20@${newDigest}\nFROM node:18+build\n`],
  ["updateDockerfile leaves a digest pin alone on a tag-only update", updateDockerfile,
    `FROM node:18 AS build\nFROM node:18@${oldDigest}\nFROM node:18+build\n`, "node", nodeDep,
    `FROM node:20 AS build\nFROM node:18@${oldDigest}\nFROM node:18+build\n`],
  ["updateComposeFile rewrites a tag and digest atomically", updateComposeFile,
    `services:\n  app:\n    image: node:18@${oldDigest}\n`, "node", nodeDigestDep, `services:\n  app:\n    image: node:20@${newDigest}\n`],
  ["updateWorkflowDockerImages rewrites a tag and digest atomically", updateWorkflowDockerImages,
    `steps:\n  - uses: docker://node:18@${oldDigest}\n`, "node", nodeDigestDep, `steps:\n  - uses: docker://node:20@${newDigest}\n`],
  ["updateWorkflowDockerImages rewrites a digest-only reference", updateWorkflowDockerImages, `steps:\n  - uses: docker://node@${oldDigest}\n`,
    "node", {old: "latest", new: "latest", oldDigest, newDigest, digestOnly: true}, `steps:\n  - uses: docker://node@${newDigest}\n`],
  ["updateDockerfile rewrites the ARG owning a multiline FROM version", updateDockerfile,
    `ARG VERSION=18\nFROM --platform=$BUILDPLATFORM \\\n  node:${argVersion}\n`, "node", nodeDep,
    `ARG VERSION=20\nFROM --platform=$BUILDPLATFORM \\\n  node:${argVersion}\n`],
  ["updateDockerfile rewrites an ARG and digest atomically", updateDockerfile,
    `ARG VERSION=18\nFROM node:${argVersion}@${oldDigest}\n`, "node", nodeDigestDep, `ARG VERSION=20\nFROM node:${argVersion}@${newDigest}\n`],
  ["updateDockerfile rewrites an ARG after a leading UTF-8 BOM", updateDockerfile,
    `\uFEFFARG VERSION=18\nFROM node:${argVersion}\n`, "node", nodeDep, `\uFEFFARG VERSION=20\nFROM node:${argVersion}\n`],
  ["updateDockerfile rewrites a FROM after a leading UTF-8 BOM", updateDockerfile, "\uFEFFFROM node:18\n", "node", nodeDep, "\uFEFFFROM node:20\n"],
])("%s", (_name, update, content, image, dep, expected) => {
  expect(update(content, {[`docker${fieldSep}${image}`]: dep})).toBe(expected);
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
  await expect(fetchDockerTagDigest("library", "node", "20", hubCtx(hubBody({})))).resolves.toBe(null);

  const urls: Array<string> = [];
  const listing = hubCtx((url: string) => {
    urls.push(url);
    return hubBody(url.includes("/tags/") ? {digest: oldDigest} :
      {count: 1, results: [{name: "20", tag_last_pushed: "2024-01-01", digest: newDigest}]})();
  });
  await expect(fetchDockerTagDigest("library", "node", "20", listing)).resolves.toBe(newDigest);
  expect(urls.length).toBe(1);
  await expect(fetchDockerTagDigest("library", "node", "22", listing)).resolves.toBe(oldDigest);
  expect(urls.at(-1)).toBe("https://hub.docker.com/v2/repositories/library/node/tags/22");
});

test("docker digest lookup errors are isolated per dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "updates-docker-digest-error-"));
  const file = join(dir, "Dockerfile");
  await writeFile(file, `FROM broken:1@${oldDigest}\nFROM healthy:1\n`);
  const registryUrl = "https://registry.test";
  const tags = {count: 2, results: [
    {name: "2", tag_last_pushed: "2025-01-02T00:00:00Z"},
    {name: "1", tag_last_pushed: "2025-01-01T00:00:00Z"},
  ]};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/tags")) return Promise.resolve(Response.json(tags));
    if (url.pathname === "/v2/repositories/library/broken/tags/2") {
      return Promise.resolve(new Response(null, {status: 500, statusText: "Internal Server Error"}));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const output = await updates({files: [file], modes: ["docker"], dockerapi: registryUrl, noCache: true});
    const type = Object.keys(output.results.docker)[0];
    expect(output.results.docker[type].healthy).toMatchObject({old: "1", new: "2"});
    expect(output.results.docker[type].broken).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({
      mode: "docker", type, name: "broken",
      error: expect.stringContaining(`${registryUrl}/v2/repositories/library/broken/tags/2`),
    })]);
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, {recursive: true});
  }
});

test("fetchDockerInfo library image", async () => {
  const ctx = hubCtx(hubBody({count: 1, results: [{name: "18", tag_last_pushed: "2024-01-01"}]}));
  expect((await fetchDockerInfo("node", ctx))[0]).toEqual({name: "node", tags: {"18": "2024-01-01"}});
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
  await expect(fetchDockerInfo("ghcr.io/owner/repo", {} as ModeContext)).rejects.toThrow("not yet supported");
});
