import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cliConfigBaseDir} from "./api.ts";
import {cliBaseConfig, loadConfig} from "./config.ts";

test("the package API preserves cliConfigBaseDir", () => {
  expect(cliConfigBaseDir).toBe(cliBaseConfig);
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
    await expect(loadConfig(brokenDir)).rejects.toThrow(/broken primary/);
    expect(await readFile(marker, "utf8")).toBe("js\n");
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
