import {join, relative, resolve} from "node:path";
import {globSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {type Deps, fieldSep} from "../modes/shared.ts";
import {pMap} from "./utils.ts";

export type WorkspaceMember = {
  absPath: string,
  content: string,
  memberPath: string,
};

export function baseType(type: string): string {
  return type.split("|")[0];
}

export function filterDepsForMember(allDeps: Deps, memberPath: string): Deps {
  const expectedSuffix = memberPath === "." ? "" : `|${memberPath}`;
  const result: Deps = {};
  for (const [key, dep] of Object.entries(allDeps)) {
    const [type, name] = key.split(fieldSep);
    const base = baseType(type);
    if (type === `${base}${expectedSuffix}`) {
      result[`${base}${fieldSep}${name}`] = dep;
    }
  }
  return result;
}

const globChars = /[*?{[]/;

export async function resolveWorkspaceMembers(patterns: string[], workspaceDir: string, manifestFilename: string, concurrency = 32): Promise<WorkspaceMember[]> {
  const seen = new Set<string>();
  const candidates: Array<{absPath: string, memberPath: string}> = [];
  for (const pattern of patterns) {
    const dirs = globChars.test(pattern) ?
      globSync(pattern, {cwd: workspaceDir}).map(dir => resolve(join(workspaceDir, dir))) :
      [resolve(join(workspaceDir, pattern))];
    for (const dir of dirs) {
      const absPath = join(dir, manifestFilename);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      const rel = relative(workspaceDir, dir);
      candidates.push({absPath, memberPath: `./${rel.replace(/\\/g, "/")}`});
    }
  }
  const reads = await pMap(candidates, async ({absPath, memberPath}) => {
    try {
      return {absPath, content: await readFile(absPath, "utf8"), memberPath};
    } catch {
      return null;
    }
  }, {concurrency});
  return reads.filter((m): m is WorkspaceMember => m !== null);
}

export function parsePnpmWorkspace(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split("\n");
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^\S/.test(line)) break;
      const match = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
      if (match) patterns.push(match[1]);
    }
  }
  return patterns;
}
