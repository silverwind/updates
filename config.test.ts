import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cliConfigBaseDir} from "./api.ts";
import {cliBaseConfig, loadConfig, parsePinArg} from "./config.ts";
import {rejection} from "./utils/testing.ts";

test("the package API preserves cliConfigBaseDir", () => {
  expect(cliConfigBaseDir).toBe(cliBaseConfig);
});

test("parses and validates __proto__ pins while preserving the result prototype", () => {
  const pin = parsePinArg(["react=^1", "__proto__=^1", "__proto__=^2"]);
  expect(pin).toStrictEqual({react: "^1", ["__proto__"]: "^2"});
  expect(Object.getPrototypeOf(pin)).toBe(Object.prototype);
  expect(() => parsePinArg(["__proto__=invalid"])).toThrow("Invalid pin range for __proto__: invalid");
});

test("keeps Renovate pins named after prototype properties unless locally overridden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "updates-config-"));
  try {
    await writeFile(join(dir, "updates.config.mjs"), 'export default {pin: {toString: "^2", react: "^2"}};\n');
    await writeFile(join(dir, "renovate.json"), JSON.stringify({packageRules: [{
      matchPackageNames: ["constructor", "toString", "hasOwnProperty", "valueOf", "react", "vue"], allowedVersions: "^1",
    }]}));
    const config = await loadConfig(dir);
    expect(config.pin).toEqual({constructor: "^1", toString: "^2", hasOwnProperty: "^1", valueOf: "^1", react: "^2", vue: "^1"});
    expect(config.pinNoDowngrade).toEqual(["constructor", "hasOwnProperty", "valueOf", "vue"]);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("config discovery starts at the target and loads only the highest-priority module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "updates-config-"));
  const discoveryDir = join(dir, "discovery");
  const child = join(discoveryDir, "child");
  const priorityDir = join(dir, "priority");
  try {
    await mkdir(child, {recursive: true});
    await mkdir(priorityDir);
    await writeFile(join(discoveryDir, "updates.config.js"), "module.exports = {};\n");
    await writeFile(join(child, "renovate.json"), JSON.stringify({ignoreDeps: ["child-only"]}));
    const [excluded] = (await loadConfig(child)).exclude!;
    expect(excluded).toBeInstanceOf(RegExp);
    expect((excluded as RegExp).test("child-only")).toBe(true);

    const marker = join(priorityDir, "loaded");
    await writeFile(join(priorityDir, "updates.config.js"),
      `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "js\\n"); module.exports = {exclude: ["js"]};\n`);
    await writeFile(join(priorityDir, "updates.config.mjs"),
      `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "mjs\\n"); export default {exclude: ["mjs"]};\n`);
    expect((await loadConfig(priorityDir)).exclude).toEqual(["js"]);
    expect(await readFile(marker, "utf8")).toBe("js\n");

    const brokenDir = join(priorityDir, "broken");
    await mkdir(brokenDir);
    await writeFile(join(brokenDir, "updates.config.js"), "throw new Error('broken primary');\n");
    await writeFile(join(brokenDir, "updates.config.mjs"),
      `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "broken-mjs\\n"); export default {};\n`);
    expect((await rejection(loadConfig(brokenDir)))?.message).toMatch(/broken primary/);
    expect(await readFile(marker, "utf8")).toBe("js\n");
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
