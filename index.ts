#!/usr/bin/env node
import {cwd, stdout, stderr, env, exit, platform, versions} from "node:process";
import {join, dirname, basename, resolve} from "node:path";
import {lstatSync, readFileSync, truncateSync, writeFileSync, accessSync, readdirSync, type Stats} from "node:fs";
import {stripVTControlCharacters, styleText, parseArgs, type ParseArgsOptionsConfig} from "node:util";
import {execFileSync} from "node:child_process";
import pMap from "p-map";
import pkg from "./package.json" with {type: "json"};
import {parse, coerce, diff, gt, gte, lt, neq, valid, validRange} from "semver";
import {timerel} from "timerel";
import {npmTypes, poetryTypes, uvTypes, goTypes, parseUvDependencies, nonPackageEngines} from "./utils.ts";
import type {default as registryAuthToken, AuthOptions} from "registry-auth-token";

export type Config = {
  /** Array of packages to include */
  include?: Array<string | RegExp>;
  /** Array of packages to exclude */
  exclude?: Array<string | RegExp>;
  /** Array of package types to use */
  types?: Array<string>;
  /** URL to npm registry */
  registry?: string;
  /** Minimum package age in days */
  cooldown?: number,
};

type Npmrc = {
  registry: string,
  ca?: string,
  cafile?: string,
  cert?: string,
  certfile?: string,
  key?: string,
  keyfile?: string,
  [other: string]: any,
};

type Dep = {
  old: string,
  new: string,
  oldPrint?: string,
  newPrint?: string,
  oldOrig?: string,
  info?: string,
  age?: string,
  date?: string,
};

type Deps = {
  [name: string]: Dep,
};

type DepsByMode = {
  [mode: string]: Deps,
};

type Output = {
  results: {
    [mode: string]: {
      [type: string]: Deps,
    }
  }
};

type FindVersionOpts = {
  range: string,
  semvers: Set<string>,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
};

