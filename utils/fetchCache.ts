import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir, rename} from "node:fs/promises";
import {join} from "node:path";
import {env, platform, pid} from "node:process";
import {homedir} from "node:os";

const cacheDir = join(
  platform === "win32" ?
    (env.LOCALAPPDATA || join(homedir(), "AppData", "Local")) :
    (env.XDG_CACHE_HOME || join(homedir(), ".cache")),
  "updates",
);

let dirCreated: Promise<string | undefined> | null = null;

// Memoized — the same URL is hashed twice (read then write) per cold-cache
// fetch, and many URLs are visited each run.
const cacheKeyMemo = new Map<string, string>();
function cacheKey(url: string): string {
  let key = cacheKeyMemo.get(url);
  if (key === undefined) {
    key = createHash("sha256").update(url).digest("hex").substring(0, 16);
    cacheKeyMemo.set(url, key);
  }
  return key;
}

export async function getCache(url: string): Promise<{etag: string, body: string} | null> {
  try {
    const content = await readFile(join(cacheDir, `${cacheKey(url)}.cache`), "utf8");
    const idx = content.indexOf("\n");
    if (idx === -1) return null;
    const etag = content.substring(0, idx);
    const body = content.substring(idx + 1);
    return etag && body ? {etag, body} : null;
  } catch {
    return null;
  }
}

const pendingWrites = new Set<Promise<void>>();
let tmpCounter = 0;

// Writes are intentionally not awaited by callers so a response can be
// consumed without waiting on disk. flushCacheWrites() awaits completion
// before the process may exit. The temp-file + rename dance keeps writes
// atomic: an interrupted process can never leave a torn entry that would
// poison later runs (the etag would revalidate but the body fail to parse).
export function setCache(url: string, etag: string, body: string): void {
  const write = (async () => {
    try {
      await (dirCreated ??= mkdir(cacheDir, {recursive: true}));
      const file = join(cacheDir, `${cacheKey(url)}.cache`);
      const tmpFile = `${file}.${pid}-${tmpCounter++}.tmp`;
      await writeFile(tmpFile, `${etag}\n${body}`);
      await rename(tmpFile, file);
    } catch {}
  })();
  pendingWrites.add(write);
  write.then(() => pendingWrites.delete(write));
}

export async function flushCacheWrites(): Promise<void> {
  // Loop: concurrent updates() calls share this set and may enqueue while a
  // flush is in progress.
  while (pendingWrites.size) await Promise.all(pendingWrites);
}
