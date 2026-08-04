import {env} from "node:process";
import {join, dirname} from "node:path";
import {readFileSync, globSync} from "node:fs";
import {
  type Deps, type ModeContext, type PackageInfo, fieldSep, stripv, getSubDir, normalizeUrl, fetchWithRetry, defaultApiUrls,
  getExecFile, isGoPseudoVersion,
} from "./shared.ts";
import {esc} from "../utils/utils.ts";

export {isGoPseudoVersion};

export function resolveGoProxy(): string {
  const proxyEnv = env.GOPROXY || `${defaultApiUrls.goproxy},direct`;
  for (const entry of proxyEnv.split(/[,|]/)) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "direct" && trimmed !== "off") {
      return normalizeUrl(trimmed);
    }
  }
  return defaultApiUrls.goproxy;
}

export function parseGoNoProxy(): Array<string> {
  const value = env.GONOPROXY || env.GOPRIVATE || "";
  return value.split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

// Go matches these with path.Match, so `*` and `?` stay within a path element and `[…]`
// is a class. A match on any prefix element covers the whole subtree.
const goPatternCache = new Map<string, RegExp>();

function goPatternToRegex(pattern: string): RegExp {
  let cached = goPatternCache.get(pattern);
  if (cached) return cached;
  let body = "";
  for (let idx = 0; idx < pattern.length; idx++) {
    const char = pattern[idx];
    if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else if (char === "[" && pattern.includes("]", idx + 1)) {
      const end = pattern.indexOf("]", idx + 1);
      body += `[${pattern.slice(idx + 1, end).replace(/\\/g, "\\\\")}]`;
      idx = end;
    } else {
      body += esc(char); // an unterminated `[` lands here too, as a literal
    }
  }
  goPatternCache.set(pattern, cached = new RegExp(`^${body}(?:/.*)?$`));
  return cached;
}

export function isGoNoProxy(modulePath: string, goNoProxy: Array<string>): boolean {
  return goNoProxy.some(pattern => goPatternToRegex(pattern).test(modulePath));
}

export function encodeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

const goMajorSuffixRe = /\/v(\d+)$/;
// gopkg.in encodes the major as `.vN` on the last element instead of a `/vN` element.
const gopkgMajorSuffixRe = /^gopkg\.in\/.*?\.v(\d+)$/;

export function extractGoMajor(name: string): number {
  const match = gopkgMajorSuffixRe.exec(name) ?? goMajorSuffixRe.exec(name);
  return match ? Number.parseInt(match[1]) : 1;
}

export function buildGoModulePath(name: string, major: number): string {
  if (name.startsWith("gopkg.in/")) {
    // gopkg.in has no unsuffixed form, v1 is `.v1`
    return `${name.replace(/\.v\d+$/, "")}.v${major}`;
  }
  const base = name.replace(goMajorSuffixRe, "");
  return major <= 1 ? base : `${base}/v${major}`;
}

// Module path adjusted for a target version's major suffix: .../v2 -> .../v3 on a
// major bump, unchanged for same-major and +incompatible versions.
export function goModulePathForVersion(modulePath: string, version: string): string {
  if (version.includes("+incompatible")) return modulePath;
  const newMajor = Number.parseInt(stripv(version).split(".")[0]);
  if (Number.isNaN(newMajor) || newMajor === extractGoMajor(modulePath)) return modulePath;
  return buildGoModulePath(modulePath, newMajor);
}

type ReplaceMatch = {origModule: string, origVersion: string, targetModule: string, targetVersion: string};

// Line-scanning regexes, hoisted out of the per-line loops in parseGoMod/parseGoWork.
const requireBlockRe = /^require\s*\(/;
const replaceBlockRe = /^replace\s*\(/;
const toolBlockRe = /^tool\s*\(/;
const useBlockRe = /^use\s*\(/;
const replaceLineRe = /^replace\s+/;
const requireEntryRe = /^(\S+)\s+(v\S+)/;
const requireLineRe = /^require\s+(\S+)\s+(v\S+)/;
const toolLineRe = /^tool\s+(\S+)/;
const useLineRe = /^use\s+(\S+)/;
const firstWordRe = /^(\S+)/;
const replaceInBlockRe = /^(\S+)(?:\s+(v\S+))?\s+=>\s+(\S+)(?:\s+(v\S+))?/;
const replaceDirectiveRe = /^replace\s+(\S+)(?:\s+(v\S+))?\s+=>\s+(\S+)(?:\s+(v\S+))?/;

// Local paths carry no version, so they have to parse too — the caller needs to know the
// module is replaced even when there is nothing to update on the right-hand side.
function isLocalReplaceTarget(target: string): boolean {
  return target.startsWith("./") || target.startsWith("/") || target.startsWith("../");
}

function parseReplaceDirective(trimmed: string, inBlock: boolean): ReplaceMatch | null {
  const match = (inBlock ? replaceInBlockRe : replaceDirectiveRe).exec(trimmed);
  if (!match) return null;
  const [, origModule, origVersion, targetModule, targetVersion] = match;
  return {origModule, origVersion: origVersion ?? "", targetModule, targetVersion: targetVersion ?? ""};
}

function shouldSkipMajorProbe(name: string, type: string, currentVersion: string): boolean {
  return type === "indirect" || name.startsWith("golang.org/x/") || isGoPseudoVersion(currentVersion);
}

type ProbeResult = {Version: string, Time: string, path: string};

function noUpdateInfo(name: string, currentVersion: string): PackageInfo {
  return [{name, old: currentVersion, new: currentVersion}, null];
}

export async function probeMajorVersions(
  currentMajor: number,
  firstProbe: ProbeResult | null,
  probeFn: (major: number) => Promise<ProbeResult | null>,
): Promise<ProbeResult | null> {
  if (!firstProbe) return null;
  let highest = firstProbe;

  // Stop at first gap — Go majors are conventionally contiguous.
  const cap = currentMajor + 101;
  let from = currentMajor + 2;
  let batchSize = 7;
  while (from <= cap) {
    const to = Math.min(from + batchSize - 1, cap);
    const results = await Promise.all(Array.from({length: to - from + 1}, (_, idx) => probeFn(from + idx)));
    const gapIdx = results.indexOf(null);
    const hits = gapIdx === -1 ? results : results.slice(0, gapIdx);
    if (hits.length) highest = hits.at(-1)!;
    if (gapIdx !== -1) break;
    from = to + 1;
    batchSize *= 2;
  }

  return highest;
}

function buildGoPackageInfo(
  name: string, currentVersion: string,
  probe: ProbeResult | null,
  latestVersion: string, latestTime: string,
): PackageInfo {
  const highestVersion = probe?.Version ?? latestVersion;
  const highestTime = probe?.Time ?? latestTime;
  const highestPath = probe?.path ?? name;
  return [{
    name,
    old: currentVersion,
    new: stripv(highestVersion),
    Time: highestTime,
    ...(highestPath !== name && {newPath: highestPath}),
    sameMajorNew: stripv(latestVersion),
    sameMajorTime: latestTime,
  }, null];
}

export function parseGoMod(content: string): {deps: Record<string, string>, indirect: Record<string, string>, replace: Record<string, string>, tool: Record<string, string>} {
  const deps: Record<string, string> = {};
  const indirect: Record<string, string> = {};
  const replace: Record<string, string> = {};
  const tool: Record<string, string> = {};
  const replacedModules = new Set<string>();
  const toolPaths: string[] = [];
  const lines = content.split(/\r?\n/);
  let inRequire = false;
  let inReplace = false;
  let inTool = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (requireBlockRe.test(trimmed)) { inRequire = true; continue; }
    if (replaceBlockRe.test(trimmed)) { inReplace = true; continue; }
    if (toolBlockRe.test(trimmed)) { inTool = true; continue; }
    if (trimmed === ")") { inRequire = false; inReplace = false; inTool = false; continue; }
    if (trimmed.startsWith("//")) continue; // full-line comments are not dependencies

    if (inTool) {
      if (trimmed) toolPaths.push(trimmed);
      continue;
    }

    const toolMatch = toolLineRe.exec(trimmed);
    if (toolMatch) { toolPaths.push(toolMatch[1]); continue; }

    const isIndirect = trimmed.includes("// indirect");

    if (inReplace || replaceLineRe.test(trimmed)) {
      const parsed = parseReplaceDirective(trimmed, inReplace);
      if (parsed) {
        if (parsed.targetVersion && !isLocalReplaceTarget(parsed.targetModule)) {
          replace[parsed.targetModule] = parsed.targetVersion;
        }
        // A replace pinned to one version leaves the require version live and updatable;
        // an unversioned or local one takes over, making the require version inert.
        if (!parsed.origVersion) replacedModules.add(parsed.origModule);
      }
      continue;
    }

    const match = (inRequire ? requireEntryRe : requireLineRe).exec(trimmed);
    if (match) {
      (isIndirect ? indirect : deps)[match[1]] = match[2];
    }
  }

  // Exclude replaced modules from deps
  for (const mod of replacedModules) {
    delete deps[mod];
    delete indirect[mod];
  }

  // Match tool paths to their modules in require and move them to tool
  if (toolPaths.length) {
    const allModules = [...Object.keys(indirect), ...Object.keys(deps)];
    for (const toolPath of toolPaths) {
      let bestMatch = "";
      for (const mod of allModules) {
        if ((toolPath === mod || toolPath.startsWith(`${mod}/`)) && mod.length > bestMatch.length) {
          bestMatch = mod;
        }
      }
      const source = indirect[bestMatch] ? indirect : deps[bestMatch] ? deps : null;
      if (source) {
        tool[bestMatch] = source[bestMatch];
        delete source[bestMatch];
      }
    }
  }

  return {deps, indirect, replace, tool};
}

async function fetchGoVcsInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext): Promise<PackageInfo> {
  const currentMajor = extractGoMajor(name);

  const goListQuery = async (modulePath: string, timeout: number): Promise<ProbeResult | null> => {
    try {
      const execFile = await getExecFile();
      const {stdout} = await execFile("go", ["list", "-m", "-json", `${modulePath}@latest`], {timeout, cwd: goCwd, env});
      const data = JSON.parse(stdout) as {Version: string, Time?: string};
      return {Version: data.Version, Time: data.Time || "", path: modulePath};
    } catch {
      return null;
    }
  };

  // Fetch @latest and first major probe in parallel
  const skip = shouldSkipMajorProbe(name, type, currentVersion);
  const [latest, firstProbe] = await Promise.all([
    goListQuery(name, ctx.fetchTimeout),
    skip ? null : goListQuery(buildGoModulePath(name, currentMajor + 1), ctx.goProbeTimeout),
  ]);
  if (!latest) return noUpdateInfo(name, currentVersion);

  const probeResult = await probeMajorVersions(currentMajor, firstProbe, (major) =>
    goListQuery(buildGoModulePath(name, major), ctx.goProbeTimeout),
  );
  return buildGoPackageInfo(name, currentVersion, probeResult, latest.Version, latest.Time);
}

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  if (isGoNoProxy(name, goNoProxy)) return fetchGoVcsInfo(name, type, currentVersion, goCwd, ctx);

  const encoded = encodeGoModulePath(name);
  const currentMajor = extractGoMajor(name);
  const probeGoMajor = async (major: number): Promise<ProbeResult | null> => {
    const path = buildGoModulePath(name, major);
    try {
      const r = await ctx.doFetch(`${ctx.goProxyUrl}/${encodeGoModulePath(path)}/@latest`, {signal: AbortSignal.timeout(ctx.goProbeTimeout), headers: {"accept-encoding": "gzip, deflate, br"}});
      return r.ok ? {...await r.json() as {Version: string, Time: string}, path} : null;
    } catch {
      return null;
    }
  };

  // Fetch @latest and probe for next major version in parallel
  const skip = shouldSkipMajorProbe(name, type, currentVersion);
  const [res, earlyProbe] = await Promise.all([
    fetchWithRetry(ctx, `${ctx.goProxyUrl}/${encoded}/@latest`, {headers: {"accept-encoding": "gzip, deflate, br"}}),
    skip ? null : probeGoMajor(currentMajor + 1),
  ]);
  if (!res.ok) return noUpdateInfo(name, currentVersion);

  let latestVersion: string;
  let latestTime: string;
  try {
    const data = await res.json() as {Version: string, Time: string};
    latestVersion = data.Version;
    latestTime = data.Time;
  } catch {
    return noUpdateInfo(name, currentVersion);
  }

  const probeResult = await probeMajorVersions(currentMajor, earlyProbe, probeGoMajor);

  return buildGoPackageInfo(name, currentVersion, probeResult, latestVersion, latestTime);
}

export function updateGoMod(pkgStr: string, deps: Deps): [string, Record<string, string>] {
  let newPkgStr = pkgStr;
  const majorVersionRewrites: Record<string, string> = {};
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    const newValue = deps[key].new;

    if (depType === "replace") {
      // Update version in replace line: => targetModule vOLD -> => targetModule vNEW
      newPkgStr = newPkgStr.replace(new RegExp(`(=>\\s+${esc(name)}\\s+)v${esc(oldValue)}`, "g"), `$1v${newValue}`);
      continue;
    }

    // Indirect deps: only bump version, no major version rewriting or replace removal
    if (depType === "indirect") {
      newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
      continue;
    }

    const newPath = goModulePathForVersion(name, newValue);

    if (newPath !== name) {
      newPkgStr = newPkgStr.replace(new RegExp(`${esc(name)} +v${esc(oldValue)}`, "g"), `${newPath} v${newValue}`);
      // Rewrite tool paths referencing the old module path
      if (depType === "tool") {
        newPkgStr = newPkgStr.replace(new RegExp(`(^\\s+|^tool\\s+)${esc(name)}(/\\S+)?\\s*$`, "gm"), `$1${newPath}$2`);
      }
      majorVersionRewrites[name] = newPath;
    } else {
      newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
    }
  }
  return [newPkgStr, majorVersionRewrites];
}

export function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>, write: (file: string, content: string) => void): void {
  const entries = Object.entries(majorVersionRewrites);
  if (!entries.length) return;
  const lookup = new Map(entries);
  // Sort longest-first so prefix paths don't shadow longer ones in the alternation
  const sortedPaths = entries.map(([oldPath]) => oldPath).sort((a, b) => b.length - a.length);
  const combinedRe = new RegExp(`"(${sortedPaths.map(esc).join("|")})(/|")`, "g");
  const goFiles = globSync("**/*.go", {cwd: projectDir});
  for (const relPath of goFiles) {
    const filePath = join(projectDir, relPath);
    const content = readFileSync(filePath, "utf8");
    const replaced = content.replace(combinedRe, (_, oldPath, sep) => `"${lookup.get(oldPath)}${sep}`);
    if (replaced !== content) write(filePath, replaced);
  }
}

