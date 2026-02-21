#!/usr/bin/env node
import {cwd, stdout, stderr, exit, platform, versions} from "node:process";
import {join, dirname, basename, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync, type Stats} from "node:fs";
import {stripVTControlCharacters, styleText, parseArgs, type ParseArgsOptionsConfig} from "node:util";
import pMap from "p-map";
import {valid, validRange} from "./utils/semver.ts";
import {timerel} from "timerel";
import {highlightDiff, npmTypes, poetryTypes, uvTypes, goTypes, parseUvDependencies, nonPackageEngines} from "./utils/utils.ts";
import {enableDnsCache} from "./utils/dns.ts";
import {
  type Config, type Dep, type Deps, type DepsByMode, type Output, type ModeContext,
  type PackageRepository, type PackageInfo,
  fieldSep, normalizeUrl, esc, packageVersion, fetchTimeout, goProbeTimeout,
  doFetch, findVersion, findNewVersion, coerceToVersion, getInfoUrl,
  stripv,
} from "./modes/shared.ts";
import {
  fetchNpmInfo, fetchJsrInfo, isJsr, parseJsrDependency,
  updatePackageJson, updateNpmRange, normalizeRange, checkUrlDep,
  hashRe as npmHashRe,
} from "./modes/npm.ts";
import {fetchPypiInfo, updatePyprojectToml} from "./modes/pypi.ts";
import {
  resolveGoProxy, parseGoNoProxy, isGoPseudoVersion,
  parseGoMod, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, shortenGoModule, shortenGoVersion,
} from "./modes/go.ts";
import {
  type ActionRef,
  actionsUsesRe, parseActionRef, getForgeApiBaseUrl,
  fetchActionTags, fetchActionTagDate, formatActionVersion,
  updateWorkflowFile, isWorkflowFile, resolveWorkflowFiles,
} from "./modes/actions.ts";

export type {Config, Dep, Deps, DepsByMode, Output};

const modeByFileName: Record<string, string> = {
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "go.mod": "go",
};

const options: ParseArgsOptionsConfig = {
  "allow-downgrade": {short: "d", type: "string", multiple: true},
  "error-on-outdated": {short: "E", type: "boolean"},
  "error-on-unchanged": {short: "U", type: "boolean"},
  "exclude": {short: "e", type: "string", multiple: true},
  "file": {short: "f", type: "string", multiple: true},
  "forgeapi": {type: "string"}, // undocumented, only for tests
  "goproxy": {type: "string"}, // undocumented, only for tests
  "greatest": {short: "g", type: "string", multiple: true},
  "help": {short: "h", type: "boolean"},
  "include": {short: "i", type: "string", multiple: true},
  "json": {short: "j", type: "boolean"},
  "jsrapi": {type: "string"}, // undocumented, only for tests
  "cooldown": {short: "C", type: "string"},
  "minor": {short: "m", type: "string", multiple: true},
  "modes": {short: "M", type: "string", multiple: true},
  "color": {short: "c", type: "boolean"},
  "no-color": {short: "n", type: "boolean"},
  "patch": {short: "P", type: "string", multiple: true},
  "pin": {short: "l", type: "string", multiple: true},
  "prerelease": {short: "p", type: "string", multiple: true},
  "pypiapi": {type: "string"}, // undocumented, only for tests
  "registry": {short: "r", type: "string"},
  "release": {short: "R", type: "string", multiple: true},
  "sockets": {short: "s", type: "string"},
  "timeout": {short: "T", type: "string"},
  "types": {short: "t", type: "string", multiple: true},
  "update": {short: "u", type: "boolean"},
  "verbose": {short: "V", type: "boolean"},
  "version": {short: "v", type: "boolean"},
};

type Arg = string | boolean | Array<string | boolean> | undefined;

function parseMixedArg(arg: Arg): boolean | Set<string> {
  if (Array.isArray(arg) && arg.every(a => a === true)) {
    return true;
  } else if (Array.isArray(arg)) {
    return new Set(arg.flatMap(val => {
      return typeof val === "string" ? commaSeparatedToArray(val) : "";
    }).filter(Boolean));
  } else if (typeof arg === "string") {
    return new Set([arg]);
  } else if (typeof arg === "boolean") {
    return arg;
  } else {
    return false;
  }
}

function getOptionKey(name: string): string {
  for (const [key, {short}] of Object.entries(options)) {
    if (key === name) return key;
    if (short === name) return key;
  }
  return "";
}

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
    if (!values[key]) values[key] = [];
    if (next.kind === "positional" && next.value) {
      (values[key] as Array<string | boolean>).push(next.value);
    } else {
      (values[key] as Array<string | boolean>).push(true);
    }
  }
}

