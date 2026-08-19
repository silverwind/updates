import {env} from "node:process";
import {type ModeContext, stripv, formatVersionPrecision, findNewVersion, fetchWithRetry} from "./shared.ts";
import {longestFirstAlternation, tryOrNull} from "../utils/utils.ts";
import {goModulePathForVersion, fetchGoLatestOnce, fetchGoProxyInfo, getGoInfoUrl, isGoNoProxy, goProxyHeaders} from "./go.ts";
import {
  type DockerImageRef,
  parseDockerImageRef, fetchDockerInfo, findDockerVersion, getDockerInfoUrl, fetchDockerTagDigest,
} from "./docker.ts";

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

// Module root is some prefix of the install path. A `/vN` segment (v2+ only, per
// Go's module-path convention) marks the boundary without a lookup; otherwise probe
// prefixes longest-first and take the longest that resolves as a module. v0/v1 carry
// no path suffix, so a literal /v0 or /v1 segment is an ordinary directory.
const midMajorRe = /\/v(?:[2-9]|[1-9]\d+)(?=\/|$)/;

export function moduleRootFromMajor(installPath: string): string | null {
  const match = midMajorRe.exec(installPath);
  return match ? installPath.slice(0, match.index + match[0].length) : null;
}

// Does this path resolve as a module? `direct` and a GONOPROXY match go through the VCS, as
// fetchGoProxyInfo routes them: neither literal is a URL, so interpolating one builds a nonsense
// address whose failure would silently drop every tool in the file.
async function probeGoModuleRoot(candidate: string, goCwd: string, ctx: ModeContext, useVcs: boolean): Promise<boolean> {
  if (useVcs) {
    // `go list` exits non-zero for a path that is no module and for an unreachable host alike.
    return await tryOrNull(ctx.execFile("go", ["list", "-m", "-json", `${candidate}@latest`], {timeout: ctx.fetchTimeout, cwd: goCwd, env})) !== null;
  }
  // The root decides which module the tool tracks, so this is the lookup itself, sharing its request
  // through fetchGoLatestOnce and its retries. null is a 404/410, a throw a 429 or 5xx on the tool.
  const probeFetch = (url: string) => fetchWithRetry(ctx, url, {headers: goProxyHeaders});
  return Boolean(await fetchGoLatestOnce(ctx, probeFetch, ctx.goProxyUrl, candidate));
}

export async function resolveGoModuleRoot(installPath: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<string | null> {
  const heuristic = moduleRootFromMajor(installPath);
  if (heuristic) return heuristic;
  const useVcs = ctx.goProxyUrl === "direct" || isGoNoProxy(installPath, goNoProxy);
  if (!useVcs && ctx.goProxyUrl === "off") return null; // go looks nothing up, so neither does the probe
  const parts = installPath.split("/");
  const candidates = Array.from({length: parts.length - 1}, (_, idx) => parts.slice(0, parts.length - idx).join("/"));
  if (useVcs) { // one at a time: each of these probes is a `go list -m` subprocess inside an outer fan
    for (const candidate of candidates) {
      if (await probeGoModuleRoot(candidate, goCwd, ctx, true)) return candidate;
    }
    return null;
  }
  // All at once, and a failure holds its place: it may hide the root a shorter hit would replace.
  const probes = await Promise.allSettled(candidates.map(candidate => probeGoModuleRoot(candidate, goCwd, ctx, false)));
  for (const [idx, probe] of probes.entries()) {
    if (probe.status === "rejected") throw probe.reason;
    if (probe.value) return candidates[idx];
  }
  return null;
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
  allowDowngrade: boolean,
  pinnedRange?: string,
  pinNoDowngrade?: boolean,
  cooldownDays?: number,
  now?: number,
};

export async function fetchMakeInfo(installPath: string, version: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>, opts: MakeVersionOpts): Promise<MakeUpdate | null> {
  const modulePath = await resolveGoModuleRoot(installPath, goCwd, ctx, goNoProxy);
  if (!modulePath) return null;

  const [data] = await fetchGoProxyInfo(modulePath, "tool", stripv(version), goCwd, ctx, goNoProxy);

  // Route through the same selection as the go mode so downgrades, pseudo-versions,
  // prereleases, pins and cooldowns are handled identically.
  const newVersion = findNewVersion(data, {...opts, mode: "go", range: stripv(version)});
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
  const [data] = await fetchDockerInfo(fullImage, ctx); // throws for non-Hub registries
  const result = findDockerVersion(data.tags, tag, opts.semvers, opts.cooldownDays, opts.now, opts.pinnedRange, opts.usePre, opts.useRel);
  if (!result) return null;

  let newDigest: string | null = null;
  if (image.digest) {
    // Resolve the digest for the tag actually being written, and skip rather than write a
    // stale one — a tag paired with another tag's digest silently pulls the wrong image.
    newDigest = await fetchDockerTagDigest(namespace, repo, result.newTag, ctx);
    if (!newDigest) return null;
  }
  return {newTag: result.newTag, newDigest, date: result.date, info: getDockerInfoUrl(image.ref)};
}

export type MakeRewrite = {oldSpec: string, newSpec: string};

// The outer pass hands the inner one each line's code portion alone, so an occurrence inside a
// comment is never rewritten, while the leading boundary keeps a bare `ns/img:tag` out of a
// `docker.io/ns/img:tag` elsewhere in the file.
export function updateMakefile(content: string, rewrites: Array<MakeRewrite>): string {
  const bySpec = new Map(rewrites.map(({oldSpec, newSpec}) => [oldSpec, newSpec]));
  if (!bySpec.size) return content;
  const specs = longestFirstAlternation(bySpec.keys());
  const specRe = new RegExp(`(?<![\\w./@:-])(${specs})(?=[\\s#]|$)`, "g");
  return content.replace(/^[^#\n]*/gm, code => code.replace(specRe, spec => bySpec.get(spec)!));
}
