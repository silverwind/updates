import {env} from "node:process";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {globSync, readFileSync, realpathSync} from "node:fs";
import {
  type Deps, type GoProxyEntry, type ModeContext, type PackageInfo, dedupe, fieldSep, stripv, getSubDir, normalizeUrl,
  fetchWithRetry, defaultApiUrls, isVersionPrerelease,
  throwFetchError,
} from "./shared.ts";
import {gt, valid} from "../utils/semver.ts";
import {esc, getOrSet, pushTo, tryOrNull} from "../utils/utils.ts";

export type {GoProxyEntry};

function goProxyEntryUrl(url: string): string {
  const absolute = url.includes(":/") || url.startsWith("/");
  return normalizeUrl(!absolute && /[.:/]/.test(url) ? `https://${url}` : url);
}

export async function fetchFromGoProxyChain<T>(
  chain: Array<GoProxyEntry>, fetchEntry: (url: string) => Promise<T | null>,
): Promise<T | null> {
  for (const {url, fallback} of chain) {
    try {
      const result = await fetchEntry(url);
      if (result !== null) return result;
    } catch (error) {
      if (fallback === ",") throw error;
    }
  }
  return null;
}

export function parseGoProxy(value: string): Array<GoProxyEntry> {
  const entries: Array<GoProxyEntry> = [];
  for (const match of value.matchAll(/([^,|]*)([,|]?)/g)) {
    const url = match[1].trim();
    if (!url) continue;
    const fallback = match[2] === "|" ? "|" : ",";
    if (url === "off" || url === "direct") { entries.push({url, fallback}); break; }
    entries.push({url: goProxyEntryUrl(url), fallback});
  }
  return entries;
}

export function resolveGoProxyChain(override?: string): Array<GoProxyEntry> {
  if (typeof override === "string") return [{url: normalizeUrl(override), fallback: ","}];
  const value = env.GOPROXY || `${defaultApiUrls.goproxy},direct`;
  const list = parseGoProxy(value);
  if (!list.length) throw new Error("GOPROXY list is not the empty string, but contains no entries");
  return list;
}

export function parseGoNoProxy(): Array<string> {
  const value = env.GONOPROXY || env.GOPRIVATE || "";
  return value.split(",").map(entry => entry.trim().replace(/\/+$/, "")).filter(Boolean);
}

const goPatternCache = new Map<string, RegExp>();

