import {type ModeContext, stripv, formatVersionPrecision, findNewVersion} from "./shared.ts";
import {encodeGoModulePath, goModulePathForVersion, fetchGoProxyInfo, getGoInfoUrl, isGoPseudoVersion} from "./go.ts";
import {
  type DockerImageRef,
  parseDockerImageRef, fetchDockerInfo, findDockerVersion, getDockerInfoUrl, fetchDockerTagDigest,
} from "./docker.ts";
import {esc, matchesAny} from "../utils/utils.ts";

export const makeExactFileNames = ["Makefile", "makefile", "GNUmakefile"];

export function isMakeFileName(filename: string): boolean {
  return makeExactFileNames.includes(filename) || filename.endsWith(".mk");
}

export type MakeInstall = {installPath: string, version: string};

// Variable assignment holding a single `go install` spec, e.g.
//   AIR_PACKAGE ?= github.com/air-verse/air@v1.65.1
// Captures: 1=install path, 2=version. Assignment operators: = := ::= ?= +=
const makeAssignPrefix = String.raw`^\s*[A-Za-z_][\w.]*\s*(?:::=|:=|\?=|\+=|=)\s*`;
const makeAssignRe = new RegExp(`${makeAssignPrefix}${String.raw`(\S+)@(v\d\S*)\s*$`}`);
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

export type MakeDockerImage = {
  writtenImage: string,   // image part exactly as authored, may include a `docker.io/` prefix
  ref: DockerImageRef,    // normalized for Docker Hub resolution (registry stripped); ref.tag holds the tag
  digest: string | null,  // `sha256:…` pin if present
};

// Variable assignment holding a single container image, e.g.
//   SHELLCHECK_IMAGE ?= docker.io/koalaman/shellcheck:v0.11.0@sha256:61862…
const makeImageRe = new RegExp(`${makeAssignPrefix}${String.raw`(\S+)\s*$`}`);
const makeImageDigestRe = /@(sha256:[0-9a-f]{64})$/;

// Reassemble a `[registry/]namespace/repo:tag[@sha256:…]` spec exactly as authored.
export function formatMakeImageSpec(writtenImage: string, tag: string, digest: string | null): string {
  return `${writtenImage}:${tag}${digest ? `@${digest}` : ""}`;
}

export function parseMakeImageValue(value: string): MakeDockerImage | null {
  let digest: string | null = null;
  let imageWithTag = value;
  const digestMatch = makeImageDigestRe.exec(value);
  if (digestMatch) {
    digest = digestMatch[1];
    imageWithTag = value.slice(0, digestMatch.index);
  }
  // `docker.io/` is Docker Hub; strip it for resolution but keep it in writtenImage.
  const ref = parseDockerImageRef(imageWithTag.replace(/^docker\.io\//, ""));
  // Require a Hub namespace: skips bare library images and `host:port` vars (mysql:3306).
  if (!ref || ref.registry || ref.namespace === "library") return null;
  const writtenImage = imageWithTag.slice(0, imageWithTag.lastIndexOf(":"));
  return {writtenImage, ref, digest};
}

export function parseMakeDockerImages(content: string): Array<MakeDockerImage> {
  const images: Array<MakeDockerImage> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = makeImageRe.exec(stripComment(rawLine));
    if (!match) continue;
    const image = parseMakeImageValue(match[1]);
    if (image) images.push(image);
  }
  return images;
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

export type MakeDockerUpdate = {newTag: string, newDigest: string | null, date: string, info: string};

export async function fetchMakeDockerInfo(image: MakeDockerImage, ctx: ModeContext, opts: MakeVersionOpts): Promise<MakeDockerUpdate | null> {
  const {namespace, repo, fullImage, tag} = image.ref;
  const [data] = await fetchDockerInfo(fullImage, "docker", ctx); // throws for non-Hub registries
  const result = findDockerVersion(data.tags, tag, opts.semvers, opts.cooldownDays, opts.now, opts.pinnedRange);
  if (!result) return null;

  let newDigest: string | null = null;
  if (image.digest) {
    // Keep the pin valid: resolve the digest via the real Hub tag (newTag is precision-reduced
    // to the authored tag and may 404 when Hub only publishes higher-precision tags), and skip
    // rather than write a stale one.
    newDigest = await fetchDockerTagDigest(namespace, repo, result.hubTag, ctx);
    if (!newDigest) return null;
  }
  return {newTag: result.newTag, newDigest, date: result.date, info: getDockerInfoUrl(image.ref)};
}

export type MakeRewrite = {oldSpec: string, newSpec: string};

// Surgically rewrites each `oldSpec` (the exact `path@version` or `image:tag[@sha256:…]`
// token as authored) to `newSpec` in place, touching only the matched span. The
// `^([^#\n]*?)` prefix anchors the match to a line's code portion — it cannot cross a
// `#`, so occurrences inside full-line or inline comments are never rewritten. Untouched
// bytes (including CRLF endings) are preserved verbatim.
export function updateMakefile(content: string, rewrites: Array<MakeRewrite>): string {
  for (const {oldSpec, newSpec} of rewrites) {
    // Trailing boundary allows whitespace, a directly-attached `#` comment, or EOL.
    const re = new RegExp(`^([^#\\n]*?)${esc(oldSpec)}(?=[\\s#]|$)`, "gm");
    content = content.replace(re, `$1${newSpec}`);
  }
  return content;
}
