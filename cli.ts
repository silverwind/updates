import {cwd, platform, versions} from "node:process";
import {parseArgs, stripVTControlCharacters, styleText} from "node:util";
import {dirname, join, resolve} from "node:path";
import {readFileSync, statSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {cliBaseConfig, options, optionalValueOptions, parseMixedArg, getOptionKey, parseArgList, parsePinArg,
  loadConfig} from "./config.ts";
import {highlightDiff, parsePositiveInt, textTable} from "./utils/utils.ts";
import {shortenGoModule} from "./modes/go.ts";
import type {Arg} from "./config.ts";
import type {Output, UpdatesOptions} from "./api.ts";

function cliPatternToRegex(pattern: string): string | RegExp {
  return /^\/.+\/$/.test(pattern) ? new RegExp(pattern.slice(1, -1)) : pattern;
}

function argToConfigMixed(arg: Arg): boolean | Array<string | RegExp> | undefined {
  const parsed = parseMixedArg(arg);
  if (parsed === false) return undefined;
  if (parsed === true) return true;
  return Array.from(parsed).map(cliPatternToRegex);
}

function deriveStartDir(first: string | undefined): string {
  if (!first) return cwd();
  const abs = resolve(first);
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch {}
  return isDir ? abs : dirname(abs);
}

function resolveFileArgs(args: Record<string, Arg>, positionals: Array<string>): {filesList: Array<string>, startDir: string} {
  const filesList = [...parseArgList(args.file), ...positionals];
  return {filesList, startDir: deriveStartDir(filesList[0])};
}

export function parseCliArgs(argv?: Array<string>): {args: Record<string, Arg>, positionals: Array<string>} {
  const result = parseArgs({
    strict: false,
    allowPositionals: true,
    tokens: true,
    options,
    ...(argv !== undefined && {args: argv}),
  });

  const values = Object.create(null) as Record<string, Arg>;
  const consumedPositionals = new Set<number>();
  const recordOptionValue = (key: string, value: string | boolean) => {
    if (options[key]?.multiple) {
      ((values[key] ??= []) as Array<string | boolean>).push(value);
    } else {
      values[key] = value;
    }
  };
  let positionalsSeen = 0;
  for (const [index, token] of result.tokens.entries()) {
    if (token.kind === "positional") positionalsSeen++;
    if (token.kind !== "option") continue;
    if (!getOptionKey(token.name)) throw new Error(`Unknown option: ${token.rawName}`);
    if (options[token.name]?.type === "string" && token.value === undefined && !optionalValueOptions.has(token.name)) {
      throw new Error(`Missing value for --${token.name}`);
    }
    if (token.inlineValue || !token.value?.startsWith("-")) {
      recordOptionValue(token.name, token.value ?? true);
      continue;
    }
    const longOption = token.value.startsWith("--");
    const next = result.tokens[index + 1];
    const nextPositional = next?.kind === "positional" ? next.value : undefined;
    const recoveredOptions: Array<{key: string, value: string | boolean}> = [];
    const raw = token.value.substring(longOption ? 2 : 1);
    let consumesPositional = false;
    if (longOption) {
      const key = getOptionKey(raw);
      if (key) {
        consumesPositional = options[key].type === "string" && nextPositional !== undefined;
        recoveredOptions.push({key, value: consumesPositional ? nextPositional! : true});
      }
    } else {
      for (let offset = 0; offset < raw.length;) {
        const key = getOptionKey(raw[offset]);
        if (!key) { recoveredOptions.length = 0; break; }
        if (options[key].type === "boolean") {
          recoveredOptions.push({key, value: true});
          offset++;
        } else {
          const inlineValue = raw.substring(offset + 1);
          consumesPositional = !inlineValue && nextPositional !== undefined;
          recoveredOptions.push({
            key,
            value: inlineValue || (consumesPositional ? nextPositional! : true),
          });
          offset = raw.length;
        }
      }
    }
    if (!recoveredOptions.length) {
      recordOptionValue(token.name, token.value);
      continue;
    }
    if (!options[token.name]?.multiple) {
      values[token.name] = true;
    } else if (optionalValueOptions.has(token.name)) {
      recordOptionValue(token.name, true); // a bare occurrence still means "all"
    } else {
      values[token.name] ??= [];
    }
    if (consumesPositional) consumedPositionals.add(positionalsSeen);
    for (const {key, value} of recoveredOptions) recordOptionValue(key, value);
  }

  return {args: values, positionals: result.positionals.filter((_val, index) => !consumedPositionals.has(index))};
}

export async function resolveConfig(
  args: Record<string, Arg>,
  positionals: Array<string>,
): Promise<UpdatesOptions> {
  const {filesList, startDir} = resolveFileArgs(args, positionals);

  const fileConfig = await loadConfig(startDir);

  const cliConfig: Partial<UpdatesOptions> = {};
  if (args.json) cliConfig.json = true;
  if (args.verbose) cliConfig.verbose = true;
  if (args["no-cache"]) cliConfig.noCache = true;
  if (args.update) cliConfig.update = true;
  if (args.indirect) cliConfig.indirect = true;
  if (args["error-on-outdated"]) cliConfig.errorOnOutdated = true;
  if (args["error-on-unchanged"]) cliConfig.errorOnUnchanged = true;
  if (args.color) {cliConfig.color = true; cliConfig.noColor = false;}
  if (args["no-color"]) {cliConfig.color = false; cliConfig.noColor = true;}
  if (typeof args.timeout === "string") cliConfig.timeout = parsePositiveInt(args.timeout, "timeout");
  if (typeof args.sockets === "string") cliConfig.sockets = parsePositiveInt(args.sockets, "sockets");
  if (typeof args.registry === "string") cliConfig.registry = args.registry;
  if (typeof args.cooldown === "string") cliConfig.cooldown = args.cooldown;

  const cliInclude = parseArgList(args.include).map(cliPatternToRegex);
  const cliExclude = parseArgList(args.exclude).map(cliPatternToRegex);
  if (cliInclude.length) cliConfig.include = cliInclude;
  if (cliExclude.length) cliConfig.exclude = cliExclude;

  const cliTypes = parseArgList(args.types);
  if (cliTypes.length) cliConfig.types = cliTypes;

  const cliPin = parsePinArg(args.pin);
  if (Object.keys(cliPin).length) cliConfig.pin = cliPin;

  const cliModes = parseArgList(args.modes);
  if (cliModes.length) cliConfig.modes = cliModes;

  for (const key of ["greatest", "prerelease", "release", "patch", "minor"] as const) {
    const val = argToConfigMixed(args[key]);
    if (val !== undefined) cliConfig[key] = val;
  }
  const allowDowngrade = argToConfigMixed(args["allow-downgrade"]);
  if (allowDowngrade !== undefined) cliConfig.allowDowngrade = allowDowngrade;

  if (filesList.length) cliConfig.files = filesList;

  for (const key of ["forgeapi", "pypiapi", "jsrapi", "goproxy", "cargoapi", "dockerapi"] as const) {
    if (typeof args[key] === "string") cliConfig[key] = args[key];
  }

  const config: UpdatesOptions = {...fileConfig, pin: undefined, ...cliConfig};
  Object.defineProperty(config, cliBaseConfig, {value: {cliKeys: Object.keys(cliConfig)}});
  return config;
}

type CliIo = {
  stdout: (text: string) => void,
  stdoutIsTTY?: boolean,
  moduleUrl: string,
};

const valueOptions: Record<string, string> = {
  d: "allow-downgrade", e: "exclude", f: "file", l: "pin", C: "cooldown", p: "prerelease", R: "release",
  g: "greatest", t: "types", P: "patch", m: "minor", s: "sockets", T: "timeout", r: "registry", i: "include",
  M: "modes", forgeapi: "forgeapi", pypiapi: "pypiapi", jsrapi: "jsrapi", goproxy: "goproxy",
  cargoapi: "cargoapi", dockerapi: "dockerapi",
};
const stringShortOptions = new Set(Object.keys(valueOptions));
for (const long of Object.values(valueOptions)) valueOptions[long] = long;

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
    const inline = long ? long[2] : short![2];
    const value = inline || (rawArgs[index + 1]?.startsWith("-") === false ? rawArgs[++index] : undefined);
    if (value === undefined) continue;
    if (option === "file" || option === "modes") {
      ((args[option] ??= []) as Array<string>).push(...value.split(","));
    } else args[option] = value;
  }
  const first = (args.file as Array<string> | undefined)?.[0] ?? firstPositional;
  const firstPath = first ? resolve(first) : cwd();
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
    const method = origin.endsWith("/rate_limit") ? "GET" : "HEAD";
    (async () => { try { await (await fetch(origin, {method})).arrayBuffer(); } catch {} })();
  }
}

