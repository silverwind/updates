import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {parseIni} from "./rc.ts";
import {parseToml} from "./toml.ts";
import {parseDuration, esc} from "./utils.ts";

// Reads the native "minimum release age" supply-chain settings that npm, pnpm,
// bun and yarn expose, so `updates` won't propose a version those package
// managers would themselves refuse to install. All values are normalized to days.
//
// | PM   | file                  | key                  | unit             | exclude key                  |
// |------|-----------------------|----------------------|------------------|------------------------------|
// | npm  | .npmrc                | min-release-age      | days             | min-release-age-exclude      |
// | pnpm | .npmrc                | minimum-release-age  | minutes          | minimum-release-age-exclude  |
// | pnpm | pnpm-workspace.yaml   | minimumReleaseAge    | minutes          | minimumReleaseAgeExclude     |
// | bun  | bunfig.toml [install] | minimumReleaseAge    | seconds          | minimumReleaseAgeExcludes    |
// | yarn | .yarnrc.yml           | npmMinimalAgeGate    | minutes or "7d"  | npmPreapprovedPackages       |

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

// Extract a top-level scalar value for `key` from minimal YAML, with surrounding
// quotes and trailing comments stripped. Returns undefined when the key is absent
// or has no inline value (e.g. it heads a block list).
function yamlScalar(content: string, key: string): string | undefined {
  const re = new RegExp(`^${esc(key)}\\s*:[^\\S\\n]+(.+)$`);
  for (const line of content.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    let v = m[1].replace(/\s+#.*$/, "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    return v || undefined;
  }
  return undefined;
}

// Extract a top-level sequence for `key` from minimal YAML, supporting both
// inline (`[a, b]`) and block (`- a`) forms.
function yamlList(content: string, key: string): string[] {
  const out: string[] = [];
  const headerRe = new RegExp(`^${esc(key)}\\s*:(.*)$`);
  let inList = false;
  for (const line of content.split(/\r?\n/)) {
    const header = headerRe.exec(line);
    if (header) {
      const inline = header[1].trim();
      const arr = /^\[(.*)\]$/.exec(inline);
      if (arr) {
        for (const item of arr[1].split(",")) {
          const m = /^\s*['"]?([^'"#\s]+)['"]?\s*$/.exec(item);
          if (m) out.push(m[1]);
        }
        inList = false;
      } else {
        inList = true;
      }
      continue;
    }
    if (inList) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const item = /^-\s+['"]?([^'"#\s]+)['"]?/.exec(trimmed);
      if (item) out.push(item[1]);
      else inList = false; // a non-list line ends the block
    }
  }
  return out;
}

// pnpm-workspace.yaml: `minimumReleaseAge` is in minutes.
function fromPnpmWorkspace(content: string): {days: number, exclude: string[]} {
  const raw = yamlScalar(content, "minimumReleaseAge");
  const minutes = raw !== undefined ? Number(raw) : NaN;
  const days = Number.isFinite(minutes) && minutes > 0 ? minutes / 1440 : 0;
  return {days, exclude: yamlList(content, "minimumReleaseAgeExclude")};
}

// .yarnrc.yml (Yarn 4.10+): `npmMinimalAgeGate` is minutes as a number, or a
// duration string like "7d". `npmPreapprovedPackages` exempts packages.
function fromYarnrc(content: string): {days: number, exclude: string[]} {
  const raw = yamlScalar(content, "npmMinimalAgeGate");
  let days = 0;
  if (raw !== undefined) {
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      days = Number(raw) / 1440; // bare number is minutes
    } else {
      try {
        const d = parseDuration(raw); // duration string like "7d" -> days
        if (Number.isFinite(d) && d > 0) days = d;
      } catch {}
    }
  }
  return {days, exclude: yamlList(content, "npmPreapprovedPackages")};
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
  if (pnpmWorkspace) merge(fromPnpmWorkspace(pnpmWorkspace));

  const bunfig = readUp(projectDir, "bunfig.toml");
  if (bunfig) merge(fromBunfig(bunfig));

  const yarnrc = readUp(projectDir, ".yarnrc.yml");
  if (yarnrc) merge(fromYarnrc(yarnrc));

  return {days, exclude};
}
