import {createServer} from "node:http";
import {gzip, gzipSync, constants} from "node:zlib";
import {promisify} from "node:util";
import type {Server} from "node:http";

const gzipPromise = (data: string | Buffer) => promisify(gzip)(data, {level: constants.Z_BEST_SPEED});

function npmResponse(name: string, count = 20): string {
  const versions: Record<string, Record<string, never>> = {};
  const time: Record<string, string> = {};
  for (let major = 0; major < 5; major++) {
    for (let minor = 0; minor < count; minor++) {
      const v = `${major}.${minor}.0`;
      versions[v] = {};
      time[v] = new Date(2020, major, minor + 1).toISOString();
    }
  }
  const latest = `4.${count - 1}.0`;
  return JSON.stringify({name, "dist-tags": {latest}, versions, time});
}

function npmVersionResponse(version: string): string {
  return JSON.stringify({
    repository: "https://github.com/example/example",
    homepage: "https://example.com",
    _npmOperationalInternal: {tmp: `tmp/example_${version}_${Date.now()}_0`},
  });
}

function pypiResponse(name: string): string {
  const releases: Record<string, Array<{upload_time_iso_8601: string}>> = {};
  for (let minor = 0; minor < 20; minor++) {
    releases[`1.${minor}.0`] = [{upload_time_iso_8601: new Date(2024, 0, minor + 1).toISOString()}];
  }
  return JSON.stringify({
    info: {name, version: "1.19.0", project_urls: {Homepage: "https://example.com"}},
    releases,
  });
}

function jsrResponse(): string {
  const versions: Record<string, {createdAt: string}> = {};
  for (let minor = 0; minor < 10; minor++) {
    versions[`1.${minor}.0`] = {createdAt: new Date(2024, 0, minor + 1).toISOString()};
  }
  return JSON.stringify({latest: "1.9.0", versions});
}

function goLatestResponse(version = "v1.10.0"): string {
  return JSON.stringify({Version: version, Time: "2025-01-01T00:00:00Z"});
}

function cargoResponse(): string {
  const versions: Array<{num: string, created_at: string, yanked: boolean}> = [];
  for (let minor = 19; minor >= 0; minor--) {
    versions.push({num: `1.${minor}.0`, created_at: new Date(2024, 0, minor + 1).toISOString(), yanked: false});
  }
  return JSON.stringify({versions});
}

function dockerTagsResponse(): string {
  const results: Array<{name: string, last_updated: string, tag_last_pushed: string}> = [];
  for (let major = 18; major <= 22; major++) {
    for (const suffix of ["", "-alpine", "-slim"]) {
      results.push({
        name: `${major}${suffix}`,
        last_updated: new Date(2024, major - 18, 1).toISOString(),
        tag_last_pushed: new Date(2024, major - 18, 1).toISOString(),
      });
    }
  }
  return JSON.stringify({count: results.length, results});
}

function githubTagsResponse(): string {
  const tags: Array<{name: string, commit: {sha: string}}> = [];
  for (let major = 1; major <= 10; major++) {
    tags.push({name: `v${major}.0.0`, commit: {sha: "a".repeat(40 - String(major).length) + major}});
  }
  return JSON.stringify(tags);
}

function githubCommitResponse(): string {
  return JSON.stringify({committer: {date: "2025-01-01T00:00:00Z"}, author: {date: "2025-01-01T00:00:00Z"}});
}

function githubCommitsResponse(): string {
  return JSON.stringify([{sha: "a".repeat(40), commit: {committer: {date: "2025-01-01T00:00:00Z"}}}]);
}

type Cache = {
  npmList: Buffer,
  npmVersion: Map<string, Buffer>,
  pypi: Buffer,
  jsr: Buffer,
  goLatest: Buffer,
  cargo: Buffer,
  dockerTags: Buffer,
  ghTags: Buffer,
  ghCommit: Buffer,
  ghCommits: Buffer,
};

async function buildCache(): Promise<Cache> {
  const [npmList, pypi, jsr, goLatest, cargo, dockerTags, ghTags, ghCommit, ghCommits] = await Promise.all([
    gzipPromise(npmResponse("example")),
    gzipPromise(pypiResponse("example")),
    gzipPromise(jsrResponse()),
    gzipPromise(goLatestResponse()),
    gzipPromise(cargoResponse()),
    gzipPromise(dockerTagsResponse()),
    gzipPromise(githubTagsResponse()),
    gzipPromise(githubCommitResponse()),
    gzipPromise(githubCommitsResponse()),
  ]);
  return {npmList, npmVersion: new Map(), pypi, jsr, goLatest, cargo, dockerTags, ghTags, ghCommit, ghCommits};
}

export async function startBenchServer(port = 0, latencyMs = 0): Promise<{server: Server, url: string, requests: {count: number}}> {
  const cache = await buildCache();
  const requests = {count: 0};

  const server = createServer(async (req, res) => {
    requests.count++;
    if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
    const url = (req.url || "/").split("?")[0];
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("ETag", `"bench-etag"`);

    if (req.headers["if-none-match"] === `"bench-etag"`) {
      res.statusCode = 304;
      res.end();
      return;
    }

    if (url.startsWith("/pypi/")) return res.end(cache.pypi);
    if (url.startsWith("/@") && url.endsWith("/meta.json")) return res.end(cache.jsr);
    if (url.endsWith("/@latest")) return res.end(cache.goLatest);
    if (url.startsWith("/api/v1/crates/")) return res.end(cache.cargo);
    if (url.startsWith("/v2/repositories/")) return res.end(cache.dockerTags);
    if (url.startsWith("/repos/") && url.endsWith("/tags")) return res.end(cache.ghTags);
    if (url.startsWith("/repos/") && url.includes("/git/commits/")) return res.end(cache.ghCommit);
    if (url.startsWith("/repos/") && url.endsWith("/commits")) return res.end(cache.ghCommits);

    // npm: /pkg or /pkg/version
    const segs = url.split("/").filter(Boolean);
    const looksVersioned = segs.length >= 2 && /^[0-9]+\.[0-9]+\.[0-9]+/.test(segs[segs.length - 1]);
    if (looksVersioned) {
      const version = segs[segs.length - 1];
      let cached = cache.npmVersion.get(version);
      if (!cached) {
        cached = gzipSync(npmVersionResponse(version), {level: constants.Z_BEST_SPEED});
        cache.npmVersion.set(version, cached);
      }
      return res.end(cached);
    }

    return res.end(cache.npmList);
  });

  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}`;
  return {server, url, requests};
}