export async function runCli(
  rawArgs: Array<string>,
  io: CliIo,
  prewarm = true,
): Promise<number> {
  let red: (text: string | number) => string = String;
  let green: (text: string | number) => string = String;
  let jsonOutput = hasFlag(rawArgs, "json", "j");
  const writeLine = (text: string | number) => io.stdout(`${text}\n`);
  const end = async (err?: Error, exitCode?: number): Promise<number> => {
    if (err) {
      const error = err.message ?? String(err);
      writeLine(jsonOutput ? JSON.stringify({error}) : red(error));
    }

    if (platform === "win32" && Number(versions.node.split(".")[0]) >= 23) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return exitCode ?? (err ? 1 : 0);
  };

  try {
    if (hasFlag(rawArgs, "help", "h")) {
      io.stdout(`usage: updates [options] [files...]

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
      return await end();
    }

    if (hasFlag(rawArgs, "version", "v")) {
      let packageJson: string;
      try { packageJson = readFileSync(new URL("package.json", io.moduleUrl), "utf8"); } catch {
        packageJson = readFileSync(new URL("../package.json", io.moduleUrl), "utf8");
      }
      writeLine(JSON.parse(packageJson).version);
      return await end();
    }

    if (prewarm) {
      try { await startPrewarm(rawArgs); } catch {}
    }
    const {args, positionals} = parseCliArgs(rawArgs);
    const config = await resolveConfig(args, positionals);
    const {updates} = await import("./api.ts");

    const useColor = !config.noColor && (config.color || io.stdoutIsTTY);
    if (useColor) {
      red = (text: string | number) => styleText("red", String(text), {validateStream: false});
      green = (text: string | number) => styleText("green", String(text), {validateStream: false});
    }
    jsonOutput = Boolean(config.json);

    const output = await updates(config);
    const hasResults = Object.keys(output.results).length > 0;
    const errors = output.errors ?? [];

    if (config.json) {
      writeLine(JSON.stringify({
        ...(output.message && {message: output.message}),
        ...(hasResults && {results: output.results}),
        ...(errors.length && {errors}),
      }));
    } else if (output.message) {
      writeLine(output.message);
    } else if (hasResults) {
      writeLine(formatOutput(output, shortenGoModule, highlightDiff, textTable, stripVTControlCharacters, red, green));
    }

    if (config.update && !config.json) {
      for (const mode of Object.keys(output.results)) writeLine(green(`✨ ${mode} updated`));
    }

    if (!config.json) {
      for (const {mode, name, error} of errors) writeLine(red(`${mode} ${name}: ${error}`));
    }

    return await end(undefined, errors.length ? 1 : config.errorOnOutdated ? (hasResults ? 2 : 0) :
      config.errorOnUnchanged ? (hasResults ? 0 : 2) : 0);
  } catch (err) {
    return await end(err as Error);
  }
}

function formatOutput(
  output: Output,
  shortenGoModule: (value: string) => string,
  highlightDiff: (left: string, right: string, colorFn: (text: string) => string) => string,
  textTable: (rows: Array<Array<string>>, lengthFn: (value: string) => number) => string,
  stripVTControlCharacters: (value: string) => string,
  red: (text: string | number) => string,
  green: (text: string | number) => string,
): string {
  const modes = Object.keys(output.results);
  const hasMultipleModes = modes.length > 1;
  const header = hasMultipleModes ? ["NAME", "MODE", "OLD", "NEW", "AGE", "INFO"] : ["NAME", "OLD", "NEW", "AGE", "INFO"];
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
