import {join, relative, resolve} from "node:path";
import {globSync, readFileSync} from "node:fs";
import {type Deps, fieldSep} from "../modes/shared.ts";

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

export function resolveWorkspaceMembers(patterns: string[], workspaceDir: string, manifestFilename: string): WorkspaceMember[] {
  const members: WorkspaceMember[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const dirs = globChars.test(pattern) ?
      globSync(pattern, {cwd: workspaceDir}).map(dir => resolve(join(workspaceDir, dir))) :
      [resolve(join(workspaceDir, pattern))];
    for (const dir of dirs) {
      const absPath = join(dir, manifestFilename);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      let content: string;
      try { content = readFileSync(absPath, "utf8"); } catch { continue; }
      const rel = relative(workspaceDir, dir);
      const memberPath = `./${rel.replace(/\\/g, "/")}`;
      members.push({absPath, content, memberPath});
    }
  }
  return members;
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
