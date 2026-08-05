import {resolve, join} from "node:path";
import {readdirSync} from "node:fs";
import {parse} from "../utils/semver.ts";
import {type ModeContext, ForgeError, stripv, hashRe, fetchForge, formatVersionPrecision, githubApiUrl, parseCommitDate} from "./shared.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {forgeDirs, longestFirstAlternation} from "../utils/utils.ts";

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

// "" is a commit with no date, which holds a cooldown candidate back, undefined is a failed request.
export async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string, ctx: ModeContext): Promise<string | undefined> {
  // Commit data is immutable — cache the resolved date forever keyed by URL.
  const url = `${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  if (!ctx.noCache) {
    const cached = await getCache(url);
    if (cached) return cached.body;
  }
  try {
    const res = await fetchForge(url, ctx);
    if (res.status === 404) return ""; // the commit is gone, so no date will ever exist
    if (!res.ok) return undefined;
    const date = parseCommitDate(await res.json());
    if (date && !ctx.noCache) setCache(url, "immutable", date);
    return date;
  } catch (err) {
    // A classified forge failure is the dependency's result, a malformed body is worth degrading over.
    if (err instanceof ForgeError) throw err;
    return undefined;
  }
}

export function formatActionVersion(newFullVersion: string, oldRef: string): string {
  const newParsed = parse(stripv(newFullVersion));
  return formatVersionPrecision(newParsed?.version ?? stripv(newFullVersion), oldRef);
}

// Reader and writer share this, so the writer can never reach a `uses:` the reader did not extract,
// like a commented-out step or one quoted inside a `run:` script.
const usesLineRe = /^(\s*(?:-\s*)?uses:\s*)([^\n]*)$/;

// The version a trailing comment names, behind the `renovate:`, `pin `, `tag=` and `ratchet:`
// prefixes a pinned sha's comment carries. Mirrors renovate's pinTokenRe.
const pinTokenRe = /^\s*(?:(?:renovate\s*:\s*)?(?:pin\s+|tag\s*=\s*)?|ratchet:[\w-]+\/[.\w-]+)@?((?:[\w-]*[-/])?v?\d+(?:\.\d+(?:\.\d+)?)?(?:-[a-zA-Z0-9.]+)?)/;

export type UsesLine = {
  prefix: string, // indentation, the list dash and `uses:` with its trailing space
  quote: string, // the quote around the value, empty when it is unquoted
  value: string, // the `[scheme://]owner/repo[/path]@ref` text, unquoted
  gap: string, // whatever sits between the value and the comment
  comment: string, // the comment including its `#`, empty when the line has none
  pinnedVersion: string, // the version the comment names, empty when it names none
  pinnedEnd: number, // offset into `comment` just past the token that named it
};

export function parseUsesLine(line: string): UsesLine | null {
  const match = usesLineRe.exec(line);
  if (!match) return null;
  const [, prefix, remainder] = match;
  const quote = remainder[0] === "'" || remainder[0] === '"' ? remainder[0] : "";
  const quoteEnd = quote ? remainder.indexOf(quote, 1) : 0;
  if (quoteEnd === -1) return null;
  const value = quote ? remainder.slice(1, quoteEnd) : /^[^\s#]*/.exec(remainder)![0];
  if (!value) return null;
  const rest = remainder.slice(quote ? quoteEnd + 1 : value.length);
  const hash = rest.indexOf("#");
  const comment = hash === -1 ? "" : rest.slice(hash);
  const pin = comment ? pinTokenRe.exec(comment.slice(1)) : null;
  return {
    prefix, quote, value,
    gap: hash === -1 ? rest : rest.slice(0, hash),
    comment,
    pinnedVersion: pin?.[1] ?? "",
    pinnedEnd: pin ? pin[0].length + 1 : 0,
  };
}

const schemeRe = /^https?:\/\//;

export function updateWorkflowFile(content: string, actionDeps: Array<{name: string, oldRef: string, newRef: string, newComment?: string}>): string {
  const depByUses = new Map(actionDeps.map(dep => [`${dep.name}@${dep.oldRef}`, dep]));
  return content.split("\n").map(line => {
    const parsed = parseUsesLine(line);
    if (!parsed) return line;
    const {prefix, quote, value, gap, comment, pinnedVersion, pinnedEnd} = parsed;
    const scheme = schemeRe.exec(value)?.[0] ?? "";
    const dep = depByUses.get(value.slice(scheme.length));
    if (!dep) return line;
    // A sha pin's trailing comment names the version and would otherwise keep naming the old one.
    // Renovate rewrites it to the version alone, dropping any `tag=`/`pin`/`ratchet:` prefix.
    const newComment = dep.newComment && pinnedVersion ? `# ${dep.newComment}${comment.slice(pinnedEnd)}` : comment;
    return `${prefix}${quote}${scheme}${dep.name}@${dep.newRef}${quote}${gap}${newComment}`;
  }).join("\n");
}

const workflowFileRe = new RegExp(`(?:^|/)(?:${longestFirstAlternation(forgeDirs)})/(?:workflows/[^/]+|(?:[^/]+/)*action)\\.ya?ml$`);

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

