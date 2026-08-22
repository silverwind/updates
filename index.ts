#!/usr/bin/env node
import {argv, stdout, stderr, exit, platform, versions} from "node:process";
import {readFileSync, statSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {Output} from "./api.ts";

let red: (text: string | number) => string = String;
let green: (text: string | number) => string = String;
let jsonOutput = false;

const stringShortOptions = new Set("deflCpgPtmsTriM");

function hasFlag(args: Array<string>, long: string, short: string): boolean {
  if (args.includes(`--${long}`)) return true;
  for (const arg of args) {
    if (!/^-[^-]/.test(arg)) continue;
    const options = arg.slice(1);
    const index = options.indexOf(short);
    if (index !== -1 && Array.from(options.slice(0, index)).every(option => !stringShortOptions.has(option))) return true;
  }
  return false;
}

const valueOptions: Record<string, string> = {
  d: "allow-downgrade", e: "exclude", f: "file", l: "pin", C: "cooldown", p: "prerelease", R: "release",
  g: "greatest", t: "types", P: "patch", m: "minor", s: "sockets", T: "timeout", r: "registry", i: "include",
  M: "modes", forgeapi: "forgeapi", pypiapi: "pypiapi", jsrapi: "jsrapi", goproxy: "goproxy",
  cargoapi: "cargoapi", dockerapi: "dockerapi", file: "file", modes: "modes", registry: "registry",
};

async function startPrewarm(rawArgs: Array<string>): Promise<void> {
  const args: Record<string, unknown> = {};
  let firstPositional: string | undefined;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith("-")) {
      firstPositional ??= arg;
      continue;
    }
    const long = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    const short = /^-([A-Za-z])(.*)$/.exec(arg);
    const option = long ? valueOptions[long[1]] : short ? valueOptions[short[1]] : undefined;
    if (!option) continue;
    const inline = long ? long[2] : short?.[2];
    const value = inline || rawArgs[index + 1]?.startsWith("-") === false ? inline || rawArgs[++index] : undefined;
    if (value === undefined) continue;
    if (option === "file" || option === "modes") {
      ((args[option] ??= []) as Array<string>).push(...value.split(","));
    } else args[option] = value;
  }
  const first = (args.file as Array<string> | undefined)?.[0] ?? firstPositional;
  const firstPath = first ? resolve(first) : process.cwd();
  let startDir = first ? dirname(firstPath) : firstPath;
  try { if (statSync(firstPath).isDirectory()) startDir = firstPath; } catch {}

  let config: Record<string, unknown> = {};
  configSearch:
  for (let dir = startDir; ; dir = dirname(dir)) {
    for (const extension of ["js", "ts", "mjs", "mts"]) {
      const path = join(dir, `updates.config.${extension}`);
      try {
        if (!statSync(path).isFile()) continue;
        config = (await import(pathToFileURL(path).href)).default ?? {};
        break configSearch;
      } catch {}
    }
    if (dirname(dir) === dir) break;
  }
  config = {...config, ...args};
  const files = Array.isArray(config.file) ? config.file : config.files;
  const {prewarmOrigins} = await import("./utils/prewarm.ts");
  for (const origin of prewarmOrigins(startDir, {...config, files})) {
    (async () => { try { await fetch(origin, {method: "HEAD"}); } catch {} })();
  }
}

async function end(err?: Error | void, exitCode?: number): Promise<void> {
  if (err) {
    const error = err.message ?? String(err);
    if (jsonOutput) {
      console.info(JSON.stringify({error}));
    } else {
      console.info(red(error));
    }
  }

  if (platform === "win32" && Number(versions.node.split(".")[0]) >= 23) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  exit(exitCode ?? (err ? 1 : 0));
}

