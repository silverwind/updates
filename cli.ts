import {cwd, exit, stderr, stdin} from "node:process";
import {parseArgs, stripVTControlCharacters, styleText} from "node:util";
import {dirname, resolve} from "node:path";
import {readFileSync, statSync} from "node:fs";
import {text} from "node:stream/consumers";
import type {Readable} from "node:stream";
import type {ReadStream} from "node:tty";
import {cliBaseConfig, options, optionalValueOptions, parseMixedArg, getOptionKey, parseArgList, parsePinArg,
  loadConfig, findConfigUp} from "./config.ts";
import {forgeHostOf, normalizeUrl, verifyToken} from "./modes/shared.ts";
import {removeToken, storeToken} from "./utils/tokens.ts";
import {highlightDiff, parsePositiveInt, splitGlobAlternatives, textTable} from "./utils/utils.ts";
import {shortenGoModule} from "./modes/go.ts";
import type {Arg} from "./config.ts";
import type {Output, UpdatesOptions} from "./api.ts";

function cliPatternToRegex(pattern: string): string | RegExp {
  return /^\/.+\/$/.test(pattern) ? new RegExp(pattern.slice(1, -1)) : pattern;
}

function camelCase(option: string): string {
  return option.replace(/-(.)/g, (_match, char: string) => char.toUpperCase());
}

function deriveStartDir(first: string | undefined): string {
  if (!first) return cwd();
  const abs = resolve(first);
  try { if (statSync(abs).isDirectory()) return abs; } catch {}
  return dirname(abs);
}

export function parseCliArgs(argv: Array<string>): {args: Record<string, Arg>, positionals: Array<string>} {
  const {tokens} = parseArgs({args: argv, strict: false, allowPositionals: true, tokens: true, options});
  const values = Object.create(null) as Record<string, Arg>;
  const consumedTokens = new Set<number>();
  const recordOptionValue = (key: string, value: string | boolean) => {
    if (options[key]?.multiple) ((values[key] ??= []) as Array<string | boolean>).push(value);
    else values[key] = value;
  };
  for (const [index, token] of tokens.entries()) {
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
    const next = tokens[index + 1];
    const nextPositional = next?.kind === "positional" ? next.value : undefined;
    const recoveredOptions: Array<{key: string, value: string | boolean}> = [];
    const raw = token.value.substring(longOption ? 2 : 1);
    let consumesPositional = false;
    for (const [offset, name] of (longOption ? [raw] : raw.split("")).entries()) {
      const key = getOptionKey(name);
      if (!key) { recoveredOptions.length = 0; break; }
      if (options[key].type === "boolean") { recoveredOptions.push({key, value: true}); continue; }
      const inlineValue = longOption ? "" : raw.substring(offset + 1);
      consumesPositional = !inlineValue && nextPositional !== undefined;
      recoveredOptions.push({key, value: inlineValue || !consumesPositional || nextPositional!});
      break;
    }
    if (!recoveredOptions.length) {
      recordOptionValue(token.name, token.value);
      continue;
    }
    if (!options[token.name]?.multiple || optionalValueOptions.has(token.name)) {
      recordOptionValue(token.name, true); // a bare occurrence still means "all"
    } else {
      values[token.name] ??= [];
    }
    if (consumesPositional) consumedTokens.add(index + 1);
    for (const {key, value} of recoveredOptions) recordOptionValue(key, value);
  }
  return {
    args: values,
    positionals: tokens.flatMap((token, index) => token.kind === "positional" && !consumedTokens.has(index) ? [token.value] : []),
  };
}

