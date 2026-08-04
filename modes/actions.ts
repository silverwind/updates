import {resolve, join} from "node:path";
import {readdirSync} from "node:fs";
import {parse} from "../utils/semver.ts";
import {type ModeContext, type TagEntry, stripv, hashRe, fetchForge, fetchActionTags, formatVersionPrecision, githubApiUrl, parseCommitDate} from "./shared.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {esc, forgeDirs} from "../utils/utils.ts";

export {type TagEntry, fetchActionTags};
export const actionsUsesRe = /^\s*(?:-\s*)?uses:\s*['"]?([^'"#\s]+)['"]?/gm;

export type ActionRef = {
  host: string | null,
  owner: string,
  repo: string,
  ref: string,
  name: string,
  isHash: boolean,
};

export function parseActionRef(uses: string): ActionRef | null {
  if (uses.startsWith("docker://") || uses.startsWith("./")) return null;
  const urlMatch = /^https?:\/\/([^/]+)\/(.+)$/.exec(uses);
  const host = urlMatch?.[1] ?? null;
  const rest = urlMatch?.[2] ?? uses;
  const atIndex = rest.indexOf("@");
  if (atIndex === -1) return null;
  const pathPart = rest.substring(0, atIndex);
  const ref = rest.substring(atIndex + 1);
  if (!ref) return null;
  const segments = pathPart.split("/");
  if (segments.length < 2) return null;
  const name = host ? `${host}/${pathPart}` : pathPart;
  return {host, owner: segments[0], repo: segments[1], ref, name, isHash: hashRe.test(ref)};
}

// A host spelled out in the ref wins over the configured forge, so `https://gitea.com/o/r@v1`
// resolves against gitea.com even when the run defaults to GitHub. A bare `o/r@v1` has no host
// to go on and follows the default.
export function getForgeApiBaseUrl(host: string | null, forgeApiUrl: string): string {
  if (!host) return forgeApiUrl;
  return host === "github.com" ? githubApiUrl : `https://${host}/api/v1`;
}

export async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string, ctx: ModeContext): Promise<string> {
  // Commit data is immutable — cache the resolved date forever keyed by URL.
  const url = `${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  if (!ctx.noCache) {
    const cached = await getCache(url);
    if (cached) return cached.body;
  }
  try {
    const res = await fetchForge(url, ctx);
    if (!res.ok) return "";
    const date = parseCommitDate(await res.json());
    if (date && !ctx.noCache) setCache(url, "immutable", date);
    return date;
  } catch {
    return "";
  }
}

export function formatActionVersion(newFullVersion: string, oldRef: string): string {
  const newParsed = parse(stripv(newFullVersion));
  return formatVersionPrecision(newParsed?.version ?? stripv(newFullVersion), oldRef);
}

export function updateWorkflowFile(content: string, actionDeps: Array<{name: string, oldRef: string, newRef: string, newComment?: string}>): string {
  let newContent = content;
  for (const {name, oldRef, newRef, newComment} of actionDeps) {
    const uses = `(uses:\\s*['"]?(?:https?:\\/\\/)?)${esc(name)}@${esc(oldRef)}(?![\\w.-])`;
    // A sha pin carries its readable version in a trailing comment. Rewriting the sha alone
    // leaves that comment naming the old version, so the file misreports what it pins. Run
    // first, so the pass below only sees occurrences without a comment.
    if (newComment) {
      newContent = newContent.replace(new RegExp(`${uses}([ \\t]*#[ \\t]*)v?\\d\\S*`, "g"), `$1${name}@${newRef}$2${newComment}`);
    }
    newContent = newContent.replace(new RegExp(uses, "g"), `$1${name}@${newRef}`);
  }
  return newContent;
}

const workflowFileRe = new RegExp(`(?:^|/)(?:${forgeDirs.map(esc).join("|")})\\/(?:workflows\\/[^/]+|(?:[^/]+\\/)*action)\\.ya?ml$`);

export function isWorkflowFile(file: string): boolean {
  return workflowFileRe.test(file.replace(/\\/g, "/"));
}

export function resolveWorkflowFiles(forgeDir: string): Array<string> {
  const found = new Set<string>();
  try {
    for (const f of readdirSync(join(forgeDir, "workflows"))) {
      if (/\.ya?ml$/.test(f)) found.add(resolve(join(forgeDir, "workflows", f)));
    }
  } catch {}
  try {
    for (const entry of readdirSync(forgeDir, {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !/^action\.ya?ml$/.test(entry.name)) continue;
      found.add(resolve(join(entry.parentPath, entry.name)));
    }
  } catch {}
  return Array.from(found);
}

