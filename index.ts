#!/usr/bin/env node
import {stdout, stderr, exit, platform, versions} from "node:process";
import {stripVTControlCharacters, styleText} from "node:util";
import {updates} from "./api.ts";
import {parseCliArgs, resolveConfig, deriveStartDir} from "./cli.ts";
import {parseMixedArg} from "./config.ts";
import {packageVersion, fetchTimeout} from "./modes/shared.ts";
import {highlightDiff, textTable} from "./utils/utils.ts";
import {shortenGoModule} from "./modes/go.ts";
import {prewarmOrigins} from "./utils/prewarm.ts";
import type {Output, UpdatesOptions} from "./api.ts";

const {args, positionals} = parseCliArgs();

const fileSet = parseMixedArg(args.file);
const filesList = [...(fileSet instanceof Set ? fileSet : []), ...positionals];
const startDir = deriveStartDir(filesList[0]);

if (!args.help && !args.version) {
  for (const url of prewarmOrigins(startDir, args)) {
    (async () => { try { await fetch(url, {method: "HEAD"}); } catch {} })();
  }
}

let red: (text: string | number) => string = String;
let green: (text: string | number) => string = String;
// Effective json setting (CLI flag or config file), so error output matches the
// success/message paths even when json comes from the config file rather than -j.
let jsonOutput = false;

function resolveColor(fileConfig: UpdatesOptions): boolean {
  if (args["no-color"] === true) return false;
  if (args.color === true) return true;
  if (fileConfig.noColor === true) return false;
  if (fileConfig.color === true) return true;
  return stdout.isTTY;
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

  if (platform === "win32" && Number(versions?.node?.split(".")[0]) >= 23) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  exit(exitCode ?? (err ? 1 : 0));
}

async function main(): Promise<void> {
  for (const stream of [stdout, stderr]) {
    (stream as any)?._handle?.setBlocking?.(true);
  }

  const maxSockets = 25;

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
    -p, --prerelease [<dep,...>]       Consider prerelease versions
    -R, --release [<dep,...>]          Only use release versions, may downgrade
    -g, --greatest [<dep,...>]         Prefer greatest over latest version
    -t, --types <type,...>             Dependency types to update
    -P, --patch [<dep,...>]            Consider only up to semver-patch
    -m, --minor [<dep,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<dep,...>]  Allow version downgrades when using latest version
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

  const useColor = resolveColor(config);
  if (useColor) {
    red = (text: string | number) => styleText("red", String(text));
    green = (text: string | number) => styleText("green", String(text));
  }
  jsonOutput = Boolean(config.json);

  const output = await updates(config);

  const hasResults = Object.keys(output.results).length > 0;

  if (output.message) {
    console.info(config.json ? JSON.stringify({message: output.message}) : output.message);
  } else if (hasResults) {
    if (config.json) {
      console.info(JSON.stringify({results: output.results}));
    } else {
      console.info(formatOutput(output));
    }

    if (config.update) {
      for (const [mode, modeResults] of Object.entries(output.results)) {
        if (Object.values(modeResults).some(deps => Object.keys(deps).length)) {
          console.info(green(`✨ ${mode} updated`));
        }
      }
    }
  }

  if (config.errorOnOutdated) {
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
    for (const typeDeps of Object.values(output.results[mode])) {
      for (const [name, data] of Object.entries(typeDeps)) {
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
  }

  return textTable(arr, ansiLen);
}

try {
  await main();
} catch (err) {
  await end(err as Error);
}
