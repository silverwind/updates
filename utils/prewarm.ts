import {readFileSync, existsSync} from "node:fs";
import {join} from "node:path";
import {dockerExactFileNames} from "../modes/docker.ts";
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
  const has = (...names: string[]) => names.some(name => existsSync(join(dir, name)));
  const origins = new Set<string>();
  const add = (origin: string | null) => { if (origin) origins.add(origin); };
  const forgeOrigin = resolveOrigin(args.forgeapi, "https://api.github.com/");
  const dockerOrigin = resolveOrigin(args.dockerapi, "https://hub.docker.com/");
  if (has("package.json", "pnpm-workspace.yaml")) {
    add(resolveOrigin(args.registry ?? npmrcRegistry(dir), "https://registry.npmjs.org/"));
    add(resolveOrigin(args.jsrapi, "https://jsr.io/"));
    add(forgeOrigin);
  }
  if (has("pyproject.toml")) add(resolveOrigin(args.pypiapi, "https://pypi.org/"));
  if (has("Cargo.toml")) add(resolveOrigin(args.cargoapi, "https://crates.io/"));
  if (has("go.mod", "go.work")) add(resolveOrigin(args.goproxy, "https://proxy.golang.org/"));
  if (has(...dockerExactFileNames)) add(dockerOrigin);
  if (has(".github/workflows")) {
    add(forgeOrigin);
    add(dockerOrigin);
  }
  return Array.from(origins);
}
