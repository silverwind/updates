import {env} from "node:process";
import {join, dirname} from "node:path";
import {readFileSync, globSync} from "node:fs";
import {type Deps, type ModeContext, type PackageInfo, fieldSep, stripv, getSubDir, normalizeUrl} from "./shared.ts";
import {esc} from "../utils/utils.ts";

let execFilePromise: ReturnType<typeof loadExecFile> | undefined;
async function loadExecFile() {
  const [{execFile}, {promisify}] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
  ]);
  return promisify(execFile);
}
function getExecFile() {
  return execFilePromise ??= loadExecFile();
}

export function resolveGoProxy(): string {
  const proxyEnv = env.GOPROXY || "https://proxy.golang.org,direct";
  for (const entry of proxyEnv.split(/[,|]/)) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "direct" && trimmed !== "off") {
      return normalizeUrl(trimmed);
    }
  }
  return "https://proxy.golang.org";
}

export function parseGoNoProxy(): Array<string> {
  const value = env.GONOPROXY || env.GOPRIVATE || "";
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

export function isGoNoProxy(modulePath: string, goNoProxy: Array<string>): boolean {
  return goNoProxy.some(pattern => modulePath === pattern || modulePath.startsWith(`${pattern}/`));
}

export function encodeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

export function extractGoMajor(name: string): number {
  const match = /\/v(\d+)$/.exec(name);
  return match ? Number.parseInt(match[1]) : 1;
}

export function buildGoModulePath(name: string, major: number): string {
  if (major <= 1) return name.replace(/\/v\d+$/, "");
  return `${name.replace(/\/v\d+$/, "")}/v${major}`;
}

type ReplaceMatch = {origModule: string, targetModule: string, targetVersion: string};

function parseReplaceDirective(trimmed: string, inBlock: boolean): ReplaceMatch | null {
  const match = inBlock ?
    /^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+(v\S+)/.exec(trimmed) :
    /^replace\s+(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+(v\S+)/.exec(trimmed);
  if (!match) return null;
  const [, origModule, targetModule, targetVersion] = match;
  if (targetModule.startsWith("./") || targetModule.startsWith("/") || targetModule.startsWith("../")) return null;
  return {origModule, targetModule, targetVersion};
}


function shouldSkipMajorProbe(name: string, type: string, currentVersion: string): boolean {
  return type === "indirect" || name.startsWith("golang.org/x/") || isGoPseudoVersion(currentVersion);
}

// TODO: maybe include pseudo-versions with --prerelease
export function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

type ProbeResult = {Version: string, Time: string, path: string};


function noUpdateInfo(name: string, currentVersion: string, type: string): PackageInfo {
  return [{name, old: currentVersion, new: currentVersion}, type, null, name];
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
  name: string, type: string, currentVersion: string,
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
    ...(highestPath !== name ? {newPath: highestPath} : {}),
    sameMajorNew: stripv(latestVersion),
    sameMajorTime: latestTime,
  }, type, null, name];
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
    if (/^require\s*\(/.test(trimmed)) { inRequire = true; continue; }
    if (/^replace\s*\(/.test(trimmed)) { inReplace = true; continue; }
    if (/^tool\s*\(/.test(trimmed)) { inTool = true; continue; }
    if (trimmed === ")") { inRequire = false; inReplace = false; inTool = false; continue; }

    if (inTool) {
      if (trimmed && !trimmed.startsWith("//")) toolPaths.push(trimmed);
      continue;
    }

    const toolMatch = /^tool\s+(\S+)/.exec(trimmed);
    if (toolMatch) { toolPaths.push(toolMatch[1]); continue; }

    const isIndirect = trimmed.includes("// indirect");

    if (inReplace || /^replace\s+/.test(trimmed)) {
      const parsed = parseReplaceDirective(trimmed, inReplace);
      if (parsed) {
        replace[parsed.targetModule] = parsed.targetVersion;
        replacedModules.add(parsed.origModule);
      }
      continue;
    }

    const match = inRequire ?
      /^(\S+)\s+(v\S+)/.exec(trimmed) :
      /^require\s+(\S+)\s+(v\S+)/.exec(trimmed);

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
      const source = bestMatch ? (indirect[bestMatch] ? indirect : deps[bestMatch] ? deps : null) : null;
      if (source) {
        tool[bestMatch] = source[bestMatch];
        delete source[bestMatch];
      }
    }
  }

  return {deps, indirect, replace, tool};
}

export async function fetchGoVcsInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext): Promise<PackageInfo> {
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
  if (!latest) return noUpdateInfo(name, currentVersion, type);

  const probeResult = await probeMajorVersions(currentMajor, firstProbe, (major) =>
    goListQuery(buildGoModulePath(name, major), ctx.goProbeTimeout),
  );
  return buildGoPackageInfo(name, type, currentVersion, probeResult, latest.Version, latest.Time);
}

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  if (isGoNoProxy(name, goNoProxy)) return fetchGoVcsInfo(name, type, currentVersion, goCwd, ctx);

  const encoded = encodeGoModulePath(name);
  const currentMajor = extractGoMajor(name);
  const probeGoMajor = async (major: number): Promise<ProbeResult | null> => {
    const path = buildGoModulePath(name, major);
    return ctx.doFetch(`${ctx.goProxyUrl}/${encodeGoModulePath(path)}/@latest`, {signal: AbortSignal.timeout(ctx.goProbeTimeout), headers: {"accept-encoding": "gzip, deflate, br"}})
      .then(async (r) => r.ok ? {...await r.json() as {Version: string, Time: string}, path} : null)
      .catch(() => null);
  };

  // Fetch @latest and probe for next major version in parallel
  const skip = shouldSkipMajorProbe(name, type, currentVersion);
  const [res, earlyProbe] = await Promise.all([
    ctx.doFetch(`${ctx.goProxyUrl}/${encoded}/@latest`, {signal: AbortSignal.timeout(ctx.fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}}),
    skip ? null : probeGoMajor(currentMajor + 1),
  ]);
  if (!res.ok) return noUpdateInfo(name, currentVersion, type);

  let latestVersion: string;
  let latestTime: string;
  try {
    const data = await res.json() as {Version: string, Time: string};
    latestVersion = data.Version;
    latestTime = data.Time;
  } catch {
    return noUpdateInfo(name, currentVersion, type);
  }

  const probeResult = await probeMajorVersions(currentMajor, earlyProbe, probeGoMajor);

  return buildGoPackageInfo(name, type, currentVersion, probeResult, latestVersion, latestTime);
}

