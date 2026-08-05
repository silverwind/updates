import {createServer} from "node:http";
import {gzip, gzipSync, constants} from "node:zlib";
import {promisify} from "node:util";
import type {Server, ServerResponse} from "node:http";

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

// The module paths the proxy hosts. Every other path 404s, as a real proxy does: answering
// `@latest` for any path let probeMajorVersions walk to its 101-major cap, 102 requests per
// dependency, so the scenario measured the cap rather than go's cost.
const goModules = new Set([
  "github.com/google/uuid",
  "github.com/google/go-github/v70",
  "github.com/google/go-github/v71", // a next major exists, so the major-probe walk is measured
  "github.com/example/testpkg",
  "github.com/example/testpkg/v2",
]);

// `@latest` is optional in the GOPROXY protocol and these paths omit it, exercising the `@v/list`
// fallback. `listonly`'s list carries no timestamps and so costs the follow-up `.info`.
const goLists: Record<string, string> = {
  "github.com/example/listonly": "v1.0.0\nv1.2.0\nv1.3.0-rc.1\n",
  "github.com/example/listtime": "v1.0.0 2024-01-01T00:00:00Z\nv1.1.0 2024-06-01T00:00:00Z\n",
};

const goMajorSuffixRe = /\/v(\d+)$/;

function goLatestResponse(path: string): string {
  const major = goMajorSuffixRe.exec(path)?.[1] ?? "1";
  return JSON.stringify({Version: `v${major}.10.0`, Time: "2025-01-01T00:00:00Z"});
}

// The sparse index answers with NDJSON, one record per version in publication order.
function cargoResponse(): string {
  const lines: Array<string> = [];
  for (let minor = 0; minor < 20; minor++) {
    lines.push(JSON.stringify({name: "example", vers: `1.${minor}.0`, yanked: false, pubtime: new Date(2024, 0, minor + 1).toISOString()}));
  }
  return lines.join("\n");
}

const pageSize = 100;
const dockerTagsPerMajor = 60;
// The newest major each fixture image sits below, so its authored tag is a few pages down rather
// than absent, which is what leaves a walk unbounded.
const dockerNewestMajor: Record<string, number> = {node: 24, postgres: 17, redis: 9};
const dockerEpoch = Date.UTC(2026, 0, 1);

// Hub serves tags newest-first, 100 per page, and reports the total up front, which is what lets
// the walk stop at the page holding the authored tag. A single page of 15 tags reported a total
// of 15, so the walk never started and the scenario could not see its cost.
function dockerTagsResponse(repo: string, page: number): string {
  const newest = dockerNewestMajor[repo] ?? 22;
  const count = newest * dockerTagsPerMajor; // every major down to 1, three flavours and a patch series each
  const results: Array<{name: string, last_updated: string, tag_last_pushed: string}> = [];
  for (let idx = (page - 1) * pageSize; idx < Math.min(page * pageSize, count); idx++) {
    const major = newest - Math.floor(idx / dockerTagsPerMajor);
    const within = idx % dockerTagsPerMajor;
    const suffix = ["", "-alpine", "-slim"][within % 3];
    const minor = Math.floor(within / 3);
    const pushed = new Date(dockerEpoch - idx * 86400000).toISOString();
    results.push({
      name: minor ? `${major}.${20 - minor}${suffix}` : `${major}${suffix}`,
      last_updated: pushed, tag_last_pushed: pushed,
    });
  }
  return JSON.stringify({count, results});
}

const ghTagPages = 3;
const ghTagsPerMajor = 30;

// GitHub serves tags newest-first and names the page count only in the Link header, which is what
// bounds fetchActionTags' walk. Ten tags on one unlinked page meant the walk never ran.
function githubTagsResponse(page: number): string {
  const tags: Array<{name: string, commit: {sha: string}}> = [];
  for (let idx = (page - 1) * pageSize; idx < page * pageSize; idx++) {
    const major = 10 - Math.floor(idx / ghTagsPerMajor);
    const minor = ghTagsPerMajor - 1 - idx % ghTagsPerMajor;
    tags.push({name: `v${major}.${minor}.0`, commit: {sha: idx.toString(16).padStart(40, "0")}});
  }
  return JSON.stringify(tags);
}

function githubCommitResponse(): string {
  return JSON.stringify({committer: {date: "2025-01-01T00:00:00Z"}, author: {date: "2025-01-01T00:00:00Z"}});
}

function githubCommitsResponse(): string {
  return JSON.stringify([{sha: "a".repeat(40), commit: {committer: {date: "2025-01-01T00:00:00Z"}}}]);
}

// The sparse index has no fixed prefix, only the shard shape a crate name maps to:
// `1/a`, `2/ab`, `3/a/abc` or `ab/cd/name`. Distinguishes it from `/pkg` and `/pkg/version`.
const cargoIndexRe = /^\/(?:[12]\/[^/]+|3\/[^/]\/[^/]+|[^/]{2}\/[^/]{2}\/[^/]+)$/;

