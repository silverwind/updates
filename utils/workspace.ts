import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {globSync, readFileSync} from "node:fs";
import {readFile, realpath} from "node:fs/promises";
import {type Deps, fieldSep} from "../modes/shared.ts";
import {getOrSet, pMap, pushTo} from "./utils.ts";

export type WorkspaceMember = {
  absPath: string,
  content: string,
  memberPath: string,
};

export function baseType(type: string): string {
  const idx = type.indexOf("|");
  return idx === -1 ? type : type.slice(0, idx);
}

const depsByMember = new WeakMap<Deps, Map<string, Array<[string, Deps[string]]>>>();

export function filterDepsForMember(allDeps: Deps, memberPath: string): Deps {
  const byMember = getOrSet(depsByMember, allDeps, () => {
    const result = new Map<string, Array<[string, Deps[string]]>>();
    for (const [key, dep] of Object.entries(allDeps)) {
      const [type, ...parts] = key.split(fieldSep);
      const separator = type.indexOf("|");
      const path = separator === -1 ? "." : type.slice(separator + 1);
      pushTo(result, path, [[baseType(type), ...parts].join(fieldSep), dep]);
    }
    return result;
  });
  return Object.fromEntries(byMember.get(memberPath) ?? []);
}

const globChars = /[*?{[]/;

function globDirectories(pattern: string, cwd: string): Array<string> {
  return globSync(pattern, {cwd, withFileTypes: true})
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => resolve(entry.parentPath, entry.name));
}

export async function resolveWorkspaceMembers(patterns: string[], workspaceDir: string, manifestFilename: string, concurrency = 32): Promise<WorkspaceMember[]> {
  const workspaceRoot = await realpath(workspaceDir);
  const excluded = new Set(patterns.filter(pattern => pattern.startsWith("!"))
    .flatMap(pattern => globDirectories(pattern.slice(1), workspaceDir))
    .map(dir => relative(workspaceDir, dir).replace(/\\/g, "/")));
  const seen = new Set<string>();
  const candidates: Array<{dir: string, memberPath: string}> = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const dirs = globChars.test(pattern) ?
      globDirectories(pattern, workspaceDir) :
      [resolve(join(workspaceDir, pattern))];
    for (const dir of dirs) {
      const rel = relative(workspaceDir, dir).replace(/\\/g, "/");
      if (excluded.has(rel)) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      candidates.push({dir, memberPath: `./${rel}`});
    }
  }
  const reads = await pMap(candidates, async ({dir, memberPath}) => {
    try {
      const absPath = await realpath(join(dir, manifestFilename));
      const rel = relative(workspaceRoot, absPath);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return {absPath, content: await readFile(absPath, "utf8"), memberPath};
    } catch {
      return null;
    }
  }, {concurrency});
  return reads.filter((m): m is WorkspaceMember => m !== null);
}

export type PnpmCatalogEntry = {
  type: string,
  name: string,
  value: string,
  lineIndex: number,
  valueIndex: number,
};

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

type FlowPair = {key: string, value: string, valueIndex: number};

type FlowPart = {colon: number, start: number, text: string};

function flowParts(content: string): Array<FlowPart> | null {
  const parts: Array<FlowPart> = [];
  let start = 1;
  let colon = -1;
  let depth = 0;
  let quote = "";
  for (let index = 1; index < content.length - 1; index++) {
    const char = content[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) {
        if (quote === "'" && content[index + 1] === "'") index++;
        else quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return null;
      depth--;
    } else if (char === ":" && depth === 0 && colon === -1) {
      colon = index - start;
    } else if (char === "," && depth === 0) {
      parts.push({colon, start, text: content.slice(start, index)});
      start = index + 1;
      colon = -1;
    }
  }
  if (quote || depth !== 0) return null;
  parts.push({colon, start, text: content.slice(start, -1)});
  return parts;
}

function yamlScalar(content: string): {value: string, valueIndex: number} | null {
  const leading = content.length - content.trimStart().length;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1); // anything past the closing quote is a comment
    if (end === -1) return null;
    return {value: trimmed.slice(1, end), valueIndex: leading + 1};
  }
  const commentIndex = trimmed.search(/\s#/);
  return {value: (commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)).trimEnd(), valueIndex: leading};
}

