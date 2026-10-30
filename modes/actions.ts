import {resolve, join} from "node:path";
import {readdirSync} from "node:fs";
import {env} from "node:process";
import {parse} from "../utils/semver.ts";
import {
  type ModeContext, commitHashRe, ForgeError, fetchForge, formatVersionPrecision, getExecFile, githubApiUrl, parseCommitDate,
} from "./shared.ts";
import {getCache, setCache} from "../utils/fetchCache.ts";
import {forgeDirs, longestFirstAlternation} from "../utils/utils.ts";

export type ActionRef = {host: string | null, owner: string, repo: string, ref: string, name: string, isHash: boolean};

export function parseActionRef(uses: string): ActionRef | null {
  const match = /^(?!\.\.?\/|\$\/)(self:|https?:\/\/([^/]+)\/)?(([^/@]+)\/([^/@]+)[^@]*)@(.+)$/.exec(uses);
  if (!match) return null;
  const [_match, prefix = "", host = null, path, owner, repo, ref] = match;
  return {host, owner, repo, ref, name: host ? `${host}/${path}` : `${prefix}${path}`, isHash: commitHashRe.test(ref)};
}

export function instanceUrlFromRemote(remote: string): string | null {
  if (!remote.includes("://")) {
    const host = /^(?:[^@/]+@)?([^/:\\]{2,}):/.exec(remote)?.[1];
    return host ? `https://${host}` : null;
  }
  try {
    const url = new URL(remote);
    if (url.protocol === "ssh:") return `https://${url.hostname}`;
    if (url.protocol === "https:" || url.protocol === "http:") return `${url.origin}${url.pathname.replace(/(?:\/[^/]+){2}\/?$/, "")}`;
  } catch {}
  return null;
}

async function originInstanceUrl(dir: string): Promise<string | null> {
  try {
    const {stdout} = await (await getExecFile())("git", ["remote", "get-url", "origin"], {cwd: dir, encoding: "utf8", timeout: 5000});
    return instanceUrlFromRemote(stdout.trim());
  } catch {
    return null;
  }
}

export async function resolveSelfApiUrl(dir: string): Promise<string> {
  const serverUrl = (env.GITEA_SERVER_URL || env.GITHUB_SERVER_URL || "").replace(/\/+$/, "");
  const instanceUrl = serverUrl && serverUrl !== "https://github.com" ? serverUrl : await originInstanceUrl(dir);
  return instanceUrl ? `${instanceUrl}/api/v1` : "";
}

export function getForgeApiBaseUrl(host: string | null, forgeApiUrl: string): string {
  if (!host) return forgeApiUrl;
  return host === "github.com" ? githubApiUrl : `https://${host}/api/v1`;
}

