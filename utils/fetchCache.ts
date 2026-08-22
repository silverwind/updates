import {createHash} from "node:crypto";
import {readFile} from "node:fs";
import {writeFile, mkdir, readdir, rename, stat, unlink, utimes} from "node:fs/promises";
import {join} from "node:path";
import {env, platform, pid} from "node:process";
import {homedir} from "node:os";
import {getOrSet, tryOrNull} from "./utils.ts";

function readFileUtf8(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    readFile(path, "utf8", (err, content) => err ? reject(err) : resolve(content));
  });
}

const cacheDir = join(
  platform === "win32" ?
    (env.LOCALAPPDATA || join(homedir(), "AppData", "Local")) :
    (env.XDG_CACHE_HOME || join(homedir(), ".cache")),
  "updates",
);

const createdDirs = new Map<string, Promise<string | undefined>>();

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

const maxAge = 7 * 24 * 60 * 60 * 1000;
const maxEntries = 4096;

export async function getCache(url: string, dir: string = cacheDir): Promise<{etag: string, body: string} | null> {
  try {
    const path = join(dir, `${cacheKey(url)}.cache`);
    if (Date.now() - (await stat(path)).mtimeMs > maxAge) {
      await unlink(path);
      return null;
    }
    const content = await readFileUtf8(path);
    const idx = content.indexOf("\n");
    if (idx === -1) return null;
    const etag = content.substring(0, idx);
    const body = content.substring(idx + 1);
    if (!etag || !body) return null;
    const now = new Date();
    await tryOrNull(utimes(path, now, now));
    return {etag, body};
  } catch {
    return null;
  }
}

const pendingWrites = new Set<Promise<void>>();
let tmpCounter = 0;

export function setCache(url: string, etag: string, body: string, dir: string = cacheDir): void {
  const write = (async () => {
    try {
      await getOrSet(createdDirs, dir, () => mkdir(dir, {recursive: true}));
    } catch {
      createdDirs.delete(dir);
      return;
    }
    let tmpFile: string | undefined;
    try {
      const file = join(dir, `${cacheKey(url)}.cache`);
      tmpFile = `${file}.${pid}-${tmpCounter++}.tmp`;
      await writeFile(tmpFile, `${etag}\n${body}`);
      await rename(tmpFile, file);
    } catch {
      if (tmpFile) await tryOrNull(unlink(tmpFile));
    }
  })();
  pendingWrites.add(write);
  (async () => { await write; pendingWrites.delete(write); })();
}

export async function flushCacheWrites(dir: string = cacheDir): Promise<void> {
  while (pendingWrites.size) await Promise.all(pendingWrites);
  try {
    const files = (await readdir(dir)).filter(name => name.endsWith(".cache"));
    const entries = (await Promise.all(files.map(async name => {
      const path = join(dir, name);
      try { return {path, mtime: (await stat(path)).mtimeMs}; } catch { return null; }
    }))).filter(entry => entry !== null).sort((a, b) => b.mtime - a.mtime);
    const fresh = entries.filter(entry => Date.now() - entry.mtime <= maxAge);
    await Promise.all([...entries.filter(entry => Date.now() - entry.mtime > maxAge), ...fresh.slice(maxEntries)]
      .map(entry => tryOrNull(unlink(entry.path))));
  } catch {}
}
