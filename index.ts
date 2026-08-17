#!/usr/bin/env node
import {stdout, stderr, exit, platform, versions} from "node:process";
import {stripVTControlCharacters, styleText} from "node:util";
import {updates} from "./api.ts";
import {parseCliArgs, resolveConfig, resolveFileArgs} from "./cli.ts";
import {packageVersion, fetchTimeout, maxSockets} from "./modes/shared.ts";
import {highlightDiff, textTable} from "./utils/utils.ts";
import {shortenGoModule} from "./modes/go.ts";
import {prewarmOrigins} from "./utils/prewarm.ts";
import type {Output} from "./api.ts";

const {args, positionals} = parseCliArgs();

if (!args.help && !args.version) {
  for (const url of prewarmOrigins(resolveFileArgs(args, positionals).startDir, args)) {
    (async () => { try { await fetch(url, {method: "HEAD"}); } catch {} })();
  }
}

let red: (text: string | number) => string = String;
let green: (text: string | number) => string = String;
// Seeded from the flag so an error raised before the config loads still honours -j, then widened
// to the effective setting below, so the config file's `json` reaches the error path too.
let jsonOutput = Boolean(args.json);

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

  if (args.help) {
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
    -s, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
    -T, --timeout <ms>                 Network request timeout in ms (go probes use half). Default: ${fetchTimeout}
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

  if (args.version) {
    console.info(packageVersion);
    await end();
  }

  const config = await resolveConfig(args, positionals);

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
    console.info(formatOutput(output));
  }

  if (config.update && hasResults && !config.json) {
    for (const [mode, modeResults] of Object.entries(output.results)) {
      if (Object.values(modeResults).some(deps => Object.keys(deps).length)) {
        console.info(green(`✨ ${mode} updated`));
      }
    }
  }

  if (!config.json) {
    for (const {mode, name, error} of errors) console.info(red(`${mode} ${name}: ${error}`));
  }

  // A run that could not look everything up is neither outdated nor up to date, so -E/-U yield to it.
  if (errors.length) {
    await end(undefined, 1);
  } else if (config.errorOnOutdated) {
    await end(undefined, hasResults ? 2 : 0);
  } else if (config.errorOnUnchanged) {
    await end(undefined, hasResults ? 0 : 2);
  } else {
    await end();
  }
}

const ansiLen = (str: string): number => stripVTControlCharacters(str).length;

function formatOutput(output: Output): string {
  const modes = Object.keys(output.results);
  const hasMultipleModes = modes.length > 1;

  const header = hasMultipleModes ?
    ["NAME", "MODE", "OLD", "NEW", "AGE", "INFO"] :
    ["NAME", "OLD", "NEW", "AGE", "INFO"];
  const arr = [header];
  const seen = new Set<string>();

  for (const mode of modes) {
    // Rows sort across the whole mode, where the JSON keeps its dep-type sections to sort within.
    const rows = Object.values(output.results[mode]).flatMap(typeDeps => Object.entries(typeDeps));
    for (const [name, data] of rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      // Key on the visible columns (incl. versions) so the same dep at
      // different versions across dep-sections/workspace members keeps a row
      // each; only truly identical rows collapse.
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

  return textTable(arr, ansiLen);
}

try {
  await main();
} catch (err) {
  await end(err as Error);
}
