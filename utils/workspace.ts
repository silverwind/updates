import {isAbsolute, join, relative, resolve, sep} from "node:path";
import {globSync, readFileSync} from "node:fs";
import {readFile, realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {env, platform} from "node:process";
import {type Deps, fieldSep} from "../modes/shared.ts";
import {getOrSet, pMap, pushTo, walkUpSync} from "./utils.ts";

export type WorkspaceMember = {absPath: string, content: string, memberPath: string};

export function baseType(type: string): string {
  const idx = type.indexOf("|");
  return idx === -1 ? type : type.slice(0, idx);
}

const depsByMember = new WeakMap<Deps, Map<string, Array<[string, Deps[string]]>>>();

export function filterDepsForMember(allDeps: Deps, memberPath: string): Deps {
  const byMember = getOrSet(depsByMember, allDeps, () => {
    const result = new Map<string, Array<[string, Deps[string]]>>();
    for (const [key, dep] of Object.entries(allDeps)) {
      const type = key.split(fieldSep, 1)[0];
      const separator = type.indexOf("|");
      pushTo(result, separator === -1 ? "." : type.slice(separator + 1), [`${baseType(type)}${key.slice(type.length)}`, dep]);
    }
    return result;
  });
  return Object.fromEntries(byMember.get(memberPath) ?? []);
}

const globChars = /[*?{[]/;
const ignoredDirs = new Set(["node_modules", "bower_components"]);

function globDirectories(pattern: string, cwd: string): Array<string> {
  return globSync(pattern, {cwd, exclude: entry => ignoredDirs.has(entry.name), withFileTypes: true})
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => resolve(entry.parentPath, entry.name));
}

export async function resolveWorkspaceMembers(patterns: string[], workspaceDir: string, manifestFilename: string, concurrency = 32): Promise<WorkspaceMember[]> {
  const workspaceRoot = await realpath(workspaceDir);
  const excluded = new Set(patterns.filter(pattern => pattern.startsWith("!"))
    .flatMap(pattern => globDirectories(pattern.slice(1), workspaceDir))
    .map(dir => relative(workspaceDir, dir).replace(/\\/g, "/")));
  const candidates = new Map<string, string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    for (const dir of globChars.test(pattern) ? globDirectories(pattern, workspaceDir) : [resolve(join(workspaceDir, pattern))]) {
      const rel = relative(workspaceDir, dir).replace(/\\/g, "/");
      if (!excluded.has(rel) && !candidates.has(dir)) candidates.set(dir, `./${rel}`);
    }
  }
  const reads = await pMap(candidates, async ([dir, memberPath]) => {
    try {
      const absPath = await realpath(join(dir, manifestFilename));
      const rel = relative(workspaceRoot, absPath);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return {absPath, content: await readFile(absPath, "utf8"), memberPath};
    } catch {
      return null;
    }
  }, {concurrency});
  return reads.filter(member => member !== null);
}

type PnpmCatalogEntry = {type: string, name: string, value: string, lineIndex: number, valueIndex: number};

const yamlPairRe = /^(\s*)(?:"([^"]*)"|'([^']*)'|([^\s#](?:[^:#]|:(?=\S))*?))\s*:(?:\s+(.*))?$/;
const yamlCommentRe = /\s#/;

function parseYamlPair(line: string): {indent: number, key: string, value: string, valueIndex: number} | null {
  const match = yamlPairRe.exec(line);
  if (!match) return null;
  const [_full, indent, doubleQuoted, singleQuoted, plain, rest = ""] = match;
  let valueIndex = line.length - rest.length;
  const commentIndex = rest.startsWith("#") ? 0 : rest.search(yamlCommentRe);
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

function flowParts(content: string): Array<FlowPart> {
  const parts: Array<FlowPart> = [];
  let start = 1;
  let colon = -1;
  let depth = 0;
  let quote = "";
  for (let index = 1; index < content.length - 1; index++) {
    const char = content[index];
    if (quote) {
      if ((char === "\\" && quote === '"') || (char === quote && quote === "'" && content[index + 1] === "'")) index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return [];
      depth--;
    } else if (char === ":" && depth === 0 && colon === -1) {
      colon = index - start;
    } else if (char === "," && depth === 0) {
      parts.push({colon, start, text: content.slice(start, index)});
      start = index + 1;
      colon = -1;
    }
  }
  if (quote || depth !== 0) return [];
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
    return end === -1 ? null : {value: trimmed.slice(1, end), valueIndex: leading + 1};
  }
  const commentIndex = trimmed.search(yamlCommentRe);
  return {value: (commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)).trimEnd(), valueIndex: leading};
}

function flowPairs(content: string, contentIndex: number): FlowPair[] {
  if (!content.startsWith("{") || !content.endsWith("}")) return [];
  const result: FlowPair[] = [];
  for (const part of flowParts(content)) {
    if (part.colon === -1) return [];
    const key = yamlScalar(part.text.slice(0, part.colon));
    const value = yamlScalar(part.text.slice(part.colon + 1));
    if (!key || !value) return [];
    result.push({key: key.value, value: value.value, valueIndex: contentIndex + part.start + part.colon + 1 + value.valueIndex});
  }
  return result;
}

type NpmRegistryConfig = {registry?: string, registries: Record<string, string>};

