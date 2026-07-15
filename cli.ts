import {cwd} from "node:process";
import {parseArgs} from "node:util";
import {dirname, isAbsolute, resolve} from "node:path";
import {statSync} from "node:fs";
import {options, parseMixedArg, getOptionKey, parseArgList, parsePinArg, loadConfig} from "./config.ts";
import {fetchTimeout} from "./modes/shared.ts";
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

export function deriveStartDir(first: string | undefined): string {
  if (!first) return cwd();
  const abs = isAbsolute(first) ? first : resolve(cwd(), first);
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch {}
  return isDir ? abs : dirname(abs);
}

// Parse argv into option values, fixing the parseArgs "-a -b" → {a: "-b"} defect.
export function parseCliArgs(argv?: Array<string>): {args: Record<string, Arg>, positionals: Array<string>} {
  const result = parseArgs({
    strict: false,
    allowPositionals: true,
    tokens: true,
    options,
    ...(argv !== undefined && {args: argv}),
  });

  const values = result.values as Record<string, Arg>;
  for (const [index, token] of result.tokens.entries()) {
    if (token.kind !== "option" || !token.value?.startsWith("-")) continue;
    const dashes = token.value.startsWith("--") ? 2 : 1;
    const key = getOptionKey(token.value.substring(dashes));
    if (!key) continue;
    const next = result.tokens[index + 1];
    // The flag was wrongly swallowed as this option's value; drop only that bogus
    // value (the dash-prefixed token.value, which may not be the last element)
    // rather than discarding the whole accumulated array, so other repeats like
    // `-i react -i -p -i vue` keep both `react` and `vue`.
    const swallowed = values[token.name];
    if (Array.isArray(swallowed)) {
      const pos = swallowed.indexOf(token.value);
      if (pos !== -1) swallowed.splice(pos, 1);
    } else {
      values[token.name] = true;
    }
    const recovered = next?.kind === "positional" && next.value ? next.value : true;
    if (options[key]?.multiple) {
      const list = (values[key] ??= []) as Array<string | boolean>;
      list.push(recovered);
    } else {
      // non-multiple options expect a scalar; an array shape is rejected by the typeof string consumers
      values[key] = recovered;
    }
  }

  return {args: values, positionals: result.positionals};
}

// Overlay parsed CLI args onto the config file. Shared by the binary and tests.
export async function resolveConfig(
  args: Record<string, Arg>,
  positionals: Array<string>,
): Promise<UpdatesOptions> {
  const fileSet = parseMixedArg(args.file);
  const filesList = [...(fileSet instanceof Set ? fileSet : []), ...positionals];
  const startDir = deriveStartDir(filesList[0]);

  const cliTimeout = typeof args.timeout === "string" ? parsePositiveInt(args.timeout, "timeout") : undefined;

  const fileConfig = await loadConfig(startDir, {
    noCache: Boolean(args["no-cache"]),
    timeout: cliTimeout ?? fetchTimeout,
  });

  const config: UpdatesOptions = {...fileConfig};
  config.pin = undefined;
  if (args.json) config.json = true;
  if (args.verbose) config.verbose = true;
  if (args["no-cache"]) config.noCache = true;
  if (args.update) config.update = true;
  if (args.indirect) config.indirect = true;
  if (args["error-on-outdated"]) config.errorOnOutdated = true;
  if (args["error-on-unchanged"]) config.errorOnUnchanged = true;
  if (cliTimeout !== undefined) config.timeout = cliTimeout;
  if (typeof args.sockets === "string") config.sockets = Number(args.sockets) || undefined;
  if (typeof args.registry === "string") config.registry = args.registry;
  if (typeof args.cooldown === "string") config.cooldown = Number(args.cooldown) || args.cooldown;

  const cliInclude = parseArgList(args.include).map(cliPatternToRegex);
  const cliExclude = parseArgList(args.exclude).map(cliPatternToRegex);
  if (cliInclude.length) config.include = cliInclude;
  if (cliExclude.length) config.exclude = cliExclude;

  const cliTypes = parseArgList(args.types);
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

  return config;
}
