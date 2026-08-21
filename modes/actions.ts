import {resolve, join} from "node:path";
import {readdirSync} from "node:fs";
import {parse} from "../utils/semver.ts";
import {
  type ModeContext, commitHashRe, ForgeError, stripv, fetchForge, formatVersionPrecision, githubApiUrl, parseCommitDate,
} from "./shared.ts";
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
  return {host, owner: segments[0], repo: segments[1], ref, name, isHash: commitHashRe.test(ref)};
}

export function getForgeApiBaseUrl(host: string | null, forgeApiUrl: string): string {
  if (!host) return forgeApiUrl;
  return host === "github.com" ? githubApiUrl : `https://${host}/api/v1`;
}

export async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string, ctx: ModeContext): Promise<string | undefined> {
  const url = `${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  if (!ctx.noCache) {
    const cached = await getCache(url);
    if (cached) return cached.body;
  }
  try {
    const res = await fetchForge(url, ctx);
    if (res.status === 404) return "";
    if (!res.ok) return undefined;
    const date = parseCommitDate(await res.json());
    if (date && !ctx.noCache) setCache(url, "immutable", date);
    return date;
  } catch (err) {
    if (err instanceof ForgeError) throw err;
    return undefined;
  }
}

export function formatActionVersion(newFullVersion: string, oldRef: string): string {
  const newParsed = parse(stripv(newFullVersion));
  return formatVersionPrecision(newParsed?.version ?? stripv(newFullVersion), oldRef);
}

const yamlPairRe = /^(\s*)(?:-\s*)?(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*)):\s*([^\r\n]*)\r?$/;

const pinTokenRe = /^\s*(?:(?:renovate\s*:\s*)?(?:pin\s+|tag\s*=\s*)?|ratchet:[\w-]+\/[.\w-]+(?:\/[.\w-]+)*)@?((?:[\w-]*[-/])?v?\d+(?:\.\d+(?:\.\d+)?)?(?:-[a-zA-Z0-9.]+)?)/;

export type UsesLine = {
  prefix: string,
  quote: string,
  value: string,
  gap: string,
  comment: string,
  pinnedVersion: string,
  pinnedEnd: number,
};

export function parseUsesLine(line: string): UsesLine | null {
  const match = /^(\s*(?:-\s*)?uses:\s*)(?:(["'])(.*?)\2|((?!["'])[^\s#]+))([^\n]*)$/.exec(line);
  if (!match) return null;
  const [, prefix, quote = "", quotedValue, plainValue, rest] = match;
  const value = quotedValue ?? plainValue;
  if (!value) return null;
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

export type ActionUpdate = {name: string, oldRef: string, newRef: string, oldComment?: string, newComment?: string};

const schemeRe = /^https?:\/\//;

export function updateWorkflowFile(content: string, actionDeps: Array<ActionUpdate>): string {
  const depByUses = new Map(actionDeps.map(dep => [`${dep.name}@${dep.oldRef}${dep.oldComment ? `#${dep.oldComment}` : ""}`, dep]));
  const yamlPath: Array<{indent: number, key: string}> = [];
  let blockIndent = -1;
  return content.split("\n").map(line => {
    if (blockIndent !== -1) {
      if (!line.trim() || line.length - line.trimStart().length > blockIndent) return line;
      blockIndent = -1;
    }
    const pair = yamlPairRe.exec(line);
    if (!pair) return line;
    const indent = pair[1].length;
    while (yamlPath.length && yamlPath.at(-1)!.indent >= indent) yamlPath.pop();
    const key = (pair[2] ?? pair[3] ?? pair[4]).trim();
    const isUses = key === "uses" && (
      yamlPath[0]?.key === "jobs" && yamlPath.length === 3 && yamlPath[2].key === "steps" ||
      yamlPath[0]?.key === "runs" && yamlPath.length === 2 && yamlPath[1].key === "steps"
    );
    const pairValue = pair[5].replace(/(?:^|\s)#.*$/, "").trim();
    if (!pairValue) yamlPath.push({indent, key});
    if (/^[>|](?:[+-]?\d?|\d[+-]?)$/.test(pairValue)) { blockIndent = indent; return line; }
    if (!isUses) return line;
    const parsed = parseUsesLine(line);
    if (!parsed) return line;
    const {prefix, quote, value, gap, comment, pinnedVersion, pinnedEnd} = parsed;
    const scheme = schemeRe.exec(value)?.[0] ?? "";
    const oldComment = pinnedVersion || /^#\s*(\S+)\s*$/.exec(comment)?.[1] || "";
    const dep = depByUses.get(`${value.slice(scheme.length)}${oldComment ? `#${oldComment}` : ""}`) ??
      depByUses.get(value.slice(scheme.length));
    if (!dep) return line;
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
