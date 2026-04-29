import {test, expect, afterAll} from "vitest";
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prewarmOrigins} from "./prewarm.ts";

const created: Array<string> = [];

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), {recursive: true});
    writeFileSync(full, content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, {recursive: true, force: true});
});

test("empty dir returns no origins", () => {
  expect(prewarmOrigins(makeDir(), [])).toEqual([]);
});

test("--help short-circuits regardless of files", () => {
  const dir = makeDir({"package.json": "{}", "Cargo.toml": ""});
  expect(prewarmOrigins(dir, ["--help"])).toEqual([]);
  expect(prewarmOrigins(dir, ["-h"])).toEqual([]);
  expect(prewarmOrigins(dir, ["--version"])).toEqual([]);
  expect(prewarmOrigins(dir, ["-v"])).toEqual([]);
  expect(prewarmOrigins(dir, ["foo", "--help", "bar"])).toEqual([]);
});

test("package.json triggers npm + jsr + github", () => {
  const origins = prewarmOrigins(makeDir({"package.json": "{}"}), []);
  expect(origins).toEqual(expect.arrayContaining([
    "https://registry.npmjs.org/",
    "https://jsr.io/",
    "https://api.github.com/",
  ]));
  expect(origins).toHaveLength(3);
});

test("pnpm-workspace.yaml triggers same set as package.json", () => {
  const origins = prewarmOrigins(makeDir({"pnpm-workspace.yaml": ""}), []);
  expect(origins).toEqual(expect.arrayContaining([
    "https://registry.npmjs.org/",
    "https://jsr.io/",
    "https://api.github.com/",
  ]));
});

test("pyproject.toml triggers pypi", () => {
  expect(prewarmOrigins(makeDir({"pyproject.toml": ""}), [])).toEqual(["https://pypi.org/"]);
});

test("Cargo.toml triggers crates.io", () => {
  expect(prewarmOrigins(makeDir({"Cargo.toml": ""}), [])).toEqual(["https://crates.io/"]);
});

test("go.mod triggers proxy.golang.org", () => {
  expect(prewarmOrigins(makeDir({"go.mod": ""}), [])).toEqual(["https://proxy.golang.org/"]);
});

test("go.work triggers proxy.golang.org", () => {
  expect(prewarmOrigins(makeDir({"go.work": ""}), [])).toEqual(["https://proxy.golang.org/"]);
});

test("Dockerfile triggers hub.docker.com", () => {
  expect(prewarmOrigins(makeDir({"Dockerfile": ""}), [])).toEqual(["https://hub.docker.com/"]);
});

test("docker-compose.yml triggers hub.docker.com", () => {
  expect(prewarmOrigins(makeDir({"docker-compose.yml": ""}), [])).toEqual(["https://hub.docker.com/"]);
});

test(".github/workflows dir triggers github + hub.docker.com", () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  mkdirSync(join(dir, ".github", "workflows"), {recursive: true});
  expect(prewarmOrigins(dir, [])).toEqual(expect.arrayContaining([
    "https://api.github.com/",
    "https://hub.docker.com/",
  ]));
});

test("multi-mode project: package.json + Cargo.toml dedupes correctly", () => {
  const origins = prewarmOrigins(makeDir({"package.json": "{}", "Cargo.toml": ""}), []);
  expect(origins).toEqual(expect.arrayContaining([
    "https://registry.npmjs.org/",
    "https://jsr.io/",
    "https://api.github.com/",
    "https://crates.io/",
  ]));
  expect(origins).toHaveLength(4);
});

test("github overlap is deduplicated when both package.json and .github/workflows present", () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-prewarm-"));
  created.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  mkdirSync(join(dir, ".github", "workflows"), {recursive: true});
  const origins = prewarmOrigins(dir, []);
  expect(origins.filter(origin => origin === "https://api.github.com/")).toHaveLength(1);
});
