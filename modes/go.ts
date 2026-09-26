import {env} from "node:process";
import {basename, dirname, join, resolve} from "node:path";
import {existsSync, globSync, readFileSync, realpathSync} from "node:fs";
import {
  type Deps, type GoProxyEntry, type ModeContext, type PackageInfo, dedupe, fieldSep, stripv, getSubDir, normalizeUrl,
  fetchWithRetry, defaultApiUrls, isVersionPrerelease, throwFetchError,
} from "./shared.ts";
import {gt, valid} from "../utils/semver.ts";
import {esc, getOrSet, pushTo, tryOrNull} from "../utils/utils.ts";

export function parseGoProxy(value: string): Array<GoProxyEntry> {
  const entries: Array<GoProxyEntry> = [];
  for (const match of value.matchAll(/([^,|]*)([,|]?)/g)) {
    const url = match[1].trim();
    if (!url) continue;
    const fallback = match[2] === "|" ? "|" : ",";
    if (url === "off" || url === "direct") { entries.push({url, fallback}); break; }
    const absolute = url.includes(":/") || url.startsWith("/");
    entries.push({url: normalizeUrl(!absolute && /[.:/]/.test(url) ? `https://${url}` : url), fallback});
  }
  return entries;
}

export function resolveGoProxyChain(override?: string): Array<GoProxyEntry> {
  if (typeof override === "string") return [{url: normalizeUrl(override), fallback: ","}];
  const list = parseGoProxy(env.GOPROXY || `${defaultApiUrls.goproxy},direct`);
  if (!list.length) throw new Error("GOPROXY list is not the empty string, but contains no entries");
  return list;
}

export function parseGoNoProxy(): Array<string> {
  return (env.GONOPROXY || env.GOPRIVATE || "").split(",").map(entry => entry.trim().replace(/\/+$/, "")).filter(Boolean);
}

const goPatternCache = new Map<string, RegExp>();

export function isGoNoProxy(modulePath: string, goNoProxy: Array<string>): boolean {
  return goNoProxy.some(pattern => getOrSet(goPatternCache, pattern, () => {
    let body = "";
    for (const [token, characterClass] of pattern.matchAll(/\[([^\]]*)\]|./gs)) {
      body += characterClass !== undefined ? `[${characterClass.replace(/\\/g, "\\\\")}]` :
        token === "*" ? "[^/]*" : token === "?" ? "[^/]" : esc(token);
    }
    return new RegExp(`^${body}(?:/.*)?$`);
  }).test(modulePath));
}

export function goProxyChainFor(modulePath: string, ctx: ModeContext, goNoProxy: Array<string>): Array<GoProxyEntry> {
  return isGoNoProxy(modulePath, goNoProxy) ? [{url: "direct", fallback: ","}] : ctx.goProxyChain;
}

export function encodeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

const goMajorSuffixRe = /\/v(\d+)$/;
const gopkgMajorSuffixRe = /^gopkg\.in\/.*?\.v(\d+)$/;

export function extractGoMajor(name: string, unversioned = 1): number {
  const match = gopkgMajorSuffixRe.exec(name) ?? goMajorSuffixRe.exec(name);
  return match ? Number.parseInt(match[1]) : unversioned;
}

export function buildGoModulePath(name: string, major: number): string {
  if (name.startsWith("gopkg.in/")) return `${name.replace(/\.v\d+$/, "")}.v${major}`;
  const base = name.replace(goMajorSuffixRe, "");
  return major <= 1 ? base : `${base}/v${major}`;
}

export function goModulePathForVersion(modulePath: string, version: string): string {
  if (version.includes("+incompatible")) return modulePath;
  const newMajor = Number.parseInt(stripv(version));
  if (Number.isNaN(newMajor) || newMajor === extractGoMajor(modulePath)) return modulePath;
  return buildGoModulePath(modulePath, newMajor);
}

type GoDirectiveKind = "module" | "require" | "replace" | "exclude" | "tool" | "use";

