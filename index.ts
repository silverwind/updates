#!/usr/bin/env node
import {cwd, stdout, stderr, env, exit, platform, versions} from "node:process";
import {join, dirname, basename, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {lstatSync, readFileSync, readdirSync, truncateSync, writeFileSync, accessSync, globSync, type Stats} from "node:fs";
import {execFile as execFileCb} from "node:child_process";
import {stripVTControlCharacters, styleText, parseArgs, promisify, type ParseArgsOptionsConfig} from "node:util";

import pMap from "p-map";
import pkg from "./package.json" with {type: "json"};
import {parse, coerce, diff, gt, gte, lt, neq, valid, validRange, satisfies} from "./utils/semver.ts";
import {timerel} from "timerel";
import {npmTypes, poetryTypes, uvTypes, goTypes, parseUvDependencies, nonPackageEngines} from "./utils/utils.ts";
import {enableDnsCache} from "./utils/dns.ts";
import rc from "./utils/rc.ts";

const execFile = promisify(execFileCb);

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
  /** Pin packages to semver ranges */
  pin?: Record<string, string>,
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
  pinnedRange?: string,
};

type FindNewVersionOpts = {
  mode: string,
  range: string,
  usePre: boolean,
  useRel: boolean,
  useGreatest: boolean,
  semvers: Set<string>,
  pinnedRange?: string,
};

