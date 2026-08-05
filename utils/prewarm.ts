import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {isDockerFileName} from "../modes/docker.ts";
import {isMakeFileName} from "../modes/make.ts";
import {resolveGoProxyChain} from "../modes/go.ts";
import {defaultApiUrls} from "../modes/shared.ts";
import {forgeDirs, modeByFileName} from "./utils.ts";
import {parseIni} from "./rc.ts";

function npmrcRegistry(dir: string): string | undefined {
  try {
    return parseIni(readFileSync(join(dir, ".npmrc"), "utf8")).registry;
  } catch {
    return undefined;
  }
}

// The origin of the override when set (so tests and custom registries warm the host actually
// contacted), of the default otherwise, null when unparsable.
function resolveOrigin(override: unknown, defaultUrl: string): string | null {
  try {
    return `${new URL(typeof override === "string" && override ? override : defaultUrl).origin}/`;
  } catch {
    return null;
  }
}

// Which APIs each mode contacts, named by their override flag so the URLs live in
// defaultApiUrls alone. Keyed by mode rather than by filename, so giving a mode another
// manifest or another API has one place to update — prewarm.test.ts fails on a missing mode.
const apisByMode: Record<string, Array<keyof typeof defaultApiUrls>> = {
  npm: ["registry", "jsrapi", "forgeapi"],
  pypi: ["pypiapi"],
  cargo: ["cargoapi"],
  go: ["goproxy"],
  docker: ["dockerapi"],
  actions: ["forgeapi", "dockerapi"], // workflows carry action refs and docker images
  make: ["goproxy", "dockerapi"], // Makefiles carry `go install` tools and docker images
};

// The mode that claims a file, mirroring resolveFiles so prewarming cannot warm a different
// set of origins than the run goes on to contact.
function modeForFile(filename: string): string | undefined {
  if (modeByFileName[filename]) return modeByFileName[filename];
  if (isDockerFileName(filename)) return "docker";
  if (isMakeFileName(filename)) return "make";
  return undefined;
}

// Detect which registry origins should have a TLS keep-alive socket pre-warmed
// based on files present in `dir`, honoring the API override flags in `args`.
// Registry overrides from the config file are not seen here: it loads later.
export function prewarmOrigins(dir: string, args: Record<string, unknown>): string[] {
  const modes = new Set<string>();
  try {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.isFile()) {
        const mode = modeForFile(entry.name);
        if (mode) modes.add(mode);
      } else if (entry.isDirectory() && forgeDirs.some(forgeDir => forgeDir === entry.name)) {
        // Bare forge dir, matching resolveFiles' auto-discovery: workflows also live
        // outside `workflows/` as `<forge>/**/action.yml`.
        modes.add("actions");
      }
    }
  } catch {}

  const origins = new Set<string>();
  for (const mode of modes) {
    for (const api of apisByMode[mode] ?? []) {
      // the npm registry is the only one that can also come from a file
      const override = api === "registry" && typeof args.registry !== "string" ? npmrcRegistry(dir) : args[api];
      // GOPROXY, not the default, is where go lookups go, and its `off` and `direct` parse as no
      // URL, so they warm nothing.
      const origin = resolveOrigin(override, api === "goproxy" ? resolveGoProxyChain()[0].url : defaultApiUrls[api]);
      if (origin) origins.add(origin);
    }
  }
  return Array.from(origins);
}
