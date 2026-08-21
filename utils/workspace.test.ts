import {join, relative} from "node:path";
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {
  baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, pnpmCatalogEntries, updatePnpmWorkspace,
  parsePnpmRegistryConfig,
} from "./workspace.ts";
import {fieldSep} from "../modes/shared.ts";

const created: Array<string> = [];
const makeWorkspace = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), {recursive: true});
    writeFileSync(full, content);
  }
  return dir;
};

afterAll(() => { for (const dir of created) rmSync(dir, {recursive: true, force: true}); });

test("baseType", () => {
  expect(["dependencies", "dependencies|./app", "dev-dependencies|./crate-a", "workspace.dependencies", "deps|./lib"]
    .map(baseType)).toEqual(["dependencies", "dependencies", "dev-dependencies", "workspace.dependencies", "deps"]);
});

test("filterDepsForMember", () => {
  const allDeps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0", new: "1.1"},
    [`dependencies|./app${fieldSep}tokio`]: {old: "1.0", new: "1.35"},
    [`workspace.dependencies${fieldSep}serde_json`]: {old: "1.0", new: "1.1"},
    [`dev-dependencies|./app${fieldSep}rand`]: {old: "0.8", new: "0.9"},
  };
  expect(filterDepsForMember(allDeps, ".")).toEqual({
    [`dependencies${fieldSep}serde`]: allDeps[`dependencies${fieldSep}serde`],
    [`workspace.dependencies${fieldSep}serde_json`]: allDeps[`workspace.dependencies${fieldSep}serde_json`],
  });
  expect(filterDepsForMember(allDeps, "./app")).toEqual({
    [`dependencies${fieldSep}tokio`]: allDeps[`dependencies|./app${fieldSep}tokio`],
    [`dev-dependencies${fieldSep}rand`]: allDeps[`dev-dependencies|./app${fieldSep}rand`],
  });
});

test("resolveWorkspaceMembers resolves literals, globs and exclusions", async () => {
  const literalDir = makeWorkspace({
    "crate-a/Cargo.toml": "[package]\nname = \"a\"",
    "crate-b/Cargo.toml": "[package]\nname = \"b\"",
  });
  const literalMembers = await resolveWorkspaceMembers(["crate-a", "crate-b"], literalDir, "Cargo.toml");
  expect(literalMembers.map(({memberPath}) => memberPath)).toEqual(["./crate-a", "./crate-b"]);
  expect(literalMembers[0].content).toContain("name = \"a\"");

  const globDir = makeWorkspace({
    "packages/foo/package.json": "{\"name\": \"foo\"}",
    "packages/bar/package.json": "{\"name\": \"bar\"}",
    "packages/README.md": "workspace notes",
  });
  const memberPaths = async (patterns: Array<string>) =>
    (await resolveWorkspaceMembers(patterns, globDir, "package.json")).map(({memberPath}) => memberPath).sort();
  expect(await memberPaths(["packages/*"])).toEqual(["./packages/bar", "./packages/foo"]);
  mkdirSync(join(globDir, "packages/internal"));
  writeFileSync(join(globDir, "packages/internal/package.json"), "{\"name\": \"internal\"}");
  expect(await memberPaths(["packages/*", "!packages/internal"])).toEqual(["./packages/bar", "./packages/foo"]);
});

test("resolveWorkspaceMembers skips missing", async () => {
  const dir = makeWorkspace();
  expect(await resolveWorkspaceMembers(["nonexistent"], dir, "Cargo.toml")).toEqual([]);
  mkdirSync(join(dir, "member"));
  await expect(resolveWorkspaceMembers(["member"], dir, ".")).rejects.toMatchObject({code: "EISDIR"});
});

test("resolveWorkspaceMembers rejects traversal and escaping symlinks", async () => {
  const dir = makeWorkspace();
  const outside = makeWorkspace({"package.json": "{\"name\": \"outside\"}"});
  symlinkSync(outside, join(dir, "linked"), "dir");
  mkdirSync(join(dir, "manifest-link"));
  symlinkSync(join(outside, "package.json"), join(dir, "manifest-link", "package.json"));
  expect(await resolveWorkspaceMembers([relative(dir, outside), "linked", "manifest-link"], dir, "package.json")).toEqual([]);
});