const args = result.values;
const positionals = result.positionals;

const [magenta, red, green] = (["magenta", "red", "green"] as const).map(color => {
  if (args["no-color"]) return String;
  return (text: string | number) => styleText(color, String(text));
});

const greatest = argSetToRegexes(parseMixedArg(args.greatest));
const prerelease = argSetToRegexes(parseMixedArg(args.prerelease));
const release = argSetToRegexes(parseMixedArg(args.release));
const patch = argSetToRegexes(parseMixedArg(args.patch));
const minor = argSetToRegexes(parseMixedArg(args.minor));
const allowDowngrade = argSetToRegexes(parseMixedArg(args["allow-downgrade"]));
const enabledModes = parseMixedArg(args.modes) as Set<string> || new Set(["npm", "pypi", "go", "actions"]);
const forgeApiUrl = typeof args.forgeapi === "string" ? normalizeUrl(args.forgeapi) : "https://api.github.com";
const pypiApiUrl = typeof args.pypiapi === "string" ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const jsrApiUrl = typeof args.jsrapi === "string" ? normalizeUrl(args.jsrapi) : "https://jsr.io";
const goProxyUrl = typeof args.goproxy === "string" ? normalizeUrl(args.goproxy) : resolveGoProxy();
const goNoProxy = parseGoNoProxy();

function matchesAny(str: string, set: Set<RegExp> | boolean): boolean {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

function getProperty(obj: Record<string, any>, path: string): Record<string, any> {
  return path.split(".").reduce((obj: Record<string, any>, prop: string) => obj?.[prop] ?? null, obj);
}

function commaSeparatedToArray(str: string): Array<string> {
  return str.split(",").filter(Boolean);
}

function parsePinArg(arg: Arg): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(arg)) {
    for (const val of arg) {
      if (typeof val === "string") {
        const [pkg, range] = val.split("=", 2);
        if (pkg && range && validRange(range)) {
          result[pkg] = range;
        }
      }
    }
  } else if (typeof arg === "string") {
    const [pkg, range] = arg.split("=", 2);
    if (pkg && range && validRange(range)) {
      result[pkg] = range;
    }
  }
  return result;
}

function findUpSync(filename: string, dir: string): string | null {
  const path = join(dir, filename);
  try { accessSync(path); return path; } catch {}
  const parent = dirname(dir);
  return parent === dir ? null : findUpSync(filename, parent);
}

