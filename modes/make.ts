import {env} from "node:process";
import {resolve} from "node:path";
import {dedupe, fieldSep, type ModeContext} from "./shared.ts";
import {esc} from "../utils/utils.ts";
import {fetchGoLatest, goListError, goProxyChainFor} from "./go.ts";
import {type DockerImageRef, parseDockerImageRef} from "./docker.ts";

export const makeExactFileNames = ["Makefile", "makefile", "GNUmakefile"];

export function isMakeFileName(filename: string): boolean {
  return makeExactFileNames.includes(filename) || filename.endsWith(".mk");
}

const makeAssignRe = /^\s*(?:(?:export|override|private|unexport)\s+)*[A-Za-z_][\w.]*\s*(?:::=|:=|\?=|\+=|=)\s*(.*)$/;
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

export function parseMakeGoInstalls(content: string) {
  const installs: Array<{installPath: string, version: string}> = [];
  for (const value of makeAssignmentValues(content)) {
    const match = makeGoInstallRe.exec(value);
    if (match && goHostRe.test(match[1])) installs.push({installPath: match[1], version: match[2]});
  }
  return installs;
}

export type MakeDockerImage = {writtenImage: string, ref: DockerImageRef, digest: string | null};

const makeImageDigestRe = /@(sha256:[0-9a-f]{64})$/;

export function formatMakeImageSpec(writtenImage: string, tag: string, digest: string | null): string {
  return `${writtenImage}:${tag}${digest ? `@${digest}` : ""}`;
}

export function parseMakeImageValue(value: string): MakeDockerImage | null {
  const digestMatch = makeImageDigestRe.exec(value);
  const imageWithTag = digestMatch ? value.slice(0, digestMatch.index) : value;
  const ref = parseDockerImageRef(imageWithTag.replace(/^docker\.io\//, ""));
  if (!ref || ref.registry || ref.namespace === "library") return null;
  return {writtenImage: imageWithTag.slice(0, imageWithTag.lastIndexOf(":")), ref, digest: digestMatch?.[1] ?? null};
}

export function parseMakeDockerImages(content: string): Array<MakeDockerImage> {
  return Array.from(makeAssignmentValues(content), parseMakeImageValue).filter(image => image !== null);
}

const midMajorRe = /\/v(?:[2-9]|[1-9]\d+)(?=\/|$)/;
const directGoProbesByCtx = new WeakMap<ModeContext, Map<string, Promise<boolean | null>>>();

function probeDirectGoModule(candidate: string, goCwd: string, ctx: ModeContext): Promise<boolean | null> {
  return dedupe(directGoProbesByCtx, ctx, `${resolve(goCwd)}${fieldSep}${candidate}`, async () => {
    let stdout: string;
    try {
      ({stdout} = await ctx.execFile("go", ["list", "-m", "-e", "-json", `${candidate}@latest`], {
        timeout: ctx.fetchTimeout, cwd: goCwd, env: {...env, GOPROXY: "direct"},
      }));
    } catch (err) {
      throw goListError(`${candidate}@latest`, err);
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
  }, false);
}

export async function resolveGoModuleRoot(installPath: string, goCwd: string, ctx: ModeContext, goNoProxy: Array<string>): Promise<string | null> {
  const major = midMajorRe.exec(installPath);
  if (major) return installPath.slice(0, major.index + major[0].length);
  const parts = installPath.split("/");
  const candidates = Array.from({length: parts.length - 1}, (_, idx) => parts.slice(0, parts.length - idx).join("/"));
  // One entry at a time, all candidates at once: the first entry that knows the module decides the root.
  for (const {url, fallback} of goProxyChainFor(installPath, ctx, goNoProxy)) {
    if (url === "off") break;
    const probes = await Promise.allSettled(candidates.map(async candidate => url === "direct" ?
      probeDirectGoModule(candidate, goCwd, ctx) : Boolean(await fetchGoLatest(ctx, "primary", url, candidate))));
    for (const [index, probe] of probes.entries()) {
      if (probe.status === "rejected" && fallback === ",") throw probe.reason;
      if (probe.status === "fulfilled" && probe.value) return candidates[index];
    }
  }
  return null;
}

export function updateMakefile(content: string, rewrites: Array<{oldSpec: string, newSpec: string}>): string {
  const bySpec = new Map(rewrites.map(({oldSpec, newSpec}) => [oldSpec, newSpec]));
  if (!bySpec.size) return content;
  const specs = Array.from(bySpec.keys()).sort((left, right) => right.length - left.length)
    .map(spec => Array.from(spec, esc).join(`["']*`)).join("|");
  const specRe = new RegExp(`(?<![\\w./@:-])(${specs})(?=[\\s#"']|$)`, "g");
  return content.replace(/^[^#\n]*/gm, code => code.replace(specRe, authoredSpec => {
    const newSpec = bySpec.get(authoredSpec.replace(/["']/g, ""))!;
    let newIndex = 0;
    return authoredSpec.replace(/[^"']/g, () => newSpec[newIndex++] ?? "") + newSpec.slice(newIndex);
  }));
}