function goPatternToRegex(pattern: string): RegExp {
  return getOrSet(goPatternCache, pattern, () => {
    let body = "";
    for (const match of pattern.matchAll(/\[([^\]]*)\]|./gs)) {
      const [token, characterClass] = match;
      body += characterClass !== undefined ? `[${characterClass.replace(/\\/g, "\\\\")}]` :
        token === "*" ? "[^/]*" : token === "?" ? "[^/]" : esc(token);
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
const gopkgMajorSuffixRe = /^gopkg\.in\/.*?\.v(\d+)$/;

export function extractGoMajor(name: string): number {
  const match = gopkgMajorSuffixRe.exec(name) ?? goMajorSuffixRe.exec(name);
  return match ? Number.parseInt(match[1]) : 1;
}

export function buildGoModulePath(name: string, major: number): string {
  if (name.startsWith("gopkg.in/")) {
    return `${name.replace(/\.v\d+$/, "")}.v${major}`;
  }
  const base = name.replace(goMajorSuffixRe, "");
  return major <= 1 ? base : `${base}/v${major}`;
}

export function goModulePathForVersion(modulePath: string, version: string): string {
  if (version.includes("+incompatible")) return modulePath;
  const newMajor = Number.parseInt(stripv(version).split(".")[0]);
  if (Number.isNaN(newMajor) || newMajor === extractGoMajor(modulePath)) return modulePath;
  return buildGoModulePath(modulePath, newMajor);
}

type GoDirectiveKind = "require" | "replace" | "exclude" | "tool" | "use";
type GoDirective = {kind: GoDirectiveKind, value: string, lineNumber: number};

const directiveRe = /^(require|replace|exclude|tool|use)(?:\s*\(\s*(?:\/\/.*)?$|\s+(.+)$)/;
const requireEntryRe = /^(\S+)\s+(v\S+)/;
const replaceInBlockRe = /^(\S+)(?:\s+(v\S+))?\s+=>\s+(\S+)(?:\s+(v\S+))?/;
type ParsedReplace = {origModule: string, origVersion: string, targetModule: string, targetVersion: string};

const trimQuotes = (str: string): string => str.replace(/^"(.*)"$/, "$1");

function isLocalReplaceTarget(target: string): boolean {
  return target.startsWith("./") || target.startsWith("/") || target.startsWith("../");
}

function parseReplaceDirective(value: string): ParsedReplace | null {
  const match = replaceInBlockRe.exec(value);
  if (!match) return null;
  const [, origModule, origVersion, targetModule, targetVersion] = match;
  return {origModule: trimQuotes(origModule), origVersion: origVersion ?? "", targetModule: trimQuotes(targetModule), targetVersion: targetVersion ?? ""};
}

function* scanGoDirectives(lines: Array<string>): Generator<GoDirective> {
  let block: GoDirectiveKind | null = null;

  for (const [lineNumber, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (block) {
      if (/^\)\s*(?:\/\/.*)?$/.test(trimmed)) { block = null; continue; }
      yield {kind: block, value: trimmed, lineNumber};
      continue;
    }
    const match = directiveRe.exec(trimmed);
    if (!match) continue;
    if (match[2] === undefined) block = match[1] as GoDirectiveKind;
    else yield {kind: match[1] as GoDirectiveKind, value: match[2], lineNumber};
  }
}

function shouldSkipMajorProbe(name: string): boolean {
  return name.startsWith("golang.org/x/");
}

type ProbeResult = {Version: string, Time: string, path: string};

async function probeMajorVersions(
  currentMajor: number,
  firstProbe: ProbeResult | null,
  probeFn: (major: number) => Promise<ProbeResult | null>,
): Promise<ProbeResult | null> {
  let highest = firstProbe;
  let highestRelease = firstProbe && !isVersionPrerelease(firstProbe.Version) ? firstProbe : null;

  for (let major = currentMajor + 2; highest; major++) {
    const result = await probeFn(major);
    if (!result) break;
    highest = result;
    if (!isVersionPrerelease(result.Version)) highestRelease = result;
  }

  return highestRelease ?? highest;
}

function buildGoPackageInfo(
  name: string, currentVersion: string, probe: ProbeResult | null, latest: ProbeResult,
): PackageInfo {
  const highest = probe ?? latest;
  return [{
    name, old: currentVersion, new: stripv(highest.Version), Time: highest.Time,
    ...(highest.path !== name && {newPath: highest.path}),
    sameMajorNew: stripv(latest.Version), sameMajorTime: latest.Time,
  }, null];
}

export function parseGoMod(content: string) {
  const deps: Record<string, string> = {};
  const indirect: Record<string, string> = {};
  const replace: Record<string, string> = {};
  const tool: Record<string, string> = {};
  const exclude: Record<string, Array<string>> = {};
  const replacedModules = new Set<string>();
  const toolPaths: string[] = [];

  for (const directive of scanGoDirectives(content.split(/\r?\n/))) {
    if (directive.kind === "tool") {
      toolPaths.push(trimQuotes(directive.value.split(/\s/, 1)[0]));
      continue;
    }
    if (directive.kind === "exclude") {
      const match = requireEntryRe.exec(directive.value);
      if (match) (exclude[trimQuotes(match[1])] ??= []).push(match[2]);
      continue;
    }
    if (directive.kind === "replace") {
      const parsed = parseReplaceDirective(directive.value);
      if (parsed) {
        if (parsed.targetVersion && !isLocalReplaceTarget(parsed.targetModule)) {
          replace[parsed.targetModule] = parsed.targetVersion;
        }
        if (!parsed.origVersion) replacedModules.add(parsed.origModule);
      }
      continue;
    }
    if (directive.kind !== "require") continue;
    const match = requireEntryRe.exec(directive.value);
    if (match) (directive.value.includes("// indirect") ? indirect : deps)[trimQuotes(match[1])] = match[2];
  }

  for (const mod of replacedModules) { delete deps[mod]; delete indirect[mod]; }

  const allModules = [...Object.keys(indirect), ...Object.keys(deps)];
  for (const toolPath of toolPaths) {
    let bestMatch = "";
    for (const mod of allModules) {
      if ((toolPath === mod || toolPath.startsWith(`${mod}/`)) && mod.length > bestMatch.length) {
        bestMatch = mod;
      }
    }
    const source = indirect[bestMatch] ? indirect : deps;
    if (source[bestMatch]) {
      tool[bestMatch] = source[bestMatch];
      delete source[bestMatch];
    }
  }

  return {deps, indirect, replace, tool, ...(Object.keys(exclude).length && {exclude})};
}

type GoExcludes = Map<string, Set<string>>;

function getGoExcludes(goCwd: string, type: string): GoExcludes {
  const suffix = type.includes("|") ? type.slice(type.indexOf("|") + 1) : "";
  // multi-root workspaces prefix the member with `<relWorkspaceFile>:`
  const memberPath = suffix.includes(":") ? suffix.slice(suffix.indexOf(":") + 1) : suffix;
  for (const manifest of memberPath ? [join(goCwd, memberPath, "go.mod"), join(goCwd, "go.mod")] : [join(goCwd, "go.mod")]) {
    try {
      return new Map(Object.entries(parseGoMod(readFileSync(manifest, "utf8")).exclude ?? {}).map(
        ([name, versions]) => [name, new Set(versions)],
      ));
    } catch {}
  }
  return new Map();
}

async function fetchGoVcsInfo(
  name: string, currentVersion: string, goCwd: string, ctx: ModeContext, excludes: GoExcludes,
): Promise<PackageInfo> {
  const currentMajor = extractGoMajor(name);

  const goListQuery = async (modulePath: string, timeout: number, version?: string): Promise<ProbeResult & {Versions?: Array<string>}> => {
    try {
      const query = version ?? "latest";
      const args = ["list", "-m", ...(!version ? ["-versions"] : []), "-json", `${modulePath}@${query}`];
      const {stdout} = await ctx.execFile("go", args, {timeout, cwd: goCwd, env: {...env, GOPROXY: "direct"}});
      const data = JSON.parse(stdout) as {Version: string, Time?: string, Versions?: Array<string>};
      return {Version: data.Version, Time: data.Time || "", path: modulePath, Versions: data.Versions};
    } catch (err: any) {
      const reason = String(err?.stderr ?? "").trim().split("\n")[0] || err?.message || String(err);
      throw new Error(`go list -m ${modulePath}@${version ?? "latest"} failed: ${reason}`);
    }
  };
  const latestQuery = async (modulePath: string, timeout: number) => {
    const latest = await goListQuery(modulePath, timeout);
    const excluded = excludes.get(modulePath);
    if (!excluded?.has(latest.Version)) return latest;
    const available = pickGoListVersion((latest.Versions ?? []).join("\n"), goPathMajor(modulePath), excluded);
    if (!available) throw new Error(`No non-excluded versions found for ${modulePath}`);
    return goListQuery(modulePath, timeout, available.Version);
  };
  const probeQuery = (modulePath: string) => tryOrNull(latestQuery(modulePath, ctx.goProbeTimeout));

  const [latest, firstProbe] = await Promise.all([
    latestQuery(name, ctx.fetchTimeout),
    shouldSkipMajorProbe(name) ? null : probeQuery(buildGoModulePath(name, currentMajor + 1)),
  ]);

  return buildGoPackageInfo(
    name, currentVersion,
    await probeMajorVersions(currentMajor, firstProbe, major => probeQuery(buildGoModulePath(name, major))),
    latest,
  );
}

export const goProxyHeaders = {"accept-encoding": "gzip, deflate, br"};

type ProxyFetch = (url: string) => Promise<Response>;

const isGoProxyMiss = (status: number): boolean => status === 404 || status === 410;

async function readGoProxyInfo(res: Response, url: string, path: string): Promise<ProbeResult> {
  try {
    const data = await res.json() as {Version?: string, Time?: string};
    if (data?.Version) return {Version: data.Version, Time: data.Time || "", path};
  } catch {}
  throw new Error(`Invalid response from ${url}`);
}

const fetchGoLatest = async (doFetch: ProxyFetch, base: string, path: string): Promise<ProbeResult | null> => {
  const url = `${base}/${encodeGoModulePath(path)}/@latest`;
  const res = await doFetch(url);
  if (res.ok) return readGoProxyInfo(res, url, path);
  if (isGoProxyMiss(res.status)) return null;
  throwFetchError(res, url, path, base);
};

const goLatestByCtx = new WeakMap<ModeContext, Map<string, Promise<ProbeResult | null>>>();

export function fetchGoLatestOnce(ctx: ModeContext, doFetch: ProxyFetch, base: string, path: string): Promise<ProbeResult | null> {
  return dedupe(goLatestByCtx, ctx, `${base}/${path}`, () => fetchGoLatest(doFetch, base, path));
}

export function pickGoListVersion(body: string, major = 0, excluded = new Set<string>()): {Version: string, Time: string} | null {
  let best: {Version: string, Time: string} | null = null;
  for (const line of body.split("\n")) {
    const [version, time] = line.trim().split(/\s+/);
    if (!version || !valid(version) || excluded.has(version)) continue;
    if (major && Number.parseInt(stripv(version)) !== major) continue;
    if (best) {
      const prerelease = isVersionPrerelease(version);
      if (prerelease === isVersionPrerelease(best.Version) ? !gt(version, best.Version) : prerelease) continue;
    }
    best = {Version: version, Time: time ?? ""};
  }
  return best;
}

function goPathMajor(path: string): number {
  return goMajorSuffixRe.test(path) || gopkgMajorSuffixRe.test(path) ? extractGoMajor(path) : 0;
}

async function fetchGoList(doFetch: ProxyFetch, base: string, path: string, excluded = new Set<string>()): Promise<ProbeResult | null> {
  const encoded = encodeGoModulePath(path);
  const url = `${base}/${encoded}/@v/list`;
  const res = await doFetch(url);
  if (!res.ok) {
    if (isGoProxyMiss(res.status)) return null;
    throwFetchError(res, url, path, base);
  }
  const best = pickGoListVersion(await res.text(), goPathMajor(path), excluded);
  if (!best) return null;
  if (best.Time) return {...best, path};
  const infoUrl = `${base}/${encoded}/@v/${encodeGoModulePath(best.Version)}.info`;
  try {
    const infoRes = await doFetch(infoUrl);
    if (infoRes.ok) return readGoProxyInfo(infoRes, infoUrl, path);
  } catch {}
  return {...best, path};
}

async function fetchGoProxyModule(
  base: string, name: string, currentVersion: string, ctx: ModeContext, excludes: GoExcludes,
): Promise<PackageInfo | null> {
  const currentMajor = extractGoMajor(name);
  const primaryFetch: ProxyFetch = url => fetchWithRetry(ctx, url, {headers: goProxyHeaders});
  const probeFetch: ProxyFetch = url => ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.goProbeTimeout), headers: goProxyHeaders});
  const primaryLatestPromise = fetchGoLatestOnce(ctx, primaryFetch, base, name);
  const primaryPromise = (async () => {
    const primaryLatest = await primaryLatestPromise;
    return primaryLatest && !excludes.get(name)?.has(primaryLatest.Version) ? primaryLatest :
      fetchGoList(primaryFetch, base, name, excludes.get(name));
  })();
  const probe = async (path: string) => {
    try {
      const [latest, primaryLatest] = await Promise.all([
        fetchGoLatestOnce(ctx, probeFetch, base, path), primaryLatestPromise,
      ]);
      const excluded = excludes.get(path);
      if (latest && !excluded?.has(latest.Version)) return latest;
      if (!latest && primaryLatest) return null;
      return fetchGoList(probeFetch, base, path, excluded);
    } catch {
      return null;
    }
  };

  const [primary, firstProbe] = await Promise.all([
    primaryPromise,
    shouldSkipMajorProbe(name) ? null : probe(buildGoModulePath(name, currentMajor + 1)),
  ]);
  if (!primary) return null;

  return buildGoPackageInfo(
    name, currentVersion,
    await probeMajorVersions(currentMajor, firstProbe, major => probe(buildGoModulePath(name, major))),
    primary,
  );
}

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  const excludes = getGoExcludes(goCwd, type);
  if (isGoNoProxy(name, goNoProxy)) return fetchGoVcsInfo(name, currentVersion, goCwd, ctx, excludes);

  const info = await fetchFromGoProxyChain(ctx.goProxyChain, async url => {
    if (url === "off") throw new Error("Module lookup disabled by GOPROXY=off");
    if (url === "direct") return fetchGoVcsInfo(name, currentVersion, goCwd, ctx, excludes);
    return fetchGoProxyModule(url, name, currentVersion, ctx, excludes);
  });
  if (info) return info;
  throw new Error(`Unable to find ${name} on any GOPROXY entry`);
}

