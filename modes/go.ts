import {env} from "node:process";
import {join, dirname} from "node:path";
import {readFileSync, globSync} from "node:fs";
import {execFile as execFileCb} from "node:child_process";
import {promisify} from "node:util";
import {type Deps, type ModeContext, type PackageInfo, esc, fieldSep, stripv, getSubDir} from "./shared.ts";

const execFile = promisify(execFileCb);

export function resolveGoProxy(): string {
  const proxyEnv = env.GOPROXY || "https://proxy.golang.org,direct";
  for (const entry of proxyEnv.split(/[,|]/)) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "direct" && trimmed !== "off") {
      return trimmed.endsWith("/") ? trimmed.substring(0, trimmed.length - 1) : trimmed;
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
  return match ? parseInt(match[1]) : 1;
}

export function buildGoModulePath(name: string, major: number): string {
  if (major <= 1) return name.replace(/\/v\d+$/, "");
  return `${name.replace(/\/v\d+$/, "")}/v${major}`;
}

// TODO: maybe include pseudo-versions with --prerelease
export function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

export function parseGoMod(content: string): {deps: Record<string, string>, replace: Record<string, string>} {
  const deps: Record<string, string> = {};
  const replace: Record<string, string> = {};
  const replacedModules = new Set<string>();
  const lines = content.split(/\r?\n/);
  let inRequire = false;
  let inReplace = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^require\s*\(/.test(trimmed)) { inRequire = true; continue; }
    if (/^replace\s*\(/.test(trimmed)) { inReplace = true; continue; }
    if (trimmed === ")") { inRequire = false; inReplace = false; continue; }

    if (trimmed.includes("// indirect")) continue;

    if (inReplace || /^replace\s+/.test(trimmed)) {
      const m = inReplace ?
        /^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+(v\S+)/.exec(trimmed) :
        /^replace\s+(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+(v\S+)/.exec(trimmed);
      if (m) {
        const [, origModule, targetModule, targetVersion] = m;
        // Skip local path replacements
        if (!targetModule.startsWith("./") && !targetModule.startsWith("/") && !targetModule.startsWith("../")) {
          replace[targetModule] = targetVersion;
          replacedModules.add(origModule);
        }
      }
      continue;
    }

    const match = inRequire ?
      /^(\S+)\s+(v\S+)/.exec(trimmed) :
      /^require\s+(\S+)\s+(v\S+)/.exec(trimmed);

    if (match) {
      deps[match[1]] = match[2];
    }
  }

  // Exclude replaced modules from deps
  for (const mod of replacedModules) {
    delete deps[mod];
  }

  return {deps, replace};
}

export async function fetchGoVcsInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext): Promise<PackageInfo> {
  const noUpdate: PackageInfo = [{name, old: currentVersion, new: currentVersion}, type, null, name];
  const currentMajor = extractGoMajor(name);

  const goListQuery = async (modulePath: string, timeout: number) => {
    try {
      const {stdout} = await execFile("go", ["list", "-m", "-json", `${modulePath}@latest`], {
        timeout,
        cwd: goCwd,
        env,
      });
      const data = JSON.parse(stdout) as {Version: string, Time?: string};
      return {Version: data.Version, Time: data.Time || "", path: modulePath};
    } catch {
      return null;
    }
  };

  // Fetch @latest and first major probe in parallel
  const [latest, firstProbe] = await Promise.all([
    goListQuery(name, ctx.fetchTimeout),
    goListQuery(buildGoModulePath(name, currentMajor + 1), ctx.goProbeTimeout),
  ]);
  if (!latest) return noUpdate;

  const latestVersion = latest.Version;
  const latestTime = latest.Time;
  let highestVersion = latestVersion;
  let highestTime = latestTime;
  let highestPath = name;

  const applyProbe = (data: {Version: string, Time: string, path: string}) => {
    highestVersion = data.Version;
    highestTime = data.Time;
    highestPath = data.path;
  };

  if (firstProbe) {
    applyProbe(firstProbe);
    const second = await goListQuery(buildGoModulePath(name, currentMajor + 2), ctx.goProbeTimeout);
    if (second) {
      applyProbe(second);
      const probeBatchSize = 20;
      for (let batchStart = currentMajor + 3; batchStart <= currentMajor + 100; batchStart += probeBatchSize) {
        const batchEnd = Math.min(batchStart + probeBatchSize, currentMajor + 101);
        const probes = Array.from({length: batchEnd - batchStart}, (_, i) =>
          goListQuery(buildGoModulePath(name, batchStart + i), ctx.goProbeTimeout),
        );
        const results = await Promise.all(probes);
        let foundInBatch = false;
        for (const result of results) {
          if (!result) break;
          applyProbe(result);
          foundInBatch = true;
        }
        if (!foundInBatch || results.some(r => !r)) break;
      }
    }
  }

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

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  const noUpdate: PackageInfo = [{name, old: currentVersion, new: currentVersion}, type, null, name];

  if (isGoNoProxy(name, goNoProxy)) return fetchGoVcsInfo(name, type, currentVersion, goCwd, ctx);

  const encoded = encodeGoModulePath(name);
  const currentMajor = extractGoMajor(name);
  const probeGoMajor = async (major: number) => {
    const path = buildGoModulePath(name, major);
    return ctx.doFetch(`${ctx.goProxyUrl}/${encodeGoModulePath(path)}/@latest`, {signal: AbortSignal.timeout(ctx.goProbeTimeout)})
      .then(async (r) => r.ok ? {...await r.json() as {Version: string, Time: string}, path} : null)
      .catch(() => null);
  };

  // Fetch @latest and first major probe in parallel
  const [res, firstProbe] = await Promise.all([
    ctx.doFetch(`${ctx.goProxyUrl}/${encoded}/@latest`, {signal: AbortSignal.timeout(ctx.fetchTimeout)}),
    probeGoMajor(currentMajor + 1),
  ]);
  if (!res.ok) return noUpdate;

  let latestVersion: string;
  let latestTime: string;
  try {
    const data = await res.json() as {Version: string, Time: string};
    latestVersion = data.Version;
    latestTime = data.Time;
  } catch {
    return noUpdate;
  }

  // Probe for major version upgrades
  let highestVersion = latestVersion;
  let highestTime = latestTime;
  let highestPath = name;
  const applyProbe = (data: {Version: string, Time: string, path: string}) => {
    highestVersion = data.Version;
    highestTime = data.Time;
    highestPath = data.path;
  };

  if (firstProbe) {
    applyProbe(firstProbe);
    const second = await probeGoMajor(currentMajor + 2);
    if (second) {
      applyProbe(second);
      // Multiple consecutive majors, probe further in parallel batches
      const probeBatchSize = 20;
      for (let batchStart = currentMajor + 3; batchStart <= currentMajor + 100; batchStart += probeBatchSize) {
        const batchEnd = Math.min(batchStart + probeBatchSize, currentMajor + 101);
        const probes = Array.from({length: batchEnd - batchStart}, (_, i) => ({
          result: probeGoMajor(batchStart + i),
        }));
        const results = await Promise.all(probes.map(p => p.result));
        let foundInBatch = false;
        for (const result of results) {
          if (!result) break;
          applyProbe(result);
          foundInBatch = true;
        }
        if (!foundInBatch || results.some(r => !r)) break;
      }
    }
  }

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

    const oldMajor = extractGoMajor(name);
    const newMajor = parseInt(newValue.split(".")[0]);

    if (oldMajor !== newMajor && newMajor > 1) {
      const newPath = buildGoModulePath(name, newMajor);
      newPkgStr = newPkgStr.replace(new RegExp(`${esc(name)} +v${esc(oldValue)}`, "g"), `${newPath} v${newValue}`);
      majorVersionRewrites[name] = newPath;
    } else {
      newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
    }
    newPkgStr = removeGoReplace(newPkgStr, name);
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

export function getGoInfoUrl(name: string): string {
  const str = `https://${shortenGoModule(name)}`;
  const url = new URL(str);
  const pathParts = url.pathname.split("/"); // ["", "user", "repo"]
  if (pathParts.length > 3) {
    const [_empty, user, repo, ...other] = pathParts;
    url.pathname = `/${user}/${repo}/${getSubDir(str)}/${other.join("/")}`;
    return url.toString();
  } else {
    return str;
  }
}

export function shortenGoModule(module: string): string {
  return /\/v[0-9]$/.test(module) ? dirname(module) : module;
}

// turn "v1.3.2-0.20230802210424-5b0b94c5c0d3" into "v1.3.2"
export function shortenGoVersion(version: string): string {
  return version.replace(/-.*/, "");
}