function flowPairs(content: string, contentIndex: number): FlowPair[] | null {
  if (!content.startsWith("{") || !content.endsWith("}")) return null;
  const result: FlowPair[] = [];
  for (const part of flowParts(content) ?? []) {
    if (part.colon === -1) return null;
    const key = yamlScalar(part.text.slice(0, part.colon));
    const value = yamlScalar(part.text.slice(part.colon + 1));
    if (!key || !value) return null;
    result.push({
      key: key.value,
      value: value.value,
      valueIndex: contentIndex + part.start + part.colon + 1 + value.valueIndex,
    });
  }
  return result;
}

export type NpmRegistryConfig = {
  registry?: string,
  registries: Record<string, string>,
};

export function parsePnpmRegistryConfig(content: string): NpmRegistryConfig {
  let registry: string | undefined;
  const registries: Record<string, string> = {};
  let inRegistries = false;
  for (const line of content.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (!pair) continue;
    if (pair.indent === 0) {
      inRegistries = pair.key === "registries";
      if (pair.key === "registry" && pair.value) registry = pair.value;
      if (inRegistries) {
        for (const entry of flowPairs(pair.value, pair.valueIndex) ?? []) registries[entry.key] = entry.value;
      }
    } else if (inRegistries && pair.value) {
      registries[pair.key] = pair.value;
    }
  }
  return {
    registry,
    registries: Object.fromEntries(Object.entries(registries).filter(([, url]) => !url.includes("${"))),
  };
}

function readConfigUp(filename: string, startDir: string): string | null {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    try {
      return readFileSync(join(dir, filename), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(dir) === dir) return null;
  }
}

const nativeRegistryCache = new Map<string, NpmRegistryConfig>();

export function resolveNativeNpmRegistry(name: string, startDir: string): string | null {
  let config = nativeRegistryCache.get(startDir);
  if (!config) {
    config = parsePnpmRegistryConfig(readConfigUp("pnpm-workspace.yaml", startDir) ?? "");
    nativeRegistryCache.set(startDir, config);
  }
  for (const [scope, url] of Object.entries(config.registries)) {
    if (scope !== "default" && name.startsWith(`${scope}/`)) return url;
  }
  return config.registries.default || config.registry || null;
}

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
      if (key === "catalog") {
        for (const entry of flowPairs(value, valueIndex) ?? []) yield {type: "catalog", name: entry.key, value: entry.value, lineIndex, valueIndex: entry.valueIndex};
      } else if (key === "catalogs") {
        for (const catalog of flowPairs(value, valueIndex) ?? []) {
          for (const entry of flowPairs(catalog.value, catalog.valueIndex) ?? []) {
            yield {type: `catalogs.${catalog.key}`, name: entry.key, value: entry.value, lineIndex, valueIndex: entry.valueIndex};
          }
        }
      }
    } else if (section === "catalog") {
      if (value) yield {type: "catalog", name: key, value, lineIndex, valueIndex};
    } else if (section === "catalogs") {
      if (nameIndent === -1 || indent <= nameIndent) {
        catalogName = key;
        nameIndent = indent;
        for (const entry of flowPairs(value, valueIndex) ?? []) {
          yield {type: `catalogs.${catalogName}`, name: entry.key, value: entry.value, lineIndex, valueIndex: entry.valueIndex};
        }
      } else if (value) {
        yield {type: `catalogs.${catalogName}`, name: key, value, lineIndex, valueIndex};
      }
    }
  }
}

export function updatePnpmWorkspace(content: string, deps: Deps): string {
  const lines = content.split("\n");
  let changed = false;
  for (const {type, name, value, lineIndex, valueIndex} of Array.from(pnpmCatalogEntries(content))
    .sort((a, b) => b.lineIndex - a.lineIndex || b.valueIndex - a.valueIndex)) {
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
  let inPackages = false;
  for (const line of content.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (pair?.indent === 0 && pair.key === "packages") {
      if (pair.value.startsWith("[") && pair.value.endsWith("]")) {
        for (const part of flowParts(pair.value) ?? []) {
          const scalar = yamlScalar(part.text);
          if (scalar) patterns.push(scalar.value);
        }
      }
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("-")) break;
      const scalar = yamlScalar(trimmed.slice(1));
      if (scalar) patterns.push(scalar.value);
    }
  }
  return patterns;
}