export function parseGoWork(content: string): {use: string[], replace: Record<string, string>} {
  const use: string[] = [];
  const replace: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  let inUse = false;
  let inReplace = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (useBlockRe.test(trimmed)) { inUse = true; continue; }
    if (replaceBlockRe.test(trimmed)) { inReplace = true; continue; }
    if (trimmed === ")") { inUse = false; inReplace = false; continue; }

    if (inUse) {
      const useEntry = firstWordRe.exec(trimmed);
      if (useEntry && !trimmed.startsWith("//")) use.push(useEntry[1]);
      continue;
    }

    const useMatch = useLineRe.exec(trimmed);
    if (useMatch) { use.push(useMatch[1]); continue; }

    if (inReplace || replaceLineRe.test(trimmed)) {
      const parsed = parseReplaceDirective(trimmed, inReplace);
      if (parsed?.targetVersion && !isLocalReplaceTarget(parsed.targetModule)) {
        replace[parsed.targetModule] = parsed.targetVersion;
      }
    }
  }

  return {use, replace};
}

export function getGoInfoUrl(name: string): string {
  const str = `https://${shortenGoModule(name)}`;
  const url = new URL(str);
  const pathParts = url.pathname.split("/"); // ["", "user", "repo"]
  if (pathParts.length > 3) {
    const [, user, repo, ...other] = pathParts;
    url.pathname = `/${user}/${repo}/${getSubDir(str)}/${other.join("/")}`;
    return url.href;
  } else {
    return str;
  }
}

export function shortenGoModule(module: string): string {
  return goMajorSuffixRe.test(module) ? dirname(module) : module;
}

// turn "v0.0.0-20221128193559-754e69321358" into "v0.0.0-2022112"
export function shortenGoVersion(version: string): string {
  return version.replace(/(\d{7})\d{7}-[0-9a-f]{12}$/, "$1");
}
