import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {join} from "node:path";
import {env, platform} from "node:process";
import {homedir} from "node:os";

const cacheDir = join(
  platform === "win32" ?
    (env.LOCALAPPDATA || join(homedir(), "AppData", "Local")) :
    (env.XDG_CACHE_HOME || join(homedir(), ".cache")),
  "updates",
);

let dirCreated: Promise<string | undefined> | null = null;

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").substring(0, 16);
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

export async function setCache(url: string, etag: string, body: string): Promise<void> {
  try {
    await (dirCreated ??= mkdir(cacheDir, {recursive: true}));
    await writeFile(join(cacheDir, `${cacheKey(url)}.cache`), `${etag}\n${body}`);
  } catch {}
}