export function removeGoReplace(content: string, name: string): string {
  const e = esc(name);
  // Remove single-line: replace <name> [version] => <replacement> [version]
  content = content.replace(new RegExp(`^replace\\s+${e}(\\s+v\\S+)?\\s+=>\\s+\\S+(\\s+v\\S+)?\\s*\\n`, "gm"), "");
  // Remove entry from replace block
  content = content.replace(new RegExp(`^\\s+${e}(\\s+v\\S+)?\\s+=>\\s+\\S+(\\s+v\\S+)?\\s*\\n`, "gm"), "");
  // Remove empty replace blocks
  content = content.replace(/^replace\s*\(\s*\)\s*\n/gm, "");
  return content;
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

    const oldMajor = extractGoMajor(name);
    const newMajor = Number.parseInt(newValue.split(".")[0]);

    if (oldMajor !== newMajor && newMajor > 1) {
      const newPath = buildGoModulePath(name, newMajor);
      newPkgStr = newPkgStr.replace(new RegExp(`${esc(name)} +v${esc(oldValue)}`, "g"), `${newPath} v${newValue}`);
      // Rewrite tool paths referencing the old module path
      if (depType === "tool") {
        newPkgStr = newPkgStr.replace(new RegExp(`(^\\s+|^tool\\s+)${esc(name)}(/\\S+)?\\s*$`, "gm"), `$1${newPath}$2`);
      }
      majorVersionRewrites[name] = newPath;
    } else {
      newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
    }
    if (depType !== "tool") newPkgStr = removeGoReplace(newPkgStr, name);
  }
  return [newPkgStr, majorVersionRewrites];
}

export function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>, write: (file: string, content: string) => void): void {
  if (!Object.keys(majorVersionRewrites).length) return;
  const goFiles = globSync("**/*.go", {cwd: projectDir});
  for (const relPath of goFiles) {
    const filePath = join(projectDir, relPath);
    let content = readFileSync(filePath, "utf8");
    let changed = false;
    for (const [oldPath, newPath] of Object.entries(majorVersionRewrites)) {
      const re = new RegExp(`"${esc(oldPath)}(/|")`, "g");
      const replaced = content.replace(re, `"${newPath}$1`);
      if (replaced !== content) {
        content = replaced;
        changed = true;
      }
    }
    if (changed) {
      write(filePath, content);
    }
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
    if (/^use\s*\(/.test(trimmed)) { inUse = true; continue; }
    if (/^replace\s*\(/.test(trimmed)) { inReplace = true; continue; }
    if (trimmed === ")") { inUse = false; inReplace = false; continue; }

    if (inUse) {
      const useEntry = /^(\S+)/.exec(trimmed);
      if (useEntry && !trimmed.startsWith("//")) use.push(useEntry[1]);
      continue;
    }

    const useMatch = /^use\s+(\S+)/.exec(trimmed);
    if (useMatch) { use.push(useMatch[1]); continue; }

    if (inReplace || /^replace\s+/.test(trimmed)) {
      const parsed = parseReplaceDirective(trimmed, inReplace);
      if (parsed) replace[parsed.targetModule] = parsed.targetVersion;
      continue;
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
    return url.toString();
  } else {
    return str;
  }
}

export function shortenGoModule(module: string): string {
  return /\/v[0-9]$/.test(module) ? dirname(module) : module;
}

// turn "v0.0.0-20221128193559-754e69321358" into "v0.0.0-2022112"
export function shortenGoVersion(version: string): string {
  return version.replace(/(\d{7})\d{7}-[0-9a-f]{12}$/, "$1");
}
