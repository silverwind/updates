import {env} from "node:process";
import {join, dirname} from "node:path";
import {readFileSync, globSync} from "node:fs";
import {
  type Deps, type GoProxyEntry, type ModeContext, type PackageInfo, dedupe, fieldSep, stripv, getSubDir, normalizeUrl,
  fetchWithRetry, defaultApiUrls, getExecFile, isGoPseudoVersion, isVersionPrerelease,
  throwFetchError,
} from "./shared.ts";
import {gt, valid} from "../utils/semver.ts";
import {esc, getOrSet, longestFirstAlternation, tryOrNull} from "../utils/utils.ts";

export type {GoProxyEntry};

// go turns a bare host into an https URL, so `GOPROXY=proxy.corp/mod` reaches the same endpoint.
function goProxyEntryUrl(url: string): string {
  const absolute = url.includes(":/") || url.startsWith("/");
  return normalizeUrl(!absolute && /[.:/]/.test(url) ? `https://${url}` : url);
}

// GOPROXY is an ordered list: `,` moves on only when the module is absent there, `|` on any error.
// `off` (fail, look nothing up) and `direct` (VCS only) both end the list, exactly as in go.
export function parseGoProxy(value: string): Array<GoProxyEntry> {
  const entries: Array<GoProxyEntry> = [];
  let rest = value;
  while (rest) {
    const sepIdx = rest.search(/[,|]/);
    const url = (sepIdx === -1 ? rest : rest.slice(0, sepIdx)).trim();
    const fallback = sepIdx !== -1 && rest[sepIdx] === "|" ? "|" : ",";
    rest = sepIdx === -1 ? "" : rest.slice(sepIdx + 1);
    if (!url) continue;
    if (url === "off" || url === "direct") { entries.push({url, fallback}); break; }
    entries.push({url: goProxyEntryUrl(url), fallback});
  }
  return entries;
}

// An endpoint override stands in for the whole list, without one GOPROXY spells it out. `off` and
// `direct` are tokens, not URLs, so no origin can be derived from them.
export function resolveGoProxyChain(override?: string): Array<GoProxyEntry> {
  if (typeof override === "string") return [{url: normalizeUrl(override), fallback: ","}];
  const list = parseGoProxy(env.GOPROXY || `${defaultApiUrls.goproxy},direct`);
  return list.length ? list : [{url: defaultApiUrls.goproxy, fallback: ","}];
}

