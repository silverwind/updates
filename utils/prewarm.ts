import {readFileSync, readdirSync, type Dirent} from "node:fs";
import {join} from "node:path";
import {isDockerFileName} from "../modes/docker.ts";
import {forgeDirs} from "./utils.ts";
import {parseIni} from "./rc.ts";

function npmrcRegistry(dir: string): string | undefined {
  try {
    return parseIni(readFileSync(join(dir, ".npmrc"), "utf8")).registry;
  } catch {
    return undefined;
  }
}

// The override's origin when set (so tests and custom registries warm the host
// actually contacted), the default otherwise, null when unparsable.
function resolveOrigin(override: unknown, defaultOrigin: string): string | null {
  if (typeof override !== "string" || !override) return defaultOrigin;
  try {
    return `${new URL(override).origin}/`;
  } catch {
    return null;
  }
}

// Detect which registry origins should have a TLS keep-alive socket pre-warmed
// based on files present in `dir`, honoring the API override flags in `args`.
// Registry overrides from the config file are not seen here: it loads later.
export function prewarmOrigins(dir: string, args: Record<string, unknown>): string[] {
  let entries: Array<Dirent> = [];
  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {}
  const names = new Set(entries.map(entry => entry.name));
  const has = (...candidates: string[]) => candidates.some(name => names.has(name));
  const origins = new Set<string>();
  const add = (origin: string | null) => { if (origin) origins.add(origin); };
  const forgeOrigin = resolveOrigin(args.forgeapi, "https://api.github.com/");
  const dockerOrigin = resolveOrigin(args.dockerapi, "https://hub.docker.com/");
  if (has("package.json", "pnpm-workspace.yaml")) {
    const registry = typeof args.registry === "string" ? args.registry : npmrcRegistry(dir);
    add(resolveOrigin(registry, "https://registry.npmjs.org/"));
    add(resolveOrigin(args.jsrapi, "https://jsr.io/"));
    add(forgeOrigin);
  }
  if (has("pyproject.toml")) add(resolveOrigin(args.pypiapi, "https://pypi.org/"));
  if (has("Cargo.toml")) add(resolveOrigin(args.cargoapi, "https://crates.io/"));
  if (has("go.mod", "go.work")) add(resolveOrigin(args.goproxy, "https://proxy.golang.org/"));
  // Keyed off the predicate, not a name list, so every file resolveFiles would scan prewarms
  // too — `Dockerfile.dev`, `docker-stack.yml`, `compose.prod.yaml`.
  if (entries.some(entry => entry.isFile() && isDockerFileName(entry.name))) add(dockerOrigin);
  // Bare forge dir, matching resolveFiles' auto-discovery: workflows also live
  // outside `workflows/` as `<forge>/**/action.yml`.
  if (has(...forgeDirs)) {
    add(forgeOrigin);
    add(dockerOrigin);
  }
  return Array.from(origins);
}
