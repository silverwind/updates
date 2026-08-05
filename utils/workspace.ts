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
  const idx = type.indexOf("|");
  return idx === -1 ? type : type.slice(0, idx);
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
  const includes = patterns.filter(pattern => !pattern.startsWith("!"));
  const excludes = patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1));
  const excluded = new Set(excludes.flatMap(pattern => globSync(pattern, {cwd: workspaceDir})).map(dir => dir.replace(/\\/g, "/")));
  const seen = new Set<string>();
  const candidates: Array<{absPath: string, memberPath: string}> = [];
  for (const pattern of includes) {
    const dirs = globChars.test(pattern) ?
      globSync(pattern, {cwd: workspaceDir}).map(dir => resolve(join(workspaceDir, dir))) :
      [resolve(join(workspaceDir, pattern))];
    for (const dir of dirs) {
      const rel = relative(workspaceDir, dir).replace(/\\/g, "/");
      if (excluded.has(rel)) continue;
      const absPath = join(dir, manifestFilename);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      candidates.push({absPath, memberPath: `./${rel}`});
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

export type PnpmCatalogEntry = {
  /** `catalog` for the default catalog, `catalogs.<name>` for a named one */
  type: string,
  name: string,
  value: string,
  lineIndex: number,
  /** index of `value` inside its line, quotes excluded, so a rewrite touches the value alone */
  valueIndex: number,
};

// The value capture runs to the line's end, which is what makes its start index recoverable.
const yamlPairRe = /^(\s*)(?:"([^"]*)"|'([^']*)'|([^\s#][^:#]*?))\s*:(?:\s+(.*))?$/;
const yamlCommentRe = /\s#/;

function parseYamlPair(line: string): {indent: number, key: string, value: string, valueIndex: number} | null {
  const match = yamlPairRe.exec(line);
  if (!match) return null;
  const [, indent, doubleQuoted, singleQuoted, plain, rest = ""] = match;
  let valueIndex = line.length - rest.length;
  const commentIndex = rest.search(yamlCommentRe);
  let value = (commentIndex === -1 ? rest : rest.slice(0, commentIndex)).trimEnd();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    value = value.slice(1, -1);
    valueIndex += 1;
  }
  return {indent: indent.length, key: doubleQuoted ?? singleQuoted ?? plain, value, valueIndex};
}

// Only block style is read, as `packages:` is. A member's `catalog:`/`catalog:<name>` value only
// names a catalog, so the range lives here and is reported and rewritten here alone.
export function* pnpmCatalogEntries(content: string): Generator<PnpmCatalogEntry> {
  let section = "";
  let catalogName = "";
  let nameIndent = -1;
  for (const [lineIndex, line] of content.split("\n").entries()) {
    const pair = parseYamlPair(line);
    if (!pair) continue;
    const {indent, key, value, valueIndex} = pair;
    if (indent === 0) {
      section = key === "catalog" || key === "catalogs" ? key : "";
      catalogName = "";
      nameIndent = -1;
    } else if (section === "catalog") {
      if (value) yield {type: "catalog", name: key, value, lineIndex, valueIndex};
    } else if (section === "catalogs") {
      if (nameIndent === -1 || indent <= nameIndent) {
        catalogName = key;
        nameIndent = indent;
      } else if (value) {
        yield {type: `catalogs.${catalogName}`, name: key, value, lineIndex, valueIndex};
      }
    }
  }
}

// A dep whose value moved since the run read it is left alone.
export function updatePnpmWorkspace(content: string, deps: Deps): string {
  const lines = content.split("\n");
  let changed = false;
  for (const {type, name, value, lineIndex, valueIndex} of pnpmCatalogEntries(content)) {
    const dep = deps[`${type}${fieldSep}${name}`];
    if (!dep || (dep.oldOrig || dep.old) !== value) continue;
    const line = lines[lineIndex];
    lines[lineIndex] = line.slice(0, valueIndex) + dep.new + line.slice(valueIndex + value.length);
    changed = true;
  }
  return changed ? lines.join("\n") : content;
}

export function parsePnpmWorkspace(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("-")) break;
      const match = /^\s*-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
      if (match) patterns.push(match[1]);
    }
  }
  return patterns;
}