function argsToConfig(args: Record<string, Arg>, files: Array<string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const setNonEmpty = (key: string, list: Array<unknown>) => { if (list.length) config[key] = list; };
  for (const option of ["json", "verbose", "no-cache", "update", "indirect", "error-on-outdated", "error-on-unchanged"]) {
    if (args[option]) config[camelCase(option)] = true;
  }
  if (args.color) {config.color = true; config.noColor = false;}
  if (args["no-color"]) {config.color = false; config.noColor = true;}
  if (typeof args.timeout === "string") config.timeout = parsePositiveInt(args.timeout, "timeout");
  if (typeof args.sockets === "string") config.sockets = parsePositiveInt(args.sockets, "sockets");
  for (const key of ["registry", "cooldown", "forgeapi", "pypiapi", "jsrapi", "goproxy", "cargoapi", "dockerapi"]) {
    if (typeof args[key] === "string") config[key] = args[key];
  }
  for (const key of ["include", "exclude"]) setNonEmpty(key, parseArgList(args[key]).map(cliPatternToRegex));
  setNonEmpty("types", parseArgList(args.types));
  const pin = parsePinArg(args.pin);
  if (Object.keys(pin).length) config.pin = pin;
  setNonEmpty("modes", parseArgList(args.modes));
  for (const option of optionalValueOptions) {
    const parsed = parseMixedArg(args[option]);
    if (parsed !== false) config[camelCase(option)] = parsed === true || Array.from(parsed, cliPatternToRegex);
  }
  setNonEmpty("files", files);
  for (const option of ["include-paths", "exclude-paths"]) setNonEmpty(camelCase(option), parseArgList(args[option], splitGlobAlternatives));
  return config;
}

export async function resolveConfig(args: Record<string, Arg>, positionals: Array<string>): Promise<UpdatesOptions> {
  const files = [...parseArgList(args.file), ...positionals];
  const fileConfig = await loadConfig(deriveStartDir(files[0]));
  const cliConfig = argsToConfig(args, files);
  return Object.defineProperty({...fileConfig, pin: undefined, ...cliConfig}, cliBaseConfig, {value: {cliKeys: Object.keys(cliConfig)}});
}

type CliIo = {
  stdout: (text: string) => void,
  stdoutIsTTY?: boolean,
  stdin?: Readable,
  moduleUrl: string,
};

function hasFlag(args: Array<string>, long: string, short: string): boolean {
  return args.some(arg => arg === `--${long}` || /^-[^-]/.test(arg) && arg.includes(short) &&
    Array.from(arg.slice(1, arg.indexOf(short))).every(char => options[getOptionKey(char)]?.type !== "string"));
}

async function startPrewarm(args: Record<string, Arg>, positionals: Array<string>): Promise<void> {
  const files = parseArgList(args.file);
  const startDir = deriveStartDir(files[0] ?? positionals[0]);
  const fileConfig = await findConfigUp(startDir) ?? {};
  const {prewarmOrigins} = await import("./utils/prewarm.ts");
  for (const origin of prewarmOrigins(startDir, {...fileConfig, ...argsToConfig(args, files)})) {
    const method = origin.endsWith("/rate_limit") ? "GET" : "HEAD";
    (async () => { try { await (await fetch(origin, {method})).arrayBuffer(); } catch {} })();
  }
}

function normalizeHost(value: unknown, option: string): string {
  if (typeof value !== "string") throw new Error(`Missing value for --${option}`);
  return forgeHostOf(new URL(value.includes("://") ? value : `https://${value}`).host);
}

function readHidden(stdin: ReadStream, prompt: string): Promise<string> {
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stderr.write(prompt);
  return new Promise(resolve => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (!"\u0003\u0004\r\n".includes(char)) {
          value = char === "\b" || char === "\u007f" ? value.slice(0, -1) : value + char;
          continue;
        }
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write("\n");
        if (char === "\u0003" || char === "\u0004") exit(130);
        return resolve(value);
      }
    };
    stdin.on("data", onData);
  });
}

async function readToken(stdin: Readable | ReadStream, host: string): Promise<string> {
  const token = ("isTTY" in stdin && stdin.isTTY ? await readHidden(stdin, `token for ${host}: `) : await text(stdin)).trim();
  if (!token) throw new Error(`token for ${host} is empty`);
  if (/[\s\p{C}]/u.test(token)) throw new Error(`token for ${host} contains invalid characters`);
  return token;
}

