import {cwd, platform, stderr} from "node:process";
import {styleText} from "node:util";
import {join, dirname, basename, resolve} from "node:path";
import {statSync, readdirSync, realpathSync, truncateSync, writeFileSync, accessSync, type Stats} from "node:fs";
import {readFile} from "node:fs/promises";
import {parseToml} from "./utils/toml.ts";
import {githubActionsVersioning, validRange} from "./utils/semver.ts";
import {timerel} from "timerel";
import {npmTypes, uvTypes, goTypes, cargoTypes, cargoTargetTypes, expandDepTypes, parseUvDependencies, nonPackageEngines, parseDuration, parsePositiveInt, matchesAny, memoizeAsync, timestamp, forgeDirs, modeByFileName, pMap, pushTo, tryOrNull} from "./utils/utils.ts";
import {
  type Dep, type Deps, type DepsByMode, type Limiter, type Output as ModeOutput, type ModeContext,
  type PackageRepository, type PackageInfo, type TagEntry,
  fieldSep, normalizeUrl, fetchTimeout, goProbeTimeout, maxSockets,
  doFetch, fetchActionTags, findVersion, findNewVersion, getInfoUrl, getGithubTokens, getLimiter,
  passesCooldown, stripv, hashRe, isVersionLikeRef, defaultApiUrls,
} from "./modes/shared.ts";
import {flushCacheWrites} from "./utils/fetchCache.ts";
import {loadConfig, configMixedToRegexes, patternsToRegexSet, validatePin} from "./config.ts";
import type {Config, Override} from "./config.ts";
import {
  fetchNpmInfo, fetchNpmVersionInfo, fetchJsrInfo, isJsr, isLocalDep, isCatalogRef, parseJsrDependency, parseNpmAlias,
  getNpmrc, updatePackageJson, updateVersionRange, normalizeRange, checkUrlDep, resolutionsBasePackage, selectorTypes,
} from "./modes/npm.ts";
import {fetchPypiInfo, updatePyprojectToml, updateRequirement} from "./modes/pypi.ts";
import {
  resolveGoProxyChain, parseGoNoProxy,
  parseGoMod, parseGoWork, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, shortenGoVersion, shortenGoModule,
} from "./modes/go.ts";
import {
  type ActionRef,
  parseActionRef, parseUsesLine, getForgeApiBaseUrl,
  fetchActionTagDate, formatActionVersion,
  updateWorkflowFile, isWorkflowFile, resolveWorkflowFiles,
} from "./modes/actions.ts";
import {
  type DockerImageRef,
  parseDockerTag, extractDockerRefs, dockerImageNames,
  getExtractionRegex, isDockerfile, isDockerFileName, dockerExactFileNames,
  fetchDockerInfo, findDockerVersion, getDockerInfoUrl,
  updateDockerfile, updateComposeFile, updateWorkflowDockerImages,
  composeImageRe, workflowContainerRe, workflowDockerUsesRe,
} from "./modes/docker.ts";
import {
  type MakeRewrite,
  type MakeDockerImage,
  type MakeUpdate,
  type MakeDockerUpdate,
  isMakeFileName, makeExactFileNames, parseMakeGoInstalls, parseMakeDockerImages,
  fetchMakeInfo, fetchMakeDockerInfo, formatMakeImageSpec, updateMakefile,
} from "./modes/make.ts";
import {fetchCratesIoInfo, updateCargoToml, updateCargoRange, cargoToNpmRange, parseCargoLock, findLockedVersion} from "./modes/cargo.ts";
import {baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, pnpmCatalogEntries, updatePnpmWorkspace, type WorkspaceMember} from "./utils/workspace.ts";

/** A dependency whose lookup failed. Every other dependency is still resolved and written. */
export type DepError = {
  mode: string,
  /** The dependency type, or the file path for the file-scoped modes, as in `results` */
  type: string,
  name: string,
  error: string,
};

/** `errors` is absent unless a lookup failed, keeping a clean run's shape unchanged. */
export type Output = ModeOutput & {errors?: Array<DepError>};

export type {Config, Override, Dep, Deps, DepsByMode};

// Also the order rows print in, as file discovery finds a directory's manifests in readdir order and
// a walk up in modeByFileName order, which would otherwise print a project's modes either way round.
// The three that follow match a filename by pattern rather than by name, so the map does not hold them.
const modeOrder = [...new Set(Object.values(modeByFileName)), "actions", "docker", "make"];
const defaultModes = new Set(modeOrder);

// One read-only Set per precision, shared by every dependency instead of built
// per name. Sharing the identity also lets findVersion's prerelease-variant
// cache hit across packages rather than recomputing a variant set per package.
const semversByPrecision = {
  patch: new Set(["patch"]),
  minor: new Set(["patch", "minor"]),
  major: new Set(["patch", "minor", "major"]),
};

// Manifests that declare a workspace for their mode, and the plain manifest
// each supersedes in the same directory. Cargo is absent: it has no dedicated
// workspace filename, so it is detected by parsing Cargo.toml's content.
const workspaceManifests: Record<string, {mode: string, supersedes: string}> = {
  "go.work": {mode: "go", supersedes: "go.mod"},
  "pnpm-workspace.yaml": {mode: "npm", supersedes: "package.json"},
};

const apiUrl = (val: unknown, dflt: string | (() => string)) => typeof val === "string" ? normalizeUrl(val) : (typeof dflt === "function" ? dflt() : dflt);

// Splits a jsr specifier into its `npm:@jsr/pkg@` / `jsr:@scope/pkg@` prefix and version.
const jsrSpecifierRe = /^(npm:@jsr\/[^@]+@|jsr:@[^@]+@)(.+)$/;