type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
};

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const npmVersionRePre = /[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g;
const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const normalizeUrl = (url: string) => url.endsWith("/") ? url.substring(0, url.length - 1) : url;
const packageVersion = pkg.version;
const sep = "\0";

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
  "githubapi": {type: "string"}, // undocumented, only for tests
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
  "prerelease": {short: "p", type: "string", multiple: true},
  "pypiapi": {type: "string"}, // undocumented, only for tests
  "registry": {short: "r", type: "string"},
  "release": {short: "R", type: "string", multiple: true},
  "sockets": {short: "s", type: "string"},
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
for (const [index, token] of result.tokens.entries()) {
  if (token.kind === "option" && token.value?.startsWith("-")) {
    const key = getOptionKey(token.value.substring(1));
    const next = result.tokens[index + 1];
    // @ts-expect-error
    result.values[token.name] = [true];
    // @ts-expect-error
    if (!result.values[key]) result.values[key] = [];
    if (next.kind === "positional" && next.value) {
      // @ts-expect-error
      result.values[key].push(next.value);
    } else {
      // @ts-expect-error
      result.values[key].push(true);
    }
  }
}

const args = result.values;

const [magenta, red, green] = (["magenta", "red", "green"] as const)
  .map(color => args["no-color"] ? String : (text: string | number) => styleText(color, String(text)));

const greatest = argSetToRegexes(parseMixedArg(args.greatest));
const prerelease = argSetToRegexes(parseMixedArg(args.prerelease));
const release = argSetToRegexes(parseMixedArg(args.release));
const patch = argSetToRegexes(parseMixedArg(args.patch));
const minor = argSetToRegexes(parseMixedArg(args.minor));
const allowDowngrade = argSetToRegexes(parseMixedArg(args["allow-downgrade"]));
const enabledModes = parseMixedArg(args.modes) as Set<string> || new Set(["npm", "pypi", "actions"]);
const githubApiUrl = typeof args.githubapi === "string" ? normalizeUrl(args.githubapi) : "https://api.github.com";
const pypiApiUrl = typeof args.pypiapi === "string" ? normalizeUrl(args.pypiapi) : "https://pypi.org";
const jsrApiUrl = typeof args.jsrapi === "string" ? normalizeUrl(args.jsrapi) : "https://jsr.io";

const stripv = (str: string): string => str.replace(/^v/, "");

function matchesAny(str: string, set: Set<RegExp> | boolean): boolean {
  for (const re of (set instanceof Set ? set : [])) {
    if (re.test(str)) return true;
  }
  return false;
}

function registryUrl(scope: string, npmrc: Npmrc): string {
  const url: string = npmrc[`${scope}:registry`] || npmrc.registry;
  return url.endsWith("/") ? url : `${url}/`;
}

function getProperty(obj: Record<string, any>, path: string): Record<string, any> {
  return path.split(".").reduce((obj: Record<string, any>, prop: string) => obj?.[prop] ?? null, obj);
}

function commaSeparatedToArray(str: string): Array<string> {
  return str.split(",").filter(Boolean);
}

function findUpSync(filename: string, dir: string): string | null {
  const path = join(dir, filename);
  try { accessSync(path); return path; } catch {}
  const parent = dirname(dir);
  return parent === dir ? null : findUpSync(filename, parent);
}

type AuthAndRegistry = {
  auth: {
    token: string,
    type: string,
    username?: string | undefined,
    password?: string | undefined,
  } | undefined,
  registry: string,
};

const defaultRegistry = "https://registry.npmjs.org";
let authOpts: AuthOptions | null = null;
let npmrc: Npmrc | null = null;
let rat: typeof registryAuthToken | null = null;

const authCache = new Map<string, AuthAndRegistry>();

async function getNpmrc() {
  if (npmrc) return npmrc;
  return (await import("rc")).default("npm", {registry: defaultRegistry});
}

async function getAuthAndRegistry(name: string, registry: string): Promise<AuthAndRegistry> {
  if (!npmrc) npmrc = await getNpmrc();
  if (!authOpts) authOpts = {npmrc, recursive: true};
  if (!rat) rat = (await import("registry-auth-token")).default;

  const scope = name.startsWith("@") ? (/@[a-z0-9][\w-.]+/.exec(name) || [""])[0] : "";
  const cacheKey = `${scope}:${registry}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached;

  let result: AuthAndRegistry;
  if (!name.startsWith("@")) {
    result = {auth: rat(registry, authOpts), registry};
  } else {
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = rat(url, authOpts);
        result = newAuth?.token ? {auth: newAuth, registry: url} : {auth: rat(registry, authOpts), registry};
      } catch {
        result = {auth: rat(registry, authOpts), registry};
      }
    } else {
      result = {auth: rat(registry, authOpts), registry};
    }
  }

  authCache.set(cacheKey, result);
  return result;
}

function getFetchOpts(authType?: string, authToken?: string): RequestInit {
  return {
    headers: {
      "user-agent": `updates/${packageVersion}`,
      "accept-encoding": "gzip, deflate, br",
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
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

async function doFetch(url: string, opts?: RequestInit): Promise<Response> {
  if (args.verbose) logVerbose(`${magenta("fetch")} ${url}`);
  const res = await fetch(url, opts);
  if (args.verbose) logVerbose(`${res.ok ? green(res.status) : red(res.status)} ${url}`);
  return res;
}

type PackageInfo = [Record<string, any>, string, string | null, string];

async function fetchNpmInfo(name: string, type: string, config: Config): Promise<PackageInfo> {
  if (!npmrc) npmrc = await getNpmrc();
  const originalRegistry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || npmrc.registry || defaultRegistry,
  );

  const {auth, registry} = await getAuthAndRegistry(name, originalRegistry);
  const packageName = type === "resolutions" ? basename(name) : name;
  const url = `${registry}/${packageName.replace(/\//g, "%2f")}`;

  const res = await doFetch(url, getFetchOpts(auth?.type, auth?.token));
  if (res?.ok) {
    return [await res.json(), type, registry, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${registry}`);
    }
  }
}

async function fetchPypiInfo(name: string, type: string): Promise<PackageInfo> {
  const url = `${pypiApiUrl}/pypi/${name}/json`;

  const res = await doFetch(url, {headers: {"accept-encoding": "gzip, deflate, br"}});
  if (res?.ok) {
    return [await res.json(), type, null, name];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${name} from ${pypiApiUrl}`);
    }
  }
}

// Check if a dependency value is a JSR dependency
function isJsrDependency(value: string): boolean {
  return value.startsWith("npm:@jsr/") || value.startsWith("jsr:");
}

// Parse JSR dependency value and extract package name and version
// Examples:
// - "npm:@jsr/std__semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:@std/semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:1.0.5" (when package name is known) -> { scope: null, name: null, version: "1.0.5" }
function parseJsrDependency(value: string, packageName?: string): {scope: string | null, name: string | null, version: string} {
  if (value.startsWith("npm:@jsr/")) {
    // Format: npm:@jsr/std__semver@1.0.5
    const match = /^npm:@jsr\/([^_]+)__([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:@")) {
    // Format: jsr:@std/semver@1.0.5
    const match = /^jsr:@([^/]+)\/([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:")) {
    // Format: jsr:1.0.5 (short form when package name is in the dependency key)
    const version = value.substring(4);
    if (packageName?.startsWith("@")) {
      const match = /^@([^/]+)\/(.+)$/.exec(packageName);
      if (match) {
        return {scope: match[1], name: match[2], version};
      }
    }
  }
  return {scope: null, name: null, version: ""};
}

// Fetch JSR package metadata
async function fetchJsrInfo(packageName: string, type: string): Promise<PackageInfo> {
  // Parse package name to get scope and name
  const match = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (!match) {
    throw new Error(`Invalid JSR package name: ${packageName}`);
  }
  const [, scope, name] = match;
  const url = `${jsrApiUrl}/@${scope}/${name}/meta.json`;

  const res = await doFetch(url, {headers: {"accept-encoding": "gzip, deflate, br"}});
  if (res?.ok) {
    const data = await res.json();
    // Transform JSR format to match npm-like format for compatibility
    const versions: Record<string, any> = {};
    for (const [version, metadata] of Object.entries(data.versions as Record<string, any>)) {
      versions[version] = {
        version,
        time: metadata.createdAt,
      };
    }
    const transformedData = {
      name: packageName,
      "dist-tags": {
        latest: data.latest,
      },
      versions,
      time: Object.fromEntries(
        Object.entries(data.versions as Record<string, any>).map(([v, m]: [string, any]) => [v, m.createdAt])
      ),
    };
    return [transformedData, type, jsrApiUrl, packageName];
  } else {
    if (res?.status && res?.statusText) {
      throw new Error(`Received ${res.status} ${res.statusText} from ${url}`);
    } else {
      throw new Error(`Unable to fetch ${packageName} from JSR`);
    }
  }
}

function splitPlainText(str: string): Array<string> {
  return str.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

type GoListInfo = {
  Path: string, // "github.com/redis/go-redis/v9",
  Version: string, // "v9.17.1",
  Main?: boolean, // true
  Indirect?: boolean, // true
  Time: string, // "2025-11-26T10:20:20Z",
  Update?: {
    Path: string, // "github.com/redis/go-redis/v9",
    Version: string, // "v9.17.2",
    Time: string, //"2025-12-01T13:57:40Z"
  },
  Dir: string, // "/Users/silverwind/go/pkg/mod/github.com/redis/go-redis/v9@v9.17.1",
  GoMod: string // "/Users/silverwind/go/pkg/mod/cache/download/github.com/redis/go-redis/v9/@v/v9.17.1.mod",
  GoVersion: string // "1.18",
  Sum: string // "h1:7tl732FjYPRT9H9aNfyTwKg9iTETjWjGKEJ2t/5iWTs=",
  GoModSum: string // "h1:u410H11HMLoB+TP67dz8rL9s6QW2j76l0//kSOd3370="
};

function getGoUpgrades(deps: DepsByMode, projectDir: string) {
  const stdout = execFileSync("go", [
    "list", "-u", "-mod=readonly", "-json", "-m", ...Object.keys(deps.go).map(key => key.split(sep)[1]),
  ], {stdio: "pipe", encoding: "utf8", cwd: projectDir});
  const json = `[${stdout.replaceAll(/\r?\n\}/g, "},")}]`.replaceAll(/\},\r?\n\]/g, "}]");

  const ret: Array<PackageInfo> = [];
  for (const {Main, Indirect, Version, Update, Path, Time} of JSON.parse(json) as Array<GoListInfo>) {
    if (Main || Indirect) continue;
    ret.push([{
      old: stripv(Version),
      new: stripv(Update?.Version || Version),
      Time: Update?.Time || Time,
    }, "deps", null, Path]);
  }
  return ret;
}

type PackageRepository = string | {
  type: string,
  url: string,
  directory: string,
};

function resolvePackageJsonUrl(url: string): string {
  url = url.replace("git@", "").replace(/.+?\/\//, "https://").replace(/\.git$/, "");
  if (/^[a-z]+:[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // foo:user/repo
    return url.replace(/^(.+?):/, (_, p1) => `https://${p1}.com/`);
  } else if (/^[a-z0-9-]\/[a-z0-9-]$/.test(url)) { // user/repo
    return `https://github.com/${url}`;
  } else {
    return url;
  }
}

function getSubDir(url: string): string {
  if (url.startsWith("https://bitbucket.org")) {
    return "src/HEAD";
  } else {
    return "tree/HEAD";
  }
}

function getInfoUrl({repository, homepage, info}: {repository: PackageRepository, homepage: string, info: Record<string, any>}, registry: string | null, name: string): string {
  if (info) { // pypi
    repository =
      info.project_urls.repository ||
      info.project_urls.Repository ||
      info.project_urls.repo ||
      info.project_urls.Repo ||
      info.project_urls.source ||
      info.project_urls.Source ||
      info.project_urls["source code"] ||
      info.project_urls["Source code"] ||
      info.project_urls["Source Code"] ||
      info.project_urls.homepage ||
      info.project_urls.Homepage ||
      `https://pypi.org/project/${name}/`;
  }

  let infoUrl = "";
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const url = typeof repository === "string" ? repository : repository.url;
    infoUrl = resolvePackageJsonUrl(url);
    if (infoUrl && typeof repository !== "string" && repository.directory) {
      infoUrl = `${infoUrl}/${getSubDir(infoUrl)}/${repository.directory}`;
    }
  }

  return infoUrl || homepage || "";
}

function getGoInfoUrl(name: string) {
  const str = `https://${shortenGoModule(name)}`;
  const url = new URL(str);
  const pathParts = url.pathname.split("/"); // ["", "user", "repo"]
  if (pathParts.length > 3) {
    const [_empty, user, repo, ...other] = pathParts;
    url.pathname = `/${user}/${repo}/${getSubDir(str)}/${other.join("/")}`;
    return url.toString();
  } else {
    return str;
  }
}

async function finishWithMessage(message: string): Promise<void> {
  console.info(args.json ? JSON.stringify({message}) : message);
  await end();
}

async function end(err?: Error | void, exitCode?: number): Promise<void> {
  if (err) {
    const error = err.stack ?? err.message;
    const cause = err.cause as any;
    if (args.json) {
      console.info(JSON.stringify({error, cause}));
    } else {
      console.info(red(error));
      if (cause) console.info(red(`Caused by: ${cause}`));
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
      if (typeof props.oldOrig === "string" && !isJsrDependency(props.oldOrig)) {
        props.old = props.oldOrig;
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
        if (!key) continue; // Skip if key is undefined/empty
        const parts = key.split(sep);
        if (parts.length < 2) continue; // Skip malformed keys
        const [type, name] = parts;
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

function highlightDiff(a: string, b: string, colorFn: (str: string) => string): string {
  if (a === b) return a;
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;

  let res = "";
  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += colorFn(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? colorFn(char) : char;
        }).join("") + colorFn(`.${aParts.slice(i + 1).join(".")}`.replace(/\.$/, ""));
      }
      break;
    } else {
      res += `${aParts[i]}.`;
    }
  }
  return res.replace(/\.$/, "");
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

function shortenGoModule(module: string): string {
  return /\/v[0-9]$/.test(module) ? dirname(module) : module;
}

function formatDeps(deps: DepsByMode): string {
  const arr = [["NAME", "OLD", "NEW", "AGE", "INFO"]];
  const seen = new Set<string>();

  for (const mode of Object.keys(deps)) {
    for (const [key, data] of Object.entries(deps[mode])) {
      if (!key || !data) continue; // Skip if key or data is missing
      const parts = key.split(sep);
      if (parts.length < 2) continue; // Skip malformed keys
      const name = parts[1];
      const id = `${mode}|${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      arr.push([
        mode === "go" ? shortenGoModule(name) : name,
        highlightDiff(data.old, data.new, red),
        highlightDiff(data.new, data.old, green),
        data.age || "",
        data.info || "",
      ]);
    }
  }

  return textTable(arr);
}

function updatePackageJson(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [depType, name] = key.split(sep);
    const oldValue = oldOrig || old;
    if (depType === "packageManager") {
      const re = new RegExp(`"${esc(depType)}": *"${name}@${esc(oldValue)}"`, "g");
      newPkgStr = newPkgStr.replace(re, `"${depType}": "${name}@${deps[key].new}"`);
    } else {
      const re = new RegExp(`"${esc(name)}": *"${esc(oldValue)}"`, "g");
      newPkgStr = newPkgStr.replace(re, `"${name}": "${deps[key].new}"`);
    }
  }
  return newPkgStr;
}

function updatePyprojectToml(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [_depType, name] = key.split(sep);
    const oldValue = oldOrig || old;
    newPkgStr = newPkgStr.replace( // poetry
      new RegExp(`${esc(name)} *= *"${esc(oldValue)}"`, "g"),
      `${name} = "${deps[key].new}"`,
    );
    newPkgStr = newPkgStr.replace( // uv
      new RegExp(`("${esc(name)} *[<>=~]+ *)${esc(oldValue)}(")`, "g"),
      (_, m1, m2) => `${m1}${deps[key].new}${m2}`,
    );
  }
  return newPkgStr;
}

function updateGoMod(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [_depType, name] = key.split(sep);
    const oldValue = oldOrig || old;
    newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${deps[key].new}`);
  }
  return newPkgStr;
}

function updateActionsYaml(yamlStr: string, deps: Deps): string {
  let newYamlStr = yamlStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [_depType, actionName] = key.split(sep);
    const oldVersion = oldOrig || old;

    // Handle hash@version format (e.g., @87697c0dca7dd44e37a2b79a79489332556ff1f3 # v37.6.0)
    const hashCommentMatch = /^([0-9a-f]{40})\s*#\s*(v?[\d.]+)$/.exec(oldVersion);
    if (hashCommentMatch) {
      const [, hash, oldCommentVersion] = hashCommentMatch;
      // When updating, replace hash with new version and update comment to match
      const pattern = new RegExp(
        `(uses:\\s*${esc(actionName)}@)${esc(hash)}(\\s*#\\s*)${esc(oldCommentVersion)}`,
        "g"
      );
      newYamlStr = newYamlStr.replace(pattern, `$1${deps[key].new}$2${deps[key].new}`);
    } else {
      // Handle standard format (e.g., @v2, @v3)
      const pattern = new RegExp(`(uses:\\s*${esc(actionName)}@)${esc(oldVersion)}`, "g");
      newYamlStr = newYamlStr.replace(pattern, `$1${deps[key].new}`);
    }
  }
  return newYamlStr;
}

function updateNpmRange(oldRange: string, newVersion: string, oldOrig: string | undefined): string {
  let newRange = oldRange.replace(npmVersionRePre, newVersion);

  // if old version is a range like ^5 or ~5, retain number of version parts in new range
  if (oldOrig && oldOrig !== oldRange && /^[\^~]/.test(newRange)) {
    const oldParts = oldOrig.substring(1).split(".");
    const newParts = newRange.substring(1).split(".");
    if (oldParts.length !== newParts.length) {
      newRange = `${newRange[0]}${newParts.slice(0, oldParts.length).join(".")}`;
    }
  }

  // if old version is a range like >=5 or >= 5, retain number of version parts in new range
  if (oldOrig && oldOrig !== oldRange && newRange.startsWith(">=")) {
    const hasSpace = /^>=\s/.test(oldOrig);
    const prefix = hasSpace ? ">= " : ">=";
    const oldVersion = oldOrig.replace(/^>=\s*/, "");
    const newVersion = newRange.replace(/^>=\s*/, "");
    const oldParts = oldVersion.split(".");
    const newParts = newVersion.split(".");
    if (oldParts.length !== newParts.length) {
      newRange = `${prefix}${newParts.slice(0, oldParts.length).join(".")}`;
    }
  }

  return newRange;
}

function isVersionPrerelease(version: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

function isRangePrerelease(range: string): boolean {
  // can not use coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function coerceToVersion(rangeOrVersion: string): string {
  try {
    return coerce(rangeOrVersion)?.version ?? "";
  } catch {
    return "";
  }
}

function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest}: FindVersionOpts): string | null {
  const oldVersion = coerceToVersion(range);
  if (!oldVersion) return oldVersion;

  usePre = isRangePrerelease(range) || usePre;

  if (usePre) {
    semvers.add("prerelease");
    if (semvers.has("patch")) semvers.add("prepatch");
    if (semvers.has("minor")) semvers.add("preminor");
    if (semvers.has("major")) semvers.add("premajor");
  }

  let greatestDate = 0;
  let newVersion = oldVersion;

  for (const version of versions) {
    const parsed = parse(version);
    if (!parsed?.version || parsed.prerelease.length && (!usePre || useRel)) continue;
    const candidateVersion = parsed.version;

    const d = diff(newVersion, candidateVersion);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(coerceToVersion(candidateVersion), newVersion)) {
        newVersion = candidateVersion;
      }
    } else {
      const date = (new Date(data.time[version])).getTime();
      if (date >= 0 && date > greatestDate) {
        newVersion = candidateVersion;
        greatestDate = date;
      }
    }
  }

  return newVersion || null;
}

function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers}: FindNewVersionOpts): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains

  let versions: Array<string> = [];
  if (mode === "pypi") {
    versions = Object.keys(data.releases).filter((version: string) => valid(version));
  } else if (mode === "npm") {
    versions = Object.keys(data.versions).filter((version: string) => valid(version));
  } else if (mode === "go") {
    return data.new;
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest});
  if (!version) return null;

  if (useGreatest) {
    return version;
  } else {
    let latestTag = "";
    let originalLatestTag = "";
    if (mode === "pypi") {
      originalLatestTag = data.info.version; // may not be a 3-part semver
      latestTag = coerceToVersion(data.info.version); // add .0 to 6.0 so semver eats it
    } else {
      latestTag = data["dist-tags"].latest;
    }

    const oldVersion = coerceToVersion(range);
    const oldIsPre = isRangePrerelease(range);
    const newIsPre = isVersionPrerelease(version);
    const latestIsPre = isVersionPrerelease(latestTag);
    const isGreater = gt(version, oldVersion);

    // update to new prerelease
    if (!useRel && usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // downgrade from prerelease to release on --release-only
    if (useRel && !isGreater && oldIsPre && !newIsPre) {
      return version;
    }

    // update from prerelease to release
    if (oldIsPre && !newIsPre && isGreater) {
      return version;
    }

    // do not downgrade from prerelease to release
    if (oldIsPre && !newIsPre && !isGreater) {
      return null;
    }

    // check if latestTag is allowed by semvers
    const d = diff(oldVersion, latestTag);
    if (d && d !== "prerelease" && !semvers.has(d.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // prevent downgrade to older version except with --allow-downgrade
    if (lt(latestTag, oldVersion) && !latestIsPre) {
      if (allowDowngrade === true || matchesAny(data.name, allowDowngrade)) {
        return latestTag;
      } else {
        return null;
      }
    }

    // prevent upgrading from non-prerelease to prerelease from latest dist-tag by default
    if (!oldIsPre && latestIsPre && !usePre) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return originalLatestTag || latestTag;
  }
}

function fetchGitHub(url: string): Promise<Response> {
  const opts: RequestInit = {headers: {"accept-encoding": "gzip, deflate, br"}};
  const token =
    env.UPDATES_GITHUB_API_TOKEN ||
    env.GITHUB_API_TOKEN ||
    env.GH_TOKEN ||
    env.GITHUB_TOKEN ||
    env.HOMEBREW_GITHUB_API_TOKEN;

  if (token) {
    opts.headers = {...opts.headers, Authorization: `Bearer ${token}`};
  }
  return doFetch(url, opts);
}

type CommitInfo = {
  hash: string,
  commit: Record<string, any>,
};

async function getLastestCommit(user: string, repo: string): Promise<CommitInfo> {
  const url = `${githubApiUrl}/repos/${user}/${repo}/commits`;
  const res = await fetchGitHub(url);
  if (!res?.ok) return {hash: "", commit: {}};
  const data = await res.json();
  const {sha: hash, commit} = data[0];
  return {hash, commit};
}

// return list of tags sorted old to new
// TODO: newDate support, semver matching
async function getTags(user: string, repo: string): Promise<Array<string>> {
  const res = await fetchGitHub(`${githubApiUrl}/repos/${user}/${repo}/git/refs/tags`);
  if (!res?.ok) return [];
  const data = await res.json();
  const tags = data.map((entry: {ref: string}) => entry.ref.replace(/^refs\/tags\//, ""));
  return tags;
}

function selectTag(tags: Array<string>, oldRef: string, useGreatest: boolean): string | null {
  const oldRefBare = stripv(oldRef);
  if (!valid(oldRefBare)) return null;

  if (!useGreatest) {
    const lastTag = tags.at(-1);
    if (!lastTag) return null;
    const lastTagBare = stripv(lastTag);
    if (!valid(lastTagBare)) return null;

    if (neq(oldRefBare, lastTagBare)) {
      return lastTag;
    }
  } else {
    let greatestTag = oldRef;
    let greatestTagBare = stripv(oldRef);

    for (const tag of tags) {
      const tagBare = stripv(tag);
      if (!valid(tagBare)) continue;
      if (!greatestTag || gt(tagBare, greatestTagBare)) {
        greatestTag = tag;
        greatestTagBare = tagBare;
      }
    }
    if (neq(oldRefBare, greatestTagBare)) {
      return greatestTag;
    }
  }

  return null;
}

type CheckResult = {
  key: string,
  newRange: string,
  user: string,
  repo: string,
  oldRef: string,
  newRef: string,
  newDate?: string,
  newTag?: string,
};

async function checkUrlDep(key: string, dep: Dep, useGreatest: boolean): Promise<CheckResult | null> {
  const stripped = dep.old.replace(stripRe, "");
  const [_, user, repo, oldRef] = partsRe.exec(stripped) || [];
  if (!user || !repo || !oldRef) return null;

  if (hashRe.test(oldRef)) {
    const {hash, commit} = await getLastestCommit(user, repo);
    if (!hash) return null;

    const newDate = commit?.committer?.date ?? commit?.author?.date;
    const newRef = hash.substring(0, oldRef.length);
    if (oldRef !== newRef) {
      const newRange = dep.old.replace(oldRef, newRef);
      return {key, newRange, user, repo, oldRef, newRef, newDate};
    }
  } else {
    const tags = await getTags(user, repo);
    const newTag = selectTag(tags, oldRef, useGreatest);
    if (newTag) {
      return {key, newRange: newTag, user, repo, oldRef, newRef: newTag};
    }
  }

  return null;
}

type ActionDep = {
  owner: string,
  repo: string,
  version: string,
  fullName: string,
};

async function parseActionsFromYaml(yamlContent: string): Promise<Array<ActionDep>> {
  const {parse} = await import("yaml");
  const actions: Array<ActionDep> = [];

  try {
    const doc = parse(yamlContent);
    if (!doc?.jobs) return actions;

    for (const job of Object.values(doc.jobs)) {
      if (typeof job !== "object" || !job || !("steps" in job)) continue;
      const steps = (job as any).steps;
      if (!Array.isArray(steps)) continue;

      for (const step of steps) {
        if (!step?.uses) continue;
        const uses = step.uses;

        // Skip local actions (e.g., ./local-action@v1)
        if (uses.startsWith("./") || uses.startsWith("../")) continue;

        // Parse owner/repo@version
        const match = uses.match(/^([^/]+)\/([^@]+)@(.+)$/);
        if (!match) continue;

        const [_, owner, repo, versionPart] = match;
        const fullName = `${owner}/${repo}`;

        // Now check if there's a comment in the raw YAML for this action
        let version = versionPart;
        const hashMatch = /^[0-9a-f]{40}$/.exec(versionPart);
        if (hashMatch) {
          // It's a hash, check raw YAML for version comment
          const regex = new RegExp(`uses:\\s*${esc(owner)}/${esc(repo)}@${esc(versionPart)}\\s*#\\s*(v?[\\d.]+)`, "m");
          const commentMatch = regex.exec(yamlContent);
          if (commentMatch) {
            version = `${versionPart} # ${commentMatch[1]}`;
          }
        }

        actions.push({
          owner,
          repo,
          version,
          fullName,
        });
      }
    }
  } catch {
    // If parsing fails, return empty array
  }

  return actions;
}

async function checkActionDep(action: ActionDep, useGreatest: boolean): Promise<{oldVersion: string, newVersion: string | null} | null> {
  const {owner, repo, version} = action;

  // Handle hash with version comment format
  const hashCommentMatch = /^([0-9a-f]{40})\s*#\s*(v?[\d.]+)$/.exec(version);
  if (hashCommentMatch) {
    const [, _hash, versionTag] = hashCommentMatch;
    const tags = await getTags(owner, repo);
    if (args.verbose) {
      console.error(`DEBUG: ${owner}/${repo} has ${tags.length} tags, checking hash comment version ${versionTag}`);
    }
    const newTag = selectActionTag(tags, versionTag, useGreatest);

    if (newTag && newTag !== versionTag) {
      return {oldVersion: version, newVersion: newTag};
    }
  } else {
    // Handle standard semver tag format (including major-only like v2, v3)
    const tags = await getTags(owner, repo);
    if (args.verbose) {
      console.error(`DEBUG: ${owner}/${repo} has ${tags.length} tags, checking version ${version}, useGreatest=${useGreatest}`);
      console.error(`DEBUG: Last few tags: ${tags.slice(-5).join(", ")}`);
    }
    const newTag = selectActionTag(tags, version, useGreatest);
    if (args.verbose) {
      console.error(`DEBUG: selectActionTag returned: ${newTag}`);
    }

    if (newTag && newTag !== version) {
      return {oldVersion: version, newVersion: newTag};
    }
  }

  return null;
}

function selectActionTag(tags: Array<string>, oldRef: string, useGreatest: boolean): string | null {
  const oldRefBare = stripv(oldRef);
  const oldRefCoerced = coerce(oldRefBare);
  if (!oldRefCoerced) return null;

  if (!useGreatest) {
    // Find the latest tag
    const lastTag = tags.at(-1);
    if (!lastTag) return null;
    const lastTagBare = stripv(lastTag);
    const lastTagCoerced = coerce(lastTagBare);
    if (!lastTagCoerced) return null;

    if (neq(oldRefCoerced.version, lastTagCoerced.version)) {
      return lastTag;
    }
  } else {
    // Find the greatest tag
    let greatestTag: string | null = null;
    let greatestVersion: string | null = null;

    for (const tag of tags) {
      const tagBare = stripv(tag);
      const tagCoerced = coerce(tagBare);
      if (!tagCoerced) continue;
      if (!greatestVersion || gt(tagCoerced.version, greatestVersion)) {
        greatestTag = tag;
        greatestVersion = tagCoerced.version;
      }
    }

    if (greatestTag && greatestVersion && neq(oldRefCoerced.version, greatestVersion)) {
      return greatestTag;
    }
  }

  return null;
}

// turn "v1.3.2-0.20230802210424-5b0b94c5c0d3" into "v1.3.2"
function shortenGoVersion(version: string): string {
  return version.replace(/-.*/, "");
}

function normalizeRange(range: string): string {
  const versionMatches = range.match(npmVersionRe);
  if (versionMatches?.length !== 1) return range;
  return range.replace(npmVersionRe, coerceToVersion(versionMatches[0]));
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

function canInclude(name: string, mode: string, include: Set<RegExp>, exclude: Set<RegExp>, depType: string): boolean {
  if (depType === "engines" && nonPackageEngines.includes(name)) return false;
  if (mode === "pypi" && name === "python") return false;
  if (!include.size && !exclude.size) return true;
  for (const re of exclude) {
    if (re.test(name)) return false;
  }
  for (const re of include) {
    if (re.test(name)) return true;
  }
  return include.size ? false : true;
}

function canIncludeByDate(date: string | undefined, cooldownDays: number, now: number) {
  if (!date || !cooldownDays) return true;
  const diffDays = (now - Date.parse(date)) / (24 * 3600 * 1000);
  return diffDays >= cooldownDays;
}

function discoverWorkflowFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const workflowDir of [".github/workflows", ".gitea/workflows"]) {
    const fullPath = join(dir, workflowDir);
    try {
      const entries = readdirSync(fullPath);
      for (const entry of entries) {
        if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
          files.push(resolve(join(fullPath, entry)));
        }
      }
    } catch {}
  }
  return files;
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
        // Also discover workflow files
        for (const workflowFile of discoverWorkflowFiles(file)) {
          resolvedFiles.add(workflowFile);
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
    // Also discover workflow files from current directory
    for (const workflowFile of discoverWorkflowFiles(cwd())) {
      resolvedFiles.add(workflowFile);
    }
  }
  return [resolvedFiles, explicitFiles];
}

async function loadConfig(rootDir: string): Promise<Config> {
  const filenames: Array<string> = [];
  for (const prefix of ["", ".config/"]) {
    for (const ext of ["js", "ts", "mjs", "mts"]) {
      filenames.push(`${prefix}updates${prefix ? "" : ".config"}.${ext}`);
    }
  }
  let config: Config = {};
  try {
    ({default: config} = await Promise.any(filenames.map(str => {
      return import(join(rootDir, ...str.split("/")));
    })));
  } catch {}
  return config;
}

async function main(): Promise<void> {
  // Node.js does not guarantee that stdio streams are flushed when calling process.exit(). Prevent Node
  // from cutting off long output by setting those streams into blocking mode.
  // Ref: https://github.com/nodejs/node/issues/6379
  for (const stream of [stdout, stderr]) {
    // @ts-expect-error -- _handle is missing in @types/node
    stream?._handle?.setBlocking?.(true);
  }

  const maxSockets = 96;
  const concurrency = typeof args.sockets === "number" ? args.sockets : maxSockets;
  const {help, version, file: filesArg, types, update} = args;

  if (help) {
    stdout.write(`usage: updates [options]

  Options:
    -u, --update                       Update versions and write package file
    -f, --file <path,...>              File or directory to use, defaults to current directory
    -i, --include <pkg,...>            Include only given packages
    -e, --exclude <pkg,...>            Exclude given packages
    -p, --prerelease [<pkg,...>]       Consider prerelease versions
    -R, --release [<pkg,...>]          Only use release versions, may downgrade
    -g, --greatest [<pkg,...>]         Prefer greatest over latest version
    -t, --types <type,...>             Dependency types to update
    -P, --patch [<pkg,...>]            Consider only up to semver-patch
    -m, --minor [<pkg,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<pkg,...>]  Allow version downgrades when using latest version
    -C, --cooldown <days>              Minimum package age in days
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
    -M, --modes <mode,...>             Which modes to enable. Either npm,pypi,go,actions. Default: npm,pypi,actions
    -j, --json                         Output a JSON object
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -C 7
    $ updates -e react,react-dom
    $ updates -e '/^react-(dom)?/'
    $ updates -f package.json
    $ updates -f pyproject.toml
    $ updates -f go.mod
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
  const actionFiles = new Map<string, string>(); // Map action file path to its content
  const actionDepsOriginal: Deps = {}; // Store original action deps with file paths in keys
  const now = Date.now();
  let numDependencies = 0;

  const [files, explicitFiles] = resolveFiles(parseMixedArg(filesArg) as Set<string>);

  for (const file of files) {
    const filename = basename(file);
    let mode = modeByFileName[filename];

    // Detect actions mode for workflow files
    if (!mode && (explicitFiles.has(file) && (filename.endsWith(".yaml") || filename.endsWith(".yml")))) {
      // For explicit files, check if it's a workflow file by trying to parse it
      try {
        const content = readFileSync(file, "utf8");
        // Simple check: does it have 'jobs:' which is required for workflow files
        if (content.includes("jobs:") && content.includes("uses:")) {
          mode = "actions";
        }
      } catch {}
    } else if (!mode) {
      // For discovered files, check if they're in workflow directories (using path separators)
      const normalizedPath = file.split(sep).join("/");
      if ((normalizedPath.includes("/.github/workflows/") || normalizedPath.includes("/.gitea/workflows/")) &&
          (filename.endsWith(".yaml") || filename.endsWith(".yml"))) {
        mode = "actions";
      }
    }

    if (!enabledModes.has(mode) && !explicitFiles.has(file)) continue;

    // For actions mode, don't overwrite filePerMode - we need to track all files separately
    if (mode !== "actions") {
      filePerMode[mode] = file;
    }
    if (!deps[mode]) deps[mode] = {};

    const projectDir = dirname(resolve(file));
    const config = await loadConfig(projectDir);

    let includeCli: Array<string> = [];
    let excludeCli: Array<string> = [];
    if (Array.isArray(args.include)) { // cli
      includeCli = args.include.filter(v => typeof v === "string").flatMap(item => commaSeparatedToArray(item));
    }
    if (Array.isArray(args.exclude)) {
      excludeCli = args.exclude.filter(v => typeof v === "string").flatMap(item => commaSeparatedToArray(item));
    }
    const include = matchersToRegexSet(includeCli, config?.include ?? []);
    const exclude = matchersToRegexSet(excludeCli, config?.exclude ?? []);

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
    if (mode === "actions") {
      // For actions mode, skip standard dependency parsing
      try {
        const content = readFileSync(file, "utf8");
        actionFiles.set(file, content);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }

      // Parse actions from YAML
      const actions = await parseActionsFromYaml(actionFiles.get(file)!);
      const actionsToCheck: Array<{key: string, action: ActionDep}> = [];

      for (const action of actions) {
        if (canInclude(action.fullName, mode, include, exclude, "actions")) {
          // Include file path in the key to track which file this action belongs to
          const key = `${file}${sep}${action.fullName}`;
          deps[mode][key] = {
            old: action.version,
            oldOrig: action.version,
          } as Dep;
          actionsToCheck.push({key, action});
        }
      }

      // Check each action for updates
      await pMap(actionsToCheck, async ({key, action}) => {
        const {fullName, version} = action;

        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(fullName, greatest);
        const result = await checkActionDep(action, useGreatest);
        const {verbose} = args;

        if (verbose) {
          console.error(`DEBUG: Checked ${fullName}: result=${JSON.stringify(result)}`);
        }

        const dep = deps[mode][key];
        const newVersion = result?.newVersion;
        if (newVersion) {
          dep.new = newVersion;
          // Store original with file path
          actionDepsOriginal[key] = dep;
          if (verbose) {
            console.error(`DEBUG: Added update for ${fullName}: ${version} -> ${newVersion}`);
          }
        } else {
          delete deps[mode][key];
          if (verbose) {
            console.error(`DEBUG: Deleted ${fullName} (no update)`);
          }
        }

        return null;
      }, {concurrency});

      numDependencies += Object.keys(deps[mode]).length;
      continue; // Skip standard dependency processing
    } else if (mode === "go") {
      pkgStrs[mode] = execFileSync("go", [
        "list", "-m", "-f", "{{if not .Indirect}}{{.Path}}@{{.Version}}{{end}}", "all",
      ], {stdio: "pipe", encoding: "utf8", cwd: projectDir});
    } else {
      try {
        pkgStrs[mode] = readFileSync(file, "utf8");
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }
    }

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else if (mode === "pypi") {
        const {parse} = await import("smol-toml");
        pkg = parse(pkgStrs[mode]);
      } else {
        pkg.deps = {};
        for (const modulePathAndVersion of splitPlainText(pkgStrs[mode])) {
          const [modulePath, version] = modulePathAndVersion.split("@");
          if (version) {
            pkg.deps[modulePath] = version;
          }
        }
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
            deps[mode][`${depType}${sep}${name}`] = {
              old: normalizeRange(version),
              oldOrig: version,
            } as Dep;
          }
        }
      } else {
        if (typeof obj === "string") { // string (packageManager)
          const [name, value] = obj.split("@");
          deps[mode][`${depType}${sep}${name}`] = {
            old: normalizeRange(value),
            oldOrig: value,
          } as Dep;
        } else { // object
          for (const [name, value] of Object.entries(obj)) {
            if (mode === "npm" && isJsrDependency(value) && canInclude(name, mode, include, exclude, depType)) {
              // Handle JSR dependencies
              const parsed = parseJsrDependency(value, name);
              deps[mode][`${depType}${sep}${name}`] = {
                old: parsed.version,
                oldOrig: value,
              } as Dep;
            } else if (mode !== "go" && validRange(value) && canInclude(name, mode, include, exclude, depType)) {
              deps[mode][`${depType}${sep}${name}`] = {
                old: normalizeRange(value),
                oldOrig: value,
              } as Dep;
            } else if (mode === "npm" && !isJsrDependency(value) && canInclude(name, mode, include, exclude, depType)) {
              maybeUrlDeps[`${depType}${sep}${name}`] = {
                old: value,
              } as Dep;
            } else if (mode === "go" && canInclude(name, mode, include, exclude, depType)) {
              deps[mode][`${depType}${sep}${name}`] = {
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

    if (mode === "go") {
      entries = getGoUpgrades(deps, projectDir);
    } else {
      entries = await pMap(Object.keys(deps[mode]), async (key) => {
        const [type, name] = key.split(sep);
        if (mode === "npm") {
          // Check if this dependency is a JSR dependency
          const depValue = deps[mode][key].oldOrig;
          if (depValue && isJsrDependency(depValue)) {
            return fetchJsrInfo(name, type);
          }
          return fetchNpmInfo(name, type, config);
        } else {
          return fetchPypiInfo(name, type);
        }
      }, {concurrency});
    }

    for (const [data, type, registry, name] of entries) {
      if (data?.error) throw new Error(data.error);

      const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(data.name, greatest);
      const usePre = typeof prerelease === "boolean" ? prerelease : matchesAny(data.name, prerelease);
      const useRel = typeof release === "boolean" ? release : matchesAny(data.name, release);

      let semvers: Set<string>;
      if (patch === true || matchesAny(data.name, patch)) {
        semvers = new Set<string>(["patch"]);
      } else if (minor === true || matchesAny(data.name, minor)) {
        semvers = new Set<string>(["patch", "minor"]);
      } else {
        semvers = new Set<string>(["patch", "minor", "major"]);
      }

      const key = `${type}${sep}${name}`;
      const oldRange = deps[mode][key].old;
      const oldOrig = deps[mode][key].oldOrig;
      const newVersion = findNewVersion(data, {
        usePre, useRel, useGreatest, semvers, range: oldRange, mode,
      });

      let newRange = "";
      if (["go", "pypi"].includes(mode) && newVersion) {
        // go has no ranges and pypi oldRange is a version at this point, not a range
        newRange = newVersion;
      } else if (newVersion) {
        // Check if this is a JSR dependency
        if (oldOrig && isJsrDependency(oldOrig)) {
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
      if (oldOrig && isJsrDependency(oldOrig)) {
        deps[mode][key].newPrint = newVersion;
      }

      if (mode === "npm") {
        deps[mode][key].info = getInfoUrl(data?.versions?.[newVersion], registry, data.name);
      } else if (mode === "pypi") {
        deps[mode][key].info = getInfoUrl(data as any, registry, data.info.name);
      } else if (mode === "go") {
        deps[mode][key].info = getGoInfoUrl(name);
      }

      if (date) {
        deps[mode][key].date = date;
        deps[mode][key].age = timerel(date, {noAffix: true});
      }
    }

    if (Object.keys(maybeUrlDeps).length) {
      const results = (await pMap(Object.entries(maybeUrlDeps), ([key, dep]) => {
        const name = key.split(sep)[1];
        const useGreatest = typeof greatest === "boolean" ? greatest : matchesAny(name, greatest);
        return checkUrlDep(key, dep, useGreatest);
      }, {concurrency})).filter(r => r !== null);

      for (const res of results) {
        const {key, newRange, user, repo, oldRef, newRef, newDate} = res;

        deps[mode][key] = {
          old: maybeUrlDeps[key].old,
          new: newRange,
          oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
          newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
          info: `https://github.com/${user}/${repo}`,
          ...(newDate ? {age: timerel(newDate, {noAffix: true})} : {}),
        };
      }
    }

    const cooldown = args.cooldown ?? config.cooldown;
    if (cooldown) {
      for (const mode of Object.keys(deps)) {
        for (const [key, {date}] of Object.entries(deps[mode])) {
          if (!canIncludeByDate(date, Number(cooldown), now)) {
            delete deps[mode][key];
            continue;
          }
        }
      }
    }
  }

  if (numDependencies === 0) {
    finishWithMessage("No dependencies found, nothing to do.");
  }

  let numEntries = 0;
  for (const mode of Object.keys(deps)) {
    numEntries += Object.keys(deps[mode]).length;
  }

  if (!numEntries) {
    finishWithMessage("All dependencies are up to date.");
  }

  // Transform actions deps for output - remove file path from key and deduplicate
  if (deps.actions) {
    const {verbose} = args;
    if (verbose) {
      console.error(`DEBUG: deps.actions keys before transform: ${JSON.stringify(Object.keys(deps.actions))}`);
    }
    const actionsKeys = Object.keys(deps.actions);
    if (actionsKeys.length > 0) {
      const transformedActions: Deps = {};
      for (const [key, dep] of Object.entries(deps.actions)) {
        if (!key) {
          if (verbose) console.error("Empty key found in actions deps");
          continue;
        }
        const parts = key.split(sep);
        // Actions keys should have file path as first part, action name as second
        // Transform to: actions${sep}${actionName}
        if (parts.length >= 2) {
          const actionName = parts[parts.length - 1]; // Get last part (action name)
          const transformedKey = `actions${sep}${actionName}`;
          // If multiple files use the same action, keep the first one we see
          // (they should all have the same old/new versions if discovered together)
          if (!transformedActions[transformedKey]) {
            transformedActions[transformedKey] = dep;
          }
        } else {
          if (verbose) console.error(`Malformed key in actions deps: ${key}`);
        }
      }
      deps.actions = transformedActions;
      if (verbose) {
        console.error(`DEBUG: deps.actions keys after transform: ${JSON.stringify(Object.keys(deps.actions))}`);
      }
    }
  }

  const exitCode = outputDeps(deps);

  if (update) {
    for (const mode of Object.keys(deps)) {
      if (!Object.keys(deps[mode]).length) continue;

      if (mode === "actions") {
        // Group deps by file - use actionDepsOriginal which has file paths
        const depsByFile = new Map<string, Deps>();
        for (const [key, dep] of Object.entries(actionDepsOriginal)) {
          const parts = key.split(sep);
          const filePath = parts[0];
          const actionName = parts[1];

          if (!depsByFile.has(filePath)) {
            depsByFile.set(filePath, {});
          }
          // Store with simplified key for updateActionsYaml
          const fileDeps = depsByFile.get(filePath)!;
          fileDeps[`actions${sep}${actionName}`] = dep;
        }

        // Update each file
        for (const [filePath, fileDeps] of depsByFile.entries()) {
          try {
            const content = actionFiles.get(filePath)!;
            write(filePath, updateActionsYaml(content, fileDeps));
            console.info(green(`✨ ${basename(filePath)} updated`));
          } catch (err) {
            throw new Error(`Error writing ${basename(filePath)}: ${(err as Error).message}`);
          }
        }
      } else {
        try {
          let fn: (content: string, deps: Deps) => string;
          if (mode === "npm") {
            fn = updatePackageJson;
          } else if (mode === "go") {
            fn = updateGoMod;
          } else {
            fn = updatePyprojectToml;
          }

          const fileContent = (mode === "go") ? readFileSync(filePerMode[mode], "utf8") : pkgStrs[mode];
          write(filePerMode[mode], fn(fileContent, deps[mode]));
          console.info(green(`✨ ${basename(filePerMode[mode])} updated`));
        } catch (err) {
          throw new Error(`Error writing ${basename(filePerMode[mode])}: ${(err as Error).message}`);
        }
      }
    }
  }

  await end(undefined, exitCode);
}

try {
  await main();
} catch (err) {
  await end(err);
}