export function parseGoNoProxy(): Array<string> {
  const value = env.GONOPROXY || env.GOPRIVATE || "";
  return value.split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

// Go matches these with path.Match, so `*` and `?` stay within a path element and `[…]`
// is a class. A match on any prefix element covers the whole subtree.
const goPatternCache = new Map<string, RegExp>();

function goPatternToRegex(pattern: string): RegExp {
  return getOrSet(goPatternCache, pattern, () => {
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
    return new RegExp(`^${body}(?:/.*)?$`);
  });
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

const quotedRe = /^"(.*)"$/; // a module path may be quoted, and the quotes are not part of it
const trimQuotes = (str: string): string => quotedRe.exec(str)?.[1] ?? str;

// Local paths carry no version, so they have to parse too — the caller needs to know the
// module is replaced even when there is nothing to update on the right-hand side.
function isLocalReplaceTarget(target: string): boolean {
  return target.startsWith("./") || target.startsWith("/") || target.startsWith("../");
}

function parseReplaceDirective(trimmed: string, inBlock: boolean): ReplaceMatch | null {
  const match = (inBlock ? replaceInBlockRe : replaceDirectiveRe).exec(trimmed);
  if (!match) return null;
  const [, origModule, origVersion, targetModule, targetVersion] = match;
  return {origModule: trimQuotes(origModule), origVersion: origVersion ?? "", targetModule: trimQuotes(targetModule), targetVersion: targetVersion ?? ""};
}

function shouldSkipMajorProbe(name: string, type: string, currentVersion: string): boolean {
  return type === "indirect" || name.startsWith("golang.org/x/") || isGoPseudoVersion(currentVersion);
}

type ProbeResult = {Version: string, Time: string, path: string};

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
      if (trimmed) toolPaths.push(trimQuotes(trimmed));
      continue;
    }

    const toolMatch = toolLineRe.exec(trimmed);
    if (toolMatch) { toolPaths.push(trimQuotes(toolMatch[1])); continue; }

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
      (isIndirect ? indirect : deps)[trimQuotes(match[1])] = match[2];
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

  // A missing `go`, an unreachable host, an auth prompt and a nonexistent module all leave
  // `go list` with the same exit, and nothing follows `direct`, so any failure is the dep's error.
  const goListQuery = async (modulePath: string, timeout: number): Promise<ProbeResult> => {
    try {
      const execFile = await getExecFile();
      const {stdout} = await execFile("go", ["list", "-m", "-json", `${modulePath}@latest`], {timeout, cwd: goCwd, env});
      const data = JSON.parse(stdout) as {Version: string, Time?: string};
      return {Version: data.Version, Time: data.Time || "", path: modulePath};
    } catch (err: any) {
      // go names the reason on stderr, where execFile's own message only repeats the command
      const reason = String(err?.stderr ?? "").trim().split("\n")[0] || err?.message || String(err);
      throw new Error(`go list -m ${modulePath}@latest failed: ${reason}`);
    }
  };
  // A probe only answers "does this major exist", so a failing one costs no more than a missing one.
  const probeQuery = (modulePath: string) => tryOrNull(goListQuery(modulePath, ctx.goProbeTimeout));

  // Fetch @latest and first major probe in parallel
  const skip = shouldSkipMajorProbe(name, type, currentVersion);
  const [latest, firstProbe] = await Promise.all([
    goListQuery(name, ctx.fetchTimeout),
    skip ? null : probeQuery(buildGoModulePath(name, currentMajor + 1)),
  ]);

  const probeResult = await probeMajorVersions(currentMajor, firstProbe, major =>
    probeQuery(buildGoModulePath(name, major)),
  );
  return buildGoPackageInfo(name, currentVersion, probeResult, latest.Version, latest.Time);
}

export const goProxyHeaders = {"accept-encoding": "gzip, deflate, br"};

type ProxyFetch = (url: string) => Promise<Response>;
type GoModuleFetch = (doFetch: ProxyFetch, base: string, path: string) => Promise<ProbeResult | null>;

// 404 and 410 are the protocol's "not here", anything else is a proxy failure, never "up to date".
const isGoProxyMiss = (status: number): boolean => status === 404 || status === 410;

async function readGoProxyInfo(res: Response, url: string, path: string): Promise<ProbeResult> {
  try {
    const data = await res.json() as {Version?: string, Time?: string};
    if (data?.Version) return {Version: data.Version, Time: data.Time || "", path};
  } catch {}
  throw new Error(`Invalid response from ${url}`);
}

// `@latest` is optional in the GOPROXY protocol, so a miss only says this endpoint has nothing.
const fetchGoLatest: GoModuleFetch = async (doFetch, base, path) => {
  const url = `${base}/${encodeGoModulePath(path)}/@latest`;
  const res = await doFetch(url);
  if (res.ok) return readGoProxyInfo(res, url, path);
  if (isGoProxyMiss(res.status)) return null;
  throwFetchError(res, url, path, base);
};

const goLatestByCtx = new WeakMap<ModeContext, Map<string, Promise<ProbeResult | null>>>();

// One `@latest` per endpoint and module path for the whole run, as the make mode's probe makes the
// same request as the lookup that follows. A rejected one is evicted so the lookup still retries.
export function fetchGoLatestOnce(ctx: ModeContext, doFetch: ProxyFetch, base: string, path: string): Promise<ProbeResult | null> {
  const byUrl = getOrSet(goLatestByCtx, ctx, () => new Map());
  return dedupe(byUrl, `${base}/${path}`, () => fetchGoLatest(doFetch, base, path));
}

// The order `@latest` reports: a release outranks any prerelease, pseudo-versions among them.
function isHigherGoVersion(candidate: string, best: string): boolean {
  const candidateIsPre = isVersionPrerelease(candidate);
  if (candidateIsPre !== isVersionPrerelease(best)) return !candidateIsPre;
  return gt(candidate, best);
}

