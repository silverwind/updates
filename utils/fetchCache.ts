import {createHash} from "node:crypto";
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {env, platform} from "node:process";
import {homedir} from "node:os";

const cacheDir = join(
  platform === "win32" ?
    (env.LOCALAPPDATA || join(homedir(), "AppData", "Local")) :
    (env.XDG_CACHE_HOME || join(homedir(), ".cache")),
  "updates",
);

let dirCreated = false;

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").substring(0, 16);
}

export function getCache(url: string): {etag: string, body: string} | null {
  try {
    const key = cacheKey(url);
    const etag = readFileSync(join(cacheDir, `${key}.etag`), "utf8");
    const body = readFileSync(join(cacheDir, `${key}.body`), "utf8");
    return etag && body ? {etag, body} : null;
  } catch {
    return null;
  }
}

export function setCache(url: string, etag: string, body: string): void {
  try {
    if (!dirCreated) { mkdirSync(cacheDir, {recursive: true}); dirCreated = true; }
    const key = cacheKey(url);
    writeFileSync(join(cacheDir, `${key}.etag`), etag);
    writeFileSync(join(cacheDir, `${key}.body`), body);
  } catch {}
}
