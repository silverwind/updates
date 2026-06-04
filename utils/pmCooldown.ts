import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {parseIni} from "./rc.ts";
import {parseToml} from "./toml.ts";

// Reads the native "minimum release age" supply-chain settings that npm, pnpm and
// bun expose, so `updates` won't propose a version those package managers would
// themselves refuse to install. All values are normalized to days.
//
// | PM   | file                  | key                  | unit    | exclude key                  |
// |------|-----------------------|----------------------|---------|------------------------------|
// | npm  | .npmrc                | min-release-age      | days    | min-release-age-exclude      |
// | pnpm | .npmrc                | minimum-release-age  | minutes | minimum-release-age-exclude  |
// | pnpm | pnpm-workspace.yaml   | minimumReleaseAge    | minutes | minimumReleaseAgeExclude     |
// | bun  | bunfig.toml [install] | minimumReleaseAge    | seconds | minimumReleaseAgeExcludes    |

export type NativeCooldown = {
  /** Largest minimum age found, in days (0 if none). */
  days: number;
  /** Union of package names exempted from the minimum age. */
  exclude: Set<string>;
};

function readUp(startDir: string, filename: string): string | undefined {
  let dir = startDir;
  while (true) {
    try {
      return readFileSync(join(dir, filename), "utf8");
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// Parse `minimumReleaseAge` (minutes) and `minimumReleaseAgeExclude` from a
// pnpm-workspace.yaml. Mirrors the minimal YAML extraction in parsePnpmWorkspace;
// supports both inline (`[a, b]`) and block (`- a`) list forms for the exclude.
function parsePnpmWorkspaceCooldown(content: string): {minutes?: number, exclude: string[]} {
  let minutes: number | undefined;
  const exclude: string[] = [];
  let inExclude = false;
  for (const line of content.split(/\r?\n/)) {
    const scalar = /^minimumReleaseAge\s*:\s*['"]?(\d+(?:\.\d+)?)/.exec(line);
    if (scalar) {
      minutes = Number(scalar[1]);
      inExclude = false;
      continue;
    }
    const excludeKey = /^minimumReleaseAgeExclude\s*:(.*)$/.exec(line);
    if (excludeKey) {
      const inline = excludeKey[1].trim();
      const arr = /^\[(.*)\]$/.exec(inline);
      if (arr) {
        for (const item of arr[1].split(",")) {
          const m = /^\s*['"]?([^'"#\s]+)['"]?\s*$/.exec(item);
          if (m) exclude.push(m[1]);
        }
        inExclude = false;
      } else {
        inExclude = true;
      }
      continue;
    }
    if (inExclude) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const item = /^-\s+['"]?([^'"#\s]+)['"]?/.exec(trimmed);
      if (item) {
        exclude.push(item[1]);
      } else {
        inExclude = false; // a non-list line ends the block
      }
    }
  }
  return {minutes, exclude};
}

function fromNpmrc(content: string): {days: number, exclude: string[]} {
  const ini = parseIni(content);
  let days = 0;
  const npmDays = Number(ini["min-release-age"]);
  if (Number.isFinite(npmDays) && npmDays > 0) days = Math.max(days, npmDays);
  const pnpmMinutes = Number(ini["minimum-release-age"]);
  if (Number.isFinite(pnpmMinutes) && pnpmMinutes > 0) days = Math.max(days, pnpmMinutes / 1440);
  const exclude = [
    ...splitList(ini["min-release-age-exclude"]),
    ...splitList(ini["minimum-release-age-exclude"]),
  ];
  return {days, exclude};
}

function fromBunfig(content: string): {days: number, exclude: string[]} {
  let parsed: Record<string, any>;
  try {
    parsed = parseToml(content) as Record<string, any>;
  } catch {
    return {days: 0, exclude: []};
  }
  const install = (parsed.install ?? {}) as Record<string, any>;
  const seconds = Number(install.minimumReleaseAge ?? parsed.minimumReleaseAge);
  const days = Number.isFinite(seconds) && seconds > 0 ? seconds / 86400 : 0;
  const raw = install.minimumReleaseAgeExcludes ?? parsed.minimumReleaseAgeExcludes;
  const exclude = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string" && Boolean(n)) : [];
  return {days, exclude};
}

/**
 * Resolve the effective native minimum release age for an npm-ecosystem project,
 * walking up from `projectDir` to find .npmrc, pnpm-workspace.yaml and bunfig.toml.
 * When several settings are present the most conservative (max days, union of
 * excludes) wins. Missing or unparseable files contribute nothing. Callers that
 * look this up repeatedly should cache per run, since config files can change
 * between separate invocations within a long-lived process.
 */
export function npmEcosystemCooldown(projectDir: string): NativeCooldown {
  let days = 0;
  const exclude = new Set<string>();
  const merge = ({days: d, exclude: ex}: {days: number, exclude: string[]}) => {
    if (d > days) days = d;
    for (const name of ex) exclude.add(name);
  };

  const npmrc = readUp(projectDir, ".npmrc");
  if (npmrc) merge(fromNpmrc(npmrc));

  const pnpmWorkspace = readUp(projectDir, "pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    const {minutes, exclude: ex} = parsePnpmWorkspaceCooldown(pnpmWorkspace);
    merge({days: minutes && minutes > 0 ? minutes / 1440 : 0, exclude: ex});
  }

  const bunfig = readUp(projectDir, "bunfig.toml");
  if (bunfig) merge(fromBunfig(bunfig));

  return {days, exclude};
}