const directiveRe = /^(module|require|replace|exclude|tool|use)(?:\s*\(\s*(?:\/\/.*)?$|\s+(.+)$)/;
const requireEntryRe = /^(\S+)\s+(v\S+)/;
const replaceInBlockRe = /^(\S+)(?:\s+(v\S+))?\s+=>\s+(\S+)(?:\s+(v\S+))?/;
type ParsedReplace = {origModule: string, origVersion: string, targetModule: string, targetVersion: string};

const trimQuotes = (str: string): string => str.replace(/^"(.*)"$/, "$1");
const goVersionRe = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const isUsableGoVersion = (version: string): boolean => goVersionRe.test(version) &&
  !version.endsWith("-00010101000000-000000000000");
const isLocalReplaceTarget = (target: string): boolean =>
  target.startsWith("./") || target.startsWith("/") || target.startsWith("../");

function parseReplaceDirective(value: string): ParsedReplace | null {
  const match = replaceInBlockRe.exec(value);
  return match && {origModule: trimQuotes(match[1]), origVersion: match[2] ?? "", targetModule: trimQuotes(match[3]), targetVersion: match[4] ?? ""};
}

function* scanGoDirectives(lines: Array<string>): Generator<{kind: GoDirectiveKind, value: string, lineNumber: number}> {
  let block: GoDirectiveKind | null = null;
  for (const [lineNumber, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (block) {
      if (/^\)\s*(?:\/\/.*)?$/.test(trimmed)) block = null;
      else yield {kind: block, value: trimmed, lineNumber};
      continue;
    }
    const match = directiveRe.exec(trimmed);
    if (!match) continue;
    if (match[2] === undefined) block = match[1] as GoDirectiveKind;
    else yield {kind: match[1] as GoDirectiveKind, value: match[2], lineNumber};
  }
}

export function parseGoModule(content: string): string {
  for (const {kind, value} of scanGoDirectives(content.split(/\r?\n/))) {
    if (kind === "module") return trimQuotes(value.split(/\s/, 1)[0]);
  }
  return "";
}

export function parseGoMod(content: string) {
  const deps: Record<string, string> = {};
  const indirect: Record<string, string> = {};
  const replace: Record<string, string> = {};
  const tool: Record<string, string> = {};
  const exclude: Record<string, Array<string>> = {};
  const replacedModules = new Set<string>();
  const toolPaths: string[] = [];

  for (const {kind, value} of scanGoDirectives(content.split(/\r?\n/))) {
    if (kind === "tool") {
      toolPaths.push(trimQuotes(value.split(/\s/, 1)[0]));
    } else if (kind === "replace") {
      const parsed = parseReplaceDirective(value);
      if (parsed && isUsableGoVersion(parsed.targetVersion) && !isLocalReplaceTarget(parsed.targetModule)) {
        replace[parsed.targetModule] = parsed.targetVersion;
      }
      if (parsed && !parsed.origVersion) replacedModules.add(parsed.origModule);
    } else if (kind === "exclude" || kind === "require") {
      const match = requireEntryRe.exec(value);
      if (!match) continue;
      if (kind === "exclude") (exclude[trimQuotes(match[1])] ??= []).push(match[2]);
      else if (isUsableGoVersion(match[2])) (value.includes("// indirect") ? indirect : deps)[trimQuotes(match[1])] = match[2];
    }
  }

  for (const mod of replacedModules) { delete deps[mod]; delete indirect[mod]; }

  const allModules = new Set([...Object.keys(indirect), ...Object.keys(deps)]);
  for (const toolPath of toolPaths) {
    let bestMatch = toolPath;
    while (bestMatch && !allModules.has(bestMatch)) {
      bestMatch = bestMatch.includes("/") ? bestMatch.slice(0, bestMatch.lastIndexOf("/")) : "";
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

const goExcludesByCtx = new WeakMap<ModeContext, Map<string, GoExcludes | null>>();

function getGoExcludes(goCwd: string, type: string, ctx: ModeContext): GoExcludes {
  // multi-root workspaces prefix the member with `<relWorkspaceFile>:`
  const memberPath = /\|(?:[^:]*:)?(.*)/s.exec(type)?.[1] ?? "";
  const byManifest = getOrSet(goExcludesByCtx, ctx, () => new Map<string, GoExcludes | null>());
  for (const manifest of memberPath ? [join(goCwd, memberPath, "go.mod"), join(goCwd, "go.mod")] : [join(goCwd, "go.mod")]) {
    const manifestPath = resolve(manifest);
    const excludes = getOrSet(byManifest, manifestPath, (): GoExcludes | null => {
      try {
        return new Map(Object.entries(parseGoMod(readFileSync(manifestPath, "utf8")).exclude ?? {}).map(
          ([name, versions]) => [name, new Set(versions)],
        ));
      } catch {
        return null;
      }
    });
    if (excludes) return excludes;
  }
  return new Map();
}

type ProbeResult = {Version: string, Time: string, path: string};
type GoFetchKind = "primary" | "probe";

async function fetchGoModuleInfo(
  name: string, currentVersion: string, lookup: (path: string, kind: GoFetchKind) => Promise<ProbeResult | null>,
): Promise<PackageInfo | null> {
  const currentMajor = extractGoMajor(name);
  const probe = (major: number) => tryOrNull(lookup(buildGoModulePath(name, major), "probe"));
  const [latest, firstProbe] = await Promise.all([
    lookup(name, "primary"), name.startsWith("golang.org/x/") ? null : probe(currentMajor + 1),
  ]);
  if (!latest) return null;
  const majors: Array<ProbeResult> = [];
  let result = firstProbe;
  for (let major = currentMajor + 2; result; major++) {
    majors.push(result);
    result = await probe(major);
  }
  const newest = majors.findLast(result => !isVersionPrerelease(result.Version)) ?? majors.at(-1) ?? latest;
  return [{
    name, old: currentVersion, new: stripv(newest.Version), Time: newest.Time,
    ...(newest.path !== name && {newPath: newest.path}),
    sameMajorNew: stripv(latest.Version), sameMajorTime: latest.Time,
  }, null];
}

export function goListError(spec: string, err: any): Error {
  return new Error(`go list -m ${spec} failed: ${String(err?.stderr ?? "").trim().split("\n")[0] || err?.message || String(err)}`);
}

function fetchGoVcsInfo(
  name: string, currentVersion: string, goCwd: string, ctx: ModeContext, excludes: GoExcludes,
): Promise<PackageInfo | null> {
  const goListQuery = async (modulePath: string, timeout: number, version?: string) => {
    const spec = `${modulePath}@${version ?? "latest"}`;
    try {
      const args = ["list", "-m", ...(!version ? ["-versions"] : []), "-json", spec];
      const {stdout} = await ctx.execFile("go", args, {timeout, cwd: goCwd, env: {...env, GOPROXY: "direct"}});
      const data = JSON.parse(stdout) as {Version: string, Time?: string, Versions?: Array<string>};
      return {Version: data.Version, Time: data.Time || "", path: modulePath, Versions: data.Versions};
    } catch (err) {
      throw goListError(spec, err);
    }
  };
  return fetchGoModuleInfo(name, currentVersion, async (modulePath, kind) => {
    const timeout = kind === "probe" ? ctx.goProbeTimeout : ctx.fetchTimeout;
    const latest = await goListQuery(modulePath, timeout);
    const excluded = excludes.get(modulePath);
    if (!excluded?.has(latest.Version)) return latest;
    const available = pickGoListVersion((latest.Versions ?? []).join("\n"), extractGoMajor(modulePath, 0), excluded);
    if (!available) throw new Error(`No non-excluded versions found for ${modulePath}`);
    return goListQuery(modulePath, timeout, available.Version);
  });
}

const goProxyHeaders = {"accept-encoding": "gzip, deflate, br"};

async function fetchGoProxy(ctx: ModeContext, kind: GoFetchKind, url: string, path: string, base: string): Promise<Response | null> {
  const res = await (kind === "primary" ? fetchWithRetry(ctx, url, {headers: goProxyHeaders}) :
    ctx.doFetch(url, {signal: AbortSignal.timeout(ctx.goProbeTimeout), headers: goProxyHeaders}));
  if (res.ok) return res;
  if (res.status === 404 || res.status === 410) return null;
  throwFetchError(res, url, path, base);
}

async function readGoProxyInfo(res: Response, url: string, path: string): Promise<ProbeResult> {
  try {
    const data = await res.json() as {Version?: string, Time?: string};
    if (data?.Version) return {Version: data.Version, Time: data.Time || "", path};
  } catch {}
  throw new Error(`Invalid response from ${url}`);
}

const goFetchesByCtx = new WeakMap<ModeContext, Map<string, Promise<ProbeResult | null>>>();

export function fetchGoLatest(ctx: ModeContext, kind: GoFetchKind, base: string, path: string): Promise<ProbeResult | null> {
  return dedupe(goFetchesByCtx, ctx, `latest${fieldSep}${kind}${fieldSep}${base}/${path}`, async () => {
    const url = `${base}/${encodeGoModulePath(path)}/@latest`;
    const res = await fetchGoProxy(ctx, kind, url, path, base);
    return res && readGoProxyInfo(res, url, path);
  });
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

function fetchGoList(ctx: ModeContext, kind: GoFetchKind, base: string, path: string, excluded = new Set<string>()): Promise<ProbeResult | null> {
  const key = `list${fieldSep}${kind}${fieldSep}${base}/${path}${fieldSep}${Array.from(excluded).sort().join(fieldSep)}`;
  return dedupe(goFetchesByCtx, ctx, key, async () => {
    const encoded = encodeGoModulePath(path);
    const res = await fetchGoProxy(ctx, kind, `${base}/${encoded}/@v/list`, path, base);
    const best = res && pickGoListVersion(await res.text(), extractGoMajor(path, 0), excluded);
    if (!best) return null;
    if (best.Time) return {...best, path};
    const infoUrl = `${base}/${encoded}/@v/${encodeGoModulePath(best.Version)}.info`;
    try {
      const infoRes = await fetchGoProxy(ctx, kind, infoUrl, path, base);
      if (infoRes) return await readGoProxyInfo(infoRes, infoUrl, path);
    } catch {}
    return {...best, path};
  });
}

function fetchGoProxyModule(
  base: string, name: string, currentVersion: string, ctx: ModeContext, excludes: GoExcludes,
): Promise<PackageInfo | null> {
  const primaryLatestPromise = fetchGoLatest(ctx, "primary", base, name);
  return fetchGoModuleInfo(name, currentVersion, async (path, kind) => {
    const [latest, primaryLatest] = await Promise.all([fetchGoLatest(ctx, kind, base, path), primaryLatestPromise]);
    const excluded = excludes.get(path);
    if (latest && !excluded?.has(latest.Version)) return latest;
    if (!latest && primaryLatest) return null;
    return fetchGoList(ctx, kind, base, path, excluded);
  });
}

export async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<PackageInfo> {
  const excludes = getGoExcludes(goCwd, type, ctx);
  for (const {url, fallback} of goProxyChainFor(name, ctx, goNoProxy)) {
    try {
      if (url === "off") throw new Error("Module lookup disabled by GOPROXY=off");
      const info = url === "direct" ? await fetchGoVcsInfo(name, currentVersion, goCwd, ctx, excludes) :
        await fetchGoProxyModule(url, name, currentVersion, ctx, excludes);
      if (info) return info;
    } catch (error) {
      if (fallback === ",") throw error;
    }
  }
  throw new Error(`Unable to find ${name} on any GOPROXY entry`);
}

const quotedPath = (name: string) => `("?)${esc(name)}\\2`;
const versionedPathRe = (prefix: string, name: string, version: string) =>
  new RegExp(`(${prefix})${quotedPath(name)}(\\s+)v${version}(?=\\s*(?://.*)?$)`);

export function updateGoMod(pkgStr: string, deps: Deps): [string, Record<string, string>] {
  const majorVersionRewrites: Record<string, string> = {};
  const entries = Object.entries(deps);
  if (!entries.length) return [pkgStr, majorVersionRewrites];
  const lineEndings = pkgStr.match(/\r?\n/g) ?? [];
  const lines = pkgStr.split(/\r?\n/);
  const rewriteLines = (lineNumbers: Array<number> = [], pattern: RegExp, replacement: string): boolean => {
    let rewritten = false;
    for (const lineNumber of lineNumbers) {
      const line = lines[lineNumber];
      lines[lineNumber] = line.replace(pattern, replacement);
      rewritten ||= lines[lineNumber] !== line;
    }
    return rewritten;
  };
  const requireLines = new Map<string, Array<number>>();
  const replaceDirectives = new Map<string, Array<ParsedReplace & {lineNumber: number}>>();
  const toolLines = new Map<string, Array<number>>();
  for (const {kind, value, lineNumber} of scanGoDirectives(lines)) {
    if (kind === "require") {
      const match = requireEntryRe.exec(value);
      if (match) pushTo(requireLines, trimQuotes(match[1]), lineNumber);
    } else if (kind === "replace") {
      const parsed = parseReplaceDirective(value);
      if (parsed) pushTo(replaceDirectives, parsed.targetModule, {...parsed, lineNumber});
    } else if (kind === "tool") {
      let path = trimQuotes(value.split(/\s/, 1)[0]);
      while (path) {
        pushTo(toolLines, path, lineNumber);
        path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      }
    }
  }
  for (const [key, {old, oldOrig, new: newValue}] of entries) {
    const [depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    const newPath = goModulePathForVersion(name, newValue);
    const replacement = `$1$2${newPath}$2$3v${newValue}`;
    let requireVersion: string | null = esc(oldValue);
    if (depType === "replace") {
      requireVersion = null;
      for (const {targetVersion, origModule, origVersion, lineNumber} of replaceDirectives.get(name) ?? []) {
        if (stripv(targetVersion) !== oldValue) continue;
        rewriteLines([lineNumber], versionedPathRe("=>\\s+", name, esc(oldValue)), replacement);
        if (newPath === name || origModule !== name || origVersion) continue;
        rewriteLines([lineNumber], new RegExp(`(^\\s*(?:replace\\s+)?)${quotedPath(name)}(?=\\s+=>)`), `$1$2${newPath}$2`);
        requireVersion = "\\S+";
      }
    }
    if (requireVersion !== null && rewriteLines(
      requireLines.get(name), versionedPathRe("^\\s*(?:require\\s+)?", name, requireVersion), replacement,
    ) && newPath !== name) majorVersionRewrites[name] = newPath;
    if (depType === "tool" && newPath !== name) {
      rewriteLines(
        toolLines.get(name), new RegExp(`(^\\s*(?:tool\\s+)?)("?)${esc(name)}((?:/[^"\\s]+)?)\\2(?=\\s*(?://.*)?$)`),
        `$1$2${newPath}$3$2`,
      );
    }
  }
  return [lines.map((line, index) => `${line}${lineEndings[index] ?? ""}`).join(""), majorVersionRewrites];
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

const goIgnoredPath = (path: string): boolean => { // mirrors go's `./...`, globSync already skips dot-prefixed
  const name = basename(path);
  return name === "vendor" || name === "testdata" || name[0] === "_";
};

export function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>, write: (file: string, content: string) => void): void {
  if (!Object.keys(majorVersionRewrites).length) return;
  const nested = new Map<string, boolean>();
  const inNestedModule = (dir: string): boolean => dir.length > projectDir.length &&
    getOrSet(nested, dir, () => existsSync(join(dir, "go.mod")) || inNestedModule(dirname(dir)));
  for (const relPath of globSync("**/*.go", {cwd: projectDir, exclude: goIgnoredPath})) {
    const filePath = join(projectDir, relPath);
    if (inNestedModule(dirname(filePath))) continue; // its own module, its go.mod was not bumped
    const content = readFileSync(filePath, "utf8");
    const replaced = rewriteGoImportPaths(content, majorVersionRewrites);
    if (replaced !== content) write(filePath, replaced);
  }
}

export function parseGoWork(content: string): {use: string[], replace: Record<string, string>} {
  const use: string[] = [];
  const replace: Record<string, string> = {};
  for (const {kind, value} of scanGoDirectives(content.split(/\r?\n/))) {
    if (kind === "use") {
      use.push(value.split(/\s/, 1)[0]);
    } else if (kind === "replace") {
      const parsed = parseReplaceDirective(value);
      if (parsed && isUsableGoVersion(parsed.targetVersion) && !isLocalReplaceTarget(parsed.targetModule)) replace[parsed.targetModule] = parsed.targetVersion;
    }
  }
  return {use, replace};
}

export function resolveGoWorkModule(workspaceDir: string, usePath: string): string | null {
  try {
    return realpathSync(join(realpathSync(resolve(workspaceDir)), usePath, "go.mod"));
  } catch {
    return null;
  }
}

export function getGoInfoUrl(name: string): string {
  const str = `https://${shortenGoModule(name)}`;
  const url = new URL(str);
  const [_root, user, repo, ...other] = url.pathname.split("/");
  if (!other.length) return str;
  url.pathname = `/${user}/${repo}/${getSubDir(str)}/${other.join("/")}`;
  return url.href;
}

export function shortenGoModule(module: string): string {
  return goMajorSuffixRe.test(module) ? dirname(module) : module;
}

export function shortenGoVersion(version: string): string {
  return version.replace(/(\d{7})\d{7}-[0-9a-f]{12}$/, "$1");
}