// `/v2/repositories/<ns>/<repo>/tags`, and the per-tag digest lookup a `image:tag@sha256:` pin makes.
const dockerTagsRe = /^\/v2\/repositories\/[^/]+\/([^/]+)\/tags(?:\/(.+))?$/;
const dockerDigest = `sha256:${"b".repeat(64)}`;

const goLatestRe = /^\/(.+)\/@latest$/;
const goListRe = /^\/(.+)\/@v\/list$/;
const goInfoRe = /^\/(.+)\/@v\/(.+)\.info$/;

type Cache = {
  npmList: Buffer,
  npmVersion: Map<string, Buffer>,
  pypi: Buffer,
  jsr: Buffer,
  go: Map<string, Buffer>,
  cargo: Buffer,
  dockerTags: Map<string, Buffer>,
  ghTags: Map<string, Buffer>,
  ghCommit: Buffer,
  ghCommits: Buffer,
};

async function buildCache(): Promise<Cache> {
  const [npmList, pypi, jsr, cargo, ghCommit, ghCommits] = await Promise.all([
    gzipPromise(npmResponse("example")),
    gzipPromise(pypiResponse("example")),
    gzipPromise(jsrResponse()),
    gzipPromise(cargoResponse()),
    gzipPromise(githubCommitResponse()),
    gzipPromise(githubCommitsResponse()),
  ]);
  return {
    npmList, npmVersion: new Map(), pypi, jsr, go: new Map(), cargo,
    dockerTags: new Map(), ghTags: new Map(), ghCommit, ghCommits,
  };
}

function lazyGzip(cache: Map<string, Buffer>, key: string, build: () => string): Buffer {
  let cached = cache.get(key);
  if (!cached) cache.set(key, cached = gzipSync(build(), {level: constants.Z_BEST_SPEED}));
  return cached;
}

function notFound(res: ServerResponse): void {
  res.removeHeader("Content-Encoding");
  res.removeHeader("ETag");
  res.statusCode = 404;
  res.end();
}

export async function startBenchServer(port = 0, latencyMs = 0): Promise<{server: Server, url: string, requests: {count: number}}> {
  const cache = await buildCache();
  const requests = {count: 0};

  const server = createServer(async (req, res) => {
    requests.count++;
    if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
    const [url, query] = (req.url || "/").split("?");
    const page = Number(new URLSearchParams(query).get("page")) || 1;
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("ETag", `"bench-etag"`);

    if (req.headers["if-none-match"] === `"bench-etag"`) {
      res.statusCode = 304;
      res.end();
      return;
    }

    if (url.startsWith("/pypi/")) return res.end(cache.pypi);
    if (url.startsWith("/@") && url.endsWith("/meta.json")) return res.end(cache.jsr);

    const goLatest = goLatestRe.exec(url);
    if (goLatest) {
      if (!goModules.has(goLatest[1])) return notFound(res);
      return res.end(lazyGzip(cache.go, url, () => goLatestResponse(goLatest[1])));
    }
    const goList = goListRe.exec(url);
    if (goList) {
      const body = goLists[goList[1]];
      if (!body) return notFound(res);
      return res.end(lazyGzip(cache.go, url, () => body));
    }
    const goInfo = goInfoRe.exec(url);
    if (goInfo) {
      if (!goLists[goInfo[1]] && !goModules.has(goInfo[1])) return notFound(res);
      return res.end(lazyGzip(cache.go, url, () => JSON.stringify({Version: goInfo[2], Time: "2025-03-01T00:00:00Z"})));
    }

    if (cargoIndexRe.test(url)) return res.end(cache.cargo);

    const dockerTags = dockerTagsRe.exec(url);
    if (dockerTags) {
      // Hub sends no etag on tag pages, so a warm run pays for the walk again, as it does live.
      res.removeHeader("ETag");
      if (dockerTags[2]) return res.end(lazyGzip(cache.dockerTags, url, () => JSON.stringify({digest: dockerDigest})));
      const repo = dockerTags[1];
      return res.end(lazyGzip(cache.dockerTags, `${repo}/${page}`, () => dockerTagsResponse(repo, page)));
    }

    if (url.startsWith("/repos/") && url.endsWith("/tags")) {
      res.setHeader("Link", `<http://${req.headers.host}${url}?page=${ghTagPages}>; rel="last"`);
      return res.end(lazyGzip(cache.ghTags, String(page), () => githubTagsResponse(page)));
    }
    if (url.startsWith("/repos/") && url.includes("/git/commits/")) return res.end(cache.ghCommit);
    if (url.startsWith("/repos/") && url.endsWith("/commits")) return res.end(cache.ghCommits);

    // npm: /pkg or /pkg/version
    const segs = url.split("/").filter(Boolean);
    const looksVersioned = segs.length >= 2 && /^[0-9]+\.[0-9]+\.[0-9]+/.test(segs[segs.length - 1]);
    if (looksVersioned) {
      const version = segs[segs.length - 1];
      return res.end(lazyGzip(cache.npmVersion, version, () => npmVersionResponse(version)));
    }

    return res.end(cache.npmList);
  });

  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}`;
  return {server, url, requests};
}
