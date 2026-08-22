import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readdir, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {flushCacheWrites, getCache, setCache} from "./fetchCache.ts";

let cacheRoot: string;

beforeAll(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "updates-fetch-cache-"));
});

afterAll(async () => {
  await rm(cacheRoot, {recursive: true, force: true});
});

async function makeCacheDir(name: string): Promise<string> {
  const dir = join(cacheRoot, name);
  await mkdir(dir);
  return dir;
}

test("setCache shares directory creation and getCache preserves newlines", async () => {
  const cacheDir = join(cacheRoot, "round-trip");
  const url = "https://test.example.com/fetchCache-round-trip-test";
  const otherUrl = "https://test.example.com/fetchCache-concurrent-test";
  const body = '{"a":1}\n{"b":2}\n{"c":3}';
  setCache(url, "W/\"abc123\"", body, cacheDir);
  setCache(otherUrl, "etag", "other", cacheDir);
  await flushCacheWrites(cacheDir);
  expect(await getCache(url, cacheDir)).toEqual({etag: "W/\"abc123\"", body});
  expect(await getCache(otherUrl, cacheDir)).toEqual({etag: "etag", body: "other"});
  expect(await readdir(cacheDir)).toContain(`${createHash("sha256").update(url).digest("hex")}.cache`);
});

test("getCache returns null for unknown URL", async () => {
  expect(await getCache("https://test.example.com/nonexistent-url-12345", await makeCacheDir("unknown"))).toBeNull();
});

test("getCache returns null when the key can not be derived", async () => {
  expect(await getCache(undefined as unknown as string, await makeCacheDir("invalid-key"))).toBeNull();
});

test("expired cache entries are removed", async () => {
  const cacheDir = await makeCacheDir("expired");
  const url = "https://test.example.com/fetchCache-expired-test";
  setCache(url, "etag-val", "body", cacheDir);
  await flushCacheWrites(cacheDir);
  const file = join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.cache`);
  await utimes(file, new Date(0), new Date(0));
  expect(await getCache(url, cacheDir)).toBeNull();
  expect(await readdir(cacheDir)).not.toContain(basename(file));
});

test("cache eviction retains a recently used entry and bounds files across runs", async () => {
  const cacheDir = await makeCacheDir("eviction");
  const usedUrl = "https://test.example.com/fetchCache-used-before-eviction";
  const usedFile = `${createHash("sha256").update(usedUrl).digest("hex")}.cache`;
  const now = Date.now();
  await Promise.all(Array.from({length: 4096}, async (_value, index) => {
    const file = join(cacheDir, index === 0 ? usedFile : `${index}.cache`);
    await writeFile(file, "etag\nbody");
    const time = new Date(now - (4097 - index) * 1000);
    await utimes(file, time, time);
  }));
  expect(await getCache(usedUrl, cacheDir)).toEqual({etag: "etag", body: "body"});
  setCache("https://test.example.com/fetchCache-newest", "etag", "body", cacheDir);
  await flushCacheWrites(cacheDir);
  const files = (await readdir(cacheDir)).filter(name => name.endsWith(".cache"));
  expect(files).toHaveLength(4096);
  expect(files).toContain(usedFile);
  expect(files).not.toContain("1.cache");
});