function findUpSync(filenames: string[], dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const remaining = new Set(filenames);
  let cur = dir;
  while (remaining.size) {
    for (const filename of remaining) {
      const path = join(cur, filename);
      try { accessSync(path); found.set(filename, path); remaining.delete(filename); } catch {}
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

async function prefetchFiles(files: Iterable<string>, concurrency: number): Promise<Map<string, string>> {
  const entries = await pMap(files, async (file): Promise<[string, string]> => {
    try {
      return [file, await readFile(file, "utf8")];
    } catch (err) {
      throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
    }
  }, {concurrency});
  return new Map(entries);
}

function setDepAge(dep: Dep, date: string): void {
  if (date) {
    dep.date = date;
    dep.age = timerel(date, {noAffix: true, shortUnits: true});
  }
}

const depKey = (depType: string, typePrefix: string, name: string) => `${depType}${typePrefix}${fieldSep}${name}`;

const countDeps = (deps: DepsByMode) => Object.values(deps).reduce((num, modeDeps) => num + Object.keys(modeDeps).length, 0);

const normalizePep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

// The spellings a dep answers to, so include/exclude patterns, overrides and pin keys
// all match on the same set regardless of which one the manifest happens to use.
function depNames(name: string, kind: string): Array<string> {
  if (kind === "go") return [name, shortenGoModule(name)];
  if (kind === "docker") return dockerImageNames(name);
  return [name];
}

const pinNameFor = (pin: Record<string, string>, names: Array<string>) => names.find(name => pin[name]);

// `kind` selects the name spellings and defaults to `mode`. Make manifests hold both go
// and docker deps, so those call sites pass it rather than claiming to be another mode.
function canInclude(name: string, mode: string, include: Set<RegExp>, exclude: Set<RegExp>, depType: string, kind: string = mode): boolean {
  if (depType === "engines" && nonPackageEngines.includes(name)) return false;
  if (mode === "pypi" && name === "python") return false;
  if (!include.size && !exclude.size) return true;
  const names = depNames(name, kind);
  for (const re of exclude) {
    if (names.some(n => re.test(n))) return false;
  }
  for (const re of include) {
    if (names.some(n => re.test(n))) return true;
  }
  return !include.size;
}

function resolveFiles(filesArg: Set<string> | false): Set<string> {
  const resolvedFiles = new Set<string>();

  if (filesArg) {
    for (const arg of filesArg) {
      let stat: Stats;
      try {
        stat = statSync(arg);
      } catch (err) {
        throw new Error(`Unable to open ${arg}: ${(err as Error).message}`);
      }
      // A symlink is the file it points at, which is also the spelling whose name selects a mode:
      // an argument naming both collapses here rather than being collected twice, and `link.json`
      // pointing at a `package.json` is the manifest it resolves to, as the auto-discovery branch
      // below already treats a real path as the file's identity.
      let file = resolve(arg);
      try { file = realpathSync.native(arg); } catch {}

      if (stat.isFile()) {
        resolvedFiles.add(file);
      } else if (stat.isDirectory()) {
        try {
          for (const entry of readdirSync(file, {withFileTypes: true})) {
            if (!entry.isFile()) continue;
            if (Object.hasOwn(modeByFileName, entry.name) || isDockerFileName(entry.name) || isMakeFileName(entry.name)) {
              resolvedFiles.add(resolve(join(file, entry.name)));
            }
          }
        } catch {}
        const normalized = file.replace(/\\/g, "/");
        const endsInWorkflowsDir = forgeDirs.some(forgeDir => normalized.endsWith(`/${forgeDir}/workflows`));
        const endsInForgeDir = !endsInWorkflowsDir && forgeDirs.some(forgeDir => normalized.endsWith(`/${forgeDir}`));
        const forgeDirCandidates: Array<string> = endsInWorkflowsDir ? [dirname(normalized)] :
          endsInForgeDir ? [normalized] :
            forgeDirs.map(forgeDir => join(normalized, forgeDir));
        for (const forgeDir of forgeDirCandidates) {
          for (const workflow of resolveWorkflowFiles(forgeDir)) resolvedFiles.add(workflow);
        }
      } else {
        throw new Error(`${arg} is neither a file nor directory`);
      }
    }
  } else {
    const forgeDirSet = new Set<string>(forgeDirs);
    const candidates = [...Object.keys(modeByFileName), ...dockerExactFileNames, ...makeExactFileNames, ...forgeDirs];
    // `Makefile` and `makefile` are both candidates and a case-insensitive filesystem opens
    // either, so the real path's on-disk spelling is what stops one file being found twice.
    const realPaths = new Set<string>();
    for (const [filename, path] of findUpSync(candidates, cwd())) {
      if (forgeDirSet.has(filename)) {
        for (const wf of resolveWorkflowFiles(path)) resolvedFiles.add(wf);
        continue;
      }
      let realPath = resolve(path);
      try { realPath = realpathSync.native(path); } catch {}
      if (realPaths.has(realPath)) continue;
      realPaths.add(realPath);
      resolvedFiles.add(resolve(path));
    }
    try {
      for (const entry of readdirSync(cwd(), {withFileTypes: true})) {
        const isExtraDocker = isDockerFileName(entry.name) && !dockerExactFileNames.includes(entry.name);
        const isExtraMake = isMakeFileName(entry.name) && !makeExactFileNames.includes(entry.name);
        if (entry.isFile() && (isExtraDocker || isExtraMake)) {
          resolvedFiles.add(resolve(join(cwd(), entry.name)));
        }
      }
    } catch {}
  }

  // A workspace manifest is processed before the plain manifests of its mode: a run started inside
  // a member finds that member's own file first, which would then be collected a second time.
  const workspaceFiles: Array<string> = [];
  for (const file of Array.from(resolvedFiles)) {
    const filename = basename(file);
    if (!Object.hasOwn(workspaceManifests, filename)) continue;
    workspaceFiles.push(file);
    resolvedFiles.delete(join(dirname(file), workspaceManifests[filename].supersedes));
  }

  return workspaceFiles.length ? new Set([...workspaceFiles, ...resolvedFiles]) : resolvedFiles;
}

// preserve file metadata on windows
function write(file: string, content: string): void {
  if (platform === "win32") truncateSync(file, 0);
  writeFileSync(file, content, platform === "win32" ? {flag: "r+"} : undefined);
}

// `results` holds one entry per name, so a name a file references twice gets its authored ref appended.
const rowId = (mode: string, key: string) => `${mode}${fieldSep}${key.split(fieldSep, 2).join(fieldSep)}`;

function buildOutput(deps: DepsByMode): Output {
  const output: Output = {results: {}};
  const rowsPerName = new Map<string, number>();
  const modes = Object.entries(deps).sort(([a], [b]) => modeOrder.indexOf(a) - modeOrder.indexOf(b));
  for (const [mode, modeDeps] of modes) {
    for (const key of Object.keys(modeDeps)) {
      const id = rowId(mode, key);
      rowsPerName.set(id, (rowsPerName.get(id) ?? 0) + 1);
    }
  }
  for (const [mode, modeDeps] of modes) {
    for (const [key, props] of Object.entries(modeDeps)) {
      if (typeof props.oldPrint === "string") props.old = props.oldPrint;
      if (typeof props.newPrint === "string") props.new = props.newPrint;
      if (typeof props.oldOrig === "string" && !isJsr(props.oldOrig)) {
        props.old = mode === "go" ? shortenGoVersion(props.oldOrig) : props.oldOrig;
      }
      if (mode === "go") props.new = shortenGoVersion(props.new);
      else if (mode === "actions") {
        props.old = stripv(props.old);
        props.new = stripv(props.new);
      }
      delete props.oldPrint;
      delete props.newPrint;
      delete props.oldOrig;
      delete props.date;

      const [type, name, ref] = key.split(fieldSep);
      const label = ref && rowsPerName.get(rowId(mode, key))! > 1 ?
        `${name}${mode === "actions" ? "@" : ":"}${ref}` : name;
      const r = output.results[mode] ??= {};
      (r[type] ??= {})[label] = props;
    }
  }
  // Names sort within their type, as a reader scans for a name, not for the section it was authored in.
  // By code unit: localeCompare would load ICU, and order by the machine's locale.
  for (const modeResults of Object.values(output.results)) {
    for (const [type, typeDeps] of Object.entries(modeResults)) {
      modeResults[type] = Object.fromEntries(Object.entries(typeDeps).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
  }
  return output;
}

export type UpdatesOptions = Config & {
  /** Override GitHub/Gitea API URL (for testing) */
  forgeapi?: string;
  /** Override PyPI API URL (for testing) */
  pypiapi?: string;
  /** Override JSR API URL (for testing) */
  jsrapi?: string;
  /** Override Go proxy URL (for testing) */
  goproxy?: string;
  /** Override crates.io API URL (for testing) */
  cargoapi?: string;
  /** Override Docker Hub API URL (for testing) */
  dockerapi?: string;
};

let dnsCacheEnabled = false;

export async function updates(opts: UpdatesOptions = {}): Promise<Output> {
  if (!dnsCacheEnabled) {
    const {enableDnsCache} = await import("./utils/dns.ts");
    enableDnsCache();
    dnsCacheEnabled = true;
  }

  const config: Config = {...opts};
  if (typeof config.timeout === "number") config.timeout = parsePositiveInt(config.timeout, "timeout");

  const concurrency = config.sockets ?? maxSockets;
  const userTimeout = config.timeout ?? 0;
  const forgeApiUrl = apiUrl(opts.forgeapi, defaultApiUrls.forgeapi);
  const pypiApiUrl = apiUrl(opts.pypiapi, defaultApiUrls.pypiapi);
  const jsrApiUrl = apiUrl(opts.jsrapi, defaultApiUrls.jsrapi);
  const goProxyChain = resolveGoProxyChain(opts.goproxy);
  const goProxyUrl = goProxyChain[0].url;
  const cratesIoUrl = apiUrl(opts.cargoapi, defaultApiUrls.cargoapi);
  const dockerApiUrl = apiUrl(opts.dockerapi, defaultApiUrls.dockerapi);
  const goNoProxy = parseGoNoProxy();

  const useVerboseColor = !config.noColor && (config.color || stderr.isTTY);
  // validateStream drops the codes when stderr is not a TTY, which is exactly what -c overrides.
  const colorFn = (color: "magenta" | "green" | "red") => useVerboseColor ? (text: string | number) => styleText(color, String(text), {validateStream: false}) : String;
  const magenta = colorFn("magenta");
  const vGreen = colorFn("green");
  const vRed = colorFn("red");

  let limit: Limiter | undefined;
  const ctx: ModeContext = {
    fetchTimeout: userTimeout || fetchTimeout,
    goProbeTimeout: userTimeout ? Math.max(1, Math.floor(userTimeout / 2)) : goProbeTimeout,
    concurrency,
    forgeApiUrl,
    pypiApiUrl,
    jsrApiUrl,
    goProxyUrl,
    goProxyChain,
    cratesIoUrl,
    dockerApiUrl,
    // `--sockets` is one budget for the run: this slot covers the go major probes, which reach
    // doFetch directly rather than through fetchWithRetry.
    doFetch: (url: string, fetchOpts?: RequestInit) => (limit ??= getLimiter(ctx))(async () => {
      if (config.verbose) console.error(`${timestamp()} ${magenta(fetchOpts?.method || "GET")} ${url}`);
      const res = await doFetch(url, fetchOpts);
      if (config.verbose) console.error(`${timestamp()} ${res.ok ? vGreen(res.status) : vRed(res.status)} ${url}`);
      return res;
    }),
    noCache: Boolean(config.noCache),
  };

  const greatest = configMixedToRegexes(config.greatest);
  const prerelease = configMixedToRegexes(config.prerelease);
  const release = configMixedToRegexes(config.release);
  const patch = configMixedToRegexes(config.patch);
  const minor = configMixedToRegexes(config.minor);
  const allowDowngrade = configMixedToRegexes(config.allowDowngrade);
  for (const mode of config.modes ?? []) {
    if (!defaultModes.has(mode)) throw new Error(`Invalid mode: ${mode}, expected one of: ${modeOrder.join(",")}`);
  }
  const enabledModes = config.modes?.length ? new Set(config.modes) : defaultModes;

  type CompiledOverride = {
    include?: Set<RegExp>, exclude?: Set<RegExp>,
    greatest?: boolean, prerelease?: boolean, release?: boolean,
    patch?: boolean, minor?: boolean, allowDowngrade?: boolean, cooldownDays?: number,
  };
  const compiledOverrides: Array<CompiledOverride> = (config.overrides ?? []).map(o => ({
    include: o.include?.length ? patternsToRegexSet(o.include) : undefined,
    exclude: o.exclude?.length ? patternsToRegexSet(o.exclude) : undefined,
    greatest: o.greatest, prerelease: o.prerelease, release: o.release,
    patch: o.patch, minor: o.minor, allowDowngrade: o.allowDowngrade,
    cooldownDays: o.cooldown !== undefined ? parseDuration(String(o.cooldown)) : undefined,
  }));
  const overrideMatches = (o: CompiledOverride, names: Array<string>): boolean => {
    if (o.include && names.every(n => !matchesAny(n, o.include!))) return false;
    return !o.exclude || names.every(n => !matchesAny(n, o.exclude!));
  };
  const overridesHaveCooldown = compiledOverrides.some(o => o.cooldownDays);

  // Kick off `gh auth token` early so the first forge request isn't blocked on a subprocess.
  if (enabledModes.has("actions")) getGithubTokens();

  const versionOptsCache = new Map<string, {names: Array<string>, useGreatest: boolean, usePre: boolean, useRel: boolean, semvers: Set<string>, allowDowngrade: boolean, cooldownOverride: number | undefined}>();

  // Resolve per-dependency options: start from the global flags, then apply
  // every matching override in order so the last matching one wins. cooldown is
  // returned as an override (undefined = no override) since its base differs per
  // mode. patch wins over minor, matching the global precedence.
  function getVersionOpts(kind: string, name: string) {
    // Keyed by kind too: a docker `redis` and an npm `redis` resolve different overrides.
    const cacheKey = `${kind}${fieldSep}${name}`;
    let entry = versionOptsCache.get(cacheKey);
    if (!entry) {
      const allNames = depNames(name, kind);
      const anyMatches = (set: Set<RegExp> | boolean) => allNames.some(n => matchesAny(n, set));
      let useGreatest = anyMatches(greatest);
      let usePre = anyMatches(prerelease);
      let useRel = anyMatches(release);
      let usePatch = anyMatches(patch);
      let useMinor = anyMatches(minor);
      let allowDown = anyMatches(allowDowngrade);
      let cooldownOverride: number | undefined;

      for (const o of compiledOverrides) {
        if (!overrideMatches(o, allNames)) continue;
        if (o.greatest !== undefined) useGreatest = o.greatest;
        if (o.prerelease !== undefined) usePre = o.prerelease;
        if (o.release !== undefined) useRel = o.release;
        if (o.patch !== undefined) usePatch = o.patch;
        if (o.minor !== undefined) useMinor = o.minor;
        if (o.allowDowngrade !== undefined) allowDown = o.allowDowngrade;
        if (o.cooldownDays !== undefined) cooldownOverride = o.cooldownDays;
      }

      const semvers = usePatch ? semversByPrecision.patch : useMinor ? semversByPrecision.minor : semversByPrecision.major;

      entry = {names: allNames, useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride};
      versionOptsCache.set(cacheKey, entry);
    }
    return entry;
  }

  const include = patternsToRegexSet(config.include ?? []);
  const exclude = patternsToRegexSet(config.exclude ?? []);
  validatePin(config.pin); // the CLI validates on parse, the programmatic caller has not
  const globalPin: Record<string, string> = config.pin ?? {};
  // A pin the user authored (CLI `-l`, the programmatic `pin`, `updates.config`) may move a
  // dependency down into its range; one inherited from renovate's allowedVersions is a ceiling
  // and only ever filters (utils/renovate.ts), so provenance decides per name.
  const resolvePin = (names: Array<string>, filePin: Record<string, string>, noDowngrade?: Config["pinNoDowngrade"]) => {
    const authored = pinNameFor(globalPin, names);
    if (authored) return {pinnedRange: globalPin[authored], pinNoDowngrade: false};
    const inherited = pinNameFor(filePin, names);
    return {
      pinnedRange: inherited ? filePin[inherited] : undefined,
      pinNoDowngrade: Boolean(inherited && Array.isArray(noDowngrade) && noDowngrade.includes(inherited)),
    };
  };

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const cargoCrates = new Map<string, string>();
  const npmAliases = new Map<string, {name: string, range: string}>();
  // so a version the pypi writer would decline to write is dropped before it is reported
  const pypiSpecs = new Map<string, string>();
  const errors: Array<DepError> = [];
  const addError = (mode: string, type: string, name: string, err: unknown) => {
    errors.push({mode, type, name, error: (err as Error)?.message || String(err)});
  };
  const addKeyError = (mode: string, key: string, err: unknown) => {
    const [type, name] = key.split(fieldSep);
    addError(mode, type, name, err);
  };
  type PlainFile = {absPath: string, content: string, memberPath: string, projectDir: string, modeConfig: Config, pin: Record<string, string>, modeCooldownDays: number};
  const plainFiles: Record<string, Array<PlainFile>> = {};
  const now = Date.now();
  const cooldownDaysFor = (local: Config["cooldown"]) => {
    const raw = config.cooldown ?? local;
    return raw ? parseDuration(String(raw)) : 0;
  };
  const cwdStr = cwd();
  const toRelPath = (absPath: string) => absPath.replace(`${cwdStr}/`, "").replace(`${cwdStr}\\`, "");

  const addDep = (mode: string, depType: string, typePrefix: string, name: string, old: string, oldOrig: string) => {
    deps[mode][depKey(depType, typePrefix, name)] = {old, oldOrig} as Dep;
  };

  const addNpmDep = (depType: string, typePrefix: string, name: string, value: string) => {
    // A catalog reference names a catalog, not a version: the range lives in pnpm-workspace.yaml,
    // which is where it is reported and rewritten, so the member has nothing to resolve.
    if (isCatalogRef(value)) return;
    const alias = parseNpmAlias(value);
    if (isJsr(value)) {
      addDep("npm", depType, typePrefix, name, parseJsrDependency(value, name).version, value);
    } else if (validRange(value)) {
      addDep("npm", depType, typePrefix, name, normalizeRange(value), value);
    } else if (alias) {
      npmAliases.set(depKey(depType, typePrefix, name), alias);
      addDep("npm", depType, typePrefix, name, normalizeRange(alias.range), value);
    } else if (isLocalDep(value)) {
      addDep("npm", depType, typePrefix, name, "0.0.0", value);
    } else {
      maybeUrlDeps[depKey(depType, typePrefix, name)] = {old: value} as Dep;
    }
  };

  // Only pypi has array-valued dep types; an array elsewhere is malformed, not indices to collect.
  const collectDeps = (mode: string, pkg: Record<string, any>, typePrefix: string, depTypes: Array<string>, modeInclude: Set<RegExp>, modeExclude: Set<RegExp>) => {
    // uv resolves a dep with a source of its own from git, a url, the filesystem or another index,
    // never from pypi.org, where the same name may well be someone else's package. The keys are
    // matched PEP 503-normalized, as `Flask-SQLAlchemy` and `flask_sqlalchemy` are one project.
    const uvSources = new Set(Object.keys(pkg.tool?.uv?.sources ?? {}).map(normalizePep503));
    const addUvDeps = (specs: Array<unknown>, depType: string) => {
      for (const {name, version, spec} of parseUvDependencies(specs)) {
        if (uvSources.has(normalizePep503(name))) continue;
        if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
          addDep(mode, depType, typePrefix, name, normalizeRange(version), version);
          pypiSpecs.set(depKey(depType, typePrefix, name), spec);
        }
      }
    };
    for (const [depType, table] of expandDepTypes(depTypes, pkg)) {
      const obj = table || {};
      if (Array.isArray(obj)) {
        if (mode !== "pypi") continue;
        addUvDeps(obj, depType);
      } else if (typeof obj === "string") {
        const [name, value] = obj.split("@");
        if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
          addDep(mode, depType, typePrefix, name, normalizeRange(value), value);
        }
      } else {
        const entries = Object.entries(obj as Record<string, any>);
        // npm's nested `overrides` object carries no version of its own. Renovate recurses into it,
        // which the writer's flat key scan cannot place a rewrite in, so it is skipped instead, and
        // a name it shadows is skipped with it rather than rewritten inside the nested copy.
        const nestedNames = new Set<string>();
        if (mode === "npm") {
          const collectNested = (value: any) => {
            if (!value || typeof value !== "object") return;
            for (const [key, inner] of Object.entries(value)) {
              nestedNames.add(key);
              collectNested(inner);
            }
          };
          for (const [, value] of entries) collectNested(value);
        }
        for (const [name, value] of entries) {
          // An explicit `-t project.optional-dependencies` lands here, and its keys name groups.
          if (mode === "pypi" && Array.isArray(value)) { addUvDeps(value, `${depType}.${name}`); continue; }
          if (typeof value !== "string" || nestedNames.has(name)) continue;
          if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
          if (mode === "npm") addNpmDep(depType, typePrefix, name, value);
          else if (mode === "go") addDep(mode, depType, typePrefix, name, shortenGoVersion(value), stripv(value));
          else if (validRange(value)) addDep(mode, depType, typePrefix, name, normalizeRange(value), value);
        }
      }
    }
  };

  const files = resolveFiles(config.files?.length ? new Set(config.files) : false);
  const fileApplies = (file: string): boolean => {
    if (isWorkflowFile(file)) return enabledModes.has("actions") || enabledModes.has("docker");
    const filename = basename(file);
    if (isDockerFileName(filename)) return enabledModes.has("docker");
    if (isMakeFileName(filename)) return enabledModes.has("make");
    const mode = modeByFileName[filename];
    return Boolean(mode) && enabledModes.has(mode);
  };
  const fileContents = await prefetchFiles(Array.from(files).filter(fileApplies), concurrency);

  const wfData: Record<string, {absPath: string, content: string}> = {};
  const dockerFileData: Record<string, {absPath: string, content: string, fileType: string}> = {};
  const makeFileData: Record<string, {absPath: string, content: string}> = {};

  type GoModFileInfo = {absPath: string, content: string, projectDir: string, memberPath: string};
  const goModFiles: GoModFileInfo[] = [];
  let goWorkData: {file: string, content: string} | null = null;

  const cargoMemberFiles: WorkspaceMember[] = [];
  const pnpmMemberFiles: WorkspaceMember[] = [];
  const pnpmCatalogFiles: WorkspaceMember[] = [];

  type ActionDepInfo = ActionRef & {
    key: string, apiUrl: string, filePin: Record<string, string>, filePinNoDowngrade: Config["pinNoDowngrade"], fileCooldownDays: number,
    comment: string, // the version the line's trailing comment names, empty when it names none
  };
  const actionDepInfos: Array<ActionDepInfo> = [];
  type DockerDepInfo = {
    key: string, fullImage: string, ref: DockerImageRef, filePin: Record<string, string>, fileCooldownDays: number,
  };
  const dockerDepInfos: Array<DockerDepInfo> = [];
  type MakeDepBase = {
    key: string, name: string, oldSpec: string, projectDir: string,
    filePin: Record<string, string>, filePinNoDowngrade: Config["pinNoDowngrade"], fileCooldownDays: number, newSpec?: string,
  };
  type MakeDepInfo = MakeDepBase & (
    {kind: "go", installPath: string, version: string} |
    {kind: "docker", image: MakeDockerImage}
  );
  const makeDepInfos: Array<MakeDepInfo> = [];
  type ModeCtx = {modeConfig: Config, projectDir: string, pin: Record<string, string>};
  const modeConfigs: Record<string, ModeCtx> = {};
  const presetFetch = {noCache: config.noCache, timeout: config.timeout || fetchTimeout};

  // Load a directory's config and merge its include/exclude patterns onto the
  // global ones. Callers differ only in how they use `pin` and `cooldown`.
  // Memoized per directory: sibling manifests and workflow/Dockerfile/Makefile
  // targets share a dir, and recompiling their regex sets per file is pure waste.
  const resolveDirConfig = memoizeAsync(async (dir: string) => {
    const dirConfig = await loadConfig(dir, presetFetch);
    return {
      dirConfig,
      include: dirConfig.include?.length ? patternsToRegexSet([...(config.include ?? []), ...dirConfig.include]) : include,
      exclude: dirConfig.exclude?.length ? patternsToRegexSet([...(config.exclude ?? []), ...dirConfig.exclude]) : exclude,
    };
  });

  async function resolveModeFilters(projectDir: string) {
    const {dirConfig, include: modeInclude, exclude: modeExclude} = await resolveDirConfig(projectDir);
    // The directory's own pins only; resolvePin consults globalPin first and by name.
    return {modeConfig: dirConfig, modeInclude, modeExclude, pin: dirConfig.pin ?? {}};
  }

  function resolveDepTypes(mode: string, modeConfig: Config): Array<string> {
    if (config.types?.length) return config.types;
    if (modeConfig?.types?.length) return modeConfig.types;
    if (mode === "npm") return npmTypes;
    if (mode === "pypi") return uvTypes;
    if (mode === "go") return config.indirect ? goTypes : goTypes.filter(t => t !== "indirect");
    // Target sections are only in the default list: an explicit `-t dependencies` asks for the
    // plain table and must not be widened onto every `[target.*]` one.
    if (mode === "cargo") return [...cargoTypes, ...cargoTargetTypes];
    return [];
  }

  type FileFilters = {include: Set<RegExp>, exclude: Set<RegExp>, pin: Record<string, string>, pinNoDowngrade: Config["pinNoDowngrade"], cooldownDays: number};

  function collectDockerRefs(content: string, relPath: string, regexes: Array<RegExp>, filters: FileFilters): void {
    deps.docker ??= {};
    for (const regex of regexes) {
      for (const {ref} of extractDockerRefs(content, regex)) {
        if (!canInclude(ref.fullImage, "docker", filters.include, filters.exclude, "docker")) continue;
        // The tag is part of the key: one image at two tags is two dependencies.
        const key = `${relPath}${fieldSep}${ref.fullImage}${fieldSep}${ref.tag}`;
        if (deps.docker[key]) continue;
        const parsed = parseDockerTag(ref.tag);
        if (!parsed) continue;
        deps.docker[key] = {old: parsed.version, oldOrig: ref.tag} as Dep;
        dockerDepInfos.push({
          key, fullImage: ref.fullImage, ref, filePin: filters.pin, fileCooldownDays: filters.cooldownDays,
        });
      }
    }
  }

  async function resolveFileConfig(fileDir: string): Promise<FileFilters> {
    const {dirConfig, include, exclude} = await resolveDirConfig(fileDir);
    return {
      include, exclude, pin: dirConfig.pin ?? {}, pinNoDowngrade: dirConfig.pinNoDowngrade,
      cooldownDays: cooldownDaysFor(dirConfig.cooldown),
    };
  }

  // A workspace manifest owns the empty dep-prefix for its mode, so plain ones must avoid the "."
  // memberPath. Determined up front to stay independent of file order.
  const workspaceModes = new Set<string>();
  const parsedCargoToml = new Map<string, Record<string, any>>();
  // A cargo workspace root shares its filename with its members, so resolveFiles cannot hoist it.
  // It has to run first all the same, or a member listed ahead of it is collected a second time.
  const cargoWorkspaceFiles: Array<string> = [];
  for (const file of files) {
    const filename = basename(file);
    if (Object.hasOwn(workspaceManifests, filename)) workspaceModes.add(workspaceManifests[filename].mode);
    else if (filename === "Cargo.toml") {
      const content = fileContents.get(file);
      if (!content) continue;
      try {
        const parsed = parseToml(content);
        parsedCargoToml.set(file, parsed);
        const members = (parsed.workspace as Record<string, any>)?.members;
        if (Array.isArray(members) && members.length) {
          workspaceModes.add("cargo");
          cargoWorkspaceFiles.push(file);
        }
      } catch {}
    }
  }

  // Register a non-workspace manifest and return the type prefix its deps use.
  // The first manifest of a mode keeps the "." memberPath (empty prefix) to preserve
  // the single-manifest output shape and seeds the mode-level default context; later
  // ones are disambiguated by their relative path so deps from distinct files never
  // collide.
  const addPlainFile = (mode: string, file: string, content: string, projectDir: string, modeConfig: Config, pin: Record<string, string>): string => {
    const modeFiles = plainFiles[mode] ??= [];
    const isFirstOfMode = !modeFiles.length && !workspaceModes.has(mode);
    const memberPath = isFirstOfMode ? "." : toRelPath(file);
    modeFiles.push({absPath: resolve(file), content, memberPath, projectDir, modeConfig, pin, modeCooldownDays: cooldownDaysFor(modeConfig.cooldown)});
    if (isFirstOfMode) modeConfigs[mode] = {modeConfig, projectDir, pin};
    return isFirstOfMode ? "" : `|${memberPath}`;
  };

  // Run a manifest parser, attributing a syntax error to its file.
  const parseFile = (file: string, parse: () => Record<string, any>): Record<string, any> => {
    try {
      return parse();
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }
  };

  // `fileContents` already holds exactly the files whose mode is enabled, in `files` order.
  for (const file of cargoWorkspaceFiles.length ? new Set([...cargoWorkspaceFiles, ...fileContents.keys()]) : fileContents.keys()) {
    if (isWorkflowFile(file)) {
      const actionsEnabled = enabledModes.has("actions");
      const dockerEnabled = enabledModes.has("docker");
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const filters = await resolveFileConfig(dirname(file));
      wfData[relPath] = {absPath: file, content};

      if (actionsEnabled) {
        deps.actions ??= {};
        // The writer's parser, so a sha pin's trailing comment, its version, travels with the ref.
        for (const line of content.split("\n")) {
          const parsed = parseUsesLine(line);
          const action = parsed && parseActionRef(parsed.value);
          if (!action) continue;
          if (!canInclude(action.name, "actions", filters.include, filters.exclude, "actions")) continue;
          // The ref is part of the key: a workflow may pin one action twice.
          const key = `${relPath}${fieldSep}${action.name}${fieldSep}${action.ref}`;
          if (deps.actions[key]) continue;
          deps.actions[key] = {old: action.ref} as Dep;
          actionDepInfos.push({
            ...action, key, comment: parsed.pinnedVersion,
            apiUrl: getForgeApiBaseUrl(action.host, forgeApiUrl),
            filePin: filters.pin, filePinNoDowngrade: filters.pinNoDowngrade, fileCooldownDays: filters.cooldownDays,
          });
        }
      }

      if (dockerEnabled) {
        dockerFileData[relPath] = {absPath: file, content, fileType: "workflow"};
        collectDockerRefs(content, relPath, [composeImageRe, workflowContainerRe, workflowDockerUsesRe], filters);
      }
      continue;
    }

    const filename = basename(file);

    if (isDockerFileName(filename)) {
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const fileType = isDockerfile(filename) ? "dockerfile" : "compose";
      const filters = await resolveFileConfig(dirname(file));
      dockerFileData[relPath] = {absPath: file, content, fileType};
      collectDockerRefs(content, relPath, [getExtractionRegex(filename)], filters);
      continue;
    }

    if (isMakeFileName(filename)) {
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const filters = await resolveFileConfig(dirname(file));
      makeFileData[relPath] = {absPath: file, content};
      deps.make ??= {};
      const makeShared = {
        projectDir: dirname(file), filePin: filters.pin, filePinNoDowngrade: filters.pinNoDowngrade,
        fileCooldownDays: filters.cooldownDays,
      };
      for (const {installPath, version} of parseMakeGoInstalls(content)) {
        if (!canInclude(installPath, "make", filters.include, filters.exclude, "make", "go")) continue;
        // The version is part of the key: a Makefile may install one tool at two versions.
        const key = `${relPath}${fieldSep}${installPath}${fieldSep}${version}`;
        if (deps.make[key]) continue;
        deps.make[key] = {old: stripv(version), oldOrig: version} as Dep;
        makeDepInfos.push({kind: "go", key, name: installPath, oldSpec: `${installPath}@${version}`, installPath, version, ...makeShared});
      }
      for (const image of parseMakeDockerImages(content)) {
        if (!canInclude(image.writtenImage, "make", filters.include, filters.exclude, "make", "docker")) continue;
        const key = `${relPath}${fieldSep}${image.writtenImage}${fieldSep}${image.ref.tag}`;
        if (deps.make[key]) continue;
        const parsed = parseDockerTag(image.ref.tag);
        if (!parsed) continue;
        const oldSpec = formatMakeImageSpec(image.writtenImage, image.ref.tag, image.digest);
        deps.make[key] = {old: parsed.version, oldOrig: image.ref.tag} as Dep;
        makeDepInfos.push({kind: "docker", key, name: image.writtenImage, oldSpec, image, ...makeShared});
      }
      continue;
    }

    const mode = modeByFileName[filename];

    if (filename === "go.work") {
      deps[mode] ??= {};
      const workspaceDir = dirname(resolve(file));
      const workContent = fileContents.get(file)!;
      goWorkData = {file, content: workContent};
      const goWork = parseGoWork(workContent);

      const [{modeConfig, modeInclude, modeExclude, pin}, useReads] = await Promise.all([
        resolveModeFilters(workspaceDir),
        pMap(goWork.use, async (usePath) => {
          const modPath = resolve(join(workspaceDir, usePath, "go.mod"));
          try {
            return {usePath, modPath, content: await readFile(modPath, "utf8")};
          } catch {
            return null;
          }
        }, {concurrency}),
      ]);
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};

      for (const entry of useReads) {
        if (!entry) continue;
        const {usePath, modPath, content: modContent} = entry;
        const parsed = parseGoMod(modContent);
        const modProjectDir = dirname(modPath);
        goModFiles.push({absPath: modPath, content: modContent, projectDir: modProjectDir, memberPath: usePath});

        collectDeps(mode, parsed, usePath === "." ? "" : `|${usePath}`, dependencyTypes, modeInclude, modeExclude);
      }

      for (const [name, value] of Object.entries(goWork.replace)) {
        if (canInclude(name, mode, modeInclude, modeExclude, "replace")) {
          addDep(mode, "replace", "", name, shortenGoVersion(value), stripv(value));
        }
      }

      continue;
    }

    // Skip only manifests already consumed as workspace members; unrelated ones (e.g. from a
    // second `-f` directory) fall through to be processed as plain files.
    if (filename === "go.mod" && goModFiles.some(m => m.absPath === resolve(file))) continue;
    if (filename === "package.json" && pnpmMemberFiles.some(m => m.absPath === resolve(file))) continue;
    if (filename === "Cargo.toml" && cargoMemberFiles.some(m => m.absPath === resolve(file))) continue;

    if (filename === "Cargo.toml") {
      deps[mode] ??= {};
      const cargoContent = fileContents.get(file)!;
      const cargoParsed = parsedCargoToml.get(file) ?? parseToml(cargoContent);
      const workspaceDir = dirname(resolve(file));

      const lockPath = findUpSync(["Cargo.lock"], workspaceDir).get("Cargo.lock");
      const wsMembers = (cargoParsed.workspace as Record<string, any>)?.members;
      const isWorkspace = Array.isArray(wsMembers) && wsMembers.length;

      const [{modeConfig, modeInclude, modeExclude, pin}, lockContent, members] = await Promise.all([
        resolveModeFilters(workspaceDir),
        lockPath ? readFile(lockPath, "utf8") : Promise.resolve(null),
        isWorkspace ? resolveWorkspaceMembers(wsMembers, workspaceDir, "Cargo.toml", concurrency) : Promise.resolve([] as WorkspaceMember[]),
      ]);
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      const lockedVersions = lockContent ? parseCargoLock(lockContent) : new Map<string, string[]>();

      const collectCargoDeps = (parsed: Record<string, any>, typePrefix: string) => {
        for (const [depType, table] of expandDepTypes(dependencyTypes, parsed)) {
          const obj = table || {};
          if (typeof obj !== "object" || Array.isArray(obj)) continue;
          for (const [name, value] of Object.entries(obj)) {
            if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
            // `registry` joins `git` and `path` as a source this tool cannot resolve: crates.io
            // would 404 on the name, or worse hit a same-named public crate.
            if (typeof value === "object" && value !== null && "version" in value && !("git" in value) && !("path" in value) && !("registry" in value)) {
              const versionStr = (value as Record<string, string>).version;
              // A renamed dep keeps the manifest key so the rewrite finds it, lookups use `package`.
              const crate = (value as Record<string, string>).package || name;
              if (validRange(cargoToNpmRange(versionStr))) {
                if (crate !== name) cargoCrates.set(depKey(depType, typePrefix, name), crate);
                addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, crate, versionStr) ?? normalizeRange(cargoToNpmRange(versionStr)), versionStr);
              }
            } else if (typeof value === "string" && validRange(cargoToNpmRange(value))) {
              addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, name, value) ?? normalizeRange(cargoToNpmRange(value)), value);
            }
          }
        }
      };

      if (isWorkspace) {
        modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};
        collectCargoDeps(cargoParsed, "");
        cargoMemberFiles.push({absPath: resolve(file), content: cargoContent, memberPath: "."});
        for (const member of members) {
          cargoMemberFiles.push(member);
          collectCargoDeps(parseFile(member.absPath, () => parseToml(member.content)), `|${member.memberPath}`);
        }
      } else {
        // Track each non-workspace Cargo.toml per file so several of them never
        // overwrite each other.
        collectCargoDeps(cargoParsed, addPlainFile(mode, file, cargoContent, workspaceDir, modeConfig, pin));
      }

      continue;
    }

    if (filename === "pnpm-workspace.yaml") {
      deps[mode] ??= {};
      const workspaceDir = dirname(resolve(file));
      const wsContent = fileContents.get(file)!;
      const packagePatterns = parsePnpmWorkspace(wsContent);
      const rootPkgPath = join(workspaceDir, "package.json");

      const [{modeConfig, modeInclude, modeExclude, pin}, rootContent, members] = await Promise.all([
        resolveModeFilters(workspaceDir),
        tryOrNull(readFile(rootPkgPath, "utf8")),
        resolveWorkspaceMembers(packagePatterns, workspaceDir, "package.json", concurrency),
      ]);
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};

      pnpmCatalogFiles.push({absPath: resolve(file), content: wsContent, memberPath: filename});
      for (const {type, name, value} of pnpmCatalogEntries(wsContent)) {
        if (canInclude(name, mode, modeInclude, modeExclude, type)) addNpmDep(type, `|${filename}`, name, value);
      }

      if (rootContent !== null) {
        const rootPkg = parseFile(rootPkgPath, () => JSON.parse(rootContent));
        pnpmMemberFiles.push({absPath: resolve(rootPkgPath), content: rootContent, memberPath: "."});
        collectDeps(mode, rootPkg, "", dependencyTypes, modeInclude, modeExclude);
      }

      for (const member of members) {
        const memberPkg = parseFile(member.absPath, () => JSON.parse(member.content));
        pnpmMemberFiles.push(member);
        collectDeps(mode, memberPkg, `|${member.memberPath}`, dependencyTypes, modeInclude, modeExclude);
      }

      continue;
    }

    deps[mode] ??= {};

    const projectDir = dirname(resolve(file));
    const {modeConfig, modeInclude, modeExclude, pin} = await resolveModeFilters(projectDir);

    const dependencyTypes = resolveDepTypes(mode, modeConfig);

    const content = fileContents.get(file)!;
    const typePrefix = addPlainFile(mode, file, content, projectDir, modeConfig, pin);

    const pkg = parseFile(file, () => {
      if (mode === "npm") return JSON.parse(content);
      if (mode === "pypi") return parseToml(content);
      if (mode === "go") return parseGoMod(content);
      return {};
    });

    collectDeps(mode, pkg, typePrefix, dependencyTypes, modeInclude, modeExclude);
  }

  if (!countDeps(deps) && !Object.keys(maybeUrlDeps).length) {
    return {results: {}, message: "No dependencies found, nothing to do."};
  }

  const fetchTasks: Array<Promise<void>> = [];
  // The abbreviated npm packument carries no publish dates, so cooldown needs the full one,
  // which is roughly twice the size. Decided once per run because the doc is cached by URL
  // and shared across every dep that reads it, but only from npm's own cooldown sources.
  // The published name the lookup resolves options under, which the manifest key answers for in
  // neither direction: an `npm:` alias names another package, and a selector key is no name at all.
  const npmIdentity = (key: string, name: string) => npmAliases.get(key)?.name ??
    (selectorTypes.has(key.split(fieldSep)[0].split("|")[0]) ? resolutionsBasePackage(name) : name);

  const npmNeedsDates = Boolean(cooldownDaysFor(modeConfigs.npm?.modeConfig.cooldown)) ||
    (plainFiles.npm ?? []).some(entry => entry.modeCooldownDays) ||
    (overridesHaveCooldown && Object.keys(deps.npm ?? {}).some(key =>
      getVersionOpts("npm", npmIdentity(key, key.split(fieldSep)[1])).cooldownOverride));
  const argsForNpm = {registry: config.registry, needsDates: npmNeedsDates};

  for (const [mode, modeConfigEntry] of Object.entries(modeConfigs)) {
    const hasDeps = deps[mode] && Object.keys(deps[mode]).length > 0;
    const hasUrlDeps = mode === "npm" && Object.keys(maybeUrlDeps).length > 0;
    if (!hasDeps && !hasUrlDeps) continue;
    const {modeConfig: defaultModeConfig, projectDir: defaultProjectDir, pin: defaultPin} = modeConfigEntry;
    const defaultCooldownDays = cooldownDaysFor(defaultModeConfig.cooldown);
    fetchTasks.push((async () => {
      // Non-workspace manifests with a disambiguating `|memberPath` type suffix
      // each carry their own config/projectDir/pin/cooldown; the empty-suffix
      // case (single manifest or workspace root) uses the mode-level defaults.
      const ctxBySuffix = new Map<string, PlainFile>();
      for (const entry of plainFiles[mode] ?? []) {
        if (entry.memberPath !== ".") ctxBySuffix.set(`|${entry.memberPath}`, entry);
      }
      const defaultCtx = {modeConfig: defaultModeConfig, projectDir: defaultProjectDir, pin: defaultPin, modeCooldownDays: defaultCooldownDays};
      const ctxForType = (type: string) => {
        const barIdx = type.indexOf("|");
        return (barIdx !== -1 && ctxBySuffix.get(type.slice(barIdx))) || defaultCtx;
      };
      const npmFollowUps = new Map<string, {name: string, promise: Promise<{repository?: PackageRepository, homepage?: string, date?: string}>}>();
      // Safety net for deps that bypass findNewVersion (URL tarballs, JSR
      // follow-ups). findNewVersion's per-version cooldown filter handles the
      // common case; this catches the rest.
      const dropIfTooNew = (modeDeps: Deps) => {
        for (const [k, {date}] of Object.entries(modeDeps)) {
          if (!date) continue;
          const [type, name] = k.split(fieldSep);
          const {modeCooldownDays} = ctxForType(type);
          if (!modeCooldownDays && !overridesHaveCooldown) continue;
          const cd = getVersionOpts(mode, mode === "npm" ? npmIdentity(k, name) : name).cooldownOverride ?? modeCooldownDays;
          if (cd && !passesCooldown(date, cd, now)) delete modeDeps[k];
        }
      };

      const modeDeps = deps[mode];
      const lookupDep = async (key: string, type: string, name: string) => {
        const baseT = baseType(type);
        const {modeConfig, projectDir, pin, modeCooldownDays} = ctxForType(type);
        const dep = modeDeps[key];
        const npmAlias = npmAliases.get(key);
        let info: PackageInfo;
        if (mode === "npm") {
          if (dep.oldOrig && isJsr(dep.oldOrig)) {
            info = await fetchJsrInfo(name, ctx);
          } else if (dep.oldOrig && isLocalDep(dep.oldOrig)) {
            const localInfo = await tryOrNull(fetchNpmInfo(name, baseT, modeConfig, argsForNpm, ctx, projectDir));
            if (!localInfo) { delete modeDeps[key]; return; }
            info = localInfo;
          } else {
            info = await fetchNpmInfo(npmAlias?.name ?? name, baseT, modeConfig, argsForNpm, ctx, projectDir, dep.old);
          }
        } else if (mode === "go") {
          info = await fetchGoProxyInfo(name, baseT, dep.oldOrig || dep.old, projectDir, ctx, goNoProxy);
        } else if (mode === "cargo") {
          info = await fetchCratesIoInfo(cargoCrates.get(key) ?? name, ctx);
        } else {
          info = await fetchPypiInfo(name, ctx);
        }

        const [data, registry] = info;
        if (data.error) throw new Error(data.error);

        // A go module answers to its `/vN` short name too, which is what `-i`/`-e` accept. A
        // `packageManager` names its own identity, so corepack's `yarn` keeps resolving as
        // `@yarnpkg/cli` while options and pins stay on the `yarn` the manifest and the row show.
        const identity = baseT === "packageManager" ? name : data.name;
        const {names, useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride} = getVersionOpts(mode, identity);
        const {old: oldRange, oldOrig} = dep;
        const {pinnedRange, pinNoDowngrade} = resolvePin(names, pin, modeConfig.pinNoDowngrade);
        const depCooldownDays = cooldownOverride ?? modeCooldownDays;
        const newVersion = findNewVersion(data, {
          usePre, useRel, useGreatest, semvers, range: oldRange, mode, pinnedRange, pinNoDowngrade, allowDowngrade: allowDown,
          cooldownDays: depCooldownDays || undefined, now: depCooldownDays ? now : undefined,
        });

        let newRange = "";
        if ((mode === "go" || mode === "pypi") && newVersion) {
          newRange = newVersion;
        } else if (mode === "cargo" && newVersion && oldOrig) {
          newRange = updateCargoRange(oldOrig, newVersion);
        } else if (newVersion) {
          if (oldOrig && isLocalDep(oldOrig)) {
            newRange = String(getNpmrc(projectDir)["save-exact"]) === "true" ? newVersion : `^${newVersion}`;
          } else if (oldOrig && isJsr(oldOrig)) {
            const match = jsrSpecifierRe.exec(oldOrig);
            if (match) newRange = `${match[1]}${newVersion}`;
            else if (oldOrig.startsWith("jsr:")) newRange = `jsr:${newVersion}`;
          } else if (npmAlias) {
            // Only the aliased package's range moves, and the `npm:<pkg>@` prefix is written
            // back with it so the manifest keeps aliasing the key it always did.
            newRange = `npm:${npmAlias.name}@${updateVersionRange(oldRange, newVersion, npmAlias.range, baseT)}`;
          } else {
            newRange = updateVersionRange(oldRange, newVersion, oldOrig, baseT);
          }
        }

        // The pypi writer declines a rewrite leaving any specifier unsatisfied, so a version it
        // would refuse must not be offered either.
        const spec = pypiSpecs.get(key);
        if (!newVersion || newVersion === oldRange || oldOrig && (oldOrig === newRange) ||
          spec && !updateRequirement(spec, oldOrig || oldRange, newRange)) {
          // Without this, a version no range could be written for reads as already current.
          if (config.verbose && newVersion && newVersion !== oldRange) {
            console.error(`${timestamp()} ${magenta("SKIP")} ${name}: ${oldOrig || oldRange} can not be rewritten to ${newVersion}`);
          }
          delete modeDeps[key];
          return;
        }

        const date: string = (mode === "pypi" ? data.releases?.[newVersion]?.[0]?.upload_time_iso_8601 :
          mode === "go" ? data.Time :
            mode === "cargo" ? data.time?.[newVersion] : "") || "";

        dep.new = newRange;
        if (oldOrig && isJsr(oldOrig)) dep.newPrint = newVersion;

        if (mode === "npm") {
          npmFollowUps.set(key, {name: npmAlias?.name ?? name, promise: fetchNpmVersionInfo(data.name, newVersion, modeConfig, argsForNpm, ctx, projectDir)});
        } else if (mode === "pypi") {
          dep.info = getInfoUrl(data, registry, data.info.name);
        } else if (mode === "go") {
          dep.info = getGoInfoUrl(data.newPath || name);
        } else if (mode === "cargo") {
          dep.info = `https://crates.io/crates/${data.name}`;
        }

        setDepAge(dep, date);
      };

      await pMap(Object.keys(modeDeps), async (key) => {
        const [type, name] = key.split(fieldSep);
        try {
          await lookupDep(key, type, name);
        } catch (err) {
          delete modeDeps[key];
          addError(mode, type, name, err);
        }
      }, {concurrency});

      await Promise.all(Array.from(npmFollowUps, async ([key, {name, promise}]) => {
        const followUp = await promise;
        const dep = modeDeps[key];
        if (!dep) return;
        dep.info = getInfoUrl({repository: followUp.repository, homepage: followUp.homepage}, null, name);
        if (followUp.date) setDepAge(dep, followUp.date);
      }));

      if (mode === "npm" && Object.keys(maybeUrlDeps).length) {
        const results = (await pMap(Object.entries(maybeUrlDeps), async ([key, dep]) => {
          try {
            return await checkUrlDep(key, dep, ctx);
          } catch (err) {
            addKeyError("npm", key, err);
            return null;
          }
        }, {concurrency})).filter(r => r !== null);

        for (const {key, newRange, user, repo, oldRef, newRef, newDate} of results) {
          const dep: Dep = modeDeps[key] = {
            old: maybeUrlDeps[key].old,
            new: newRange,
            oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
            newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
            info: `https://github.com/${user}/${repo}`,
          };
          if (newDate) setDepAge(dep, newDate);
        }
      }

      dropIfTooNew(modeDeps);
    })());
  }

  if (actionDepInfos.length) {
    fetchTasks.push((async () => {
      const depsByRepo = Map.groupBy(actionDepInfos, info => `${info.apiUrl}/${info.owner}/${info.repo}`);

      await pMap(depsByRepo.values(), async (infos) => {
        const {apiUrl, owner, repo} = infos[0];
        let tags: Array<TagEntry>;
        try {
          tags = await fetchActionTags(apiUrl, owner, repo, ctx, infos.map(info => info.ref));
        } catch (err) {
          for (const info of infos) {
            delete deps.actions[info.key];
            addKeyError("actions", info.key, err);
          }
          return;
        }
        // Candidates are the versions tags parse to, never the tag text: a `+meta` or leading-zero
        // tag would never map back to its own entry.
        const versions: string[] = [];
        const tagByVersion = new Map<string, string>();
        const entryByName = new Map<string, TagEntry>();
        const commitShaToTag = new Map<string, string>();
        for (const tag of tags) {
          entryByName.set(tag.name, tag);
          const version = githubActionsVersioning.parse(tag.name)?.version;
          if (version) {
            const existing = tagByVersion.get(version);
            // `v3.19` and `v3.19.0` are the same version; the more precise tag names it.
            if (!existing) versions.push(version);
            if (!existing || tag.name.length > existing.length) tagByVersion.set(version, tag.name);
          }
          if (tag.commitSha) commitShaToTag.set(tag.commitSha, tag.name);
        }

        // Caches the promise, so the several infos of one repo resolving to the
        // same commit share a single request instead of racing their own.
        const getDate = memoizeAsync((commitSha: string) => fetchActionTagDate(apiUrl, owner, repo, commitSha, ctx));

        // Cooldown-aware selection: when cooldown is active, pick the highest
        // version, fetch its commit date, and if it's too new, exclude it and
        // retry. Bounded loop avoids pathological cases (e.g. all versions
        // released within the cooldown window).
        async function pickVersion(opts: Parameters<typeof findVersion>[2]): Promise<{version: string, tag: string, commitSha: string, date: string} | null> {
          // A tag's date costs a request, so findVersion has none to gate on and would reject
          // every candidate under an active cooldown. The gate runs per pick below.
          const selectOpts = {...opts, cooldownDays: undefined, now: undefined};
          const denylist = new Set<string>();
          for (let attempt = 0; attempt < 20; attempt++) {
            const candidates = denylist.size ? versions.filter(v => !denylist.has(v)) : versions;
            const picked = findVersion({}, candidates, selectOpts);
            if (!picked) return null;
            const tag = tagByVersion.get(picked)!;
            const commitSha = entryByName.get(tag)?.commitSha || "";
            if (!opts.cooldownDays) return {version: picked, tag, commitSha, date: ""};
            const date = commitSha ? await getDate(commitSha) : "";
            // An empty date is the commit carrying none, which holds the candidate back; not
            // knowing is a failed run and must not read as either.
            if (date === undefined) throw new Error(`Unable to fetch the commit date for ${owner}/${repo}@${tag}`);
            if (passesCooldown(date, opts.cooldownDays, opts.now)) return {version: picked, tag, commitSha, date};
            denylist.add(picked);
          }
          return null;
        }

        const updateAction = async ({key, host, ref, comment, name: actionName, isHash, filePin, filePinNoDowngrade, fileCooldownDays}: ActionDepInfo) => {
          const dep = deps.actions[key];
          const infoUrl = `https://${host || "github.com"}/${owner}/${repo}`;
          const {pinnedRange: actionPin, pinNoDowngrade} = resolvePin([actionName], filePin, filePinNoDowngrade);

          // A sha pin's version is whatever its trailing comment names, failing that the tag
          // carrying the commit; without one every candidate looks like an upgrade, an older commit
          // included. A branch ref coerces to a version but must keep its text, or a release tag
          // replaces the pin.
          let oldRef = ref;
          if (isHash) {
            // abbreviated pins need a prefix scan, the map is keyed by full sha
            oldRef = comment || commitShaToTag.get(ref) || commitShaToTag.entries().find(([sha]) => sha.startsWith(ref))?.[1] || "";
          } else if (!isVersionLikeRef(ref)) {
            oldRef = "";
          }
          if (!oldRef) { delete deps.actions[key]; return; }

          const {useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride} = getVersionOpts("actions", actionName);
          const actionCooldownDays = cooldownOverride ?? fileCooldownDays;
          const result = await pickVersion({
            range: oldRef, semvers, useGreatest, usePre, useRel, allowDowngrade: allowDown, versioning: githubActionsVersioning,
            pinnedRange: actionPin, pinNoDowngrade,
            cooldownDays: actionCooldownDays || undefined, now: actionCooldownDays ? now : undefined,
          });
          if (!result) { delete deps.actions[key]; return; }
          const {tag: newTag, commitSha: newCommitSha, date} = result;

          if (isHash) {
            if (!newCommitSha || newCommitSha.startsWith(ref) || ref.startsWith(newCommitSha)) {
              delete deps.actions[key]; return;
            }

            dep.old = ref;
            dep.new = newCommitSha.substring(0, ref.length);
            dep.oldPrint = oldRef; // the tag the pinned sha resolved to
            dep.newPrint = newTag;
          } else {
            const formatted = formatActionVersion(newTag, ref);
            if (formatted === ref) { delete deps.actions[key]; return; }

            dep.new = entryByName.has(formatted) ? formatted : newTag;
          }
          dep.info = infoUrl;

          // Only a cooldown run has fetched the date already, otherwise it takes a request.
          // The age is cosmetic, so an undeterminable date goes unprinted rather than dropping the update.
          const newDate = date || (newCommitSha ? await tryOrNull(getDate(newCommitSha)) : "");
          if (newDate) setDepAge(dep, newDate);
        };

        await pMap(infos, async (info) => {
          try {
            await updateAction(info);
          } catch (err) {
            delete deps.actions[info.key];
            addKeyError("actions", info.key, err);
          }
        }, {concurrency});
      }, {concurrency});

      if (!Object.keys(deps.actions).length) delete deps.actions;
    })());
  }

  if (dockerDepInfos.length) {
    fetchTasks.push((async () => {
      const depsByImage = Map.groupBy(dockerDepInfos, info => info.fullImage);

      await pMap(depsByImage.entries(), async ([fullImage, infos]) => {
        // An image on a registry other than Docker Hub has no lookup to attempt yet.
        if (infos[0].ref.registry) {
          for (const info of infos) delete deps.docker[info.key];
          return;
        }
        let data: Record<string, any>;
        try {
          const [fetchedData] = await fetchDockerInfo(fullImage, ctx);
          data = fetchedData;
        } catch (err) {
          for (const info of infos) {
            delete deps.docker[info.key];
            addKeyError("docker", info.key, err);
          }
          return;
        }

        const {names, semvers, usePre, useRel, cooldownOverride} = getVersionOpts("docker", fullImage);
        for (const info of infos) {
          const dep = deps.docker[info.key];
          const oldTag = dep.oldOrig || dep.old;
          // findDockerVersion only moves a tag up, so a renovate-derived pin has nothing to suppress.
          const {pinnedRange} = resolvePin(names, info.filePin);
          const dockerCooldownDays = cooldownOverride ?? info.fileCooldownDays;
          const result = findDockerVersion(
            data.tags, oldTag, semvers,
            dockerCooldownDays || undefined, dockerCooldownDays ? now : undefined,
            pinnedRange, usePre, useRel,
          );
          if (!result) { delete deps.docker[info.key]; continue; }

          dep.new = result.newTag;
          dep.info = getDockerInfoUrl(info.ref);
          setDepAge(dep, result.date);
        }
      }, {concurrency});

      if (!Object.keys(deps.docker).length) delete deps.docker;
    })());
  }

  if (makeDepInfos.length) {
    fetchTasks.push((async () => {
      await pMap(makeDepInfos, async (info) => {
        const {names, useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride} = getVersionOpts(info.kind, info.name);
        const {pinnedRange, pinNoDowngrade} = resolvePin(names, info.filePin, info.filePinNoDowngrade);
        const makeCooldownDays = cooldownOverride ?? info.fileCooldownDays;
        const opts = {
          semvers, useGreatest, usePre, useRel, allowDowngrade: allowDown, pinnedRange, pinNoDowngrade,
          cooldownDays: makeCooldownDays || undefined, now: makeCooldownDays ? now : undefined,
        };
        const dep = deps.make[info.key];
        try {
          let update: MakeUpdate | MakeDockerUpdate;
          if (info.kind === "go") {
            const goUpdate = await fetchMakeInfo(info.installPath, info.version, info.projectDir, ctx, goNoProxy, opts);
            if (!goUpdate) { delete deps.make[info.key]; return; }
            info.newSpec = `${goUpdate.newInstallPath}@${goUpdate.newVersion}`;
            dep.new = goUpdate.newVersion;
            update = goUpdate;
          } else {
            const dockerUpdate = await fetchMakeDockerInfo(info.image, ctx, opts);
            if (!dockerUpdate) { delete deps.make[info.key]; return; }
            info.newSpec = formatMakeImageSpec(info.image.writtenImage, dockerUpdate.newTag, info.image.digest ? dockerUpdate.newDigest : null);
            dep.new = dockerUpdate.newTag;
            update = dockerUpdate;
          }
          dep.info = update.info;
          if (update.date) setDepAge(dep, update.date);
        } catch (err) {
          delete deps.make[info.key];
          addKeyError("make", info.key, err);
        }
      }, {concurrency});
      if (!Object.keys(deps.make).length) delete deps.make;
    })());
  }

  // Cache writes are detached from the fetch paths; settle them before
  // returning so even an error exit cannot abandon in-flight writes.
  try {
    await Promise.all(fetchTasks);
  } finally {
    await flushCacheWrites();
  }

  if (!countDeps(deps)) {
    // A run that resolved nothing because everything failed is not an up-to-date one.
    return errors.length ? {results: {}, errors} : {results: {}, message: "All dependencies are up to date."};
  }

  if (config.update) {
    const updateMembers = (m: string, members: WorkspaceMember[], updateFn: (content: string, deps: Deps) => string) => {
      for (const member of members) {
        const localDeps = filterDepsForMember(deps[m], member.memberPath);
        if (!Object.keys(localDeps).length) continue;
        write(member.absPath, updateFn(member.content, localDeps));
      }
    };
    // Group action and docker deps by their containing workflow/dockerfile so
    // each file is rewritten once. buildOutput() (called after this block)
    // mutates dep shape and must run after writes.
    const actionsUpdatesByRelPath = new Map<string, Array<{name: string, oldRef: string, newRef: string, newComment?: string}>>();
    for (const [key, dep] of Object.entries(deps.actions ?? {})) {
      const [relPath, name] = key.split(fieldSep);
      // Sha pins keep the resolved tag in a trailing comment, which has to move along.
      const newComment = hashRe.test(dep.old) ? dep.newPrint : undefined;
      pushTo(actionsUpdatesByRelPath, relPath, {name, oldRef: dep.old, newRef: dep.new, newComment});
    }

    const dockerUpdatesByRelPath = new Map<string, Deps>();
    for (const [key, dep] of Object.entries(deps.docker ?? {})) {
      const [relPath] = key.split(fieldSep);
      let map = dockerUpdatesByRelPath.get(relPath);
      if (!map) dockerUpdatesByRelPath.set(relPath, map = {});
      map[key] = dep;
    }

    const makeUpdatesByRelPath = new Map<string, Array<MakeRewrite>>();
    for (const info of makeDepInfos) {
      if (!info.newSpec || !deps.make?.[info.key]) continue;
      pushTo(makeUpdatesByRelPath, info.key.split(fieldSep)[0], {oldSpec: info.oldSpec, newSpec: info.newSpec});
    }

    // Process actions before docker: a workflow file may hold both an action and a
    // docker-image update, and the actions branch syncs its rewrite into dockerFileData
    // (one-way). Running docker first would overwrite the action edit on disk.
    const orderedModes = Object.keys(deps).sort((a, b) => (a === "docker" ? 1 : 0) - (b === "docker" ? 1 : 0));
    for (const mode of orderedModes) {
      if (!Object.keys(deps[mode]).length) continue;

      if (mode === "actions") {
        for (const [relPath, actionDeps] of actionsUpdatesByRelPath) {
          const {absPath, content} = wfData[relPath] || {};
          if (!absPath) continue;
          const updated = updateWorkflowFile(content, actionDeps);
          write(absPath, updated);
          if (dockerFileData[relPath]) dockerFileData[relPath].content = updated;
        }
        continue;
      }

      if (mode === "docker") {
        for (const [relPath, dockerDeps] of dockerUpdatesByRelPath) {
          const fileInfo = dockerFileData[relPath];
          if (!fileInfo) continue;
          const {absPath, content, fileType} = fileInfo;
          const updateFn = fileType === "dockerfile" ? updateDockerfile :
            fileType === "compose" ? updateComposeFile : updateWorkflowDockerImages;
          write(absPath, updateFn(content, dockerDeps));
        }
        continue;
      }

      if (mode === "make") {
        for (const [relPath, rewrites] of makeUpdatesByRelPath) {
          const fileInfo = makeFileData[relPath];
          if (!fileInfo) continue;
          write(fileInfo.absPath, updateMakefile(fileInfo.content, rewrites));
        }
        continue;
      }

      // Workspace members and unrelated plain manifests of the same mode can coexist (e.g. a
      // workspace dir plus a second `-f` directory), so both are written.
      if (mode === "go") {
        for (const goMod of [...goModFiles, ...(plainFiles.go ?? [])]) {
          const localDeps = filterDepsForMember(deps[mode], goMod.memberPath);
          if (!Object.keys(localDeps).length) continue;
          const [updatedContent, majorVersionRewrites] = updateGoMod(goMod.content, localDeps);
          if (updatedContent !== goMod.content) write(goMod.absPath, updatedContent);
          rewriteGoImports(goMod.projectDir, majorVersionRewrites, write);
        }
        if (goWorkData) {
          const workDeps: Deps = {};
          for (const [key, dep] of Object.entries(deps[mode])) {
            if (key.split(fieldSep)[0] === "replace") workDeps[key] = dep;
          }
          if (Object.keys(workDeps).length) {
            const [updatedWork] = updateGoMod(goWorkData.content, workDeps);
            if (updatedWork !== goWorkData.content) write(goWorkData.file, updatedWork);
          }
        }
      } else if (mode === "cargo") {
        // The member lists stay empty unless a workspace manifest was seen.
        updateMembers(mode, cargoMemberFiles, updateCargoToml);
        updateMembers(mode, plainFiles.cargo ?? [], updateCargoToml);
      } else if (mode === "npm") {
        updateMembers(mode, pnpmCatalogFiles, updatePnpmWorkspace);
        updateMembers(mode, pnpmMemberFiles, updatePackageJson);
        updateMembers(mode, plainFiles.npm ?? [], updatePackageJson);
      } else {
        updateMembers(mode, plainFiles[mode] ?? [], updatePyprojectToml);
      }
    }
  }

  const output = buildOutput(deps);
  if (errors.length) output.errors = errors;
  return output;
}