test("parsePnpmWorkspace", () => {
  expect(parsePnpmWorkspace("packages:\n  - \"packages/*\"\n  - 'apps/*'\n")).toEqual(["packages/*", "apps/*"]);
  expect(parsePnpmWorkspace("packages:\n  - packages/*\n")).toEqual(["packages/*"]);
  expect(parsePnpmWorkspace("packages: [packages/*, apps/*]\n")).toEqual(["packages/*", "apps/*"]);
  expect(parsePnpmWorkspace('packages:\n  - "packages/with space"\n')).toEqual(["packages/with space"]);
  expect(parsePnpmWorkspace("")).toEqual([]);
  expect(parsePnpmWorkspace("packages:\n  # comment\n  - libs/*\nnodeLinker: hoisted\n")).toEqual(["libs/*"]);
});

test("parse pnpm registry config", () => {
  expect(parsePnpmRegistryConfig("registry: https://pnpm.test\nregistries: {'@foo': https://foo.pnpm.test, default: https://default.pnpm.test}\n")).toEqual({
    registry: "https://pnpm.test",
    registries: {"@foo": "https://foo.pnpm.test", default: "https://default.pnpm.test"},
  });
});

const catalogYaml = `packages:
  - "packages/*"

catalog:
  react: ^18.0.0
  'prismjs': "^1.0.0"  # pinned

catalogs:
  tools:
    typescript: ^4.9.5
  legacy:
    react: ^17.0.0
`;

test("pnpmCatalogEntries", () => {
  expect(Array.from(pnpmCatalogEntries(catalogYaml), ({type, name, value}) => [type, name, value])).toEqual([
    ["catalog", "react", "^18.0.0"],
    ["catalog", "prismjs", "^1.0.0"],
    ["catalogs.tools", "typescript", "^4.9.5"],
    ["catalogs.legacy", "react", "^17.0.0"],
  ]);
  expect(Array.from(pnpmCatalogEntries("packages:\n  - \"packages/*\"\n"))).toEqual([]);
  expect(Array.from(pnpmCatalogEntries("catalog: {react: ^18, vue: '~3'}\n"), ({type, name, value}) => [type, name, value])).toEqual([
    ["catalog", "react", "^18"],
    ["catalog", "vue", "~3"],
  ]);
  expect(Array.from(pnpmCatalogEntries("catalogs: {web: {react: ^18}}\n"), ({type, name, value}) => [type, name, value])).toEqual([
    ["catalogs.web", "react", "^18"],
  ]);
});

test("updatePnpmWorkspace", () => {
  const updated = updatePnpmWorkspace(catalogYaml, {
    [`catalog${fieldSep}react`]: {old: "^18.0.0", new: "^19.1.0"},
    [`catalog${fieldSep}prismjs`]: {old: "^1.0.0", new: "^1.30.0"},
    [`catalogs.tools${fieldSep}typescript`]: {old: "^4.9.5", new: "^5.9.2"},
    [`catalogs.legacy${fieldSep}react`]: {old: "^16.0.0", new: "^19.1.0"},
  });
  expect(updated).toContain("  react: ^19.1.0\n");
  expect(updated).toContain("  'prismjs': \"^1.30.0\"  # pinned\n");
  expect(updated).toContain("    typescript: ^5.9.2\n");
  expect(updated).toContain("    react: ^17.0.0\n");
  expect(updatePnpmWorkspace(catalogYaml, {})).toBe(catalogYaml);
  expect(updatePnpmWorkspace("catalog: {react: ^18, vue: ~3}\n", {
    [`catalog${fieldSep}react`]: {old: "^18", new: "^19.1.0"},
    [`catalog${fieldSep}vue`]: {old: "~3", new: "~4.2"},
  })).toBe("catalog: {react: ^19.1.0, vue: ~4.2}\n");
});
