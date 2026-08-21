import {cwd} from "node:process";
import {parseArgs} from "node:util";
import {dirname, isAbsolute, resolve} from "node:path";
import {statSync} from "node:fs";
import {cliBaseConfig, options, parseMixedArg, getOptionKey, parseArgList, parsePinArg, loadConfig} from "./config.ts";
import {parsePositiveInt} from "./utils/utils.ts";
import type {Arg} from "./config.ts";
import type {UpdatesOptions} from "./api.ts";

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
  const abs = isAbsolute(first) ? first : resolve(cwd(), first);
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch {}
  return isDir ? abs : dirname(abs);
}

export function resolveFileArgs(args: Record<string, Arg>, positionals: Array<string>): {filesList: Array<string>, startDir: string} {
  const fileSet = parseMixedArg(args.file);
  const filesList = [...(fileSet instanceof Set ? fileSet : []), ...positionals];
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
  let positionalsSeen = 0;
  for (const [index, token] of result.tokens.entries()) {
    if (token.kind === "positional") positionalsSeen++;
    if (token.kind !== "option") continue;
    if (token.inlineValue || !token.value?.startsWith("-")) {
      if (options[token.name]?.multiple) {
        const list = (values[token.name] ??= []) as Array<string | boolean>;
        list.push(token.value ?? true);
      } else {
        values[token.name] = token.value ?? true;
      }
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
      if (options[token.name]?.multiple) {
        const list = (values[token.name] ??= []) as Array<string | boolean>;
        list.push(token.value);
      } else {
        values[token.name] = token.value;
      }
      continue;
    }
    if (options[token.name]?.multiple) {
      values[token.name] ??= [];
    } else {
      values[token.name] = true;
    }
    if (consumesPositional) consumedPositionals.add(positionalsSeen);
    for (const {key, value} of recoveredOptions) {
      if (options[key].multiple) {
        const list = (values[key] ??= []) as Array<string | boolean>;
        list.push(value);
      } else {
        values[key] = value;
      }
    }
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
  if (typeof args.cooldown === "string") cliConfig.cooldown = Number(args.cooldown) || args.cooldown;

  const cliInclude = parseArgList(args.include).map(cliPatternToRegex);
  const cliExclude = parseArgList(args.exclude).map(cliPatternToRegex);
  if (cliInclude.length) cliConfig.include = cliInclude;
  if (cliExclude.length) cliConfig.exclude = cliExclude;

  const cliTypes = parseArgList(args.types);
  if (cliTypes.length) cliConfig.types = cliTypes;

  const cliPin = parsePinArg(args.pin);
  if (Object.keys(cliPin).length) cliConfig.pin = cliPin;

  const cliModes = parseMixedArg(args.modes);
  if (cliModes instanceof Set) cliConfig.modes = Array.from(cliModes);

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
  Object.defineProperty(config, cliBaseConfig, {value: {fileConfig, cliKeys: Object.keys(cliConfig)}});
  return config;
}
