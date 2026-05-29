import {type ModeContext, stripv, formatVersionPrecision, findNewVersion} from "./shared.ts";
import {encodeGoModulePath, goModulePathForVersion, fetchGoProxyInfo, getGoInfoUrl, isGoPseudoVersion} from "./go.ts";
import {esc, matchesAny} from "../utils/utils.ts";

export const makeExactFileNames = ["Makefile", "makefile", "GNUmakefile"];

export function isMakeFileName(filename: string): boolean {
  return makeExactFileNames.includes(filename) || filename.endsWith(".mk");
}

export type MakeInstall = {installPath: string, version: string};

// Variable assignment holding a single `go install` spec, e.g.
//   AIR_PACKAGE ?= github.com/air-verse/air@v1.65.1
// Captures: 1=install path, 2=version. Assignment operators: = := ::= ?= +=
const makeAssignRe = /^\s*[A-Za-z_][\w.]*\s*(?:::=|:=|\?=|\+=|=)\s*(\S+)@(v\d\S*)\s*$/;
// Module path must start with a host segment containing a dot (github.com, golang.org, …)
const goHostRe = /^[^/\s]+\.[^/\s]+\//;

// Strip Make comments transparently: everything from the first `#`.
function stripComment(line: string): string {
  const idx = line.indexOf("#");
  return idx === -1 ? line : line.slice(0, idx);
}

export function parseMakeGoInstalls(content: string): Array<MakeInstall> {
  const installs: Array<MakeInstall> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    const match = makeAssignRe.exec(line);
    if (!match) continue;
    const [, installPath, version] = match;
    if (!goHostRe.test(installPath)) continue;
    installs.push({installPath, version});
  }
  return installs;
}

// Module root is some prefix of the install path. A `/vN` segment marks the
// boundary without a lookup; otherwise probe prefixes longest-first and take
// the longest that resolves as a module.
const midMajorRe = /\/v\d+(?=\/|$)/;

export function moduleRootFromMajor(installPath: string): string | null {
  const match = midMajorRe.exec(installPath);
  return match ? installPath.slice(0, match.index + match[0].length) : null;
}

function prefixCandidates(installPath: string): Array<string> {
  const parts = installPath.split("/");
  const candidates: Array<string> = [];
  for (let count = parts.length; count >= 2; count--) candidates.push(parts.slice(0, count).join("/"));
  return candidates;
}

export async function resolveGoModuleRoot(installPath: string, ctx: ModeContext): Promise<string | null> {
  const heuristic = moduleRootFromMajor(installPath);
  if (heuristic) return heuristic;
  const candidates = prefixCandidates(installPath);
  const resolved = await Promise.all(candidates.map(candidate =>
    ctx.doFetch(`${ctx.goProxyUrl}/${encodeGoModulePath(candidate)}/@latest`, {signal: AbortSignal.timeout(ctx.goProbeTimeout)})
      .then(res => res.ok ? candidate : null)
      .catch(() => null),
  ));
  return resolved.find(Boolean) ?? null; // candidates are longest-first
}

export type MakeUpdate = {
  newInstallPath: string,
  newVersion: string,
  date: string,
  info: string,
};

export type MakeVersionOpts = {
  semvers: Set<string>,
  useGreatest: boolean,
  usePre: boolean,
  useRel: boolean,
  allowDowngrade: Set<RegExp> | boolean,
  pinnedRange?: string,
  cooldownDays?: number,
  now?: number,
};

export async function fetchMakeInfo(installPath: string, version: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>, opts: MakeVersionOpts): Promise<MakeUpdate | null> {
  const modulePath = await resolveGoModuleRoot(installPath, ctx);
  if (!modulePath) return null;

  const [data] = await fetchGoProxyInfo(modulePath, "tool", stripv(version), goCwd, ctx, goNoProxy);

  // Route through the same selection as the go mode so downgrades, pseudo-versions,
  // prereleases, pins and cooldowns are handled identically.
  const newVersion = findNewVersion(data, {
    mode: "go", range: stripv(version), semvers: opts.semvers,
    useGreatest: opts.useGreatest, usePre: opts.usePre, useRel: opts.useRel,
    pinnedRange: opts.pinnedRange, cooldownDays: opts.cooldownDays, now: opts.now,
  }, {allowDowngrade: opts.allowDowngrade, matchesAny, isGoPseudoVersion});
  if (!newVersion) return null;

  const newModulePath = data.newPath ?? goModulePathForVersion(modulePath, newVersion);
  const newInstallPath = `${newModulePath}${installPath.slice(modulePath.length)}`;
  const newVersionFormatted = formatVersionPrecision(newVersion, version);
  if (newInstallPath === installPath && newVersionFormatted === version) return null;
  return {newInstallPath, newVersion: newVersionFormatted, date: data.Time ?? "", info: getGoInfoUrl(newModulePath)};
}

export type MakeRewrite = {installPath: string, oldVersion: string, newInstallPath: string, newVersion: string};

// Surgically rewrites each `installPath@oldVersion` to `newInstallPath@newVersion`
// in place, touching only the matched span. The `^([^#\n]*?)` prefix anchors the
// match to a line's code portion — it cannot cross a `#`, so occurrences inside
// full-line or inline comments are never rewritten. Untouched bytes (including
// CRLF endings) are preserved verbatim.
export function updateMakefile(content: string, rewrites: Array<MakeRewrite>): string {
  for (const {installPath, oldVersion, newInstallPath, newVersion} of rewrites) {
    const re = new RegExp(`^([^#\\n]*?)${esc(installPath)}@${esc(oldVersion)}(?=\\s|$)`, "gm");
    content = content.replace(re, `$1${newInstallPath}@${newVersion}`);
  }
  return content;
}