const quotedPath = (name: string) => `("?)${esc(name)}\\2`;

export function updateGoMod(pkgStr: string, deps: Deps): [string, Record<string, string>] {
  const majorVersionRewrites: Record<string, string> = {};
  const entries = Object.entries(deps);
  if (!entries.length) return [pkgStr, majorVersionRewrites];
  const newline = pkgStr.includes("\r\n") ? "\r\n" : "\n";
  const lines = pkgStr.split(newline);
  const rewriteLines = (lineNumbers: Array<number> | undefined, pattern: RegExp, replacement: string): boolean => {
    let rewritten = false;
    for (const lineNumber of lineNumbers ?? []) {
      const line = lines[lineNumber];
      lines[lineNumber] = line.replace(pattern, replacement);
      rewritten ||= lines[lineNumber] !== line;
    }
    return rewritten;
  };
  const requireLines = new Map<string, Array<number>>();
  const replaceDirectives = new Map<string, Array<ParsedReplace & {lineNumber: number}>>();
  const toolLines = new Map<string, Array<number>>();
  for (const directive of scanGoDirectives(lines)) {
    if (directive.kind === "require") {
      const match = requireEntryRe.exec(directive.value);
      if (match) pushTo(requireLines, trimQuotes(match[1]), directive.lineNumber);
    } else if (directive.kind === "replace") {
      const parsed = parseReplaceDirective(directive.value);
      if (parsed) pushTo(replaceDirectives, parsed.targetModule, {...parsed, lineNumber: directive.lineNumber});
    } else if (directive.kind === "tool") {
      let name = trimQuotes(directive.value.split(/\s/, 1)[0]);
      while (name) {
        pushTo(toolLines, name, directive.lineNumber);
        const slash = name.lastIndexOf("/");
        if (slash === -1) break;
        name = name.slice(0, slash);
      }
    }
  }
  for (const [key, {old, oldOrig, new: newValue}] of entries) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    const newPath = goModulePathForVersion(name, newValue);
    if (depType === "replace") {
      let selfReplace = false;
      for (const parsed of replaceDirectives.get(name) ?? []) {
        if (stripv(parsed.targetVersion) !== oldValue) continue;
        const {lineNumber} = parsed;
        lines[lineNumber] = lines[lineNumber].replace(
          new RegExp(`(=>\\s+)${quotedPath(name)}(\\s+)v${esc(oldValue)}(?=\\s*(?://.*)?$)`),
          `$1$2${newPath}$2$3v${newValue}`,
        );
        if (newPath !== name && parsed.origModule === name && !parsed.origVersion) {
          lines[lineNumber] = lines[lineNumber].replace(
            new RegExp(`(^\\s*(?:replace\\s+)?)${quotedPath(name)}(?=\\s+=>)`),
            `$1$2${newPath}$2`,
          );
          selfReplace = true;
        }
      }
      if (selfReplace && rewriteLines(
        requireLines.get(name), new RegExp(`(^\\s*(?:require\\s+)?)${quotedPath(name)}(\\s+)v\\S+(?=\\s*(?://.*)?$)`),
        `$1$2${newPath}$2$3v${newValue}`,
      )) majorVersionRewrites[name] = newPath;
      continue;
    }

    if (rewriteLines(
      requireLines.get(name), new RegExp(`(^\\s*(?:require\\s+)?)${quotedPath(name)}(\\s+)v${esc(oldValue)}(?=\\s*(?://.*)?$)`),
      `$1$2${newPath}$2$3v${newValue}`,
    ) && newPath !== name) majorVersionRewrites[name] = newPath;
    if (depType === "tool" && newPath !== name) {
      rewriteLines(
        toolLines.get(name), new RegExp(`(^\\s*(?:tool\\s+)?)("?)${esc(name)}((?:/[^"\\s]+)?)\\2(?=\\s*(?://.*)?$)`),
        `$1$2${newPath}$3$2`,
      );
    }
  }
  return [lines.join(newline), majorVersionRewrites];
}

