import {readFileSync, readdirSync, statSync} from "node:fs";
import {basename, join, resolve} from "node:path";

const defaults = {
  registry: "https://registry.npmjs.org",
  jsrapi: "https://jsr.io",
  forgeapi: "https://api.github.com",
  pypiapi: "https://pypi.org",
  cargoapi: "https://crates.io",
  dockerapi: "https://hub.docker.com",
  goproxy: "https://proxy.golang.org",
} as const;

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"];
const modeByName = (filename: string) => filename === "package.json" || filename === "pnpm-workspace.yaml" ? "npm" :
  filename === "pyproject.toml" ? "pypi" : filename === "Cargo.toml" ? "cargo" :
    filename === "go.mod" || filename === "go.work" ? "go" :
      /^Dockerfile(?:\..+)?$/.test(filename) || /^(?:docker-|compose).*\.ya?ml$/.test(filename) ? "docker" :
        ["Makefile", "makefile", "GNUmakefile"].includes(filename) || filename.endsWith(".mk") ? "make" :
          /\.ya?ml$/.test(filename) ? "actions" : "";

export function prewarmOrigins(dir: string, args: Record<string, unknown>): string[] {
  const enabledModes = Array.isArray(args.modes) ? new Set(args.modes) : typeof args.modes === "string" ?
    new Set(args.modes.split(",")) : null;
  const resources = new Set<string>();
  const candidates = new Set<string>();
  const paths = Array.isArray(args.files) && args.files.length ? args.files.filter(path => typeof path === "string") : [dir];
  for (const input of paths) {
    const path = resolve(input);
    try {
      if (statSync(path).isFile()) {
        candidates.add(path);
        continue;
      }
      for (const entry of readdirSync(path, {withFileTypes: true})) {
        if (entry.isFile()) candidates.add(join(path, entry.name));
        else if ([".github", ".gitea", ".forgejo"].includes(entry.name)) {
          try {
            for (const workflow of readdirSync(join(path, entry.name, "workflows"), {withFileTypes: true})) {
              if (workflow.isFile() && /\.ya?ml$/.test(workflow.name)) candidates.add(join(path, entry.name, "workflows", workflow.name));
            }
          } catch {}
        }
      }
    } catch {}
  }

  for (const path of candidates) {
    const filename = basename(path);
    const mode = modeByName(filename);
    if (!mode || enabledModes && !enabledModes.has(mode) && !(mode === "actions" && enabledModes.has("docker"))) continue;
    try {
      const content = readFileSync(path, "utf8");
      if (filename === "package.json") {
        let data: Record<string, any>;
        try { data = JSON.parse(content); } catch { continue; }
        const specs = dependencyFields.flatMap(field => Object.values(data[field] ?? {}));
        if (typeof data.packageManager === "string") specs.push(data.packageManager.split("@", 1)[0]);
        for (const spec of specs) {
          if (typeof spec !== "string" || /^(?:file|link|workspace):/.test(spec)) continue;
          if (/^(?:jsr:|npm:@jsr\/)/.test(spec)) resources.add("jsrapi");
          else if (/^(?:git(?:\+https?|\+ssh)?:|https?:\/\/[^/]*(?:github|gitea|forgejo)|github:|gitea:|forgejo:)/.test(spec)) {
            resources.add("forgeapi");
          } else resources.add("registry");
        }
      } else if (filename === "pnpm-workspace.yaml") {
        if (/\b(?:jsr:|npm:@jsr\/)/.test(content)) resources.add("jsrapi");
        if (/\b(?:catalogs?|overrides):|:\s*["']?[~^<>=]*\d/.test(content)) resources.add("registry");
      } else if (filename === "pyproject.toml") {
        if (/^[ \t]*["'][A-Za-z0-9][\w.-]*(?:\[[^\]]+\])?\s*(?:[<>=!~]|@)/m.test(content)) resources.add("pypiapi");
      } else if (filename === "Cargo.toml") {
        if (/^\s*\[(?:target\.[^\]]+\.)?(?:dev-|build-)?dependencies\]/m.test(content)) resources.add("cargoapi");
      } else if (filename === "go.mod" || filename === "go.work") {
        if (/^\s*(?:require\s+)?\S+\s+v\d/m.test(content)) resources.add("goproxy");
      } else if (/^Dockerfile(?:\..+)?$/.test(filename) || /^(?:docker-|compose).*\.ya?ml$/.test(filename)) {
        if (/^\s*(?:FROM\s+(?:--\S+\s+)*|image\s*:\s*)[^\s#]+[:@]/im.test(content)) resources.add("dockerapi");
      } else if (["Makefile", "makefile", "GNUmakefile"].includes(filename) || filename.endsWith(".mk")) {
        if (/\bgo\s+install\s+\S+@v\d/.test(content)) resources.add("goproxy");
        if (/\b(?:docker|image)\b[^\n]*[\w./-]+:[\w.-]+/i.test(content)) resources.add("dockerapi");
      } else {
        let blockIndent = -1;
        for (const line of content.split(/\r?\n/)) {
          const indent = line.search(/\S|$/);
          if (blockIndent !== -1 && (!line.trim() || indent > blockIndent)) continue;
          blockIndent = /:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(line) ? indent : -1;
          if ((!enabledModes || enabledModes.has("actions")) &&
            /^\s*(?:-\s*)?uses\s*:\s*["']?(?!\.\/|docker:\/\/)[^\s#]+@/.test(line)) resources.add("forgeapi");
          if ((!enabledModes || enabledModes.has("docker")) &&
            /^\s*(?:(?:container|image)\s*:\s*["']?[^\s#]+[:@]|(?:-\s*)?uses\s*:\s*["']?docker:\/\/)/.test(line)) {
            resources.add("dockerapi");
          }
        }
      }
    } catch {}
  }

  const origins = new Set<string>();
  for (const resource of resources) {
    let value = args[resource];
    if (resource === "registry" && typeof value !== "string") {
      try { value = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(readFileSync(join(dir, ".npmrc"), "utf8"))?.[1]; } catch {}
    } else if (resource === "goproxy" && typeof value !== "string") {
      value = process.env.GOPROXY;
    }
    let origin = typeof value === "string" && value ? value : defaults[resource as keyof typeof defaults];
    if (resource === "goproxy") {
      origin = origin.split(/[|,]/, 1)[0].trim();
      if (origin === "off" || origin === "direct") continue;
    }
    try { origins.add(`${new URL(origin).origin}/`); } catch {}
  }
  return Array.from(origins);
}