// `@v/list` is `version [timestamp]` per line, unordered. `major` bounds the answer: some proxies
// list every major under each path, and a version the path cannot carry writes a go.mod go refuses.
export function pickGoListVersion(body: string, major = 0): {Version: string, Time: string} | null {
  let best: {Version: string, Time: string} | null = null;
  for (const line of body.split("\n")) {
    const [version, time] = line.trim().split(/\s+/);
    if (!version || !valid(version)) continue;
    if (major && Number.parseInt(stripv(version)) !== major) continue;
    if (best && !isHigherGoVersion(version, best.Version)) continue;
    best = {Version: version, Time: time ?? ""};
  }
  return best;
}

// 0 for a path without a major suffix: v0, v1 and `+incompatible` v2+ all live there.
function goPathMajor(path: string): number {
  return goMajorSuffixRe.test(path) || gopkgMajorSuffixRe.test(path) ? extractGoMajor(path) : 0;
}

// `<proxy>/<mod>/@v/list`, what go falls back to when a proxy omits `@latest`.
const fetchGoList: GoModuleFetch = async (doFetch, base, path) => {
  const encoded = encodeGoModulePath(path);
  const url = `${base}/${encoded}/@v/list`;
  const res = await doFetch(url);
  if (!res.ok) {
    if (isGoProxyMiss(res.status)) return null;
    throwFetchError(res, url, path, base);
  }
  const best = pickGoListVersion(await res.text(), goPathMajor(path));
  if (!best) return null; // a known module with no versions yet
  if (best.Time) return {...best, path};
  // No timestamp in the list, so stat the one version picked as go does. A failure costs only the date.
  const infoUrl = `${base}/${encoded}/@v/${encodeGoModulePath(best.Version)}.info`;
  try {
    const infoRes = await doFetch(infoUrl);
    if (infoRes.ok) return readGoProxyInfo(infoRes, infoUrl, path);
  } catch {}
  return {...best, path};
};

// null when this proxy does not know the module, so the caller can move down the chain.
async function fetchGoProxyModule(base: string, name: string, type: string, currentVersion: string, ctx: ModeContext): Promise<PackageInfo | null> {
  const currentMajor = extractGoMajor(name);
  const goLatest: GoModuleFetch = (doFetch, proxy, path) => fetchGoLatestOnce(ctx, doFetch, proxy, path);
  const primaryFetch: ProxyFetch = url => fetchWithRetry(ctx, url, {headers: goProxyHeaders});
  const probeFetch: ProxyFetch = url => ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.goProbeTimeout), headers: goProxyHeaders});
  const probeWith = (fetchModule: GoModuleFetch) => async (path: string) => {
    try {
      return await fetchModule(probeFetch, base, path);
    } catch {
      return null;
    }
  };

  // Fetch @latest and probe for next major version in parallel
  const skip = shouldSkipMajorProbe(name, type, currentVersion);
  const nextMajorPath = buildGoModulePath(name, currentMajor + 1);
  const [latest, latestProbe] = await Promise.all([
    goLatest(primaryFetch, base, name),
    skip ? null : probeWith(goLatest)(nextMajorPath),
  ]);
  const primary = latest ?? await fetchGoList(primaryFetch, base, name);
  if (!primary) return null;

  // A proxy serves `@latest` for every major of a module or for none, and `latestProbe` settled
  // which, so further majors go straight to that endpoint rather than missing on the other first.
  const probe = probeWith(latest ? goLatest : fetchGoList);
  const firstProbe = skip || latest ? latestProbe : await probeWith(fetchGoList)(nextMajorPath);
  const probeResult = await probeMajorVersions(currentMajor, firstProbe, major => probe(buildGoModulePath(name, major)));

  return buildGoPackageInfo(name, currentVersion, probeResult, primary.Version, primary.Time);
}

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  if (isGoNoProxy(name, goNoProxy)) return fetchGoVcsInfo(name, type, currentVersion, goCwd, ctx);

  for (const {url, fallback} of ctx.goProxyChain) {
    // go fails the lookup outright, and a lookup that could not run is not an up-to-date dependency.
    if (url === "off") throw new Error("Module lookup disabled by GOPROXY=off");
    if (url === "direct") return fetchGoVcsInfo(name, type, currentVersion, goCwd, ctx);
    try {
      const info = await fetchGoProxyModule(url, name, type, currentVersion, ctx);
      if (info) return info;
    } catch (err) {
      if (fallback === ",") throw err; // only `|` moves past a proxy that is broken rather than empty
    }
  }
  throw new Error(`Unable to find ${name} on any GOPROXY entry`);
}