function timestamp(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    "-",
    String(date.getMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getDate()).padStart(2, "0"),
    " ",
    String(date.getHours()).padStart(2, "0"),
    ":",
    String(date.getMinutes()).padStart(2, "0"),
    ":",
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function logVerbose(message: string): void {
  console.error(`${timestamp()} ${message}`);
}

// Build mode context for passing to mode functions
const userTimeout = typeof args.timeout === "string" ? Number(args.timeout) : 0;
const ctx: ModeContext = {
  fetchTimeout: userTimeout || fetchTimeout,
  goProbeTimeout: userTimeout ? userTimeout / 2 : goProbeTimeout,
  forgeApiUrl,
  pypiApiUrl,
  jsrApiUrl,
  goProxyUrl,
  doFetch: (url: string, opts?: RequestInit) => doFetch(url, opts, Boolean(args.verbose), logVerbose, magenta, green, red),
  verbose: Boolean(args.verbose),
};

async function finishWithMessage(message: string): Promise<void> {
  console.info(args.json ? JSON.stringify({message}) : message);
  await end();
}

async function end(err?: Error | void, exitCode?: number): Promise<void> {
  if (err) {
    const error = err.stack ?? err.message;
    const cause = err.cause;
    if (args.json) {
      console.info(JSON.stringify({error, cause}));
    } else {
      console.info(red(error));
      if (cause) console.info(red(`Caused by: ${String(cause)}`));
    }
  }

  // workaround https://github.com/nodejs/node/issues/56645
  if (platform === "win32" && Number(versions?.node?.split(".")[0]) >= 23) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  exit(exitCode || err ? 1 : 0);
}

function outputDeps(deps: DepsByMode = {}): number {
  for (const mode of Object.keys(deps)) {
    for (const props of Object.values(deps[mode])) {
      if (typeof props.oldPrint === "string") {
        props.old = props.oldPrint;
      }
      if (typeof props.newPrint === "string") {
        props.new = props.newPrint;
      }
      // Don't overwrite old with oldOrig for JSR dependencies
      if (typeof props.oldOrig === "string" && !isJsr(props.oldOrig)) {
        props.old = props.oldOrig;
      }
      if (mode === "actions") {
        props.old = stripv(props.old);
        props.new = stripv(props.new);
      }
      delete props.oldPrint;
      delete props.newPrint;
      delete props.oldOrig;
      delete props.date;
    }
  }

  let num = 0;
  for (const mode of Object.keys(deps)) {
    num += Object.keys(deps[mode]).length;
  }

  if (args.json) {
    const output: Output = {results: {}};
    for (const mode of Object.keys(deps)) {
      for (const [key, value] of Object.entries(deps[mode])) {
        const [type, name] = key.split(fieldSep);
        if (!output.results[mode]) output.results[mode] = {};
        if (!output.results[mode][type]) output.results[mode][type] = {};
        output.results[mode][type][name] = value;
      }
    }
    console.info(JSON.stringify(output));
  } else if (num) {
    console.info(formatDeps(deps));
  }

  if (args["error-on-outdated"]) {
    return num ? 2 : 0;
  } else if (args["error-on-unchanged"]) {
    return num ? 0 : 2;
  } else {
    return 0;
  }
}

// preserve file metadata on windows
function write(file: string, content: string): void {
  if (platform === "win32") truncateSync(file, 0);
  writeFileSync(file, content, platform === "win32" ? {flag: "r+"} : undefined);
}

const ansiLen = (str: string): number => stripVTControlCharacters(str).length;

function textTable(rows: Array<Array<string>>, hsep = " "): string {
  let ret = "";
  const colSizes = new Array(rows[0].length).fill(0);
  for (const row of rows) {
    for (const [colIndex, col] of row.entries()) {
      const len = ansiLen(col);
      if (len > colSizes[colIndex]) {
        colSizes[colIndex] = len;
      }
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    for (const [colIndex, col] of row.entries()) {
      if (colIndex > 0) ret += hsep;
      const space = " ".repeat(colSizes[colIndex] - ansiLen(col));
      ret += col + (colIndex === row.length - 1 ? "" : space);
    }
    if (rowIndex < rows.length - 1) ret += "\n";
  }
  return ret;
}

function formatDeps(deps: DepsByMode): string {
  // Check if there are multiple modes
  const modes = Object.keys(deps).filter(mode => Object.keys(deps[mode]).length > 0);
  const hasMultipleModes = modes.length > 1;

  const header = hasMultipleModes ?
    ["NAME", "MODE", "OLD", "NEW", "AGE", "INFO"] :
    ["NAME", "OLD", "NEW", "AGE", "INFO"];
  const arr = [header];
  const seen = new Set<string>();

  for (const mode of modes) {
    for (const [key, data] of Object.entries(deps[mode])) {
      const [_type, name] = key.split(fieldSep);
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

  return textTable(arr);
}

function globToRegex(glob: string, insensitive: boolean): RegExp {
  return new RegExp(`^${esc(glob).replaceAll("\\*", ".*")}$`, insensitive ? "i" : "");
}

// convert arg from cli or config to regex
function argToRegex(arg: string | RegExp, cli: boolean, insensitive: boolean): RegExp {
  if (cli && typeof arg === "string") {
    return /^\/.+\/$/.test(arg) ? new RegExp(arg.slice(1, -1)) : globToRegex(arg, insensitive);
  } else {
    return arg instanceof RegExp ? arg : globToRegex(arg, insensitive);
  }
}

// parse cli arg into regex set
function argSetToRegexes(arg: Set<string> | boolean): Set<RegExp> | boolean {
  if (arg instanceof Set) {
    const ret = new Set<RegExp>();
    for (const entry of arg) {
      ret.add(argToRegex(entry, true, false));
    }
    return ret;
  }
  return arg;
}

// parse include/exclude into a Set of regexes
function matchersToRegexSet(cliArgs: Array<string>, configArgs: Array<string | RegExp>): Set<RegExp> {
  const ret = new Set();
  for (const arg of cliArgs || []) {
    ret.add(argToRegex(arg, true, true));
  }
  for (const arg of configArgs || []) {
    ret.add(argToRegex(arg, false, true));
  }
  return ret as Set<RegExp>;
}

function parseArgList(arg: Arg): Array<string> {
  if (Array.isArray(arg)) {
    return arg.filter(v => typeof v === "string").flatMap(item => commaSeparatedToArray(item));
  }
  return [];
}

function getSemvers(name: string): Set<string> {
  if (patch === true || matchesAny(name, patch)) {
    return new Set<string>(["patch"]);
  } else if (minor === true || matchesAny(name, minor)) {
    return new Set<string>(["patch", "minor"]);
  }
  return new Set<string>(["patch", "minor", "major"]);
}

function getVersionOpts(name: string) {
  return {
    useGreatest: typeof greatest === "boolean" ? greatest : matchesAny(name, greatest),
    usePre: typeof prerelease === "boolean" ? prerelease : matchesAny(name, prerelease),
    useRel: typeof release === "boolean" ? release : matchesAny(name, release),
    semvers: getSemvers(name),
  };
}

function toRelPath(absPath: string): string {
  return absPath.replace(`${cwd()}/`, "").replace(`${cwd()}\\`, "");
}

function canInclude(name: string, mode: string, include: Set<RegExp>, exclude: Set<RegExp>, depType: string): boolean {
  if (depType === "engines" && nonPackageEngines.includes(name)) return false;
  if (mode === "pypi" && name === "python") return false;
  if (!include.size && !exclude.size) return true;
  const baseName = mode === "go" ? name.replace(/\/v\d+$/, "") : name;
  for (const re of exclude) {
    if (re.test(name) || re.test(baseName)) return false;
  }
  for (const re of include) {
    if (re.test(name) || re.test(baseName)) return true;
  }
  return include.size ? false : true;
}

function canIncludeByDate(date: string | undefined, cooldownDays: number, now: number) {
  if (!date || !cooldownDays) return true;
  const diffDays = (now - Date.parse(date)) / (24 * 3600 * 1000);
  return diffDays >= cooldownDays;
}

function resolveFiles(filesArg: Set<string>): [Set<string>, Set<string>] {
  const resolvedFiles = new Set<string>();
  const explicitFiles = new Set<string>();

  if (filesArg) { // check passed files
    for (const file of filesArg) {
      let stat: Stats;
      try {
        stat = lstatSync(file);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }

      if (stat?.isFile()) {
        const resolved = resolve(file);
        resolvedFiles.add(resolved);
        explicitFiles.add(resolved);
      } else if (stat?.isDirectory()) {
        for (const filename of Object.keys(modeByFileName)) {
          const f = join(file, filename);
          let stat: Stats | null = null;
          try {
            stat = lstatSync(f);
          } catch {}
          if (stat?.isFile()) {
            resolvedFiles.add(resolve(f));
          }
        }
        const normalized = resolve(file).replace(/\\/g, "/");
        let wfDir: string | undefined;
        if (normalized.endsWith(".github/workflows")) wfDir = normalized;
        else if (normalized.endsWith(".github")) wfDir = join(normalized, "workflows");
        else wfDir = join(normalized, ".github", "workflows");
        for (const wf of resolveWorkflowFiles(wfDir)) {
          resolvedFiles.add(wf);
          explicitFiles.add(wf);
        }
      } else {
        throw new Error(`${file} is neither a file nor directory`);
      }
    }
  } else { // search for files
    for (const filename of Object.keys(modeByFileName)) {
      const file = findUpSync(filename, cwd());
      if (file) resolvedFiles.add(resolve(file));
    }
    const workflowDir = findUpSync(join(".github", "workflows"), cwd());
    if (workflowDir) {
      for (const wf of resolveWorkflowFiles(workflowDir)) {
        resolvedFiles.add(wf);
      }
    }
  }
  return [resolvedFiles, explicitFiles];
}

async function loadConfig(rootDir: string): Promise<Config> {
  const filenames: Array<string> = [];
  for (const ext of ["js", "ts", "mjs", "mts"]) {
    filenames.push(`updates.config.${ext}`);
  }
  let config: Config = {};

  try {
    ({default: config} = await Promise.any(filenames.map(async (filename) => {
      const fullPath = join(rootDir, ...filename.split("/"));
      const fileUrl = pathToFileURL(fullPath);

      try {
        accessSync(fullPath);
      } catch {
        throw new Error(`File not found: ${filename}`);
      }

      try {
        return await import(fileUrl.href);
      } catch (err) {
        throw new Error(`Unable to parse config file ${filename}: ${err.message}`);
      }
    })));
  } catch (err) {
    if (err instanceof AggregateError) {
      const parseErrors = err.errors.filter(e => e.message.startsWith("Unable to parse"));
      if (parseErrors.length > 0) {
        throw parseErrors[0];
      }
    }
  }

  return config;
}

async function main(): Promise<void> {
  // Node.js does not guarantee that stdio streams are flushed when calling process.exit(). Prevent Node
  // from cutting off long output by setting those streams into blocking mode.
  // Ref: https://github.com/nodejs/node/issues/6379
  for (const stream of [stdout, stderr]) {
    (stream as any)?._handle?.setBlocking?.(true);
  }

  enableDnsCache();

  const maxSockets = 96;
  const concurrency = typeof args.sockets === "number" ? args.sockets : maxSockets;
  const {help, version, file: filesArg, types, update, include: includeArg, exclude: excludeArg, pin: pinArg, cooldown: cooldownArg} = args;

  if (help) {
    stdout.write(`usage: updates [options] [files...]

  Options:
    -u, --update                       Update versions and write dependency file
    -f, --file <path,...>              File or directory to use, defaults to current directory
    -i, --include <dep,...>            Include only given dependencies
    -e, --exclude <dep,...>            Exclude given dependencies
    -p, --prerelease [<dep,...>]       Consider prerelease versions
    -R, --release [<dep,...>]          Only use release versions, may downgrade
    -g, --greatest [<dep,...>]         Prefer greatest over latest version
    -t, --types <type,...>             Dependency types to update
    -P, --patch [<dep,...>]            Consider only up to semver-patch
    -m, --minor [<dep,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<dep,...>]  Allow version downgrades when using latest version
    -C, --cooldown <days>              Minimum dependency age in days
    -l, --pin <dep=range>              Pin dependency to given semver range
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
    -T, --timeout <ms>                 Network request timeout in ms (go probes use half). Default: ${fetchTimeout}
    -M, --modes <mode,...>             Which modes to enable. Either npm,pypi,go,actions. Default: npm,pypi,go,actions
    -j, --json                         Output a JSON object
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
    $ updates -f .github
`);
    await end();
  }

  if (version) {
    console.info(packageVersion);
    await end();
  }

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const pkgStrs: Record<string, string> = {};
  const filePerMode: Record<string, string> = {};
  const now = Date.now();
  let numDependencies = 0;

  const fileSet = parseMixedArg(filesArg);
  const mergedFiles = fileSet instanceof Set ? fileSet : (positionals.length ? new Set<string>() : false);
  if (mergedFiles instanceof Set) for (const p of positionals) mergedFiles.add(p);
  const [files, explicitFiles] = resolveFiles(mergedFiles as Set<string>);

  const wfData: Record<string, {absPath: string, content: string}> = {};
  const cliInclude = parseArgList(includeArg);
  const cliExclude = parseArgList(excludeArg);
  const cliPin = parsePinArg(pinArg);

  type ActionDepInfo = ActionRef & {key: string, apiUrl: string};
  const actionDepInfos: Array<ActionDepInfo> = [];

  for (const file of files) {
    if (isWorkflowFile(file)) {
      if (!enabledModes.has("actions") && !explicitFiles.has(file)) continue;
      if (!deps.actions) deps.actions = {};

      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }
      const relPath = toRelPath(file);
      wfData[relPath] = {absPath: file, content};

      const include = matchersToRegexSet(cliInclude, []);
      const exclude = matchersToRegexSet(cliExclude, []);
      const actions = Array.from(content.matchAll(actionsUsesRe), m => parseActionRef(m[1])).filter(a => a !== null);
      for (const action of actions) {
        if (!canInclude(action.name, "actions", include, exclude, "actions")) continue;
        const key = `${relPath}${fieldSep}${action.name}`;
        if (deps.actions[key]) continue;
        deps.actions[key] = {old: action.ref} as Dep;
        actionDepInfos.push({...action, key, apiUrl: getForgeApiBaseUrl(action.host, forgeApiUrl)});
      }
      continue;
    }

    const filename = basename(file);
    const mode = modeByFileName[filename];
    if (!enabledModes.has(mode) && !explicitFiles.has(file)) continue;
    filePerMode[mode] = file;
    if (!deps[mode]) deps[mode] = {};

    const projectDir = dirname(resolve(file));
    const config = await loadConfig(projectDir);

    const include = matchersToRegexSet(cliInclude, config?.include ?? []);
    const exclude = matchersToRegexSet(cliExclude, config?.exclude ?? []);
    const pin: Record<string, string> = {...config?.pin, ...cliPin};

    let dependencyTypes: Array<string> = [];
    if (Array.isArray(types)) {
      dependencyTypes = types.filter(v => typeof v === "string");
    } else if ("types" in config && Array.isArray(config.types)) {
      dependencyTypes = config.types;
    } else {
      if (mode === "npm") {
        dependencyTypes = npmTypes;
      } else if (mode === "pypi") {
        dependencyTypes = [...uvTypes, ...poetryTypes];
      } else if (mode === "go") {
        dependencyTypes = Array.from(goTypes);
      }
    }

    let pkg: Record<string, any> = {};
    try {
      pkgStrs[mode] = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
    }

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else if (mode === "pypi") {
        const {parse} = await import("smol-toml");
        pkg = parse(pkgStrs[mode]);
      } else {
        const parsed = parseGoMod(pkgStrs[mode]);
        pkg.deps = parsed.deps;
        pkg.replace = parsed.replace;
      }
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }

    for (const depType of dependencyTypes) {
      let obj: Record<string, string> | Array<string> | string;
      if (mode === "npm" || mode === "go") {
        obj = pkg[depType] || {};
      } else {
        obj = getProperty(pkg, depType) || {};
      }

      if (Array.isArray(obj) && mode === "pypi") { // array for uv
        for (const {name, version} of parseUvDependencies(obj)) {
          if (canInclude(name, mode, include, exclude, depType)) {
            deps[mode][`${depType}${fieldSep}${name}`] = {
              old: normalizeRange(version),
              oldOrig: version,
            } as Dep;
          }
        }
      } else {
        if (typeof obj === "string") { // string (packageManager)
          const [name, value] = obj.split("@");
          if (canInclude(name, mode, include, exclude, depType)) {
            deps[mode][`${depType}${fieldSep}${name}`] = {
              old: normalizeRange(value),
              oldOrig: value,
            } as Dep;
          }
        } else { // object
          for (const [name, value] of Object.entries(obj)) {
            if (mode === "npm" && isJsr(value) && canInclude(name, mode, include, exclude, depType)) {
              // Handle JSR dependencies
              const parsed = parseJsrDependency(value, name);
              deps[mode][`${depType}${fieldSep}${name}`] = {
                old: parsed.version,
                oldOrig: value,
              } as Dep;
            } else if (mode !== "go" && validRange(value) && canInclude(name, mode, include, exclude, depType)) {
              deps[mode][`${depType}${fieldSep}${name}`] = {
                old: normalizeRange(value),
                oldOrig: value,
              } as Dep;
            } else if (mode === "npm" && !isJsr(value) && canInclude(name, mode, include, exclude, depType)) {
              maybeUrlDeps[`${depType}${fieldSep}${name}`] = {
                old: value,
              } as Dep;
            } else if (mode === "go" && canInclude(name, mode, include, exclude, depType)) {
              deps[mode][`${depType}${fieldSep}${name}`] = {
                old: shortenGoVersion(value),
                oldOrig: stripv(value),
              } as Dep;
            }
          }
        }
      }
    }

    numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
    if (!numDependencies) continue;

    let entries: Array<PackageInfo> = [];

    entries = await pMap(Object.keys(deps[mode]), async (key) => {
      const [type, name] = key.split(fieldSep);
      if (mode === "npm") {
        // Check if this dependency is a JSR dependency
        const {oldOrig} = deps[mode][key];
        if (oldOrig && isJsr(oldOrig)) {
          return fetchJsrInfo(name, type, ctx);
        }
        return fetchNpmInfo(name, type, config, args, ctx);
      } else if (mode === "go") {
        return fetchGoProxyInfo(name, type, deps[mode][key].oldOrig || deps[mode][key].old, projectDir, ctx, goNoProxy);
      } else {
        return fetchPypiInfo(name, type, ctx);
      }
    }, {concurrency});

    for (const [data, type, registry, name] of entries) {
      if (data?.error) throw new Error(data.error);

      const {useGreatest, usePre, useRel, semvers} = getVersionOpts(data.name);

      const key = `${type}${fieldSep}${name}`;
      const oldRange = deps[mode][key].old;
      const oldOrig = deps[mode][key].oldOrig;
      const pinnedRange = pin[name];
      const newVersion = findNewVersion(data, {
        usePre, useRel, useGreatest, semvers, range: oldRange, mode, pinnedRange,
      }, {allowDowngrade, matchesAny, isGoPseudoVersion});

      let newRange = "";
      if (["go", "pypi"].includes(mode) && newVersion) {
        // go has no ranges and pypi oldRange is a version at this point, not a range
        newRange = newVersion;
      } else if (newVersion) {
        // Check if this is a JSR dependency
        if (oldOrig && isJsr(oldOrig)) {
          // Reconstruct JSR format with new version
          if (oldOrig.startsWith("npm:@jsr/")) {
            const match = /^(npm:@jsr\/[^@]+@)(.+)$/.exec(oldOrig);
            if (match) {
              newRange = `${match[1]}${newVersion}`;
            }
          } else if (oldOrig.startsWith("jsr:@")) {
            const match = /^(jsr:@[^@]+@)(.+)$/.exec(oldOrig);
            if (match) {
              newRange = `${match[1]}${newVersion}`;
            }
          } else if (oldOrig.startsWith("jsr:")) {
            newRange = `jsr:${newVersion}`;
          }
        } else {
          newRange = updateNpmRange(oldRange, newVersion, oldOrig);
        }
      }

      if (!newVersion || oldOrig && (oldOrig === newRange)) {
        delete deps[mode][key];
        continue;
      }

      let date = "";
      if (mode === "npm" && data.time?.[newVersion]) { // npm
        date = data.time[newVersion];
      } else if (mode === "pypi" && data.releases?.[newVersion]?.[0]?.upload_time_iso_8601) {
        date = data.releases[newVersion][0].upload_time_iso_8601;
      } else if (mode === "go" && data.Time) {
        date = data.Time;
      }

      deps[mode][key].new = newRange;

      // For JSR dependencies, set newPrint to show just the version
      if (oldOrig && isJsr(oldOrig)) {
        deps[mode][key].newPrint = newVersion;
      }

      if (mode === "npm") {
        deps[mode][key].info = getInfoUrl(data?.versions?.[newVersion], registry, data.name);
      } else if (mode === "pypi") {
        deps[mode][key].info = getInfoUrl(data as {repository: PackageRepository, homepage: string, info: Record<string, any>}, registry, data.info.name);
      } else if (mode === "go") {
        const infoName = data.newPath || name;
        deps[mode][key].info = getGoInfoUrl(infoName);
      }

      if (date) {
        deps[mode][key].date = date;
        deps[mode][key].age = timerel(date, {noAffix: true});
      }
    }

    if (Object.keys(maybeUrlDeps).length) {
      const results = (await pMap(Object.entries(maybeUrlDeps), ([key, dep]) => {
        const name = key.split(fieldSep)[1];
        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(name, greatest);
        return checkUrlDep(key, dep, useGreatest, ctx);
      }, {concurrency})).filter(r => r !== null);

      for (const res of results) {
        const {key, newRange, user, repo, oldRef, newRef, newDate} = res;

        deps[mode][key] = {
          old: maybeUrlDeps[key].old,
          new: newRange,
          oldPrint: npmHashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
          newPrint: npmHashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
          info: `https://github.com/${user}/${repo}`,
          ...(newDate ? {age: timerel(newDate, {noAffix: true})} : {}),
        };
      }
    }

    const cooldown = cooldownArg ?? config.cooldown;
    if (cooldown) {
      for (const m of Object.keys(deps)) {
        for (const [key, {date}] of Object.entries(deps[m])) {
          if (!canIncludeByDate(date, Number(cooldown), now)) {
            delete deps[m][key];
          }
        }
      }
    }
  }

  // Actions version resolution (after all workflow files collected)
  if (deps.actions) {
    numDependencies += Object.keys(deps.actions).length;
  }

  if (actionDepInfos.length) {
    const depsByRepo = new Map<string, {apiUrl: string, owner: string, repo: string, infos: Array<ActionDepInfo>}>();
    for (const info of actionDepInfos) {
      const repoKey = `${info.apiUrl}/${info.owner}/${info.repo}`;
      if (!depsByRepo.has(repoKey)) {
        depsByRepo.set(repoKey, {apiUrl: info.apiUrl, owner: info.owner, repo: info.repo, infos: []});
      }
      depsByRepo.get(repoKey)!.infos.push(info);
    }

    await pMap(depsByRepo.values(), async ({apiUrl, owner, repo, infos}) => {
      const tags = await fetchActionTags(apiUrl, owner, repo, ctx);
      const tagNames = tags.map(t => t.name);
      const versions = tagNames.map(t => stripv(t)).filter(v => valid(v));

      const commitShaToTag = new Map<string, string>();
      for (const tag of tags) {
        if (tag.commitSha) commitShaToTag.set(tag.commitSha, tag.name);
      }

      const dateCache = new Map<string, string>();
      async function getDate(commitSha: string): Promise<string> {
        if (dateCache.has(commitSha)) return dateCache.get(commitSha)!;
        const date = await fetchActionTagDate(apiUrl, owner, repo, commitSha, ctx);
        dateCache.set(commitSha, date);
        return date;
      }

      for (const info of infos) {
        const dep = deps.actions[info.key];
        const infoUrl = `https://${info.host || "github.com"}/${owner}/${repo}`;

        if (info.isHash) {
          const {usePre, useRel} = getVersionOpts(info.name);
          const newVersion = findVersion({}, versions, {
            range: "0.0.0", semvers: new Set(["patch", "minor", "major"]), usePre, useRel,
            useGreatest: true, pinnedRange: cliPin[info.name],
          });
          if (!newVersion) { delete deps.actions[info.key]; continue; }

          const newTag = tagNames.find(t => stripv(t) === newVersion);
          if (!newTag) { delete deps.actions[info.key]; continue; }

          const newEntry = tags.find(t => t.name === newTag);
          const newCommitSha = newEntry?.commitSha;
          if (!newCommitSha || newCommitSha === info.ref || newCommitSha.startsWith(info.ref) || info.ref.startsWith(newCommitSha)) {
            delete deps.actions[info.key]; continue;
          }

          const oldTagName = commitShaToTag.get(info.ref) || Array.from(commitShaToTag.entries()).find(([sha]) => sha.startsWith(info.ref))?.[1];
          dep.old = info.ref;
          dep.new = newCommitSha.substring(0, info.ref.length);
          dep.oldPrint = oldTagName || info.ref.substring(0, 7);
          dep.newPrint = newTag;
          dep.info = infoUrl;

          const date = await getDate(newCommitSha);
          if (date) {
            dep.date = date;
            dep.age = timerel(date, {noAffix: true});
          }
        } else {
          const coerced = coerceToVersion(stripv(info.ref));
          if (!coerced) { delete deps.actions[info.key]; continue; }

          const {useGreatest, usePre, useRel, semvers} = getVersionOpts(info.name);
          const newVersion = findVersion({}, versions, {
            range: coerced, semvers, usePre, useRel,
            useGreatest: useGreatest || true, pinnedRange: cliPin[info.name],
          });
          if (!newVersion || newVersion === coerced) { delete deps.actions[info.key]; continue; }

          const newTag = tagNames.find(t => stripv(t) === newVersion);
          if (!newTag) { delete deps.actions[info.key]; continue; }

          const formatted = formatActionVersion(newTag, info.ref);
          if (formatted === info.ref) { delete deps.actions[info.key]; continue; }

          dep.new = formatted;
          dep.info = infoUrl;

          const newEntry = tags.find(t => t.name === newTag);
          if (newEntry?.commitSha) {
            const date = await getDate(newEntry.commitSha);
            if (date) {
              dep.date = date;
              dep.age = timerel(date, {noAffix: true});
            }
          }
        }
      }
    }, {concurrency});

    if (cooldownArg) {
      for (const [key, {date}] of Object.entries(deps.actions)) {
        if (!canIncludeByDate(date, Number(cooldownArg), now)) {
          delete deps.actions[key];
        }
      }
    }

    if (!Object.keys(deps.actions).length) {
      delete deps.actions;
    }
  }

  if (numDependencies === 0) {
    return finishWithMessage("No dependencies found, nothing to do.");
  }

  let numEntries = 0;
  for (const mode of Object.keys(deps)) {
    numEntries += Object.keys(deps[mode]).length;
  }

  if (!numEntries) {
    return finishWithMessage("All dependencies are up to date.");
  }

  // Pre-build actions update data before outputDeps modifies dep values
  const actionsUpdatesByRelPath = new Map<string, Array<{name: string, oldRef: string, newRef: string}>>();
  if (deps.actions) {
    for (const [key, dep] of Object.entries(deps.actions)) {
      const [relPath, name] = key.split(fieldSep);
      if (!actionsUpdatesByRelPath.has(relPath)) actionsUpdatesByRelPath.set(relPath, []);
      actionsUpdatesByRelPath.get(relPath)!.push({name, oldRef: dep.old, newRef: dep.new});
    }
  }

  const exitCode = outputDeps(deps);

  if (update) {
    for (const mode of Object.keys(deps)) {
      if (!Object.keys(deps[mode]).length) continue;

      if (mode === "actions") {
        for (const [relPath, actionDeps] of actionsUpdatesByRelPath) {
          const {absPath, content} = wfData[relPath] || {};
          if (!absPath) continue;
          try {
            write(absPath, updateWorkflowFile(content, actionDeps));
          } catch (err) {
            throw new Error(`Error writing ${basename(absPath)}: ${(err as Error).message}`);
          }
          console.info(green(`✨ ${relPath} updated`));
        }
        continue;
      }

      try {
        const fileContent = pkgStrs[mode];
        if (mode === "go") {
          const [updatedContent, majorVersionRewrites] = updateGoMod(fileContent, deps[mode]);
          write(filePerMode[mode], updatedContent);
          rewriteGoImports(dirname(resolve(filePerMode[mode])), majorVersionRewrites, write);
        } else {
          const fn = (mode === "npm") ? updatePackageJson : updatePyprojectToml;
          write(filePerMode[mode], fn(fileContent, deps[mode]));
        }
      } catch (err) {
        throw new Error(`Error writing ${basename(filePerMode[mode])}: ${(err as Error).message}`);
      }

      // TODO: json
      console.info(green(`✨ ${basename(filePerMode[mode])} updated`));
    }
  }

  await end(undefined, exitCode);
}

try {
  await main();
} catch (err) {
  await end(err);
}