async function main(): Promise<void> {
  for (const stream of [stdout, stderr]) {
    (stream as any)?._handle?.setBlocking?.(true);
  }

  const rawArgs = argv.slice(2);
  jsonOutput = hasFlag(rawArgs, "json", "j");
  if (hasFlag(rawArgs, "help", "h")) {
    stdout.write(`usage: updates [options] [files...]

  Options:
    -u, --update                       Update versions and write dependency file
    -f, --file <path,...>              File or directory to use, defaults to current directory
    -M, --modes <mode,...>             Which modes to enable. Default: npm,pypi,go,cargo,actions,docker,make
    -i, --include <dep,...>            Include only given dependencies
    -e, --exclude <dep,...>            Exclude given dependencies
    -l, --pin <dep=range>              Pin dependency to given semver range
    -C, --cooldown <duration>          Minimum dependency age, e.g. 7 (days), 1w, 2d, 6h
    -p, --prerelease [<dep,...>]       Consider prereleases, implying --greatest
    -R, --release [<dep,...>]          Never consider prereleases
    -g, --greatest [<dep,...>]         Ignore the latest tag and take the greatest release
    -t, --types <type,...>             Dependency types to update
    -P, --patch [<dep,...>]            Consider only up to semver-patch
    -m, --minor [<dep,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<dep,...>]  Allow downgrading onto a lower latest tag
    -s, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: 50
    -T, --timeout <ms>                 Network request timeout in ms (go probes use half). Default: 5000
    -r, --registry <url>               Override npm registry URL
    -I, --indirect                     Include indirect Go dependencies
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -j, --json                         Output a JSON object
    -x, --no-cache                     Disable HTTP cache
    -c, --color                        Force color output
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -C 7
    $ updates -M npm
    $ updates -e react,react-dom
    $ updates -f package.json
    $ updates -f pyproject.toml
    $ updates -f go.mod
    $ updates -f Cargo.toml
    $ updates -f .github
    $ updates -f Dockerfile
    $ updates -f docker-compose.yml
    $ updates -f Makefile
`);
    await end();
  }

  if (hasFlag(rawArgs, "version", "v")) {
    let packageJson: string;
    try { packageJson = readFileSync(new URL("package.json", import.meta.url), "utf8"); } catch {
      packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    }
    console.info(JSON.parse(packageJson).version);
    await end();
  }

  try { await startPrewarm(rawArgs); } catch {}
  const {parseCliArgs, resolveConfig} = await import("./cli.ts");
  const {args, positionals} = parseCliArgs();
  const config = await resolveConfig(args, positionals);
  const [{updates}, {highlightDiff, textTable}, {shortenGoModule}, {stripVTControlCharacters, styleText}] =
    await Promise.all([
      import("./api.ts"), import("./utils/utils.ts"), import("./modes/go.ts"), import("node:util"),
    ]);

  const useColor = !config.noColor && (config.color || stdout.isTTY);
  if (useColor) {
    // validateStream drops the codes when stdout is not a TTY, which is exactly what -c overrides.
    red = (text: string | number) => styleText("red", String(text), {validateStream: false});
    green = (text: string | number) => styleText("green", String(text), {validateStream: false});
  }
  jsonOutput = Boolean(config.json);

  const output = await updates(config);

  const hasResults = Object.keys(output.results).length > 0;
  const errors = output.errors ?? [];

  if (config.json) {
    console.info(JSON.stringify({
      ...(output.message && {message: output.message}),
      ...(hasResults && {results: output.results}),
      ...(errors.length && {errors}),
    }));
  } else if (output.message) {
    console.info(output.message);
  } else if (hasResults) {
    console.info(formatOutput(output, shortenGoModule, highlightDiff, textTable, stripVTControlCharacters));
  }

  if (config.update && !config.json) {
    for (const mode of Object.keys(output.results)) console.info(green(`✨ ${mode} updated`));
  }

  if (!config.json) {
    for (const {mode, name, error} of errors) console.info(red(`${mode} ${name}: ${error}`));
  }

  const exitCode = errors.length ? 1 : config.errorOnOutdated ? (hasResults ? 2 : 0) :
    config.errorOnUnchanged ? (hasResults ? 0 : 2) : 0;
  await end(undefined, exitCode);
}

function formatOutput(
  output: Output,
  shortenGoModule: (value: string) => string,
  highlightDiff: (left: string, right: string, colorFn: (text: string) => string) => string,
  textTable: (rows: Array<Array<string>>, lengthFn: (value: string) => number) => string,
  stripVTControlCharacters: (value: string) => string,
): string {
  const modes = Object.keys(output.results);
  const hasMultipleModes = modes.length > 1;

  const header = hasMultipleModes ?
    ["NAME", "MODE", "OLD", "NEW", "AGE", "INFO"] :
    ["NAME", "OLD", "NEW", "AGE", "INFO"];
  const arr = [header];
  const seen = new Set<string>();

  for (const mode of modes) {
    const rows = Object.values(output.results[mode]).flatMap(typeDeps => Object.entries(typeDeps));
    for (const [name, data] of rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const id = `${mode}|${name}|${data.old}|${data.new}`;
      if (seen.has(id)) continue;
      seen.add(id);
      arr.push([
        mode === "go" ? shortenGoModule(name) : name,
        ...(hasMultipleModes ? [mode] : []),
        highlightDiff(data.old, data.new, red),
        highlightDiff(data.new, data.old, green),
        data.age || "",
        data.info || "",
      ]);
    }
  }

  return textTable(arr, str => stripVTControlCharacters(str).length);
}

try {
  await main();
} catch (err) {
  await end(err as Error);
}
