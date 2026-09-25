import {createServer} from "node:http";
import {gzipSync, constants} from "node:zlib";
import type {Server} from "node:http";

const pageSize = 100;
const date = "2025-01-01T00:00:00Z";

function releases(major: number, count: number, year: number, month: number) {
  return Array.from({length: count}, (_, minor) => [`${major}.${minor}.0`, new Date(year, month, minor + 1).toISOString()] as const);
}

const goModules = new Set([ // every other path 404s like a real proxy, so the major-probe walk ends
  "github.com/google/uuid",
  "github.com/google/go-github/v70",
  "github.com/google/go-github/v71", // a next major, so the major-probe walk is measured
  "github.com/example/testpkg",
  "github.com/example/testpkg/v2",
]);

const goLists: Record<string, string> = {
  "github.com/example/listonly": "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n",
  "github.com/example/listtime": "v1.0.0 2024-01-01T00:00:00Z\nv1.1.0 2024-06-01T00:00:00Z\n",
};

const dockerTagsPerMajor = 60;
const dockerNewestMajor: Record<string, number> = {node: 24, postgres: 17, redis: 9};
const dockerEpoch = Date.UTC(2026, 0, 1);

function dockerTagsResponse(repo: string, page: number): string { // newest first with the total up front like Hub, so the walk stops at the authored tag
  const newest = dockerNewestMajor[repo] ?? 22;
  const count = newest * dockerTagsPerMajor;
  const results: Array<{name: string, last_updated: string, tag_last_pushed: string}> = [];
  for (let idx = (page - 1) * pageSize; idx < Math.min(page * pageSize, count); idx++) {
    const major = newest - Math.floor(idx / dockerTagsPerMajor);
    const within = idx % dockerTagsPerMajor;
    const suffix = ["", "-alpine", "-slim"][within % 3];
    const minor = Math.floor(within / 3);
    const pushed = new Date(dockerEpoch - idx * 86400000).toISOString();
    results.push({name: minor ? `${major}.${20 - minor}${suffix}` : `${major}${suffix}`, last_updated: pushed, tag_last_pushed: pushed});
  }
  return JSON.stringify({count, results});
}

const ghTagPages = 3;
const ghTagsPerMajor = 30;

function githubTagsResponse(page: number): string {
  return JSON.stringify(Array.from({length: pageSize}, (_, offset) => {
    const idx = (page - 1) * pageSize + offset;
    const major = 10 - Math.floor(idx / ghTagsPerMajor);
    const minor = ghTagsPerMajor - 1 - idx % ghTagsPerMajor;
    return {name: `v${major}.${minor}.0`, commit: {sha: idx.toString(16).padStart(40, "0")}};
  }));
}

const cargoIndexRe = /^\/(?:[12]\/[^/]+|3\/[^/]\/[^/]+|[^/]{2}\/[^/]{2}\/[^/]+)$/; // sparse index shards, unlike npm's `/pkg/version`
const dockerTagsRe = /^\/v2\/repositories\/[^/]+\/([^/]+)\/tags(?:\/(.+))?$/;
const goLatestRe = /^\/(.+)\/@latest$/;
const goListRe = /^\/(.+)\/@v\/list$/;
const goInfoRe = /^\/(.+)\/@v\/(.+)\.info$/;

