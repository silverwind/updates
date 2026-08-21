import {test, expect, afterAll, beforeAll} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prewarmOrigins} from "./prewarm.ts";
import {forgeDirs, modeByFileName} from "./utils.ts";

const created: Array<string> = [];
const npmOrigins = ["https://registry.npmjs.org/"];
const sampleContent = (path: string, content: string) => {
  if (content && content !== "{}") return content;
  if (path.endsWith("package.json")) return JSON.stringify({dependencies: {react: "18.0.0"}});
  if (path.endsWith("pnpm-workspace.yaml")) return "catalog:\n  react: 18.0.0\n";
  if (path.endsWith("pyproject.toml")) return 'dependencies = [\n  "requests>=2",\n]\n';
  if (path.endsWith("Cargo.toml")) return '[dependencies]\nserde = "1"\n';
  if (path.endsWith("go.mod") || path.endsWith("go.work")) return "require example.com/pkg v1.0.0\n";
  if (path.includes("Dockerfile") || /compose|docker-stack/.test(path)) return "FROM node:22\n";
  if (/Makefile|makefile|GNUmakefile|\.mk$/.test(path)) return "go install example.com/tool@v1.0.0\ndocker image node:22\n";
  if (/\.ya?ml$/.test(path)) return "uses: actions/checkout@v4\ncontainer: node:22\n";
  return content;
};

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), {recursive: true});
    writeFileSync(full, sampleContent(path, content));
  }
  return dir;
}

const origGoProxy = process.env.GOPROXY;
beforeAll(() => { delete process.env.GOPROXY; });

afterAll(() => {
  for (const dir of created) rmSync(dir, {recursive: true, force: true});
  if (origGoProxy === undefined) delete process.env.GOPROXY;
  else process.env.GOPROXY = origGoProxy;
});

test.each([...Object.keys(modeByFileName), "Dockerfile", "Makefile", "tools.mk"])("%s is prewarmed", (filename) => {
  expect(prewarmOrigins(makeDir({[filename]: ""}), {})).not.toEqual([]);
});

test("package.json prewarms only the registry its dependency uses", () => {
  expect(prewarmOrigins(makeDir(), {})).toEqual([]);
  const origins = prewarmOrigins(makeDir({"package.json": "{}"}), {});
  expect(origins).toEqual(npmOrigins);
  expect(prewarmOrigins(makeDir({"pnpm-workspace.yaml": ""}), {})).toEqual(expect.arrayContaining(npmOrigins));
  expect(prewarmOrigins(makeDir({"package.json": "{}"}), {modes: "docker"})).toEqual([]);
  expect(prewarmOrigins(makeDir({".github/workflows/ci.yml": ""}), {modes: "docker"})).toEqual(["https://hub.docker.com/"]);
  expect(prewarmOrigins(makeDir({".github/workflows/ci.yml": "steps:\n  - run: |\n      uses: docker://node:18\n"}), {})).toEqual([]);
});

test.each([
  ["pyproject.toml", "https://pypi.org/"],
  ["Cargo.toml", "https://crates.io/"],
  ["go.mod", "https://proxy.golang.org/"],
  ["go.work", "https://proxy.golang.org/"],
  ["Dockerfile", "https://hub.docker.com/"],
])("%s triggers its registry", (filename, origin) => {
  expect(prewarmOrigins(makeDir({[filename]: ""}), {})).toEqual([origin]);
});

test("GOPROXY decides the go origin", () => {
  const dir = makeDir({"go.mod": ""});
  process.env.GOPROXY = "https://internal.proxy,https://proxy.golang.org,direct";
  expect(prewarmOrigins(dir, {})).toEqual(["https://internal.proxy/"]);
  for (const value of ["off", "direct", "off,https://backup.proxy"]) {
    process.env.GOPROXY = value;
    expect(prewarmOrigins(dir, {})).toEqual([]);
  }
  process.env.GOPROXY = "https://internal.proxy";
  expect(prewarmOrigins(dir, {goproxy: "http://127.0.0.1:2/"})).toEqual(["http://127.0.0.1:2/"]);
  delete process.env.GOPROXY;
});

