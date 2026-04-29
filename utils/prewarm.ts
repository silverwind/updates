import {existsSync} from "node:fs";
import {join} from "node:path";
import {dockerExactFileNames} from "../modes/docker.ts";

// Detect which registry origins should have a TLS keep-alive socket pre-warmed
// based on files present in `dir`. Returns `[]` for help/version invocations
// so undici doesn't open sockets the user will never use.
export function prewarmOrigins(dir: string, argv: readonly string[]): string[] {
  if (argv.some(arg => arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version")) return [];

  const has = (...names: string[]) => names.some(name => existsSync(join(dir, name)));
  const origins = new Set<string>();
  if (has("package.json", "pnpm-workspace.yaml")) {
    origins.add("https://registry.npmjs.org/");
    origins.add("https://jsr.io/");
    origins.add("https://api.github.com/");
  }
  if (has("pyproject.toml")) origins.add("https://pypi.org/");
  if (has("Cargo.toml")) origins.add("https://crates.io/");
  if (has("go.mod", "go.work")) origins.add("https://proxy.golang.org/");
  if (has(...dockerExactFileNames)) origins.add("https://hub.docker.com/");
  if (has(".github/workflows")) {
    origins.add("https://api.github.com/");
    origins.add("https://hub.docker.com/");
  }
  return Array.from(origins);
}