export function parsePnpmRegistryConfig(content: string): NpmRegistryConfig {
  let registry: string | undefined;
  const registries: Record<string, string> = {};
  let inRegistries = false;
  for (const line of content.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (pair?.indent === 0) {
      inRegistries = pair.key === "registries";
      if (pair.key === "registry" && pair.value) registry = pair.value;
      if (inRegistries) for (const entry of flowPairs(pair.value, pair.valueIndex)) registries[entry.key] = entry.value;
    } else if (inRegistries && pair?.value) {
      registries[pair.key] = pair.value;
    }
  }
  return {registry, registries: Object.fromEntries(Object.entries(registries).filter(([_scope, url]) => !url.includes("${")))};
}

function readIfExists(file: string): {content: string} | null {
  try {
    return {content: readFileSync(file, "utf8")};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export function parseYamlMap(content: string): Record<string, any> {
  const root: Record<string, any> = {};
  const stack = [{indent: -1, map: root}];
  for (const line of content.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (!pair) continue;
    while (pair.indent <= stack.at(-1)!.indent) stack.pop();
    const map = stack.at(-1)!.map;
    map[pair.key] = pair.value || {};
    if (!pair.value) stack.push({indent: pair.indent, map: map[pair.key]});
  }
  return root;
}

export type PnpmAuth = {tokens: Record<string, string>, registries: Record<string, string>};

export function parsePnpmAuth(value: unknown, source: string): PnpmAuth {
  const result: PnpmAuth = {tokens: {}, registries: {}};
  try {
    const parsed = (typeof value === "string" ? JSON.parse(value) : value ?? {}) as Record<string, Record<string, {authToken?: string}>>;
    for (const [url, scopes] of Object.entries(parsed)) {
      const {host, pathname, href} = new URL(url);
      for (const [scope, {authToken}] of Object.entries(scopes)) {
        if (typeof authToken !== "string") continue;
        result.tokens[`//${host}${pathname.replace(/\/$/, "")}/:${scope === "@" ? "" : `${scope}:`}_authToken`] = authToken;
        result.registries[scope === "@" ? "default" : scope] = href;
      }
    }
  } catch (err) {
    throw new Error(`Invalid _auth in ${source}: ${(err as Error).message}`);
  }
  return result;
}

const nativeRegistryCache = new Map<string, NpmRegistryConfig>();

export function nativeNpmRegistryConfig(startDir: string): NpmRegistryConfig {
  return getOrSet(nativeRegistryCache, startDir, () => parsePnpmRegistryConfig(
    walkUpSync(resolve(startDir), dir => readIfExists(join(dir, "pnpm-workspace.yaml")))?.content ?? ""));
}

type PnpmGlobalConfig = NpmRegistryConfig & {auth: PnpmAuth};

const globalConfigCache = new Map<string, PnpmGlobalConfig>();

function pnpmConfigDir(): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pnpm");
  if (platform === "darwin") return join(homedir(), "Library/Preferences/pnpm");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "pnpm/config");
  return join(homedir(), ".config/pnpm");
}

export function pnpmGlobalConfig(): PnpmGlobalConfig {
  const configDir = pnpmConfigDir();
  return getOrSet(globalConfigCache, configDir, () => {
    const content = readIfExists(join(configDir, "config.yaml"))?.content ?? "";
    return {...parsePnpmRegistryConfig(content), auth: parsePnpmAuth(parseYamlMap(content)._auth, "config.yaml")};
  });
}

const flowEntries = (type: string, {value, valueIndex}: {value: string, valueIndex: number}, lineIndex: number) =>
  flowPairs(value, valueIndex).map(entry => ({type, name: entry.key, value: entry.value, lineIndex, valueIndex: entry.valueIndex}));

export function* pnpmCatalogEntries(content: string): Generator<PnpmCatalogEntry> {
  let section = "";
  let type = "";
  let nameIndent = -1;
  for (const [lineIndex, line] of content.split("\n").entries()) {
    const pair = parseYamlPair(line);
    if (!pair) continue;
    const {indent, key, value, valueIndex} = pair;
    if (indent === 0) {
      section = key;
      type = key;
      nameIndent = -1;
      if (key === "catalog") yield* flowEntries(key, pair, lineIndex);
      else if (key === "catalogs") for (const catalog of flowPairs(value, valueIndex)) yield* flowEntries(`catalogs.${catalog.key}`, catalog, lineIndex);
    } else if (section === "catalogs" && (nameIndent === -1 || indent <= nameIndent)) {
      type = `catalogs.${key}`;
      nameIndent = indent;
      yield* flowEntries(type, pair, lineIndex);
    } else if (value && (section === "catalog" || section === "catalogs")) {
      yield {type, name: key, value, lineIndex, valueIndex};
    }
  }
}

export function updatePnpmWorkspace(content: string, deps: Deps): string {
  let lines: string[] | undefined;
  for (const {type, name, value, lineIndex, valueIndex} of Array.from(pnpmCatalogEntries(content)).reverse()) {
    const dep = deps[`${type}${fieldSep}${name}`];
    if (!dep || (dep.oldOrig || dep.old) !== value) continue;
    const line = (lines ??= content.split("\n"))[lineIndex];
    lines[lineIndex] = line.slice(0, valueIndex) + dep.new + line.slice(valueIndex + value.length);
  }
  return lines ? lines.join("\n") : content;
}

export function parsePnpmWorkspace(content: string): string[] {
  const items: string[] = [];
  let inPackages = false;
  for (const line of content.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (pair?.indent === 0 && pair.key === "packages") {
      inPackages = true;
      if (pair.value.startsWith("[") && pair.value.endsWith("]")) items.push(...flowParts(pair.value).map(part => part.text));
    } else if (inPackages) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) items.push(trimmed.slice(1));
      else if (trimmed && !trimmed.startsWith("#")) break;
    }
  }
  return items.map(item => yamlScalar(item)?.value).filter(value => value !== undefined);
}