test.each(["docker-compose.yml", "compose.yaml", "compose.prod.yaml", "docker-stack.yml", "Dockerfile.dev"])(
  "%s triggers hub.docker.com", (filename) => {
    expect(prewarmOrigins(makeDir({[filename]: ""}), {})).toEqual(["https://hub.docker.com/"]);
  });

test.each(["Makefile", "makefile", "GNUmakefile", "tools.mk"])("%s triggers proxy.golang.org + hub.docker.com", (filename) => {
  expect(prewarmOrigins(makeDir({[filename]: ""}), {})).toEqual(expect.arrayContaining([
    "https://proxy.golang.org/",
    "https://hub.docker.com/",
  ]));
});

test.each(forgeDirs)("%s/workflows dir triggers github + hub.docker.com", (forgeDir) => {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  mkdirSync(join(dir, forgeDir, "workflows"), {recursive: true});
  writeFileSync(join(dir, forgeDir, "workflows", "ci.yml"), sampleContent("ci.yml", ""));
  expect(prewarmOrigins(dir, {})).toEqual(expect.arrayContaining([
    "https://api.github.com/",
    "https://hub.docker.com/",
  ]));
});

test("API override args redirect origins", () => {
  const origins = prewarmOrigins(makeDir({"package.json": JSON.stringify({dependencies: {
    registry: "1.0.0", jsr: "jsr:@std/path@1.0.0", forge: "github:user/repo",
  }})}), {
    registry: "http://127.0.0.1:1234/",
    jsrapi: "http://127.0.0.1:2345",
    forgeapi: "http://127.0.0.1:3456/sub/path",
  });
  expect(origins).toEqual(expect.arrayContaining([
    "http://127.0.0.1:1234/",
    "http://127.0.0.1:2345/",
    "http://127.0.0.1:3456/",
  ]));
  expect(origins).toHaveLength(3);
});

test("registry args override .npmrc", () => {
  const dir = makeDir({"package.json": "{}", ".npmrc": "registry=http://127.0.0.1:1234/\nsave-exact=false"});
  expect(prewarmOrigins(dir, {})).toContain("http://127.0.0.1:1234/");
  expect(prewarmOrigins(dir, {registry: "http://127.0.0.1:5678/"})).toContain("http://127.0.0.1:5678/");
});

test("unparsable override skips the origin", () => {
  expect(prewarmOrigins(makeDir({"Cargo.toml": ""}), {cargoapi: "not a url"})).toEqual([]);
});

test("per-ecosystem overrides", () => {
  expect(prewarmOrigins(makeDir({"pyproject.toml": ""}), {pypiapi: "http://127.0.0.1:1/"})).toEqual(["http://127.0.0.1:1/"]);
  expect(prewarmOrigins(makeDir({"go.mod": ""}), {goproxy: "http://127.0.0.1:2/"})).toEqual(["http://127.0.0.1:2/"]);
  expect(prewarmOrigins(makeDir({"Dockerfile": ""}), {dockerapi: "http://127.0.0.1:3/"})).toEqual(["http://127.0.0.1:3/"]);
});

test("multi-mode project: package.json + Cargo.toml dedupes correctly", () => {
  const origins = prewarmOrigins(makeDir({"package.json": "{}", "Cargo.toml": ""}), {});
  expect(origins).toEqual(expect.arrayContaining([...npmOrigins, "https://crates.io/"]));
  expect(origins).toHaveLength(2);
});

test("local npm dependencies do not prewarm a registry", () => {
  expect(prewarmOrigins(makeDir({"package.json": JSON.stringify({dependencies: {
    file: "file:../file", link: "link:../link",
  }})}), {})).toEqual([]);
});

test("github overlap is deduplicated when both package.json and .github/workflows present", () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({dependencies: {repo: "github:user/repo"}}));
  mkdirSync(join(dir, ".github", "workflows"), {recursive: true});
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "uses: actions/checkout@v4\n");
  const origins = prewarmOrigins(dir, {});
  expect(origins.filter(origin => origin === "https://api.github.com/")).toHaveLength(1);
});