export async function runCli(rawArgs: Array<string>, io: CliIo, prewarm = true): Promise<number> {
  let red: (text: string) => string = String;
  let green: typeof red = String;
  let jsonOutput = hasFlag(rawArgs, "json", "j");
  const writeLine = (text: string) => io.stdout(`${text}\n`);
  try {
    if (hasFlag(rawArgs, "help", "h")) {
      io.stdout(`usage: updates [options] [files...]

  Options:
    -u, --update                       Update versions and write dependency file
    -f, --file <path,...>              File or directory to use, defaults to current directory
    -N, --include-paths <glob,...>     Only use paths matching the globs
    -X, --exclude-paths <glob,...>     Skip paths matching the globs
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
    -L, --login <host>                 Verify and store a forge API token
    -O, --logout <host>                Remove a stored forge API token
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
      return 0;
    }

    if (hasFlag(rawArgs, "version", "v")) {
      let packageJson: string;
      try { packageJson = readFileSync(new URL("package.json", io.moduleUrl), "utf8"); } catch {
        packageJson = readFileSync(new URL("../package.json", io.moduleUrl), "utf8");
      }
      writeLine(JSON.parse(packageJson).version);
      return 0;
    }

    const {args, positionals} = parseCliArgs(rawArgs);
    if (args.login !== undefined) {
      const host = normalizeHost(args.login, "login");
      const token = await readToken(io.stdin ?? stdin, host);
      const login = await verifyToken(host, token, typeof args.forgeapi === "string" ? normalizeUrl(args.forgeapi) : undefined);
      await storeToken(host, token);
      writeLine(`stored token for ${host} (${login})`);
      return 0;
    }
    if (args.logout !== undefined) {
      const host = normalizeHost(args.logout, "logout");
      if (!await removeToken(host)) throw new Error(`no stored token for ${host}`);
      writeLine(`removed token for ${host}`);
      return 0;
    }
    try { if (prewarm) await startPrewarm(args, positionals); } catch {}
    const config = await resolveConfig(args, positionals);
    const {updates} = await import("./api.ts");

    if (!config.noColor && (config.color || io.stdoutIsTTY)) {
      red = text => styleText("red", text, {validateStream: false});
      green = text => styleText("green", text, {validateStream: false});
    }
    jsonOutput = Boolean(config.json);

    const output = await updates(config);
    const resultModes = Object.keys(output.results);
    const hasResults = resultModes.length > 0;
    const errors = output.errors ?? [];

    if (config.json) {
      writeLine(JSON.stringify({
        ...(output.message && {message: output.message}),
        ...(hasResults && {results: output.results}),
        ...(errors.length && {errors}),
      }));
    } else {
      if (output.message) writeLine(output.message);
      else if (hasResults) writeLine(formatOutput(output, red, green));
      if (config.update) for (const mode of resultModes) writeLine(green(`✨ ${mode} updated`));
      for (const {mode, name, error} of errors) writeLine(red(`${mode} ${name}: ${error}`));
    }

    if (errors.length) return 1;
    if (config.errorOnOutdated) return hasResults ? 2 : 0;
    if (config.errorOnUnchanged) return hasResults ? 0 : 2;
    return 0;
  } catch (err) {
    const error = (err as Error).message ?? String(err);
    writeLine(jsonOutput ? JSON.stringify({error}) : red(error));
    return 1;
  }
}

function formatOutput(output: Output, red: (text: string) => string, green: (text: string) => string): string {
  const modes = Object.keys(output.results);
  const hasMultipleModes = modes.length > 1;
  const arr = [["NAME", ...(hasMultipleModes ? ["MODE"] : []), "OLD", "NEW", "AGE", "INFO"]];
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
