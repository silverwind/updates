import {join} from "node:path";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, pnpmCatalogEntries, updatePnpmWorkspace} from "./workspace.ts";
import {fieldSep} from "../modes/shared.ts";

const globalExpect = expect;

test("baseType", ({expect = globalExpect}: any = {}) => {
  expect(baseType("dependencies")).toBe("dependencies");
  expect(baseType("dependencies|./app")).toBe("dependencies");
  expect(baseType("dev-dependencies|./crate-a")).toBe("dev-dependencies");
  expect(baseType("workspace.dependencies")).toBe("workspace.dependencies");
  expect(baseType("deps|./lib")).toBe("deps");
});

test("filterDepsForMember root", ({expect = globalExpect}: any = {}) => {
  const allDeps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0", new: "1.1"},
    [`dependencies|./app${fieldSep}tokio`]: {old: "1.0", new: "1.35"},
    [`workspace.dependencies${fieldSep}serde_json`]: {old: "1.0", new: "1.1"},
  };
  const result = filterDepsForMember(allDeps, ".");
  expect(Object.keys(result)).toHaveLength(2);
  expect(result[`dependencies${fieldSep}serde`]).toBeDefined();
  expect(result[`workspace.dependencies${fieldSep}serde_json`]).toBeDefined();
});

test("filterDepsForMember named member", ({expect = globalExpect}: any = {}) => {
  const allDeps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0", new: "1.1"},
    [`dependencies|./app${fieldSep}tokio`]: {old: "1.0", new: "1.35"},
    [`dev-dependencies|./app${fieldSep}rand`]: {old: "0.8", new: "0.9"},
  };
  const result = filterDepsForMember(allDeps, "./app");
  expect(Object.keys(result)).toHaveLength(2);
  expect(result[`dependencies${fieldSep}tokio`]).toBeDefined();
  expect(result[`dev-dependencies${fieldSep}rand`]).toBeDefined();
});

test("resolveWorkspaceMembers literal paths", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  mkdirSync(join(dir, "crate-a"), {recursive: true});
  mkdirSync(join(dir, "crate-b"), {recursive: true});
  writeFileSync(join(dir, "crate-a", "Cargo.toml"), "[package]\nname = \"a\"");
  writeFileSync(join(dir, "crate-b", "Cargo.toml"), "[package]\nname = \"b\"");

  const members = await resolveWorkspaceMembers(["crate-a", "crate-b"], dir, "Cargo.toml");
  expect(members).toHaveLength(2);
  expect(members[0].memberPath).toBe("./crate-a");
  expect(members[1].memberPath).toBe("./crate-b");
  expect(members[0].content).toContain("name = \"a\"");
});

test("resolveWorkspaceMembers glob patterns", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  mkdirSync(join(dir, "packages", "foo"), {recursive: true});
  mkdirSync(join(dir, "packages", "bar"), {recursive: true});
  writeFileSync(join(dir, "packages", "foo", "package.json"), "{\"name\": \"foo\"}");
  writeFileSync(join(dir, "packages", "bar", "package.json"), "{\"name\": \"bar\"}");

  const members = await resolveWorkspaceMembers(["packages/*"], dir, "package.json");
  expect(members).toHaveLength(2);
  const paths = members.map(m => m.memberPath).sort();
  expect(paths).toEqual(["./packages/bar", "./packages/foo"]);
});

test("resolveWorkspaceMembers excludes negated patterns", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  mkdirSync(join(dir, "packages", "foo"), {recursive: true});
  mkdirSync(join(dir, "packages", "bar"), {recursive: true});
  mkdirSync(join(dir, "packages", "internal"), {recursive: true});
  writeFileSync(join(dir, "packages", "foo", "package.json"), "{\"name\": \"foo\"}");
  writeFileSync(join(dir, "packages", "bar", "package.json"), "{\"name\": \"bar\"}");
  writeFileSync(join(dir, "packages", "internal", "package.json"), "{\"name\": \"internal\"}");

  const members = await resolveWorkspaceMembers(["packages/*", "!packages/internal"], dir, "package.json");
  const paths = members.map(m => m.memberPath).sort();
  expect(paths).toEqual(["./packages/bar", "./packages/foo"]);
});

test("resolveWorkspaceMembers skips missing", async ({expect = globalExpect}: any = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const members = await resolveWorkspaceMembers(["nonexistent"], dir, "Cargo.toml");
  expect(members).toHaveLength(0);
});

test("parsePnpmWorkspace", ({expect = globalExpect}: any = {}) => {
  expect(parsePnpmWorkspace("packages:\n  - \"packages/*\"\n  - 'apps/*'\n")).toEqual(["packages/*", "apps/*"]);
  expect(parsePnpmWorkspace("packages:\n  - packages/*\n")).toEqual(["packages/*"]);
  expect(parsePnpmWorkspace("")).toEqual([]);
  expect(parsePnpmWorkspace("packages:\n  # comment\n  - libs/*\nnodeLinker: hoisted\n")).toEqual(["libs/*"]);
});

const catalogYaml = [
  "packages:",
  "  - \"packages/*\"",
  "",
  "catalog:",
  "  react: ^18.0.0",
  "  'prismjs': \"^1.0.0\"  # pinned",
  "",
  "catalogs:",
  "  tools:",
  "    typescript: ^4.9.5",
  "  legacy:",
  "    react: ^17.0.0",
  "",
].join("\n");

test("pnpmCatalogEntries", ({expect = globalExpect}: any = {}) => {
  expect(Array.from(pnpmCatalogEntries(catalogYaml), ({type, name, value}) => [type, name, value])).toEqual([
    ["catalog", "react", "^18.0.0"],
    ["catalog", "prismjs", "^1.0.0"],
    ["catalogs.tools", "typescript", "^4.9.5"],
    ["catalogs.legacy", "react", "^17.0.0"],
  ]);
  expect(Array.from(pnpmCatalogEntries("packages:\n  - \"packages/*\"\n"))).toEqual([]);
});

test("updatePnpmWorkspace", ({expect = globalExpect}: any = {}) => {
  const updated = updatePnpmWorkspace(catalogYaml, {
    [`catalog${fieldSep}react`]: {old: "^18.0.0", new: "^19.1.0"},
    [`catalog${fieldSep}prismjs`]: {old: "^1.0.0", new: "^1.30.0"},
    [`catalogs.tools${fieldSep}typescript`]: {old: "^4.9.5", new: "^5.9.2"},
    // stale, the file no longer holds this value
    [`catalogs.legacy${fieldSep}react`]: {old: "^16.0.0", new: "^19.1.0"},
  });
  expect(updated).toContain("  react: ^19.1.0\n");
  expect(updated).toContain("  'prismjs': \"^1.30.0\"  # pinned\n");
  expect(updated).toContain("    typescript: ^5.9.2\n");
  expect(updated).toContain("    react: ^17.0.0\n");
  expect(updatePnpmWorkspace(catalogYaml, {})).toBe(catalogYaml);
});
