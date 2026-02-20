import {resolve, join} from "node:path";
import {readdirSync} from "node:fs";

import {parse} from "../utils/semver.ts";
import {type ModeContext, esc, stripv, fetchForge} from "./shared.ts";

export const actionsUsesRe = /^\s*-?\s*uses:\s*['"]?([^'"#\s]+)['"]?/gm;
export const hashRe = /^[0-9a-f]{7,}$/i;

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

export function getForgeApiBaseUrl(host: string | null, forgeApiUrl: string): string {
  if (!host) return forgeApiUrl;
  if (host === "github.com") return "https://api.github.com";
  return `https://${host}/api/v1`;
}

export type TagEntry = {
  name: string,
  commitSha: string,
};

function parseTags(data: Array<any>): Array<TagEntry> {
  return data.map((tag: any) => ({name: tag.name, commitSha: tag.commit?.sha || ""}));
}

export async function fetchActionTags(apiUrl: string, owner: string, repo: string, ctx: ModeContext): Promise<Array<TagEntry>> {
  const res = await fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100`, ctx);
  if (!res?.ok) return [];
  const results = parseTags(await res.json());
  const link = res.headers.get("link") || "";
  const last = /<([^>]+)>;\s*rel="last"/.exec(link);
  if (last) {
    const lastPage = Number(new URL(last[1]).searchParams.get("page"));
    const pages = await Promise.all(
      Array.from({length: lastPage - 1}, (_, i) => fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${i + 2}`, ctx)),
    );
    for (const pageRes of pages) {
      if (pageRes?.ok) results.push(...parseTags(await pageRes.json()));
    }
  }
  return results;
}

export async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string, ctx: ModeContext): Promise<string> {
  const res = await fetchForge(`${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`, ctx);
  if (!res?.ok) return "";
  const data = await res.json();
  return data?.committer?.date || data?.author?.date || "";
}

export function formatActionVersion(newFullVersion: string, oldRef: string): string {
  const hadV = oldRef.startsWith("v");
  const newParsed = parse(stripv(newFullVersion));
  const parts = stripv(oldRef).split(".").length;
  let bare: string;
  if (!newParsed) bare = stripv(newFullVersion);
  else if (parts === 1) bare = String(newParsed.major);
  else if (parts === 2) bare = `${newParsed.major}.${newParsed.minor}`;
  else bare = newParsed.version;
  return hadV ? `v${bare}` : bare;
}

export function updateWorkflowFile(content: string, actionDeps: Array<{name: string, oldRef: string, newRef: string}>): string {
  let newContent = content;
  for (const {name, oldRef, newRef} of actionDeps) {
    const re = new RegExp(`(uses:\\s*['"]?)${esc(name)}@${esc(oldRef)}`, "g");
    newContent = newContent.replace(re, `$1${name}@${newRef}`);
  }
  return newContent;
}

export function isWorkflowFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return /\.github\/workflows\/[^/]+\.(ya?ml)$/.test(normalized);
}

export function resolveWorkflowFiles(dir: string): Array<string> {
  try {
    return readdirSync(dir).filter(f => /\.(ya?ml)$/.test(f)).map(f => resolve(join(dir, f)));
  } catch {
    return [];
  }
}

export type CheckResult = {
  key: string,
  newRange: string,
  user: string,
  repo: string,
  oldRef: string,
  newRef: string,
  newDate?: string,
  newTag?: string,
};