const goTokenRe = /\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$)|[A-Za-z_][A-Za-z0-9_]*|"(?:\\[\s\S]|[^"\\])*(?:"|$)|`[^`]*(?:`|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|./g;

export function rewriteGoImportPaths(content: string, rewrites: Record<string, string>): string {
  const entries = Object.entries(rewrites).sort(([left], [right]) => right.length - left.length);
  if (!entries.length) return content;
  const replacements: Array<{start: number, end: number, value: string}> = [];
  const addImport = (value: string, start: number): boolean => {
    if (!`"'\``.includes(value[0])) return false;
    if (value[0] === "'") return true;
    const path = value.slice(1, -1);
    const match = entries.find(([oldPath]) => path === oldPath || path.startsWith(`${oldPath}/`));
    if (match) replacements.push({start: start + 1, end: start + value.length - 1, value: `${match[1]}${path.slice(match[0].length)}`});
    return true;
  };

  let importBlock = false;
  let importTokens = 0;
  for (const match of content.matchAll(goTokenRe)) {
    const value = match[0];
    if (/^\s/.test(value) || value.startsWith("//") || value.startsWith("/*")) continue;
    if (importBlock) {
      if (value === ")") importBlock = false;
      else addImport(value, match.index);
      continue;
    }
    if (value === "import") {
      importTokens = 2;
    } else if (importTokens && value === "(") {
      importBlock = true;
      importTokens = 0;
    } else if (importTokens && (addImport(value, match.index) || --importTokens === 0)) {
      importTokens = 0;
    }
  }

  let result = content;
  for (const replacement of replacements.reverse()) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

export function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>, write: (file: string, content: string) => void): void {
  if (!Object.keys(majorVersionRewrites).length) return;
  for (const relPath of globSync("**/*.go", {cwd: projectDir})) {
    const filePath = join(projectDir, relPath);
    const content = readFileSync(filePath, "utf8");
    const replaced = rewriteGoImportPaths(content, majorVersionRewrites);
    if (replaced !== content) write(filePath, replaced);
  }
}

export function parseGoWork(content: string): {use: string[], replace: Record<string, string>} {
  const use: string[] = [];
  const replace: Record<string, string> = {};
  for (const directive of scanGoDirectives(content.split(/\r?\n/))) {
    if (directive.kind === "use") {
      use.push(directive.value.split(/\s/, 1)[0]);
    } else if (directive.kind === "replace") {
      const parsed = parseReplaceDirective(directive.value);
      if (parsed?.targetVersion && !isLocalReplaceTarget(parsed.targetModule)) {
        replace[parsed.targetModule] = parsed.targetVersion;
      }
    }
  }

  return {use, replace};
}

export function resolveGoWorkModule(workspaceDir: string, usePath: string): string | null {
  try {
    const root = realpathSync(resolve(workspaceDir));
    const manifest = realpathSync(join(root, usePath, "go.mod"));
    const relPath = relative(root, manifest);
    return relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath) ? null : manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function getGoInfoUrl(name: string): string {
  const str = `https://${shortenGoModule(name)}`;
  const url = new URL(str);
  const pathParts = url.pathname.split("/");
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

export function shortenGoVersion(version: string): string {
  return version.replace(/(\d{7})\d{7}-[0-9a-f]{12}$/, "$1");
}
