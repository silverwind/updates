#!/usr/bin/env node
import {argv, cwd, stdout, stderr, exit, platform, versions} from "node:process";
import {stripVTControlCharacters, styleText, parseArgs} from "node:util";
import {dirname, isAbsolute, resolve} from "node:path";
import {statSync} from "node:fs";
import {updates} from "./api.ts";
import {options, parseMixedArg, getOptionKey, parseArgList, parsePinArg, loadConfig} from "./config.ts";
import {packageVersion, fetchTimeout} from "./modes/shared.ts";
import {highlightDiff, textTable} from "./utils/utils.ts";
import {shortenGoModule} from "./modes/go.ts";
import {prewarmOrigins} from "./utils/prewarm.ts";
import type {Arg} from "./config.ts";
import type {Output, UpdatesOptions} from "./api.ts";

for (const url of prewarmOrigins(cwd(), argv.slice(2))) fetch(url, {method: "HEAD"}).catch(() => {});

const result = parseArgs({
  strict: false,
  allowPositionals: true,
  tokens: true,
  options,
});

// fix parseArgs defect parsing "-a -b" as {a: "-b"} when a is string
const values = result.values as Record<string, Arg>;
for (const [index, token] of result.tokens.entries()) {
  if (token.kind === "option" && token.value?.startsWith("-")) {
    const key = getOptionKey(token.value.substring(1));
    const next = result.tokens[index + 1];
    values[token.name] = [true];
    const list = (values[key] ??= []) as Array<string | boolean>;
    list.push(next?.kind === "positional" && next.value ? next.value : true);
  }
}

const args = result.values;
const positionals = result.positionals;

function cliPatternToRegex(pattern: string): string | RegExp {
  return /^\/.+\/$/.test(pattern) ? new RegExp(pattern.slice(1, -1)) : pattern;
}

function argToConfigMixed(arg: Arg): boolean | Array<string | RegExp> | undefined {
  const parsed = parseMixedArg(arg);
  if (parsed === false) return undefined;
  if (parsed === true) return true;
  return Array.from(parsed).map(cliPatternToRegex);
}

let red: (text: string | number) => string = String;
let green: (text: string | number) => string = String;

function resolveColor(fileConfig: UpdatesOptions): boolean {
  if (args["no-color"] === true) return false;
  if (args.color === true) return true;
  if (fileConfig.noColor === true) return false;
  if (fileConfig.color === true) return true;
  return Boolean(stdout.isTTY);
}

async function end(err?: Error | void, exitCode?: number): Promise<void> {
  if (err) {
    const error = err.message ?? String(err);
    if (args.json) {
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
    -M, --modes <mode,...>             Which modes to enable. Default: npm,pypi,go,cargo,actions,docker
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
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
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
`);
    await end();
  }

  if (args.version) {
    console.info(packageVersion);
    await end();
  }

  const fileSet = parseMixedArg(args.file);
  const filesList = [...(fileSet instanceof Set ? fileSet : []), ...positionals];

  let startDir = cwd();
  if (filesList.length) {
    const first = filesList[0];
    const abs = isAbsolute(first) ? first : resolve(cwd(), first);
    try {
      startDir = statSync(abs).isDirectory() ? abs : dirname(abs);
    } catch {
      startDir = dirname(abs);
    }
  }

  const fileConfig = await loadConfig(startDir);
  const useColor = resolveColor(fileConfig);
  if (useColor) {
    red = (text: string | number) => styleText("red", String(text));
    green = (text: string | number) => styleText("green", String(text));
  }

  const config: UpdatesOptions = {...fileConfig};
  // pin is resolved per-file in api.ts (walking up from each dep's file dir).
  // Only CLI/API-set pin acts as a global override.
  config.pin = undefined;
  if (args.json) config.json = true;
  if (args.verbose) config.verbose = true;
  if (args["no-cache"]) config.noCache = true;
  if (args.update) config.update = true;
  if (args.indirect) config.indirect = true;
  if (args["error-on-outdated"]) config.errorOnOutdated = true;
  if (args["error-on-unchanged"]) config.errorOnUnchanged = true;
  if (typeof args.timeout === "string") config.timeout = Number(args.timeout) || undefined;
  if (typeof args.sockets === "string") config.sockets = Number(args.sockets) || undefined;
  if (typeof args.registry === "string") config.registry = args.registry;
  if (typeof args.cooldown === "string") config.cooldown = Number(args.cooldown) || args.cooldown;

  const cliInclude = parseArgList(args.include).map(cliPatternToRegex);
  const cliExclude = parseArgList(args.exclude).map(cliPatternToRegex);
  if (cliInclude.length) config.include = cliInclude;
  if (cliExclude.length) config.exclude = cliExclude;

  const cliTypes = Array.isArray(args.types) ? args.types.filter((v): v is string => typeof v === "string") : [];
  if (cliTypes.length) config.types = cliTypes;

  const cliPin = parsePinArg(args.pin);
  if (Object.keys(cliPin).length) config.pin = cliPin;

  const cliModes = parseMixedArg(args.modes);
  if (cliModes instanceof Set) config.modes = Array.from(cliModes);

  for (const key of ["greatest", "prerelease", "release", "patch", "minor"] as const) {
    const val = argToConfigMixed(args[key]);
    if (val !== undefined) config[key] = val;
  }
  const allowDowngrade = argToConfigMixed(args["allow-downgrade"]);
  if (allowDowngrade !== undefined) config.allowDowngrade = allowDowngrade;

  if (filesList.length) config.files = filesList;

  for (const key of ["forgeapi", "pypiapi", "jsrapi", "goproxy", "cargoapi", "dockerapi"] as const) {
    if (typeof args[key] === "string") config[key] = args[key];
  }

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
      for (const mode of Object.keys(output.results)) {
        for (const type of Object.keys(output.results[mode])) {
          if (Object.keys(output.results[mode][type]).length) {
            console.info(green(`✨ ${mode} updated`));
            break;
          }
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
    for (const type of Object.keys(output.results[mode])) {
      for (const [name, data] of Object.entries(output.results[mode][type])) {
        const id = `${mode}|${name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const row = [];
        row.push(mode === "go" ? shortenGoModule(name) : name);
        if (hasMultipleModes) row.push(mode);
        row.push(highlightDiff(data.old, data.new, red));
        row.push(highlightDiff(data.new, data.old, green));
        row.push(data.age || "");
        row.push(data.info || "");
        arr.push(row);
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
