import {getCache, setCache} from "./fetchCache.ts";

test("setCache and getCache round-trip", async () => {
  const url = "https://test.example.com/fetchCache-round-trip-test";
  await setCache(url, "W/\"abc123\"", '{"versions":{"1.0.0":{}}}');
  const result = await getCache(url);
  expect(result).toEqual({etag: "W/\"abc123\"", body: '{"versions":{"1.0.0":{}}}'});
});

test("getCache returns null for unknown URL", async () => {
  expect(await getCache("https://test.example.com/nonexistent-url-12345")).toBeNull();
});

test("setCache and getCache preserve body with newlines", async () => {
  const url = "https://test.example.com/fetchCache-newline-test";
  const body = '{"a":1}\n{"b":2}\n{"c":3}';
  await setCache(url, "etag-val", body);
  const result = await getCache(url);
  expect(result).toEqual({etag: "etag-val", body});
});