export async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string, ctx: ModeContext): Promise<string | undefined> {
  const url = `${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  const cached = ctx.noCache ? null : await getCache(url);
  if (cached) return cached.body;
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
  const bare = newFullVersion.replace(/^v/i, "");
  return formatVersionPrecision(parse(bare)?.version ?? bare, oldRef);
}

const yamlPairRe = /^(\s*(?:-\s*)?)(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*)):\s*([^\r\n]*)\r?$/;

export type YamlPathEntry = {indent: number, key: string};

export function* yamlLines(lines: Array<string>): Generator<[number, string]> {
  let blockIndent = -1;
  for (const [lineNumber, line] of lines.entries()) {
    if (blockIndent !== -1) {
      if (!line.trim() || line.length - line.trimStart().length > blockIndent) continue;
      blockIndent = -1;
    }
    const pair = yamlPairRe.exec(line);
    if (pair && /^[>|](?:[+-]?\d?|\d[+-]?)$/.test(pair[5].replace(/(?:^|\s)#.*$/, "").trim())) blockIndent = pair[1].length;
    yield [lineNumber, line];
  }
}

// pops path down to this line's level, the caller decides whether to push the pair onto it
export function walkYamlPair(line: string, path: Array<YamlPathEntry>): {indent: number, key: string, value: string} | null {
  const pair = yamlPairRe.exec(line);
  if (!pair) return null;
  const indent = pair[1].length;
  const dashEnd = pair[1].indexOf("-") + 1; // closes the previous item, 0 when not a list item
  while (path.length && path.at(-1)!.indent >= (dashEnd || indent)) path.pop();
  return {indent, key: (pair[2] ?? pair[3] ?? pair[4]).trim(), value: pair[5]};
}

const pinTokenRe = /^\s*(?:(?:(?:renovate|updates)\s*:\s*)?(?:pin\s+|tag\s*=\s*)?|ratchet:[\w-]+\/[.\w-]+(?:\/[.\w-]+)*)@?((?:[\w-]*[-/])?v?\d+(?:\.\d+(?:\.\d+)?)?(?:-[a-zA-Z0-9.]+)?)/;

export function parseUsesLine(line: string) {
  const match = /^(\s*(?:-\s*)?uses:\s*)(?:(["'])(.*?)\2|((?!["'#])\S+))([^\n]*)$/.exec(line);
  if (!match) return null;
  const [_full, prefix, quote = "", quotedValue, plainValue, rest] = match;
  const value = quotedValue ?? plainValue;
  if (!value) return null;
  const hash = rest.search(/(?<=\s)#/);
  const comment = hash === -1 ? "" : rest.slice(hash);
  const pin = comment ? pinTokenRe.exec(comment.slice(1)) : null;
  return {prefix, quote, value, gap: hash === -1 ? rest : rest.slice(0, hash), comment,
    pinnedVersion: pin?.[1] ?? "", pinnedEnd: pin ? pin[0].length + 1 : 0};
}

type ActionUpdate = {name: string, oldRef: string, newRef: string, oldComment?: string, newComment?: string};

export function updateWorkflowFile(content: string, actionDeps: Array<ActionUpdate>): string {
  const depByUses = new Map(actionDeps.map(dep => [`${dep.name}@${dep.oldRef}${dep.oldComment ? `#${dep.oldComment}` : ""}`, dep]));
  const yamlPath: Array<YamlPathEntry> = [];
  const lines = content.split("\n");
  for (const [lineNumber, line] of yamlLines(lines)) {
    const pair = walkYamlPair(line, yamlPath);
    if (!pair) continue;
    const isUses = pair.key === "uses" && (
      yamlPath.length === 3 && yamlPath[0].key === "jobs" && yamlPath[2].key === "steps" ||
      yamlPath.length === 2 && (yamlPath[0].key === "jobs" || yamlPath[0].key === "runs" && yamlPath[1].key === "steps")
    );
    if (!pair.value.replace(/(?:^|\s)#.*$/, "").trim()) yamlPath.push(pair);
    const parsed = isUses && parseUsesLine(line);
    if (!parsed) continue;
    const {prefix, quote, value, gap, comment, pinnedVersion, pinnedEnd} = parsed;
    const scheme = /^https?:\/\//.exec(value)?.[0] ?? "";
    const oldComment = pinnedVersion || /^#\s*(\S+)\s*$/.exec(comment)?.[1] || "";
    const unqualifiedUses = value.slice(scheme.length);
    const dep = depByUses.get(`${unqualifiedUses}${oldComment ? `#${oldComment}` : ""}`) ?? depByUses.get(unqualifiedUses);
    if (!dep) continue;
    const newComment = dep.newComment && pinnedVersion ? `# ${dep.newComment}${comment.slice(pinnedEnd)}` : comment;
    lines[lineNumber] = `${prefix}${quote}${scheme}${dep.name}@${dep.newRef}${quote}${gap}${newComment}`;
  }
  return lines.join("\n");
}

const workflowFileRe = new RegExp( // renovate's github-actions manager patterns
  `(?:^|/)(?:(?:workflow-templates|(?:${longestFirstAlternation(forgeDirs)})/(?:workflows|actions))/.+|action)\\.ya?ml$`);

export function isWorkflowFile(file: string): boolean {
  return workflowFileRe.test(file.replace(/\\/g, "/"));
}

export function resolveWorkflowFiles(forgeDir: string): Array<string> {
  const found = new Set<string>();
  try { // the direct scan also follows symlinks and survives unreadable sibling dirs
    const workflowDir = join(forgeDir, "workflows");
    for (const file of readdirSync(workflowDir)) {
      if (/\.ya?ml$/.test(file)) found.add(resolve(workflowDir, file));
    }
  } catch {}
  try {
    for (const entry of readdirSync(forgeDir, {recursive: true, withFileTypes: true})) {
      if (entry.isFile() && isWorkflowFile(join(entry.parentPath, entry.name))) found.add(resolve(entry.parentPath, entry.name));
    }
  } catch {}
  return Array.from(found);
}
