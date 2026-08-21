import {env} from "node:process";
import {type ModeContext, fetchWithRetry} from "./shared.ts";
import {esc} from "../utils/utils.ts";
import {fetchFromGoProxyChain, fetchGoLatestOnce, isGoNoProxy, goProxyHeaders} from "./go.ts";
import {type DockerImageRef, parseDockerImageRef} from "./docker.ts";

export const makeExactFileNames = ["Makefile", "makefile", "GNUmakefile"];

export function isMakeFileName(filename: string): boolean {
  return makeExactFileNames.includes(filename) || filename.endsWith(".mk");
}

export type MakeInstall = {installPath: string, version: string};

const makeAssignRe = /^\s*[A-Za-z_][\w.]*\s*(?:::=|:=|\?=|\+=|=)\s*(.*)$/;
const makeGoInstallRe = /^([^@\s]+)@(v\d\S*)$/;
const goHostRe = /^[^/\s]+\.[^/\s]+\//;

function* makeAssignmentValues(content: string): Generator<string> {
  let logicalLine = "";
  for (const rawLine of [...content.split(/\r?\n/), ""]) {
    const commentIndex = rawLine.indexOf("#");
    const line = commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex);
    let backslashes = 0;
    while (line[line.length - backslashes - 1] === "\\") backslashes++;
    if (backslashes % 2) {
      logicalLine += `${line.slice(0, -1)} `;
      continue;
    }
    const assignment = makeAssignRe.exec(logicalLine + line);
    logicalLine = "";
    if (!assignment) continue;
    let quote = "";
    let value = "";
    for (const char of assignment[1]) {
      if (quote) {
        if (char === quote) quote = "";
        else value += char;
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        if (value) yield value;
        value = "";
      } else {
        value += char;
      }
    }
    if (value && !quote) yield value;
  }
}

export function parseMakeGoInstalls(content: string): Array<MakeInstall> {
  const installs: Array<MakeInstall> = [];
  for (const value of makeAssignmentValues(content)) {
    const match = makeGoInstallRe.exec(value);
    if (!match || !goHostRe.test(match[1])) continue;
    const [, installPath, version] = match;
    installs.push({installPath, version});
  }
  return installs;
}

export type MakeDockerImage = {
  writtenImage: string,
  ref: DockerImageRef,
  digest: string | null,
};

const makeImageDigestRe = /@(sha256:[0-9a-f]{64})$/;

export function formatMakeImageSpec(writtenImage: string, tag: string, digest: string | null): string {
  return `${writtenImage}:${tag}${digest ? `@${digest}` : ""}`;
}

export function parseMakeImageValue(value: string): MakeDockerImage | null {
  const digestMatch = makeImageDigestRe.exec(value);
  const digest = digestMatch?.[1] ?? null;
  const imageWithTag = digestMatch ? value.slice(0, digestMatch.index) : value;
  const ref = parseDockerImageRef(imageWithTag.replace(/^docker\.io\//, ""));
  if (!ref || ref.registry || ref.namespace === "library") return null;
  return {writtenImage: imageWithTag.slice(0, imageWithTag.lastIndexOf(":")), ref, digest};
}

export function parseMakeDockerImages(content: string): Array<MakeDockerImage> {
  return Array.from(makeAssignmentValues(content)).flatMap(value => parseMakeImageValue(value) ?? []);
}

const midMajorRe = /\/v(?:[2-9]|[1-9]\d+)(?=\/|$)/;

async function probeGoModuleRoot(candidate: string, goCwd: string, ctx: ModeContext, chain: ModeContext["goProxyChain"]): Promise<boolean> {
  return await fetchFromGoProxyChain(chain, async url => {
    if (url === "off") return false;
    if (url !== "direct") {
      return await fetchGoLatestOnce(
        ctx, requestUrl => fetchWithRetry(ctx, requestUrl, {headers: goProxyHeaders}), url, candidate,
      ) ? true : null;
    }
    let stdout: string;
    try {
      ({stdout} = await ctx.execFile("go", ["list", "-m", "-e", "-json", `${candidate}@latest`], {
        timeout: ctx.fetchTimeout, cwd: goCwd, env: {...env, GOPROXY: "direct"},
      }));
    } catch (err: any) {
      const reason = String(err?.stderr ?? "").trim().split("\n")[0] || err?.message || String(err);
      throw new Error(`go list -m ${candidate}@latest failed: ${reason}`);
    }
    let result: {Version?: string, Error?: {Err?: string}, Origin?: unknown};
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error(`go list -m ${candidate}@latest returned malformed JSON`);
    }
    if (result.Error) {
      const reason = result.Error.Err;
      if (result.Origin && reason?.endsWith('no matching versions for query "latest"')) return null;
      throw new Error(`go list -m ${candidate}@latest failed: ${reason || "unknown error"}`);
    }
    if (typeof result.Version !== "string") throw new Error(`go list -m ${candidate}@latest returned malformed JSON`);
    return true;
  }) ?? false;
}

export async function resolveGoModuleRoot(installPath: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<string | null> {
  const major = midMajorRe.exec(installPath);
  if (major) return installPath.slice(0, major.index + major[0].length);
  const chain = isGoNoProxy(installPath, goNoProxy) ? [{url: "direct", fallback: ","} as const] :
    ctx.goProxyChain;
  if (chain[0].url === "off") return null;
  const parts = installPath.split("/");
  const candidates = Array.from({length: parts.length - 1}, (_, idx) => parts.slice(0, parts.length - idx).join("/"));
  if (chain[0].url === "direct") {
    for (const candidate of candidates) {
      if (await probeGoModuleRoot(candidate, goCwd, ctx, chain)) return candidate;
    }
    return null;
  }
  const directIndex = chain.findIndex(({url}) => url === "direct");
  const proxyChain = directIndex === -1 ? chain : chain.slice(0, directIndex);
  const probes = await Promise.allSettled(candidates.map(candidate => probeGoModuleRoot(candidate, goCwd, ctx, proxyChain)));
  const failed = probes.find(probe => probe.status === "rejected");
  if (failed) throw failed.reason;
  const firstHit = probes.findIndex(probe => probe.status === "fulfilled" && probe.value);
  if (directIndex !== -1) {
    for (const candidate of candidates.slice(0, firstHit === -1 ? undefined : firstHit)) {
      if (await probeGoModuleRoot(candidate, goCwd, ctx, chain.slice(directIndex))) return candidate;
    }
  }
  return firstHit === -1 ? null : candidates[firstHit];
}

export type MakeRewrite = {oldSpec: string, newSpec: string};

export function updateMakefile(content: string, rewrites: Array<MakeRewrite>): string {
  const bySpec = new Map(rewrites.map(({oldSpec, newSpec}) => [oldSpec, newSpec]));
  if (!bySpec.size) return content;
  const specs = Array.from(bySpec.keys()).sort((a, b) => b.length - a.length)
    .map(spec => Array.from(spec, char => esc(char)).join(`["']*`)).join("|");
  const specRe = new RegExp(`(?<![\\w./@:-])(${specs})(?=[\\s#"']|$)`, "g");
  return content.replace(/^[^#\n]*/gm, code => code.replace(specRe, authoredSpec => {
    const oldSpec = authoredSpec.replace(/["']/g, "");
    const newSpec = bySpec.get(oldSpec)!;
    let newIndex = 0;
    const result = authoredSpec.replace(/[^"']/g, () => newSpec[newIndex++] ?? "");
    return result + newSpec.slice(newIndex);
  }));
}