// Module paths may be quoted in go.mod and the quotes have to survive a rewrite. `group` is this
// capture's number in the whole pattern, so the backreference demands a matching quote.
const quotedPath = (name: string, group: number) => `("?)${esc(name)}\\${group}`;

export function updateGoMod(pkgStr: string, deps: Deps): [string, Record<string, string>] {
  let newPkgStr = pkgStr;
  const majorVersionRewrites: Record<string, string> = {};
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    const newValue = deps[key].new;
    const newPath = goModulePathForVersion(name, newValue);

    if (depType === "replace") {
      // go rejects a replace whose version does not match the path's major, so a major bump moves
      // the target onto a new path. Only a self-replace carries its left-hand side along.
      if (newPath !== name) {
        const beforeSelfReplace = newPkgStr;
        newPkgStr = newPkgStr.replace(
          new RegExp(`(^\\s*(?:replace\\s+)?)${quotedPath(name, 2)}(\\s+=>\\s+)${quotedPath(name, 4)}(\\s+)v${esc(oldValue)}`, "gm"),
          `$1$2${newPath}$2$3$4${newPath}$4$5v${newValue}`,
        );
        // A self-replace is not in `deps`, so its require line is reachable only here, and go
        // applies the replacement solely to the path the require names. The lookahead spares a
        // `name vOLD => other vNEW` line, which carries a dep of its own.
        if (newPkgStr !== beforeSelfReplace) {
          const beforeRequire = newPkgStr;
          newPkgStr = newPkgStr.replace(
            new RegExp(`(^\\s*(?:require\\s+)?)${quotedPath(name, 2)}(\\s+)v\\S+(?=\\s*(?://.*)?$)`, "gm"),
            `$1$2${newPath}$2$3v${newValue}`,
          );
          if (newPkgStr !== beforeRequire) majorVersionRewrites[name] = newPath;
        }
      }
      // Update version in replace line: => targetModule vOLD -> => targetModule vNEW
      newPkgStr = newPkgStr.replace(new RegExp(`(=>\\s+)${quotedPath(name, 2)}(\\s+)v${esc(oldValue)}`, "g"), `$1$2${newPath}$2$3v${newValue}`);
      continue;
    }

    // An indirect dep only ever bumps its version: no path rewrite and no replace removal.
    if (newPath !== name && depType !== "indirect") {
      newPkgStr = newPkgStr.replace(new RegExp(`${quotedPath(name, 1)} +v${esc(oldValue)}`, "g"), `$1${newPath}$1 v${newValue}`);
      // Rewrite tool paths referencing the old module path
      if (depType === "tool") {
        newPkgStr = newPkgStr.replace(new RegExp(`(^\\s+|^tool\\s+)("?)${esc(name)}((?:/[^"\\s]+)?)\\2\\s*$`, "gm"), `$1$2${newPath}$3$2`);
      }
      majorVersionRewrites[name] = newPath;
    } else {
      newPkgStr = newPkgStr.replace(new RegExp(`(${quotedPath(name, 2)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
    }
  }
  return [newPkgStr, majorVersionRewrites];
}

export function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>, write: (file: string, content: string) => void): void {
  const entries = Object.entries(majorVersionRewrites);
  if (!entries.length) return;
  const lookup = new Map(entries);
  const combinedRe = new RegExp(`"(${longestFirstAlternation(lookup.keys())})(/|")`, "g");
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