function route(url: string, page: number): [cacheKey: string, body: () => unknown] | null {
  if (url.startsWith("/pypi/")) return ["pypi", () => ({
    info: {name: "example", version: "1.19.0", project_urls: {Homepage: "https://example.com"}},
    releases: Object.fromEntries(releases(1, 20, 2024, 0).map(([version, time]) => [version, [{upload_time_iso_8601: time}]])),
  })];
  if (url.startsWith("/@") && url.endsWith("/meta.json")) return ["jsr", () => ({
    latest: "1.9.0", versions: Object.fromEntries(releases(1, 10, 2024, 0).map(([version, createdAt]) => [version, {createdAt}])),
  })];
  const goLatest = goLatestRe.exec(url);
  if (goLatest) {
    return goModules.has(goLatest[1]) ? [url, () => ({Version: `v${/\/v(\d+)$/.exec(goLatest[1])?.[1] ?? "1"}.10.0`, Time: date})] : null;
  }
  const goList = goListRe.exec(url);
  if (goList) return goLists[goList[1]] ? [url, () => goLists[goList[1]]] : null;
  const goInfo = goInfoRe.exec(url);
  if (goInfo) {
    return goLists[goInfo[1]] || goModules.has(goInfo[1]) ? [url, () => ({Version: goInfo[2], Time: "2025-03-01T00:00:00Z"})] : null;
  }
  if (cargoIndexRe.test(url)) {
    return ["cargo", () => releases(1, 20, 2024, 0).map(([vers, pubtime]) => JSON.stringify({name: "example", vers, yanked: false, pubtime})).join("\n")];
  }
  const dockerTags = dockerTagsRe.exec(url);
  if (dockerTags) {
    return dockerTags[2] ? [url, () => ({digest: `sha256:${"b".repeat(64)}`})] :
      [`docker/${dockerTags[1]}/${page}`, () => dockerTagsResponse(dockerTags[1], page)];
  }
  if (url.startsWith("/repos/") && url.endsWith("/tags")) return [`github-tags/${page}`, () => githubTagsResponse(page)];
  if (url.startsWith("/repos/") && url.includes("/git/commits/")) return ["github-commit", () => ({committer: {date}, author: {date}})];
  if (url.startsWith("/repos/") && url.endsWith("/commits")) return ["github-commits", () => [{sha: "a".repeat(40), commit: {committer: {date}}}]];
  const segments = url.split("/").filter(Boolean);
  const version = segments.at(-1)!;
  if (segments.length >= 2 && /^\d+\.\d+\.\d+/.test(version)) return [`npm/${version}`, () => ({
    repository: "https://github.com/example/example",
    homepage: "https://example.com",
    _npmOperationalInternal: {tmp: `tmp/example_${version}_${Date.now()}_0`},
  })];
  return ["npm", () => {
    const npmReleases = [0, 1, 2, 3, 4].flatMap(major => releases(major, 20, 2020, major));
    return {
      name: "example", "dist-tags": {latest: "4.19.0"},
      versions: Object.fromEntries(npmReleases.map(([npmVersion]) => [npmVersion, {}])), time: Object.fromEntries(npmReleases),
    };
  }];
}

export async function startBenchServer(latencyMs = 0): Promise<{server: Server, url: string, requests: {count: number}}> {
  const gzipCache = new Map<string, Buffer>();
  const requests = {count: 0};
  const server = createServer(async (req, res) => {
    requests.count++;
    if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
    const [url, query] = req.url!.split("?");
    const page = Number(new URLSearchParams(query).get("page")) || 1;
    if (req.headers["if-none-match"] === `"bench-etag"`) {
      res.writeHead(304, {"Content-Encoding": "gzip", "ETag": `"bench-etag"`}).end();
      return;
    }
    const response = route(url, page);
    if (!response) {
      res.writeHead(404).end();
      return;
    }
    const [cacheKey, body] = response;
    let gz = gzipCache.get(cacheKey);
    if (!gz) {
      const value = body();
      gz = gzipSync(typeof value === "string" ? value : JSON.stringify(value), {level: constants.Z_BEST_SPEED});
      gzipCache.set(cacheKey, gz);
    }
    res.setHeader("Content-Encoding", "gzip");
    if (!dockerTagsRe.test(url)) res.setHeader("ETag", `"bench-etag"`); // Hub sends no etag on tag pages, so warm runs walk them again
    if (url.startsWith("/repos/") && url.endsWith("/tags")) res.setHeader("Link", `<http://${req.headers.host}${url}?page=${ghTagPages}>; rel="last"`);
    res.end(gz);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {server, url: `http://127.0.0.1:${addr.port}`, requests};
}