// regexes for url dependencies. does only github and only hash or exact semver
// https://regex101.com/r/gCZzfK/2
const stripRe = /^.*?:\/\/(.*?@)?(github\.com[:/])/i;
const partsRe = /^([^/]+)\/([^/#]+)?.*?\/([0-9a-f]+|v?[0-9]+\.[0-9]+\.[0-9]+)$/i;
const hashRe = /^[0-9a-f]{7,}$/i;
const npmVersionRe = /[0-9]+(\.[0-9]+)?(\.[0-9]+)?/g;
const npmVersionRePre = /[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g;
const actionsUsesRe = /^\s*-?\s*uses:\s*['"]?([^'"#\s]+)['"]?/gm;
const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const normalizeUrl = (url: string) => url.endsWith("/") ? url.substring(0, url.length - 1) : url;
const packageVersion = pkg.version;
const fieldSep = "\0";

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
const fetchTimeout = 5000;
const goProbeTimeout = 2500;

function resolveGoProxy(): string {
  const proxyEnv = env.GOPROXY || "https://proxy.golang.org,direct";
  for (const entry of proxyEnv.split(/[,|]/)) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "direct" && trimmed !== "off") {
      return normalizeUrl(trimmed);
    }
  }
  return "https://proxy.golang.org";
}

function parseGoNoProxy(): Array<string> {
  const value = env.GONOPROXY || env.GOPRIVATE || "";
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

function isGoNoProxy(modulePath: string): boolean {
  return goNoProxy.some(pattern => modulePath === pattern || modulePath.startsWith(`${pattern}/`));
}

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
let npmrc: Npmrc | null = null;

const authCache = new Map<string, AuthAndRegistry>();

function getNpmrc(): Npmrc {
  if (npmrc) return npmrc;
  return rc("npm", {registry: defaultRegistry}) as Npmrc;
}

function replaceEnvVar(token: string): string {
  return token.replace(/^\$\{?([^}]*)\}?$/, (_, envVar) => env[envVar] || "");
}

function getAuthInfoForUrl(regUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  // Bearer token
  const bearerToken = config[`${regUrl}:_authToken`] || config[`${regUrl}/:_authToken`];
  if (bearerToken) return {token: replaceEnvVar(bearerToken), type: "Bearer"};

  // Basic auth (username + password)
  const username = config[`${regUrl}:username`] || config[`${regUrl}/:username`];
  const password = config[`${regUrl}:_password`] || config[`${regUrl}/:_password`];
  if (username && password) {
    const pass = Buffer.from(replaceEnvVar(password), "base64").toString("utf8");
    return {token: Buffer.from(`${username}:${pass}`).toString("base64"), type: "Basic", username, password: pass};
  }

  // Legacy auth token
  const legacyToken = config[`${regUrl}:_auth`] || config[`${regUrl}/:_auth`];
  if (legacyToken) return {token: replaceEnvVar(legacyToken), type: "Basic"};

  return undefined;
}

function getRegistryAuthToken(registryUrl: string, config: Npmrc): AuthAndRegistry["auth"] {
  const parsed = new URL(registryUrl.startsWith("//") ? `http:${registryUrl}` : registryUrl);
  let pathname: string | undefined;

  while (pathname !== "/" && parsed.pathname !== pathname) {
    pathname = parsed.pathname || "/";
    const regUrl = `//${parsed.host}${pathname.replace(/\/$/, "")}`;
    const authInfo = getAuthInfoForUrl(regUrl, config);
    if (authInfo) return authInfo;
    const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
    parsed.pathname = new URL("..", new URL(normalized, "http://x")).pathname;
  }

  // Global legacy fallback
  const globalAuth = config["_auth"];
  if (globalAuth) return {token: replaceEnvVar(globalAuth), type: "Basic"};
  return undefined;
}

function getAuthAndRegistry(name: string, registry: string): AuthAndRegistry {
  if (!npmrc) npmrc = getNpmrc();

  const scope = name.startsWith("@") ? (/@[a-z0-9][\w-.]+/.exec(name) || [""])[0] : "";
  const cacheKey = `${scope}:${registry}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached;

  let result: AuthAndRegistry;
  if (!name.startsWith("@")) {
    result = {auth: getRegistryAuthToken(registry, npmrc), registry};
  } else {
    const url = normalizeUrl(registryUrl(scope, npmrc));
    if (url !== registry) {
      try {
        const newAuth = getRegistryAuthToken(url, npmrc);
        result = newAuth?.token ? {auth: newAuth, registry: url} : {auth: getRegistryAuthToken(registry, npmrc), registry};
      } catch {
        result = {auth: getRegistryAuthToken(registry, npmrc), registry};
      }
    } else {
      result = {auth: getRegistryAuthToken(registry, npmrc), registry};
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
  if (!npmrc) npmrc = getNpmrc();
  const originalRegistry = normalizeUrl((typeof args.registry === "string" ? args.registry : false) ||
    config.registry || npmrc.registry || defaultRegistry,
  );

  const {auth, registry} = getAuthAndRegistry(name, originalRegistry);
  const packageName = type === "resolutions" ? basename(name) : name;
  const url = `${registry}/${packageName.replace(/\//g, "%2f")}`;

  const res = await doFetch(url, {signal: AbortSignal.timeout(fetchTimeout), ...getFetchOpts(auth?.type, auth?.token)});
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

  const res = await doFetch(url, {signal: AbortSignal.timeout(fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}});
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

function isJsr(value: string): boolean {
  return value.startsWith("npm:@jsr/") || value.startsWith("jsr:");
}

// - "npm:@jsr/std__semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:@std/semver@1.0.5" -> { scope: "std", name: "semver", version: "1.0.5" }
// - "jsr:1.0.5" (when package name is known) -> { scope: null, name: null, version: "1.0.5" }
function parseJsrDependency(value: string, packageName?: string): {scope: string | null, name: string | null, version: string} {
  if (value.startsWith("npm:@jsr/")) {
    // npm:@jsr/std__semver@1.0.5
    const match = /^npm:@jsr\/([^_]+)__([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:@")) {
    // jsr:@std/semver@1.0.5
    const match = /^jsr:@([^/]+)\/([^@]+)@(.+)$/.exec(value);
    if (match) {
      return {scope: match[1], name: match[2], version: match[3]};
    }
  } else if (value.startsWith("jsr:")) {
    // jsr:1.0.5
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

async function fetchJsrInfo(packageName: string, type: string): Promise<PackageInfo> {
  const match = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (!match) {
    throw new Error(`Invalid JSR package name: ${packageName}`);
  }
  const [, scope, name] = match;
  const url = `${jsrApiUrl}/@${scope}/${name}/meta.json`;

  const res = await doFetch(url, {signal: AbortSignal.timeout(fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}});
  if (res?.ok) {
    const data = await res.json();
    // Transform JSR format to match npm-like format for compatibility
    const versions: Record<string, any> = {};
    const time: Record<string, string> = {};
    for (const [version, metadata] of Object.entries(data.versions as Record<string, any>)) {
      versions[version] = {
        version,
        time: metadata.createdAt,
      };
      time[version] = metadata.createdAt;
    }
    const transformedData = {
      name: packageName,
      "dist-tags": {
        latest: data.latest,
      },
      versions,
      time,
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

function encodeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

function extractGoMajor(name: string): number {
  const match = /\/v(\d+)$/.exec(name);
  return match ? parseInt(match[1]) : 1;
}

function buildGoModulePath(name: string, major: number): string {
  if (major <= 1) return name.replace(/\/v\d+$/, "");
  return `${name.replace(/\/v\d+$/, "")}/v${major}`;
}

// TODO: maybe include pseudo-versions with --prerelease
function isGoPseudoVersion(version: string): boolean {
  return /\d{14}-[0-9a-f]{12}$/.test(version);
}

function parseGoMod(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  let inRequire = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^require\s*\(/.test(trimmed)) { inRequire = true; continue; }
    if (trimmed === ")") { inRequire = false; continue; }

    if (trimmed.includes("// indirect")) continue;

    const match = inRequire ?
      /^(\S+)\s+(v\S+)/.exec(trimmed) :
      /^require\s+(\S+)\s+(v\S+)/.exec(trimmed);

    if (match) {
      deps[match[1]] = match[2];
    }
  }
  return deps;
}

async function fetchGoVcsInfo(name: string, type: string, currentVersion: string, goCwd: string): Promise<PackageInfo> {
  const noUpdate: PackageInfo = [{name, old: currentVersion, new: currentVersion}, type, null, name];
  const currentMajor = extractGoMajor(name);

  const goListQuery = async (modulePath: string, timeout: number) => {
    try {
      const {stdout} = await execFile("go", ["list", "-m", "-json", `${modulePath}@latest`], {
        timeout,
        cwd: goCwd,
        env,
      });
      const data = JSON.parse(stdout) as {Version: string, Time?: string};
      return {Version: data.Version, Time: data.Time || "", path: modulePath};
    } catch {
      return null;
    }
  };

  // Fetch @latest and first major probe in parallel
  const [latest, firstProbe] = await Promise.all([
    goListQuery(name, fetchTimeout),
    goListQuery(buildGoModulePath(name, currentMajor + 1), goProbeTimeout),
  ]);
  if (!latest) return noUpdate;

  const latestVersion = latest.Version;
  const latestTime = latest.Time;
  let highestVersion = latestVersion;
  let highestTime = latestTime;
  let highestPath = name;

  const applyProbe = (data: {Version: string, Time: string, path: string}) => {
    highestVersion = data.Version;
    highestTime = data.Time;
    highestPath = data.path;
  };

  if (firstProbe) {
    applyProbe(firstProbe);
    const second = await goListQuery(buildGoModulePath(name, currentMajor + 2), goProbeTimeout);
    if (second) {
      applyProbe(second);
      const probeBatchSize = 20;
      for (let batchStart = currentMajor + 3; batchStart <= currentMajor + 100; batchStart += probeBatchSize) {
        const batchEnd = Math.min(batchStart + probeBatchSize, currentMajor + 101);
        const probes = Array.from({length: batchEnd - batchStart}, (_, i) =>
          goListQuery(buildGoModulePath(name, batchStart + i), goProbeTimeout),
        );
        const results = await Promise.all(probes);
        let foundInBatch = false;
        for (const result of results) {
          if (!result) break;
          applyProbe(result);
          foundInBatch = true;
        }
        if (!foundInBatch || results.some(r => !r)) break;
      }
    }
  }

  return [{
    name,
    old: currentVersion,
    new: stripv(highestVersion),
    Time: highestTime,
    ...(highestPath !== name ? {newPath: highestPath} : {}),
    sameMajorNew: stripv(latestVersion),
    sameMajorTime: latestTime,
  }, type, null, name];
}

async function fetchGoProxyInfo(name: string, type: string, currentVersion: string, goCwd: string): Promise<PackageInfo> {
  const noUpdate: PackageInfo = [{name, old: currentVersion, new: currentVersion}, type, null, name];

  if (isGoNoProxy(name)) return fetchGoVcsInfo(name, type, currentVersion, goCwd);

  const encoded = encodeGoModulePath(name);
  const currentMajor = extractGoMajor(name);
  const probeGoMajor = async (major: number) => {
    const path = buildGoModulePath(name, major);
    return doFetch(`${goProxyUrl}/${encodeGoModulePath(path)}/@latest`, {signal: AbortSignal.timeout(goProbeTimeout)})
      .then(async (r) => r.ok ? {...await r.json() as {Version: string, Time: string}, path} : null)
      .catch(() => null);
  };

  // Fetch @latest and first major probe in parallel
  const [res, firstProbe] = await Promise.all([
    doFetch(`${goProxyUrl}/${encoded}/@latest`, {signal: AbortSignal.timeout(fetchTimeout)}),
    probeGoMajor(currentMajor + 1),
  ]);
  if (!res.ok) return noUpdate;

  let latestVersion: string;
  let latestTime: string;
  try {
    const data = await res.json() as {Version: string, Time: string};
    latestVersion = data.Version;
    latestTime = data.Time;
  } catch {
    return noUpdate;
  }

  // Probe for major version upgrades
  let highestVersion = latestVersion;
  let highestTime = latestTime;
  let highestPath = name;
  const applyProbe = (data: {Version: string, Time: string, path: string}) => {
    highestVersion = data.Version;
    highestTime = data.Time;
    highestPath = data.path;
  };

  if (firstProbe) {
    applyProbe(firstProbe);
    const second = await probeGoMajor(currentMajor + 2);
    if (second) {
      applyProbe(second);
      // Multiple consecutive majors, probe further in parallel batches
      const probeBatchSize = 20;
      for (let batchStart = currentMajor + 3; batchStart <= currentMajor + 100; batchStart += probeBatchSize) {
        const batchEnd = Math.min(batchStart + probeBatchSize, currentMajor + 101);
        const probes = Array.from({length: batchEnd - batchStart}, (_, i) => ({
          result: probeGoMajor(batchStart + i),
        }));
        const results = await Promise.all(probes.map(p => p.result));
        let foundInBatch = false;
        for (const result of results) {
          if (!result) break;
          applyProbe(result);
          foundInBatch = true;
        }
        if (!foundInBatch || results.some(r => !r)) break;
      }
    }
  }

  return [{
    name,
    old: currentVersion,
    new: stripv(highestVersion),
    Time: highestTime,
    ...(highestPath !== name ? {newPath: highestPath} : {}),
    sameMajorNew: stripv(latestVersion),
    sameMajorTime: latestTime,
  }, type, null, name];
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

function updatePackageJson(pkgStr: string, deps: Deps): string {
  let newPkgStr = pkgStr;
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [depType, name] = key.split(fieldSep);
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
    const [_depType, name] = key.split(fieldSep);
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

function removeGoReplace(content: string, name: string): string {
  const e = esc(name);
  // Remove single-line: replace <name> [version] => <replacement> [version]
  content = content.replace(new RegExp(`^replace\\s+${e}(\\s+v\\S+)?\\s+=>\\s+\\S+(\\s+v\\S+)?\\s*\\n`, "gm"), "");
  // Remove entry from replace block
  content = content.replace(new RegExp(`^\\s+${e}(\\s+v\\S+)?\\s+=>\\s+\\S+(\\s+v\\S+)?\\s*\\n`, "gm"), "");
  // Remove empty replace blocks
  content = content.replace(/^replace\s*\(\s*\)\s*\n/gm, "");
  return content;
}

function updateGoMod(pkgStr: string, deps: Deps): [string, Record<string, string>] {
  let newPkgStr = pkgStr;
  const majorVersionRewrites: Record<string, string> = {};
  for (const [key, {old, oldOrig}] of Object.entries(deps)) {
    const [_depType, name] = key.split(fieldSep);
    const oldValue = oldOrig || old;
    const newValue = deps[key].new;
    const oldMajor = extractGoMajor(name);
    const newMajor = parseInt(newValue.split(".")[0]);

    if (oldMajor !== newMajor && newMajor > 1) {
      const newPath = buildGoModulePath(name, newMajor);
      newPkgStr = newPkgStr.replace(new RegExp(`${esc(name)} +v${esc(oldValue)}`, "g"), `${newPath} v${newValue}`);
      majorVersionRewrites[name] = newPath;
    } else {
      newPkgStr = newPkgStr.replace(new RegExp(`(${esc(name)}) +v${esc(oldValue)}`, "g"), `$1 v${newValue}`);
    }
    newPkgStr = removeGoReplace(newPkgStr, name);
  }
  return [newPkgStr, majorVersionRewrites];
}

function rewriteGoImports(projectDir: string, majorVersionRewrites: Record<string, string>): void {
  if (!Object.keys(majorVersionRewrites).length) return;
  const goFiles = globSync("**/*.go", {cwd: projectDir});
  for (const relPath of goFiles) {
    const filePath = join(projectDir, relPath);
    let content = readFileSync(filePath, "utf8");
    let changed = false;
    for (const [oldPath, newPath] of Object.entries(majorVersionRewrites)) {
      const re = new RegExp(`"${esc(oldPath)}(/|")`, "g");
      const replaced = content.replace(re, `"${newPath}$1`);
      if (replaced !== content) {
        content = replaced;
        changed = true;
      }
    }
    if (changed) {
      write(filePath, content);
    }
  }
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

function findVersion(data: any, versions: Array<string>, {range, semvers, usePre, useRel, useGreatest, pinnedRange}: FindVersionOpts): string | null {
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

    // If a pinned range is specified, only consider versions that satisfy it
    if (pinnedRange && !satisfies(candidateVersion, pinnedRange)) continue;

    const d = diff(newVersion, candidateVersion);
    if (!d || !semvers.has(d)) continue;

    // some registries like github don't have data.time available, fall back to greatest on them
    if (useGreatest || !("time" in data)) {
      if (gte(coerceToVersion(candidateVersion), newVersion)) {
        newVersion = candidateVersion;
      }
    } else {
      const date = Date.parse(data.time[version]);
      if (date >= 0 && date > greatestDate) {
        newVersion = candidateVersion;
        greatestDate = date;
      }
    }
  }

  return newVersion || null;
}

function findNewVersion(data: any, {mode, range, useGreatest, useRel, usePre, semvers, pinnedRange}: FindNewVersionOpts): string | null {
  if (range === "*") return null; // ignore wildcard
  if (range.includes("||")) return null; // ignore or-chains

  let versions: Array<string> = [];
  if (mode === "pypi") {
    versions = Object.keys(data.releases).filter((version: string) => valid(version));
  } else if (mode === "npm") {
    versions = Object.keys(data.versions).filter((version: string) => valid(version));
  } else if (mode === "go") {
    const oldVersion = coerceToVersion(range);
    if (!oldVersion) return null;
    const effectiveUsePre = usePre || isRangePrerelease(range);
    const skipPrerelease = (v: string) => isVersionPrerelease(v) && (!effectiveUsePre || useRel);

    // Check cross-major upgrade
    const crossVersion = coerceToVersion(data.new);
    if (crossVersion && !isGoPseudoVersion(data.new) && !skipPrerelease(data.new)) {
      const d = diff(oldVersion, crossVersion);
      if (d && semvers.has(d)) {
        return data.new;
      }
    }

    // Fall back to same-major upgrade
    const sameVersion = coerceToVersion(data.sameMajorNew);
    if (sameVersion && !isGoPseudoVersion(data.sameMajorNew) && !skipPrerelease(data.sameMajorNew)) {
      const d = diff(oldVersion, sameVersion);
      if (d && semvers.has(d)) {
        data.Time = data.sameMajorTime;
        delete data.newPath;
        return data.sameMajorNew;
      }
    }

    return null;
  }
  const version = findVersion(data, versions, {range, semvers, usePre, useRel, useGreatest, pinnedRange});
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

    // If a pinned range is specified and latestTag doesn't satisfy it, return version
    if (pinnedRange && !satisfies(latestTag, pinnedRange)) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return originalLatestTag || latestTag;
  }
}

const forgeTokensByHost = new Map<string, string>();
if (env.UPDATES_FORGE_TOKENS) {
  for (const entry of env.UPDATES_FORGE_TOKENS.split(",")) {
    const sep = entry.indexOf(":");
    if (sep > 0) {
      forgeTokensByHost.set(entry.substring(0, sep), entry.substring(sep + 1));
    }
  }
}

function getForgeToken(url: string): string | undefined {
  try {
    const hostToken = forgeTokensByHost.get(new URL(url).hostname);
    if (hostToken) return hostToken;
  } catch {}
  return env.UPDATES_GITHUB_API_TOKEN || env.GITHUB_API_TOKEN ||
    env.GH_TOKEN || env.GITHUB_TOKEN || env.HOMEBREW_GITHUB_API_TOKEN;
}

function fetchForge(url: string): Promise<Response> {
  const opts: RequestInit = {signal: AbortSignal.timeout(fetchTimeout), headers: {"accept-encoding": "gzip, deflate, br"}};
  const token = getForgeToken(url);
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
  const res = await fetchForge(`${forgeApiUrl}/repos/${user}/${repo}/commits`);
  if (!res?.ok) return {hash: "", commit: {}};
  const data = await res.json();
  const {sha: hash, commit} = data[0];
  return {hash, commit};
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

type ActionRef = {
  host: string | null,
  owner: string,
  repo: string,
  ref: string,
  name: string,
  isHash: boolean,
};

function parseActionRef(uses: string): ActionRef | null {
  if (uses.startsWith("docker://") || uses.startsWith("./")) return null;
  const urlMatch = /^https?:\/\/([^/]+)\/(.+)$/.exec(uses);
  const host = urlMatch?.[1] ?? null;
  const rest = urlMatch?.[2] ?? uses;
  const atIndex = rest.indexOf("@");
  if (atIndex === -1) return null;
  const pathPart = rest.substring(0, atIndex);
  const ref = rest.substring(atIndex + 1);
  if (!ref) return null;
  const segments = pathPart.split("/");
  if (segments.length < 2) return null;
  const name = host ? `${host}/${pathPart}` : pathPart;
  return {host, owner: segments[0], repo: segments[1], ref, name, isHash: hashRe.test(ref)};
}

function getForgeApiBaseUrl(host: string | null): string {
  if (!host) return forgeApiUrl;
  if (host === "github.com") return "https://api.github.com";
  return `https://${host}/api/v1`;
}

type TagEntry = {
  name: string,
  commitSha: string,
};

function parseTags(data: Array<any>): Array<TagEntry> {
  return data.map((tag: any) => ({name: tag.name, commitSha: tag.commit?.sha || ""}));
}

async function fetchActionTags(apiUrl: string, owner: string, repo: string): Promise<Array<TagEntry>> {
  const res = await fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100`);
  if (!res?.ok) return [];
  const results = parseTags(await res.json());
  const link = res.headers.get("link") || "";
  const last = /<([^>]+)>;\s*rel="last"/.exec(link);
  if (last) {
    const lastPage = Number(new URL(last[1]).searchParams.get("page"));
    const pages = await Promise.all(
      Array.from({length: lastPage - 1}, (_, i) => fetchForge(`${apiUrl}/repos/${owner}/${repo}/tags?per_page=100&page=${i + 2}`)),
    );
    for (const pageRes of pages) {
      if (pageRes?.ok) results.push(...parseTags(await pageRes.json()));
    }
  }
  return results;
}

async function getTags(user: string, repo: string): Promise<Array<string>> {
  const entries = await fetchActionTags(forgeApiUrl, user, repo);
  return entries.map(e => e.name);
}

async function fetchActionTagDate(apiUrl: string, owner: string, repo: string, commitSha: string): Promise<string> {
  const res = await fetchForge(`${apiUrl}/repos/${owner}/${repo}/git/commits/${commitSha}`);
  if (!res?.ok) return "";
  const data = await res.json();
  return data?.committer?.date || data?.author?.date || "";
}

function formatActionVersion(newFullVersion: string, oldRef: string): string {
  const hadV = oldRef.startsWith("v");
  const newParsed = parse(stripv(newFullVersion));
  const parts = stripv(oldRef).split(".").length;
  let bare: string;
  if (!newParsed) bare = stripv(newFullVersion);
  else if (parts === 1) bare = String(newParsed.major);
  else if (parts === 2) bare = `${newParsed.major}.${newParsed.minor}`;
  else bare = newParsed.version;
  return hadV ? `v${bare}` : bare;
}

function updateWorkflowFile(content: string, actionDeps: Array<{name: string, oldRef: string, newRef: string}>): string {
  let newContent = content;
  for (const {name, oldRef, newRef} of actionDeps) {
    const re = new RegExp(`(uses:\\s*['"]?)${esc(name)}@${esc(oldRef)}`, "g");
    newContent = newContent.replace(re, `$1${name}@${newRef}`);
  }
  return newContent;
}

function isWorkflowFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return /\.github\/workflows\/[^/]+\.(ya?ml)$/.test(normalized);
}

function resolveWorkflowFiles(dir: string): Array<string> {
  try {
    return readdirSync(dir).filter(f => /\.(ya?ml)$/.test(f)).map(f => resolve(join(dir, f)));
  } catch {
    return [];
  }
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
    -l, --pin <pkg=range>              Pin package to given semver range
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: ${maxSockets}
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
    $ updates -e react,react-dom
    $ updates -e '/^react-(dom)?/'
    $ updates -f package.json
    $ updates -f pyproject.toml
    $ updates -f go.mod
    $ updates -l typescript=^5.0.0
    $ updates -f .github/workflows
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

  const [files, explicitFiles] = resolveFiles(parseMixedArg(filesArg) as Set<string>);

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
        actionDepInfos.push({...action, key, apiUrl: getForgeApiBaseUrl(action.host)});
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
        pkg.deps = parseGoMod(pkgStrs[mode]);
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
          return fetchJsrInfo(name, type);
        }
        return fetchNpmInfo(name, type, config);
      } else if (mode === "go") {
        return fetchGoProxyInfo(name, type, deps[mode][key].oldOrig || deps[mode][key].old, projectDir);
      } else {
        return fetchPypiInfo(name, type);
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
      });

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
      const tags = await fetchActionTags(apiUrl, owner, repo);
      const tagNames = tags.map(t => t.name);
      const versions = tagNames.map(t => stripv(t)).filter(v => valid(v));

      const commitShaToTag = new Map<string, string>();
      for (const tag of tags) {
        if (tag.commitSha) commitShaToTag.set(tag.commitSha, tag.name);
      }

      const dateCache = new Map<string, string>();
      async function getDate(commitSha: string): Promise<string> {
        if (dateCache.has(commitSha)) return dateCache.get(commitSha)!;
        const date = await fetchActionTagDate(apiUrl, owner, repo, commitSha);
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
          rewriteGoImports(dirname(resolve(filePerMode[mode])), majorVersionRewrites);
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
