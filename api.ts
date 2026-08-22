import {cwd, platform, stderr} from "node:process";
import {styleText} from "node:util";
import {join, dirname, basename, resolve} from "node:path";
import {statSync, readdirSync, realpathSync, truncateSync, writeFileSync, accessSync, type Stats} from "node:fs";
import {readFile} from "node:fs/promises";
import {parseToml} from "./utils/toml.ts";
import {coerce, githubActionsVersioning, satisfies, validRange} from "./utils/semver.ts";
import {timerel} from "timerel";
import {
  npmTypes, uvTypes, goTypes, cargoTypes, cargoTargetTypes, expandDepTypes, parseUvDependencies, nonPackageEngines,
  parseDuration, parsePositiveInt, matchesAny, memoizeAsync, timestamp, forgeDirs, modeByFileName, pMap, tryOrNull,
  walkUpSync, getOrSet,
} from "./utils/utils.ts";
import {
  type Dep, type Deps, type DepsByMode, type Limiter, type Output as ModeOutput, type ModeContext,
  type PackageRepository, type TagEntry,
  fieldSep, normalizeUrl, fetchTimeout, goProbeTimeout, maxSockets,
  doFetch, fetchActionTags, fetchForge, findVersion, findNewVersion, getInfoUrl, getGithubTokens, getLimiter,
  passesCooldown, stripv, hashRe, isVersionLikeRef, defaultApiUrls, formatVersionPrecision, getExecFile,
} from "./modes/shared.ts";
import {flushCacheWrites} from "./utils/fetchCache.ts";
import {cliBaseConfig, loadConfig, configMixedToRegexes, patternsToRegexSet, validatePin} from "./config.ts";
import type {Config, Override} from "./config.ts";
import {matchesRenovateRule, testRenovateMatcher, type RenovateVersionRule} from "./utils/renovate.ts";
import {
  fetchNpmInfo, fetchNpmVersionInfo, fetchJsrInfo, isJsr, isLocalDep, isCatalogRef, parseJsrDependency, parseNpmAlias,
  updatePackageJson, updateVersionRange, normalizeRange, checkUrlDep, resolutionsBasePackage, selectorTypes,
} from "./modes/npm.ts";
import {fetchPypiInfo, pypiSatisfies, updatePyprojectToml, updateRequirement} from "./modes/pypi.ts";
import {
  resolveGoProxyChain, parseGoNoProxy,
  parseGoMod, parseGoWork, resolveGoWorkModule, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, goModulePathForVersion, shortenGoVersion, shortenGoModule,
} from "./modes/go.ts";
import {
  type ActionRef,
  parseActionRef, parseUsesLine, getForgeApiBaseUrl,
  fetchActionTagDate, formatActionVersion,
  updateWorkflowFile, isWorkflowFile, resolveWorkflowFiles,
} from "./modes/actions.ts";
import {
  type DockerImageRef,
  parseDockerImageRef, parseDockerTag, extractDockerRefs, dockerImageNames,
  fetchDockerTagDigest,
  getExtractionRegex, isDockerfile, isDockerFileName, dockerExactFileNames,
  fetchDockerInfo, findDockerVersion, getDockerInfoUrl,
  updateDockerfile, updateComposeFile, updateWorkflowDockerImages,
} from "./modes/docker.ts";
import {
  type MakeDockerImage,
  isMakeFileName, makeExactFileNames, parseMakeGoInstalls, parseMakeDockerImages,
  resolveGoModuleRoot, formatMakeImageSpec, updateMakefile,
} from "./modes/make.ts";
import {fetchCratesIoInfo, updateCargoToml, updateCargoRange, cargoToNpmRange, parseCargoLock, findLockedVersion} from "./modes/cargo.ts";
import {
  baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, pnpmCatalogEntries,
  updatePnpmWorkspace, type WorkspaceMember,
} from "./utils/workspace.ts";

const allowedVersionsRe = /^(!?)\/(.*)\/(i?)$/;

/** A sha pin whose comment names a branch or other moving ref, so only its digest ever moves. */
const isDigestOnlyPin = (info: {isHash: boolean, comment: string}): boolean =>
  info.isHash && Boolean(info.comment) && !isVersionLikeRef(info.comment);

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
export {cliBaseConfig as cliConfigBaseDir};

const modeOrder = [...new Set(Object.values(modeByFileName)), "actions", "docker", "make"];
const defaultModes = new Set(modeOrder);

const semversByPrecision = {
  patch: new Set(["patch"]),
  minor: new Set(["patch", "minor"]),
  major: new Set(["patch", "minor", "major"]),
};

const workspaceManifests: Record<string, string> = {"go.work": "go.mod", "pnpm-workspace.yaml": "package.json"};

const apiUrl = (value: unknown, fallback: string) => normalizeUrl(typeof value === "string" ? value : fallback);

const jsrSpecifierRe = /^(npm:@jsr\/[^@]+@|jsr:@[^@]+@)(.+)$/;

function findUpSync(filenames: string[], dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const remaining = new Set(filenames);
  walkUpSync(dir, cur => {
    for (const filename of remaining) {
      const path = join(cur, filename);
      try { accessSync(path); found.set(filename, path); remaining.delete(filename); } catch {}
    }
    return remaining.size ? null : found;
  });
  return found;
}

function setDepAge(dep: Dep, date: string | null | undefined): void {
  if (date) {
    dep.date = date;
    dep.age = timerel(date, {noAffix: true, shortUnits: true});
  }
}

const dependencyKey = (type: string, name: string, identity?: string) =>
  `${type}${fieldSep}${name}${identity === undefined ? "" : `${fieldSep}${identity}`}`;
const manifestDependencyKey = (depType: string, typePrefix: string, name: string, identity?: string) =>
  dependencyKey(`${depType}${typePrefix}`, name, identity);

const depBelongsToMember = (key: string, memberPath: string): boolean => {
  const type = key.split(fieldSep)[0];
  return type === (memberPath === "." ? baseType(type) : `${baseType(type)}|${memberPath}`);
};

const hasDeps = (deps: DepsByMode) => Object.values(deps).some(modeDeps => Object.keys(modeDeps).length > 0);

const normalizePep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

function depNames(name: string, kind: string): Array<string> {
  if (kind === "go") return [name, shortenGoModule(name)];
  if (kind === "docker") return dockerImageNames(name);
  if (kind === "pypi") return [name, normalizePep503(name)];
  return [name];
}

function canInclude(name: string, mode: string, include: Set<RegExp>, exclude: Set<RegExp>, depType: string, kind: string = mode, packageName: string = name): boolean {
  if (depType === "engines" && nonPackageEngines.includes(name)) return false;
  if (mode === "pypi" && name === "python") return false;
  if (!include.size && !exclude.size) return true;
  const names = Array.from(new Set([...depNames(name, kind), ...depNames(packageName, kind)]));
  const test = (matcher: RegExp, value: string) => testRenovateMatcher(matcher, value, packageName, name);
  for (const matcher of exclude) {
    if (names.some(value => test(matcher, value))) return false;
  }
  for (const matcher of include) {
    if (names.some(value => test(matcher, value))) return true;
  }
  return !include.size;
}

function resolveFiles(filesArg: Array<string> | undefined): Set<string> {
  const resolvedFiles = new Set<string>();

  if (filesArg?.length) {
    for (const arg of filesArg) {
      let stat: Stats;
      try {
        stat = statSync(arg);
      } catch (err) {
        throw new Error(`Unable to open ${arg}: ${(err as Error).message}`);
      }
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

  const workspaceFiles: Array<string> = [];
  for (const file of Array.from(resolvedFiles)) {
    const filename = basename(file);
    if (!Object.hasOwn(workspaceManifests, filename)) continue;
    workspaceFiles.push(file);
    resolvedFiles.delete(join(dirname(file), workspaceManifests[filename]));
  }

  return workspaceFiles.length ? new Set([...workspaceFiles, ...resolvedFiles]) : resolvedFiles;
}

function write(file: string, content: string): void {
  if (platform === "win32") truncateSync(file, 0);
  writeFileSync(file, content, platform === "win32" ? {flag: "r+"} : undefined);
}

const rowId = (mode: string, key: string) => `${mode}${fieldSep}${key.split(fieldSep, 2).join(fieldSep)}`;

function displayKey(value: string): string {
  if (!value.startsWith("[")) return value;
  try { return (JSON.parse(value) as Array<string>).join("."); } catch { return value; }
}

function buildOutput(deps: DepsByMode): Output {
  const output: Output = {results: {}};
  const rowsPerName = new Map<string, number>();
  const modes = Object.entries(deps).sort(([left], [right]) => modeOrder.indexOf(left) - modeOrder.indexOf(right));
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
      else if (mode === "actions" && !props.digestOnly) {
        props.old = stripv(props.old);
        props.new = stripv(props.new);
      }
      delete props.oldPrint;
      delete props.newPrint;
      delete props.oldOrig;
      delete props.date;

      const [type, name, ref] = key.split(fieldSep);
      const label = ref && rowsPerName.get(rowId(mode, key))! > 1 ?
        `${name}${mode === "actions" ? "@" : ":"}${displayKey(ref)}` : name;
      const modeResults = output.results[mode] ??= {};
      (modeResults[displayKey(type)] ??= {})[label] = props;
    }
  }
  for (const modeResults of Object.values(output.results)) {
    for (const [type, typeDeps] of Object.entries(modeResults)) {
      modeResults[type] = Object.fromEntries(Object.entries(typeDeps)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
  }
  return output;
}

function versionAllowedPredicate(mode: string, allowedVersions: string | undefined): (version: string) => boolean {
  if (!allowedVersions) return () => true;
  const regex = allowedVersionsRe.exec(allowedVersions);
  if (regex) {
    const versionRe = new RegExp(regex[2], regex[3]);
    return regex[1] ? version => !versionRe.test(version) : version => versionRe.test(version);
  }
  if (mode === "docker") {
    return version => satisfies(coerce(parseDockerTag(version)?.version ?? "")?.version ?? "", allowedVersions);
  }
  if (mode === "pypi") return version => pypiSatisfies(version, allowedVersions);
  return version => satisfies(version, allowedVersions);
}

function filterVersionData(data: Record<string, any>, mode: string, allowedVersions: string | undefined) {
  if (!allowedVersions) return data;
  const isVersionAllowed = versionAllowedPredicate(mode, allowedVersions);
  const filterRecord = (record: Record<string, any>) => Object.fromEntries(Object.entries(record)
    .filter(([version]) => isVersionAllowed(version)));
  if (mode === "go") return {
    ...data,
    ...(data.versions && {versions: filterRecord(data.versions)}),
    new: typeof data.new === "string" && isVersionAllowed(data.new) ? data.new : "",
    sameMajorNew: typeof data.sameMajorNew === "string" && isVersionAllowed(data.sameMajorNew) ?
      data.sameMajorNew : "",
  };
  const key = mode === "pypi" ? "releases" : mode === "docker" ? "tags" : "versions";
  return {...data, [key]: filterRecord(data[key] ?? {})};
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

export async function updates(opts: UpdatesOptions = {}): Promise<Output> {
  const {enableDnsCache} = await import("./utils/dns.ts");
  const disposeDnsCache = enableDnsCache();
  try {
    return await runUpdates(opts);
  } finally {
    disposeDnsCache();
  }
}

async function runUpdates(opts: UpdatesOptions): Promise<Output> {
  const config: Config = {...opts};
  if (typeof config.timeout === "number") config.timeout = parsePositiveInt(config.timeout, "timeout");

  const concurrency = config.sockets ?? maxSockets;
  const userTimeout = config.timeout ?? 0;
  const forgeApiUrl = apiUrl(opts.forgeapi, defaultApiUrls.forgeapi);
  const goProxyChain = resolveGoProxyChain(opts.goproxy);
  const goNoProxy = parseGoNoProxy();

  const useVerboseColor = !config.noColor && (config.color || stderr.isTTY);
  const colorFn = (color: "magenta" | "green" | "red") => useVerboseColor ? (text: string | number) => styleText(color, String(text), {validateStream: false}) : String;
  const magenta = colorFn("magenta");
  const vGreen = colorFn("green");
  const vRed = colorFn("red");

  let limit: Limiter | undefined;
  const ctx: ModeContext = {
    execFile: async (file, args, execOpts) => (await getExecFile())(file, args, execOpts),
    fetchTimeout: userTimeout || fetchTimeout,
    goProbeTimeout: userTimeout ? Math.max(1, Math.floor(userTimeout / 2)) : goProbeTimeout,
    concurrency,
    forgeApiUrl,
    pypiApiUrl: apiUrl(opts.pypiapi, defaultApiUrls.pypiapi),
    jsrApiUrl: apiUrl(opts.jsrapi, defaultApiUrls.jsrapi),
    goProxyUrl: goProxyChain[0].url,
    goProxyChain,
    cratesIoUrl: apiUrl(opts.cargoapi, defaultApiUrls.cargoapi),
    dockerApiUrl: apiUrl(opts.dockerapi, defaultApiUrls.dockerapi),
    doFetch: (url: string, fetchOpts?: RequestInit) => (limit ??= getLimiter(ctx))(async () => {
      if (config.verbose) console.error(`${timestamp()} ${magenta(fetchOpts?.method || "GET")} ${url}`);
      const res = await doFetch(url, fetchOpts);
      if (config.verbose) console.error(`${timestamp()} ${res.ok ? vGreen(res.status) : vRed(res.status)} ${url}`);
      return res;
    }),
    noCache: Boolean(config.noCache),
  };
  const dockerTagDigestPromises = new Map<string, Promise<string | null>>();
  const resolveDockerTagDigest = async (namespace: string, repo: string, tag: string): Promise<string | null> => {
    const key = `${namespace}${fieldSep}${repo}${fieldSep}${tag}`;
    const digestPromise = getOrSet(dockerTagDigestPromises, key, () => fetchDockerTagDigest(namespace, repo, tag, ctx));
    try {
      return await digestPromise;
    } catch (err) {
      if (dockerTagDigestPromises.get(key) === digestPromise) dockerTagDigestPromises.delete(key);
      throw err;
    }
  };

  for (const mode of config.modes ?? []) {
    if (!defaultModes.has(mode)) throw new Error(`Invalid mode: ${mode}, expected one of: ${modeOrder.join(",")}`);
  }
  const enabledModes = config.modes?.length ? new Set(config.modes) : defaultModes;

  const compileVersionConfig = (source: Config) => {
    const overrides = (source.overrides ?? []).map(override => ({
      include: override.include?.length ? patternsToRegexSet(override.include) : undefined,
      exclude: override.exclude?.length ? patternsToRegexSet(override.exclude) : undefined,
      greatest: override.greatest, prerelease: override.prerelease, release: override.release,
      patch: override.patch, minor: override.minor, allowDowngrade: override.allowDowngrade,
      cooldownDays: override.cooldown !== undefined ? parseDuration(String(override.cooldown)) : undefined,
    }));
    return {
      greatest: configMixedToRegexes(source.greatest),
      prerelease: configMixedToRegexes(source.prerelease),
      release: configMixedToRegexes(source.release),
      patch: configMixedToRegexes(source.patch),
      minor: configMixedToRegexes(source.minor),
      allowDowngrade: configMixedToRegexes(source.allowDowngrade),
      overrides,
      renovateVersionRules: (source as Config & {renovateVersionRules?: Array<RenovateVersionRule>}).renovateVersionRules ?? [],
      hasCooldownOverride: overrides.some(override => override.cooldownDays !== undefined),
    };
  };
  type VersionConfig = ReturnType<typeof compileVersionConfig>;
  if (enabledModes.has("actions")) getGithubTokens();

  type ResolvedVersionOpts = {
    names: Array<string>, useGreatest: boolean, usePre: boolean, useRel: boolean, semvers: Set<string>,
    allowDowngrade: boolean, cooldownOverride: number | undefined, allowedVersions?: string,
  };
  const versionOptsCache = new WeakMap<VersionConfig, Map<string, ResolvedVersionOpts>>();

  function getVersionOpts(versionConfig: VersionConfig, kind: string, packageName: string, depName: string = packageName) {
    const cache = getOrSet(versionOptsCache, versionConfig, () => new Map());
    const cacheKey = `${kind}${fieldSep}${packageName}${fieldSep}${depName}`;
    let entry = cache.get(cacheKey);
    if (!entry) {
      const allNames = Array.from(new Set([...depNames(packageName, kind), ...depNames(depName, kind)]));
      const anyMatches = (set: Set<RegExp> | boolean) => allNames.some(name => matchesAny(name, set));
      let useGreatest = anyMatches(versionConfig.greatest);
      let usePre = anyMatches(versionConfig.prerelease);
      let useRel = anyMatches(versionConfig.release);
      let usePatch = anyMatches(versionConfig.patch);
      let useMinor = anyMatches(versionConfig.minor);
      let allowDown = anyMatches(versionConfig.allowDowngrade);
      let cooldownOverride: number | undefined;

      for (const override of versionConfig.overrides) {
        if (override.include && allNames.every(name => !matchesAny(name, override.include!)) ||
          override.exclude && allNames.some(name => matchesAny(name, override.exclude!))) continue;
        if (override.greatest !== undefined) useGreatest = override.greatest;
        if (override.prerelease !== undefined) usePre = override.prerelease;
        if (override.release !== undefined) useRel = override.release;
        if (override.patch !== undefined) usePatch = override.patch;
        if (override.minor !== undefined) useMinor = override.minor;
        if (override.allowDowngrade !== undefined) allowDown = override.allowDowngrade;
        if (override.cooldownDays !== undefined) cooldownOverride = override.cooldownDays;
      }

      const semvers = usePatch ? semversByPrecision.patch : useMinor ? semversByPrecision.minor : semversByPrecision.major;
      let allowedVersions: string | undefined;
      for (const rule of versionConfig.renovateVersionRules) {
        if (!matchesRenovateRule(rule, packageName, depName)) continue;
        if (rule.allowedVersions !== undefined) allowedVersions = rule.allowedVersions;
        if (rule.cooldownDays !== undefined) cooldownOverride = rule.cooldownDays;
      }

      entry = {names: allNames, useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride, allowedVersions};
      cache.set(cacheKey, entry);
    }
    return entry;
  }

  validatePin(config.pin); // the CLI validates on parse, the programmatic caller has not
  const globalPin: Record<string, string> = config.pin ?? {};
  const resolvePin = (names: Array<string>, filePin: Record<string, string>, noDowngrade?: Config["pinNoDowngrade"]) => {
    const authored = names.find(name => globalPin[name]);
    if (authored) return {pinnedRange: globalPin[authored], pinNoDowngrade: false};
    const inherited = names.find(name => filePin[name]);
    const inheritedFromRenovate = Boolean(inherited && Array.isArray(noDowngrade) && noDowngrade.includes(inherited));
    return {
      pinnedRange: inherited && !inheritedFromRenovate ? filePin[inherited] : undefined,
      pinNoDowngrade: inheritedFromRenovate,
    };
  };
  const resolveVersionOpts = (
    versionConfig: VersionConfig, kind: string, packageName: string, depName: string,
    filePin: Record<string, string>, pinNoDowngrade: Config["pinNoDowngrade"], fileCooldownDays: number,
  ) => {
    const versionOpts = getVersionOpts(versionConfig, kind, packageName, depName);
    return {
      ...versionOpts,
      ...resolvePin(versionOpts.names, filePin, pinNoDowngrade),
      cooldownDays: versionOpts.cooldownOverride ?? fileCooldownDays,
    };
  };

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const cargoCrates = new Map<string, string>();
  const npmAliases = new Map<string, {name: string, range: string}>();
  const npmPublishedNames = new Map<string, string>();
  const pnpmWorkspaceOverrideKeys = new Map<string, string>();
  const pypiSpecs = new Map<string, string>();
  const errors: Array<DepError> = [];
  const addKeyError = (mode: string, key: string, err: unknown) => {
    const [type, name] = key.split(fieldSep);
    errors.push({mode, type, name, error: (err as Error)?.message || String(err)});
  };
  const rejectDep = (mode: string, key: string, err: unknown) => {
    delete deps[mode][key];
    addKeyError(mode, key, err);
  };
  type PlainFile = {absPath: string, content: string, memberPath: string, projectDir: string};
  const plainFiles: Record<string, Array<PlainFile>> = {};
  const now = Date.now();
  const cwdStr = cwd();
  const toRelPath = (absPath: string) => absPath.replace(`${cwdStr}/`, "").replace(`${cwdStr}\\`, "");

  const addDep = (mode: string, depType: string, typePrefix: string, name: string, old: string, oldOrig: string) => {
    deps[mode][manifestDependencyKey(depType, typePrefix, name)] = {old, oldOrig} as Dep;
  };

  const addNpmDep = (key: string, name: string, value: string) => {
    if (isCatalogRef(value)) return;
    const alias = parseNpmAlias(value);
    if (isJsr(value)) {
      deps.npm[key] = {old: parseJsrDependency(value, name).version, new: "", oldOrig: value};
    } else if (validRange(value)) {
      deps.npm[key] = {old: normalizeRange(value), new: "", oldOrig: value};
    } else if (alias) {
      npmAliases.set(key, alias);
      deps.npm[key] = {old: normalizeRange(alias.range), new: "", oldOrig: value};
    } else if (isLocalDep(value)) {
      return;
    } else {
      maybeUrlDeps[key] = {old: value} as Dep;
    }
  };

  const collectDeps = (mode: string, pkg: Record<string, any>, typePrefix: string, depTypes: Array<string>, modeInclude: Set<RegExp>, modeExclude: Set<RegExp>) => {
    const uvSources = new Set(Object.keys(pkg.tool?.uv?.sources ?? {}).map(normalizePep503));
    const addUvDeps = (specs: Array<unknown>, depType: string) => {
      for (const {name, version, spec} of parseUvDependencies(specs)) {
        if (uvSources.has(normalizePep503(name))) continue;
        if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
          addDep(mode, depType, typePrefix, name, normalizeRange(version), version);
          pypiSpecs.set(manifestDependencyKey(depType, typePrefix, name), spec);
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
        if (mode === "npm" && (depType === "overrides" || depType === "pnpm.overrides")) {
          const root = depType === "overrides" ? ["overrides"] : ["pnpm", "overrides"];
          const collectOverrides = (child: Record<string, any>, parents: Array<string>) => {
            for (const [selector, value] of Object.entries(child)) {
              if (typeof value === "string") {
                const name = resolutionsBasePackage(selector === "." ? parents.at(-1) ?? selector : selector);
                const alias = parseNpmAlias(value);
                if (!canInclude(name, mode, modeInclude, modeExclude, depType, mode, alias?.name ?? name)) continue;
                const path = [...root, ...parents, selector];
                const identity = JSON.stringify(path);
                const key = manifestDependencyKey(depType, typePrefix, name, identity);
                addNpmDep(key, name, value);
              } else if (value && typeof value === "object" && !Array.isArray(value)) {
                collectOverrides(value, [...parents, selector]);
              }
            }
          };
          collectOverrides(obj as Record<string, any>, []);
          continue;
        }
        for (const [name, value] of entries) {
          if (mode === "pypi" && Array.isArray(value)) { addUvDeps(value, `${depType}.${name}`); continue; }
          if (typeof value !== "string") continue;
          const alias = mode === "npm" ? parseNpmAlias(value) : null;
          if (!canInclude(name, mode, modeInclude, modeExclude, depType, mode, alias?.name ?? name)) continue;
          if (mode === "npm") addNpmDep(manifestDependencyKey(depType, typePrefix, name), name, value);
          else if (mode === "go") addDep(mode, depType, typePrefix, name, shortenGoVersion(value), stripv(value));
          else if (validRange(value)) addDep(mode, depType, typePrefix, name, normalizeRange(value), value);
        }
      }
    }
  };

  const files = resolveFiles(config.files);
  const fileContents = new Map(await pMap(Array.from(files).filter(file => {
    if (isWorkflowFile(file)) return enabledModes.has("actions") || enabledModes.has("docker");
    const filename = basename(file);
    if (isDockerFileName(filename)) return enabledModes.has("docker");
    if (isMakeFileName(filename)) return enabledModes.has("make");
    return enabledModes.has(modeByFileName[filename]);
  }), async (file): Promise<[string, string]> => {
    try {
      return [file, await readFile(file, "utf8")];
    } catch (err) {
      throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
    }
  }, {concurrency}));

  const fileData: Record<string, {
    absPath: string, content: string, fileType?: "dockerfile" | "compose" | "workflow" | "make", workflowLines?: Set<number>,
  }> = {};

  const goModFiles: PlainFile[] = [];
  const goWorkFiles: Array<{file: string, content: string, memberPath: string}> = [];

  const cargoMemberFiles: WorkspaceMember[] = [];
  const pnpmMemberFiles: WorkspaceMember[] = [];
  const pnpmCatalogFiles: WorkspaceMember[] = [];

  type ActionDepInfo = ActionRef & {
    key: string, apiUrl: string, filePin: Record<string, string>, filePinNoDowngrade: Config["pinNoDowngrade"], fileCooldownDays: number,
    versionConfig: VersionConfig, comment: string,
  };
  const actionDepInfos: Array<ActionDepInfo> = [];
  type DockerDepInfo = {
    key: string, fullImage: string, ref: DockerImageRef, versionConfig: VersionConfig,
    filePin: Record<string, string>, fileCooldownDays: number,
  };
  const dockerDepInfos: Array<DockerDepInfo> = [];
  type MakeDepBase = {
    key: string, name: string, oldSpec: string, projectDir: string,
    versionConfig: VersionConfig, filePin: Record<string, string>, filePinNoDowngrade: Config["pinNoDowngrade"],
    fileCooldownDays: number, newSpec?: string,
  };
  type MakeDepInfo = MakeDepBase & (
    {kind: "go", installPath: string, version: string} |
    {kind: "docker", image: MakeDockerImage}
  );
  const makeDepInfos: Array<MakeDepInfo> = [];
  type ModeCtx = {
    modeConfig: Config, versionConfig: VersionConfig, projectDir: string, pin: Record<string, string>,
    cooldownDays: number,
  };
  const modeContextsBySuffix: Record<string, Map<string, ModeCtx>> = {};
  const registerModeContext = (mode: string, memberPath: string, modeCtx: ModeCtx) => {
    (modeContextsBySuffix[mode] ??= new Map()).set(memberPath === "." ? "" : `|${memberPath}`, modeCtx);
  };
  const cliBase = (opts as {[cliBaseConfig]?: {fileConfig: Config, cliKeys: Array<string>}})[cliBaseConfig];
  const cliKeys = cliBase && new Set(cliBase.cliKeys);
  const configOverrides = Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    value !== undefined && (!cliKeys || cliKeys.has(key))));

  const resolveDirConfig = memoizeAsync(async (dir: string) => {
    const modeConfig = {...await loadConfig(dir), ...configOverrides};
    return {
      modeConfig,
      include: patternsToRegexSet(modeConfig.include ?? []),
      exclude: patternsToRegexSet(modeConfig.exclude ?? []),
      versionConfig: compileVersionConfig(modeConfig),
      pin: modeConfig.pin ?? {},
      pinNoDowngrade: modeConfig.pinNoDowngrade,
      cooldownDays: modeConfig.cooldown ? parseDuration(String(modeConfig.cooldown)) : 0,
    };
  });

  function resolveDepTypes(mode: string, modeConfig: Config): Array<string> {
    if (modeConfig.types?.length) return modeConfig.types;
    return mode === "npm" ? npmTypes : mode === "pypi" ? uvTypes :
      mode === "go" ? modeConfig.indirect ? goTypes : goTypes.filter(type => type !== "indirect") :
        mode === "cargo" ? [...cargoTypes, ...cargoTargetTypes] : [];
  }

  type FileFilters = Awaited<ReturnType<typeof resolveDirConfig>>;
  const modeCtx = (filters: Pick<FileFilters, "modeConfig" | "versionConfig" | "pin" | "cooldownDays">, projectDir: string): ModeCtx => ({
    modeConfig: filters.modeConfig, versionConfig: filters.versionConfig, projectDir, pin: filters.pin,
    cooldownDays: filters.cooldownDays,
  });

  const pnpmWorkspaceOverrides = (content: string) => {
    const entries: Array<{selector: string, value: string, lineNumber: number, valueIndex: number}> = [];
    let sectionIndent = -1;
    for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
      const pair = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*)):\s*(.*)$/.exec(line);
      if (!pair) continue;
      const indent = pair[1].length;
      const key = (pair[2] ?? pair[3] ?? pair[4]).trim();
      if (indent === 0) { sectionIndent = key === "overrides" ? indent : -1; continue; }
      if (sectionIndent === -1 || !pair[5]) continue;
      const raw = pair[5].replace(/\s+#.*$/, "").trimEnd();
      const leading = pair[5].length - pair[5].trimStart().length;
      const quoted = /^(['"])(.*)\1$/.exec(raw.trimStart());
      const value = quoted?.[2] ?? raw.trimStart();
      entries.push({selector: key, value, lineNumber, valueIndex: line.length - pair[5].length + leading + Number(Boolean(quoted))});
    }
    return entries;
  };

  function collectDockerRef(ref: DockerImageRef, relPath: string, filters: FileFilters): void {
    deps.docker ??= {};
    if (!canInclude(ref.fullImage, "docker", filters.include, filters.exclude, "docker")) return;
    const identity = `${ref.tag}${ref.digest ? `@${ref.digest}` : ""}`;
    const key = dependencyKey(relPath, ref.fullImage, identity);
    if (deps.docker[key]) return;
    const parsed = parseDockerTag(ref.tag);
    if (!parsed && !ref.digest) return;
    deps.docker[key] = {
      old: parsed?.version ?? ref.tag, oldOrig: ref.tag,
      ...(ref.digest && {oldDigest: ref.digest}), ...(ref.digestOnly && {digestOnly: true}),
    } as Dep;
    dockerDepInfos.push({
      key, fullImage: ref.fullImage, ref, versionConfig: filters.versionConfig,
      filePin: filters.pin, fileCooldownDays: filters.cooldownDays,
    });
  }

  const cargoWorkspaceFiles = new Map<string, Record<string, any>>();
  const npmWorkspaceFiles = new Map<string, Record<string, any>>();
  for (const file of files) {
    const filename = basename(file);
    if (filename === "package.json") {
      const content = fileContents.get(file);
      if (!content) continue;
      try {
        const parsed = JSON.parse(content);
        const patterns = Array.isArray(parsed.workspaces) ? parsed.workspaces : parsed.workspaces?.packages;
        if (Array.isArray(patterns) && patterns.some(pattern => typeof pattern === "string")) {
          npmWorkspaceFiles.set(file, parsed);
        }
      } catch {}
    } else if (filename === "Cargo.toml") {
      const content = fileContents.get(file);
      if (!content) continue;
      try {
        const parsed = parseToml(content);
        const members = (parsed.workspace as Record<string, any>)?.members;
        if (Array.isArray(members) && members.length) {
          cargoWorkspaceFiles.set(file, parsed);
        }
      } catch {}
    }
  }

  const workspaceRootCounts: Record<string, number> = {
    cargo: cargoWorkspaceFiles.size,
    go: Array.from(files).filter(file => basename(file) === "go.work").length,
    npm: new Set([...npmWorkspaceFiles.keys(),
      ...Array.from(files).filter(file => basename(file) === "pnpm-workspace.yaml")]).size,
  };

  const addPlainFile = (mode: string, file: string, content: string, projectDir: string, filters: FileFilters): string => {
    const modeFiles = plainFiles[mode] ??= [];
    const isFirstOfMode = !modeFiles.length && !workspaceRootCounts[mode];
    const memberPath = isFirstOfMode ? "." : toRelPath(file);
    modeFiles.push({absPath: resolve(file), content, memberPath, projectDir});
    registerModeContext(mode, memberPath, modeCtx(filters, projectDir));
    return isFirstOfMode ? "" : `|${memberPath}`;
  };

  const parseFile = (file: string, parse: () => Record<string, any>): Record<string, any> => {
    try {
      return parse();
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }
  };

  const workspaceMemberPath = (mode: string, workspaceFile: string, memberPath: string) =>
    workspaceRootCounts[mode] > 1 ?
      `${toRelPath(workspaceFile)}:${memberPath}` : memberPath;
  const collectNpmWorkspaceMember = (
    workspaceFile: string, workspaceDir: string, member: WorkspaceMember, pkg: Record<string, any>,
    dependencyTypes: Array<string>, filters: FileFilters,
  ) => {
    const memberPath = workspaceMemberPath("npm", workspaceFile, member.memberPath);
    registerModeContext("npm", memberPath, modeCtx(filters, workspaceDir));
    pnpmMemberFiles.push({...member, memberPath});
    collectDeps("npm", pkg, memberPath === "." ? "" : `|${memberPath}`, dependencyTypes, filters.include, filters.exclude);
  };
  for (const file of cargoWorkspaceFiles.size || npmWorkspaceFiles.size ?
    new Set([...cargoWorkspaceFiles.keys(), ...npmWorkspaceFiles.keys(), ...fileContents.keys()]) : fileContents.keys()) {
    if (isWorkflowFile(file)) {
      const actionsEnabled = enabledModes.has("actions");
      const dockerEnabled = enabledModes.has("docker");
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const filters = await resolveDirConfig(dirname(file));
      const workflowLines = new Set<number>();
      fileData[relPath] = {absPath: file, content, fileType: "workflow", workflowLines};
      const yamlPath: Array<{indent: number, key: string}> = [];

      for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
        if (actionsEnabled) {
          const parsed = parseUsesLine(line);
          const action = parsed && parseActionRef(parsed.value);
          if (action && canInclude(action.name, "actions", filters.include, filters.exclude, "actions")) {
            deps.actions ??= {};
            const comment = parsed.pinnedVersion || /^#\s*(\S+)\s*$/.exec(parsed.comment)?.[1] || "";
            const identity = action.isHash && comment ? `${comment}@${action.ref}` : action.ref;
            const key = dependencyKey(relPath, action.name, identity);
            if (!deps.actions[key]) {
              deps.actions[key] = {old: action.ref} as Dep;
              actionDepInfos.push({
                ...action, key, comment,
                apiUrl: getForgeApiBaseUrl(action.host, forgeApiUrl),
                versionConfig: filters.versionConfig, filePin: filters.pin,
                filePinNoDowngrade: filters.pinNoDowngrade, fileCooldownDays: filters.cooldownDays,
              });
            }
          }
        }

        if (!dockerEnabled) continue;
        const pair = /^(\s*)(?:-\s*)?(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*)):\s*(.*)$/.exec(line);
        if (!pair) continue;
        const indent = pair[1].length;
        while (yamlPath.length && yamlPath.at(-1)!.indent >= indent) yamlPath.pop();
        const key = (pair[2] ?? pair[3] ?? pair[4]).trim();
        const container = key === "container" && yamlPath.length === 2 && yamlPath[0].key === "jobs";
        const image = key === "image" && (
          yamlPath.length === 3 && yamlPath[0].key === "jobs" && yamlPath[2].key === "container" ||
          yamlPath.length === 4 && yamlPath[0].key === "jobs" && yamlPath[2].key === "services"
        );
        const uses = key === "uses" && (
          yamlPath.length === 3 && yamlPath[0].key === "jobs" && yamlPath[2].key === "steps" ||
          yamlPath.length === 2 && yamlPath[0].key === "runs" && yamlPath[1].key === "steps"
        );
        if ((container || image || uses) && pair[5]) {
          const value = pair[5].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
          const ref = parseDockerImageRef(uses ? value.replace(/^docker:\/\//, "") : value);
          if (ref) { collectDockerRef(ref, relPath, filters); workflowLines.add(lineNumber); }
        }
        yamlPath.push({indent, key});
      }

      continue;
    }

    const filename = basename(file);
    const absFile = resolve(file);

    if (isDockerFileName(filename)) {
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const fileType = isDockerfile(filename) ? "dockerfile" : "compose";
      const filters = await resolveDirConfig(dirname(file));
      fileData[relPath] = {absPath: file, content, fileType};
      for (const {ref} of extractDockerRefs(content, getExtractionRegex(filename))) {
        collectDockerRef(ref, relPath, filters);
      }
      continue;
    }

    if (isMakeFileName(filename)) {
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const filters = await resolveDirConfig(dirname(file));
      fileData[relPath] = {absPath: file, content, fileType: "make"};
      deps.make ??= {};
      const makeShared = {
        projectDir: dirname(file), versionConfig: filters.versionConfig,
        filePin: filters.pin, filePinNoDowngrade: filters.pinNoDowngrade,
        fileCooldownDays: filters.cooldownDays,
      };
      for (const {installPath, version} of parseMakeGoInstalls(content)) {
        if (!canInclude(installPath, "make", filters.include, filters.exclude, "make", "go")) continue;
        const key = dependencyKey(relPath, installPath, version);
        if (deps.make[key]) continue;
        deps.make[key] = {old: stripv(version), oldOrig: version} as Dep;
        makeDepInfos.push({kind: "go", key, name: installPath, oldSpec: `${installPath}@${version}`, installPath, version, ...makeShared});
      }
      for (const image of parseMakeDockerImages(content)) {
        if (!canInclude(image.writtenImage, "make", filters.include, filters.exclude, "make", "docker")) continue;
        const key = dependencyKey(relPath, image.writtenImage, image.ref.tag);
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
      const workspaceDir = dirname(absFile);
      const workContent = fileContents.get(file)!;
      const goWork = parseGoWork(workContent);

      const [{modeConfig, include: modeInclude, exclude: modeExclude, versionConfig, pin, cooldownDays}, useReads] = await Promise.all([
        resolveDirConfig(workspaceDir),
        pMap(goWork.use, async (usePath) => {
          const modPath = resolveGoWorkModule(workspaceDir, usePath);
          if (!modPath) return null;
          try {
            return {usePath, modPath, content: await readFile(modPath, "utf8")};
          } catch {
            return null;
          }
        }, {concurrency}),
      ]);
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      const workspacePath = workspaceMemberPath(mode, file, ".");
      const modeContext = modeCtx({modeConfig, versionConfig, pin, cooldownDays}, workspaceDir);
      registerModeContext(mode, workspacePath, modeContext);
      goWorkFiles.push({file, content: workContent, memberPath: workspacePath});

      for (const entry of useReads) {
        if (!entry) continue;
        const {usePath, modPath, content: modContent} = entry;
        const parsed = parseGoMod(modContent);
        const memberPath = workspaceMemberPath(mode, file, usePath);
        registerModeContext(mode, memberPath, modeContext);
        goModFiles.push({absPath: modPath, content: modContent, projectDir: dirname(modPath), memberPath});

        collectDeps(mode, parsed, memberPath === "." ? "" : `|${memberPath}`, dependencyTypes, modeInclude, modeExclude);
      }

      for (const [name, value] of Object.entries(goWork.replace)) {
        if (canInclude(name, mode, modeInclude, modeExclude, "replace")) {
          addDep(mode, "replace", workspacePath === "." ? "" : `|${workspacePath}`, name, shortenGoVersion(value), stripv(value));
        }
      }

      continue;
    }

    if (filename === "go.mod" && goModFiles.some(member => member.absPath === absFile)) continue;
    if (filename === "package.json" && pnpmMemberFiles.some(member => member.absPath === absFile)) continue;
    if (filename === "Cargo.toml" && cargoMemberFiles.some(member => member.absPath === absFile)) continue;

    if (filename === "Cargo.toml") {
      deps[mode] ??= {};
      const cargoContent = fileContents.get(file)!;
      const cargoParsed = cargoWorkspaceFiles.get(file) ?? parseToml(cargoContent);
      const workspaceDir = dirname(absFile);

      const lockPath = findUpSync(["Cargo.lock"], workspaceDir).get("Cargo.lock");
      const wsMembers = (cargoParsed.workspace as Record<string, any>)?.members;
      const isWorkspace = Array.isArray(wsMembers) && wsMembers.length;

      const [filters, lockContent, members] = await Promise.all([
        resolveDirConfig(workspaceDir),
        lockPath ? readFile(lockPath, "utf8") : Promise.resolve(null),
        isWorkspace ? resolveWorkspaceMembers(wsMembers, workspaceDir, "Cargo.toml", concurrency) : Promise.resolve([] as WorkspaceMember[]),
      ]);
      const {modeConfig, include: modeInclude, exclude: modeExclude} = filters;
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      const lockedVersions = lockContent ? parseCargoLock(lockContent) : new Map<string, string[]>();

      const collectCargoDeps = (parsed: Record<string, any>, typePrefix: string) => {
        for (const [depType, table] of expandDepTypes(dependencyTypes, parsed)) {
          const obj = table || {};
          if (typeof obj !== "object" || Array.isArray(obj)) continue;
          for (const [name, value] of Object.entries(obj)) {
            if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
            if (typeof value === "object" && value !== null && "version" in value && !("git" in value) && !("path" in value) && !("registry" in value)) {
              const versionStr = (value as Record<string, string>).version;
              const crate = (value as Record<string, string>).package || name;
              if (validRange(cargoToNpmRange(versionStr))) {
                if (crate !== name) cargoCrates.set(manifestDependencyKey(depType, typePrefix, name), crate);
                addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, crate, versionStr) ?? normalizeRange(cargoToNpmRange(versionStr)), versionStr);
              }
            } else if (typeof value === "string" && validRange(cargoToNpmRange(value))) {
              addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, name, value) ?? normalizeRange(cargoToNpmRange(value)), value);
            }
          }
        }
      };

      if (isWorkspace) {
        const workspacePath = workspaceMemberPath(mode, file, ".");
        const modeContext = modeCtx(filters, workspaceDir);
        registerModeContext(mode, workspacePath, modeContext);
        collectCargoDeps(cargoParsed, workspacePath === "." ? "" : `|${workspacePath}`);
        cargoMemberFiles.push({absPath: absFile, content: cargoContent, memberPath: workspacePath});
        for (const member of members) {
          const memberPath = workspaceMemberPath(mode, file, member.memberPath);
          registerModeContext(mode, memberPath, modeContext);
          cargoMemberFiles.push({...member, memberPath});
          collectCargoDeps(parseFile(member.absPath, () => parseToml(member.content)), `|${memberPath}`);
        }
      } else {
        collectCargoDeps(cargoParsed, addPlainFile(mode, file, cargoContent, workspaceDir, filters));
      }

      continue;
    }

    if (filename === "package.json" && npmWorkspaceFiles.has(file)) {
      deps[mode] ??= {};
      const workspaceDir = dirname(absFile);
      const rootContent = fileContents.get(file)!;
      const rootPkg = npmWorkspaceFiles.get(file)!;
      const rawPackagePatterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages;
      const packagePatterns = Array.isArray(rawPackagePatterns) ?
        rawPackagePatterns.filter((pattern: unknown): pattern is string => typeof pattern === "string") : [];
      const [filters, members] = await Promise.all([
        resolveDirConfig(workspaceDir),
        resolveWorkspaceMembers(packagePatterns, workspaceDir, "package.json", concurrency),
      ]);
      const dependencyTypes = resolveDepTypes(mode, filters.modeConfig);
      collectNpmWorkspaceMember(file, workspaceDir, {
        absPath: absFile, content: rootContent, memberPath: ".",
      }, rootPkg, dependencyTypes, filters);
      for (const member of members) {
        collectNpmWorkspaceMember(file, workspaceDir, member,
          parseFile(member.absPath, () => JSON.parse(member.content)), dependencyTypes, filters);
      }
      continue;
    }

    if (filename === "pnpm-workspace.yaml") {
      deps[mode] ??= {};
      const workspaceDir = dirname(absFile);
      const wsContent = fileContents.get(file)!;
      const packagePatterns = parsePnpmWorkspace(wsContent);
      const rootPkgPath = join(workspaceDir, "package.json");

      const [filters, rootContent, members] = await Promise.all([
        resolveDirConfig(workspaceDir),
        tryOrNull(readFile(rootPkgPath, "utf8")),
        resolveWorkspaceMembers(packagePatterns, workspaceDir, "package.json", concurrency),
      ]);
      const dependencyTypes = resolveDepTypes(mode, filters.modeConfig);
      const workspaceManifestPath = workspaceMemberPath(mode, file, filename);
      registerModeContext(mode, workspaceManifestPath, modeCtx(filters, workspaceDir));

      pnpmCatalogFiles.push({absPath: absFile, content: wsContent, memberPath: workspaceManifestPath});
      for (const {type, name, value} of pnpmCatalogEntries(wsContent)) {
        if (canInclude(name, mode, filters.include, filters.exclude, type, mode, parseNpmAlias(value)?.name ?? name)) {
          addNpmDep(manifestDependencyKey(type, `|${workspaceManifestPath}`, name), name, value);
        }
      }
      for (const {selector, value} of pnpmWorkspaceOverrides(wsContent)) {
        const packages = selector.match(/(?:^|>)(?:@[^/>\s]+\/[^@>\s]+|[^@>\s]+)(?=@|>|$)/g);
        const packageName = packages?.at(-1)?.replace(/^>/, "") ?? selector;
        const type = "pnpm-workspace.overrides";
        if (!canInclude(selector, mode, filters.include, filters.exclude, type, mode, packageName)) continue;
        const identity = JSON.stringify(selector);
        const key = manifestDependencyKey(type, `|${workspaceManifestPath}`, selector, identity);
        npmPublishedNames.set(key, packageName);
        pnpmWorkspaceOverrideKeys.set(key, selector);
        addNpmDep(key, selector, value);
      }

      if (rootContent !== null) {
        const rootPkg = parseFile(rootPkgPath, () => JSON.parse(rootContent));
        collectNpmWorkspaceMember(file, workspaceDir, {
          absPath: resolve(rootPkgPath), content: rootContent, memberPath: ".",
        }, rootPkg, dependencyTypes, filters);
      }

      for (const member of members) {
        collectNpmWorkspaceMember(file, workspaceDir, member,
          parseFile(member.absPath, () => JSON.parse(member.content)), dependencyTypes, filters);
      }

      continue;
    }

    deps[mode] ??= {};

    const projectDir = dirname(absFile);
    const filters = await resolveDirConfig(projectDir);
    const {modeConfig, include: modeInclude, exclude: modeExclude} = filters;

    const dependencyTypes = resolveDepTypes(mode, modeConfig);

    const content = fileContents.get(file)!;
    const pkg = parseFile(file, () => mode === "npm" ? JSON.parse(content) :
      mode === "pypi" ? parseToml(content) : parseGoMod(content));
    const typePrefix = addPlainFile(mode, file, content, projectDir, filters);

    collectDeps(mode, pkg, typePrefix, dependencyTypes, modeInclude, modeExclude);
  }

  const hasMaybeUrlDeps = Object.keys(maybeUrlDeps).length > 0;
  if (!hasDeps(deps) && !hasMaybeUrlDeps) {
    return {results: {}, message: "No dependencies found, nothing to do."};
  }

  const fetchTasks: Array<Promise<void>> = [];
  const npmIdentity = (key: string, name: string) => npmPublishedNames.get(key) ?? npmAliases.get(key)?.name ??
    (selectorTypes.has(key.split(fieldSep)[0].split("|")[0]) ? resolutionsBasePackage(name) : name);

  const argsForNpm = {needsDates: (modeContextsBySuffix.npm?.values() ?? [][Symbol.iterator]()).some(entry =>
    entry.cooldownDays || entry.versionConfig.hasCooldownOverride)};

  for (const [mode, modeContexts] of Object.entries(modeContextsBySuffix)) {
    if (!Object.keys(deps[mode] ?? {}).length && (mode !== "npm" || !hasMaybeUrlDeps)) continue;
    fetchTasks.push((async () => {
      const modeConfigEntry = modeContexts.values().next().value!;
      const ctxForType = (type: string) => {
        const barIdx = type.indexOf("|");
        return modeContexts.get(barIdx === -1 ? "" : type.slice(barIdx)) ?? modeConfigEntry;
      };
      const npmFollowUps = new Map<string, {name: string, promise: Promise<{repository?: PackageRepository, homepage?: string, date?: string}>}>();
      const modeDeps = deps[mode];
      const lookupDep = async (key: string, type: string, name: string) => {
        const baseT = baseType(type);
        const {modeConfig, versionConfig, projectDir, pin, cooldownDays} = ctxForType(type);
        const dep = modeDeps[key];
        const npmAlias = npmAliases.get(key);
        const info = mode === "npm" ? dep.oldOrig && isJsr(dep.oldOrig) ? fetchJsrInfo(name, ctx) :
          fetchNpmInfo(npmIdentity(key, name), baseT, modeConfig, argsForNpm, ctx, projectDir, dep.old) :
          mode === "go" ? fetchGoProxyInfo(name, type, dep.oldOrig || dep.old, projectDir, ctx, goNoProxy) :
            mode === "cargo" ? fetchCratesIoInfo(cargoCrates.get(key) ?? name, ctx) : fetchPypiInfo(name, ctx);

        const [rawData, registry] = await info;
        let data = rawData;
        if (data.error) throw new Error(data.error);

        const identity = baseT === "packageManager" ? name : data.name;
        const {
          useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, allowedVersions,
          pinnedRange, pinNoDowngrade, cooldownDays: depCooldownDays,
        } = resolveVersionOpts(versionConfig, mode, identity, name, pin, modeConfig.pinNoDowngrade, cooldownDays);
        data = filterVersionData(data, mode, allowedVersions);
        const {old: oldRange, oldOrig} = dep;
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
          if (oldOrig && isJsr(oldOrig)) {
            const match = jsrSpecifierRe.exec(oldOrig);
            if (match) newRange = `${match[1]}${newVersion}`;
            else if (oldOrig.startsWith("jsr:")) newRange = `jsr:${newVersion}`;
          } else if (npmAlias) {
            newRange = `npm:${npmAlias.name}@${updateVersionRange(oldRange, newVersion, npmAlias.range, baseT)}`;
          } else {
            newRange = updateVersionRange(oldRange, newVersion, oldOrig, baseT);
          }
        }

        const spec = pypiSpecs.get(key);
        if (!newVersion || newVersion === oldRange || oldOrig && (oldOrig === newRange) ||
          spec && !updateRequirement(spec, oldOrig || oldRange, newRange)) {
          if (config.verbose && newVersion && newVersion !== oldRange) {
            console.error(`${timestamp()} ${magenta("SKIP")} ${name}: ${oldOrig || oldRange} can not be rewritten to ${newVersion}`);
          }
          delete modeDeps[key];
          return;
        }

        const date: string = (mode === "pypi" ? data.releases?.[newVersion]?.[0]?.upload_time_iso_8601 :
          mode === "go" ? data.Time : mode === "cargo" ? data.time?.[newVersion] : "") || "";

        dep.new = newRange;
        if (oldOrig && isJsr(oldOrig)) dep.newPrint = newVersion;

        if (mode === "npm") {
          npmFollowUps.set(key, {name: npmIdentity(key, name), promise: fetchNpmVersionInfo(data.name, newVersion, modeConfig, argsForNpm, ctx, projectDir)});
        } else dep.info = mode === "pypi" ? getInfoUrl(data, registry, data.info.name) :
          mode === "go" ? getGoInfoUrl(data.newPath || name) : `https://crates.io/crates/${data.name}`;

        setDepAge(dep, date);
      };

      await pMap(Object.keys(modeDeps), async (key) => {
        const [type, name] = key.split(fieldSep);
        try {
          await lookupDep(key, type, name);
        } catch (err) {
          rejectDep(mode, key, err);
        }
      }, {concurrency});

      await Promise.all(Array.from(npmFollowUps, async ([key, {name, promise}]) => {
        const followUp = await promise;
        const dep = modeDeps[key];
        if (!dep) return;
        dep.info = getInfoUrl({repository: followUp.repository, homepage: followUp.homepage}, null, name);
        setDepAge(dep, followUp.date);
      }));

      if (mode === "npm" && hasMaybeUrlDeps) {
        const results = (await pMap(Object.entries(maybeUrlDeps), async ([key, dep]) => {
          try {
            return await checkUrlDep(key, dep, ctx);
          } catch (err) {
            addKeyError("npm", key, err);
            return null;
          }
        }, {concurrency})).filter(result => result !== null);

        for (const {key, newRange, user, repo, oldRef, newRef, newDate} of results) {
          const dep: Dep = modeDeps[key] = {
            old: maybeUrlDeps[key].old,
            new: newRange,
            oldPrint: hashRe.test(oldRef) ? oldRef.substring(0, 7) : oldRef,
            newPrint: hashRe.test(newRef) ? newRef.substring(0, 7) : newRef,
            info: `https://github.com/${user}/${repo}`,
          };
          setDepAge(dep, newDate);
        }
      }

      for (const [key, {date}] of Object.entries(modeDeps)) {
        if (!date) continue;
        const [type, name] = key.split(fieldSep);
        const {cooldownDays, versionConfig} = ctxForType(type);
        if (!cooldownDays && !versionConfig.hasCooldownOverride) continue;
        const identity = mode === "npm" ? npmIdentity(key, name) : name;
        const effectiveCooldownDays = getVersionOpts(versionConfig, mode, identity, name).cooldownOverride ?? cooldownDays;
        if (effectiveCooldownDays && !passesCooldown(date, effectiveCooldownDays, now)) delete modeDeps[key];
      }
    })());
  }

  const actionVersionOpts = (info: ActionDepInfo) => resolveVersionOpts(
    info.versionConfig, "actions", info.name, info.name, info.filePin, info.filePinNoDowngrade,
    info.fileCooldownDays,
  );

  if (actionDepInfos.length) {
    fetchTasks.push((async () => {
      await pMap(Map.groupBy(actionDepInfos, info => `${info.apiUrl}/${info.owner}/${info.repo}`).values(), async (infos) => {
        const {apiUrl, owner, repo} = infos[0];
        const versionConsumers = infos.filter(info => info.isHash ?
          !isDigestOnlyPin(info) : isVersionLikeRef(info.ref));
        const needsOlderTags = versionConsumers.some(info => {
          const {allowDowngrade, pinnedRange, pinNoDowngrade} = actionVersionOpts(info);
          return allowDowngrade || Boolean(pinnedRange && !pinNoDowngrade);
        });
        const tagRefs = [
          ...versionConsumers.map(info => info.isHash ? info.comment || info.ref : info.ref),
          ...(apiUrl === defaultApiUrls.forgeapi ? [] : infos.filter(isDigestOnlyPin).map(info => info.comment)),
        ];
        let tags: Array<TagEntry> = [];
        try {
          if (tagRefs.length) {
            tags = await fetchActionTags(
              apiUrl, owner, repo, ctx, needsOlderTags ? [] : tagRefs, Boolean(versionConsumers.length),
            );
          }
        } catch (err) {
          for (const info of infos) {
            rejectDep("actions", info.key, err);
          }
          return;
        }
        const versions: string[] = [];
        const tagByVersion = new Map<string, string>();
        const entryByName = new Map<string, TagEntry>();
        const commitShaToTag = new Map<string, string>();
        for (const tag of tags) {
          entryByName.set(tag.name, tag);
          const version = githubActionsVersioning.parse(tag.name)?.version;
          if (version && tag.isStable !== false) {
            const existing = tagByVersion.get(version);
            if (!existing) versions.push(version);
            if (!existing || tag.name.length > existing.length) tagByVersion.set(version, tag.name);
          }
          if (tag.commitSha) commitShaToTag.set(tag.commitSha, tag.name);
        }

        const getDate = memoizeAsync((commitSha: string) => fetchActionTagDate(apiUrl, owner, repo, commitSha, ctx));
        const getExactDigest = memoizeAsync(async (exactRef: string): Promise<string> => {
          const tagged = entryByName.get(exactRef)?.commitSha;
          if (tagged) return tagged;
          const path = apiUrl === defaultApiUrls.forgeapi ? "commits" : "branches";
          const url = `${apiUrl}/repos/${owner}/${repo}/${path}/${encodeURIComponent(exactRef)}`;
          const response = await fetchForge(url, ctx);
          if (response.status === 404) return "";
          if (!response.ok) throw new Error(`Unable to fetch ${owner}/${repo}@${exactRef}`);
          const body = await response.json();
          return typeof body?.sha === "string" ? body.sha : typeof body?.id === "string" ? body.id :
            typeof body?.commit?.sha === "string" ? body.commit.sha : typeof body?.commit?.id === "string" ? body.commit.id : "";
        });

        async function pickVersion(opts: Parameters<typeof findVersion>[2], sourceVersions: Array<string>): Promise<{version: string, tag: string, commitSha: string, date: string} | null> {
          const selectOpts = {...opts, cooldownDays: undefined, now: undefined};
          const denylist = new Set<string>();
          for (let attempt = 0; attempt < 20; attempt++) {
            const candidates = denylist.size ? sourceVersions.filter(version => !denylist.has(version)) : sourceVersions;
            const picked = findVersion({}, candidates, selectOpts);
            if (!picked) return null;
            const tag = tagByVersion.get(picked)!;
            const commitSha = entryByName.get(tag)?.commitSha || "";
            if (!opts.cooldownDays) return {version: picked, tag, commitSha, date: ""};
            const date = commitSha ? await getDate(commitSha) : "";
            if (date === undefined) throw new Error(`Unable to fetch the commit date for ${owner}/${repo}@${tag}`);
            if (passesCooldown(date, opts.cooldownDays, opts.now)) return {version: picked, tag, commitSha, date};
            denylist.add(picked);
          }
          return null;
        }

        const updateAction = async (info: ActionDepInfo) => {
          const {key, host, ref, comment, isHash} = info;
          const dep = deps.actions[key];
          const infoUrl = `https://${host || "github.com"}/${owner}/${repo}`;

          let oldRef = ref;
          if (isHash) {
            oldRef = comment || commitShaToTag.get(ref) || commitShaToTag.entries().find(([sha]) => sha.startsWith(ref))?.[1] || "";
          } else if (!isVersionLikeRef(ref)) {
            oldRef = "";
          }
          if (!oldRef) { delete deps.actions[key]; return; }

          const {
            useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, allowedVersions,
            pinnedRange, pinNoDowngrade, cooldownDays: actionCooldownDays,
          } = actionVersionOpts(info);
          // A comment naming a branch or other moving ref has no version to select against.
          const result = isVersionLikeRef(oldRef) ? await pickVersion({
            range: oldRef, semvers, useGreatest, usePre, useRel, allowDowngrade: allowDown, versioning: githubActionsVersioning,
            pinnedRange, pinNoDowngrade,
            cooldownDays: actionCooldownDays || undefined, now: actionCooldownDays ? now : undefined,
          }, allowedVersions ? versions.filter(versionAllowedPredicate("actions", allowedVersions)) : versions) : null;
          if (!result) {
            // No newer version, but a commented sha pin still tracks whatever that ref points at now.
            if (!isHash || !comment) { delete deps.actions[key]; return; }
            const newDigest = await getExactDigest(comment);
            if (!newDigest || newDigest.startsWith(ref) || ref.startsWith(newDigest)) { delete deps.actions[key]; return; }
            dep.old = comment;
            dep.new = comment;
            dep.oldDigest = ref;
            dep.newDigest = newDigest;
            dep.digestOnly = true;
            dep.info = infoUrl;
            setDepAge(dep, await tryOrNull(getDate(newDigest)));
            return;
          }
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

          const newDate = date || (newCommitSha ? await tryOrNull(getDate(newCommitSha)) : "");
          setDepAge(dep, newDate);
        };

        await pMap(infos, async (info) => {
          try {
            await updateAction(info);
          } catch (err) {
            rejectDep("actions", info.key, err);
          }
        }, {concurrency});
      }, {concurrency});

      if (!Object.keys(deps.actions).length) delete deps.actions;
    })());
  }

  if (dockerDepInfos.length) {
    fetchTasks.push((async () => {
      await pMap(Map.groupBy(dockerDepInfos, info => info.fullImage).entries(), async ([fullImage, infos]) => {
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
            rejectDep("docker", info.key, err);
          }
          return;
        }

        await pMap(infos, async (info) => {
          const dep = deps.docker[info.key];
          const oldTag = dep.oldOrig || dep.old;
          const {semvers, usePre, useRel, allowedVersions, pinnedRange, cooldownDays: dockerCooldownDays} =
            resolveVersionOpts(info.versionConfig, "docker", fullImage, fullImage, info.filePin, undefined, info.fileCooldownDays);
          const tags = filterVersionData(data, "docker", allowedVersions).tags;
          const result = !info.ref.digestOnly && parseDockerTag(oldTag) ? findDockerVersion(
            tags, oldTag, semvers,
            dockerCooldownDays || undefined, dockerCooldownDays ? now : undefined,
            pinnedRange, usePre, useRel,
          ) : null;
          const newTag = result?.newTag ?? oldTag;
          if (info.ref.digest) {
            const newDigest = await resolveDockerTagDigest(info.ref.namespace, info.ref.repo, newTag);
            if (!newDigest || newDigest === info.ref.digest && !result) { delete deps.docker[info.key]; return; }
            dep.oldDigest = info.ref.digest;
            dep.newDigest = newDigest;
            dep.digestOnly = info.ref.digestOnly;
          } else if (!result) {
            delete deps.docker[info.key];
            return;
          }

          dep.new = newTag;
          dep.info = getDockerInfoUrl(info.ref);
          setDepAge(dep, result?.date);
        }, {concurrency});
      }, {concurrency});

      if (!Object.keys(deps.docker).length) delete deps.docker;
    })());
  }

  if (makeDepInfos.length) {
    fetchTasks.push((async () => {
      await pMap(makeDepInfos, async (info) => {
        const {
          useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, allowedVersions,
          pinnedRange, pinNoDowngrade, cooldownDays: makeCooldownDays,
        } = resolveVersionOpts(
          info.versionConfig, info.kind, info.name, info.name, info.filePin, info.filePinNoDowngrade,
          info.fileCooldownDays,
        );
        const opts = {
          semvers, useGreatest, usePre, useRel, allowDowngrade: allowDown, pinnedRange, pinNoDowngrade,
          cooldownDays: makeCooldownDays || undefined, now: makeCooldownDays ? now : undefined,
        };
        const dep = deps.make[info.key];
        try {
          if (info.kind === "go") {
            const modulePath = await resolveGoModuleRoot(info.installPath, info.projectDir, ctx, goNoProxy);
            if (!modulePath) { delete deps.make[info.key]; return; }
            const [rawData] = await fetchGoProxyInfo(modulePath, "tool", stripv(info.version), info.projectDir, ctx, goNoProxy);
            const data = filterVersionData(rawData, "go", allowedVersions);
            const newVersion = findNewVersion(data, {...opts, mode: "go", range: stripv(info.version)});
            if (!newVersion) { delete deps.make[info.key]; return; }
            const newModulePath = data.newPath ?? goModulePathForVersion(modulePath, newVersion);
            const newInstallPath = `${newModulePath}${info.installPath.slice(modulePath.length)}`;
            const formattedVersion = formatVersionPrecision(newVersion, info.version);
            if (newInstallPath === info.installPath && formattedVersion === info.version) {
              delete deps.make[info.key]; return;
            }
            info.newSpec = `${newInstallPath}@${formattedVersion}`;
            dep.new = formattedVersion;
            dep.info = getGoInfoUrl(newModulePath);
            setDepAge(dep, data.Time);
          } else {
            const [data] = await fetchDockerInfo(info.image.ref.fullImage, ctx);
            const tags = filterVersionData(data, "docker", allowedVersions).tags;
            const dockerUpdate = findDockerVersion(
              tags, info.image.ref.tag, opts.semvers, opts.cooldownDays, opts.now,
              opts.pinnedRange, opts.usePre, opts.useRel,
            );
            if (!dockerUpdate) { delete deps.make[info.key]; return; }
            const newDigest = info.image.digest ?
              await resolveDockerTagDigest(info.image.ref.namespace, info.image.ref.repo, dockerUpdate.newTag) : null;
            if (info.image.digest && !newDigest) { delete deps.make[info.key]; return; }
            info.newSpec = formatMakeImageSpec(info.image.writtenImage, dockerUpdate.newTag, newDigest);
            dep.new = dockerUpdate.newTag;
            dep.info = getDockerInfoUrl(info.image.ref);
            setDepAge(dep, dockerUpdate.date);
          }
        } catch (err) {
          rejectDep("make", info.key, err);
        }
      }, {concurrency});
      if (!Object.keys(deps.make).length) delete deps.make;
    })());
  }

  try {
    await Promise.all(fetchTasks);
  } finally {
    await flushCacheWrites();
  }

  if (!hasDeps(deps)) {
    return errors.length ? {results: {}, errors} : {results: {}, message: "All dependencies are up to date."};
  }

  const updatePnpmWorkspaceOverrideValues = (content: string, memberPath: string): string => {
    const lines = content.split("\n");
    const entries = new Map(pnpmWorkspaceOverrides(content).map(entry => [entry.selector, entry]));
    for (const [key, selector] of pnpmWorkspaceOverrideKeys) {
      const dep = deps.npm?.[key];
      const entry = entries.get(selector);
      if (!dep || !depBelongsToMember(key, memberPath) || !entry || entry.value !== (dep.oldOrig || dep.old)) continue;
      const line = lines[entry.lineNumber];
      lines[entry.lineNumber] = `${line.slice(0, entry.valueIndex)}${dep.new}${line.slice(entry.valueIndex + entry.value.length)}`;
    }
    return lines.join("\n");
  };

  if (config.update) {
    const updateMembers = (mode: string, members: WorkspaceMember[], updateFn: (content: string, deps: Deps, member: WorkspaceMember) => string) => {
      for (const member of members) {
        const localDeps = filterDepsForMember(deps[mode], member.memberPath);
        if (!Object.keys(localDeps).length) continue;
        write(member.absPath, updateFn(member.content, localDeps, member));
      }
    };
    const actionComments = new Map(actionDepInfos.map(info => [info.key, info.comment]));
    const byRelPath = <T>(entries: Array<[string, T]>) => Map.groupBy(entries, ([key]) => key.split(fieldSep)[0]);
    const actionsUpdatesByRelPath = byRelPath(Object.entries(deps.actions ?? {}));
    const dockerUpdatesByRelPath = byRelPath(Object.entries(deps.docker ?? {}));
    const makeUpdatesByRelPath = Map.groupBy(
      makeDepInfos.filter(info => info.newSpec && deps.make?.[info.key]), info => info.key.split(fieldSep)[0],
    );

    for (const mode of Object.keys(deps)
      .sort((left, right) => (left === "docker" ? 1 : 0) - (right === "docker" ? 1 : 0))) {
      if (!Object.keys(deps[mode]).length) continue;

      if (mode === "actions") {
        for (const [relPath, entries] of actionsUpdatesByRelPath) {
          const {absPath, content} = fileData[relPath] || {};
          if (!absPath) continue;
          const actionDeps = entries.map(([key, dep]) => {
            const oldRef = dep.oldDigest ?? dep.old;
            return {
              name: key.split(fieldSep)[1], oldRef,
              newRef: dep.newDigest ? dep.newDigest.substring(0, oldRef.length) : dep.new,
              oldComment: actionComments.get(key) || undefined,
              newComment: dep.digestOnly ? undefined : hashRe.test(dep.old) ? dep.newPrint : undefined,
            };
          });
          const updated = updateWorkflowFile(content, actionDeps);
          write(absPath, updated);
          fileData[relPath].content = updated;
        }
        continue;
      }

      if (mode === "docker") {
        for (const [relPath, entries] of dockerUpdatesByRelPath) {
          const fileInfo = fileData[relPath];
          if (!fileInfo) continue;
          const {absPath, content, fileType, workflowLines} = fileInfo;
          const updateFn = fileType === "dockerfile" ? updateDockerfile :
            fileType === "compose" ? updateComposeFile : (workflow: string, workflowDeps: Deps) =>
              workflow.split("\n").map((line, lineNumber) =>
                workflowLines!.has(lineNumber) ? updateWorkflowDockerImages(line, workflowDeps) : line).join("\n");
          write(absPath, updateFn(content, Object.fromEntries(entries)));
        }
        continue;
      }

      if (mode === "make") {
        for (const [relPath, infos] of makeUpdatesByRelPath) {
          const fileInfo = fileData[relPath];
          if (!fileInfo) continue;
          write(fileInfo.absPath, updateMakefile(fileInfo.content,
            infos.map(info => ({oldSpec: info.oldSpec, newSpec: info.newSpec!}))));
        }
        continue;
      }

      if (mode === "go") {
        for (const goMod of [...goModFiles, ...(plainFiles.go ?? [])]) {
          const localDeps = filterDepsForMember(deps[mode], goMod.memberPath);
          if (!Object.keys(localDeps).length) continue;
          const [updatedContent, majorVersionRewrites] = updateGoMod(goMod.content, localDeps);
          if (updatedContent !== goMod.content) write(goMod.absPath, updatedContent);
          rewriteGoImports(goMod.projectDir, majorVersionRewrites, write);
        }
        for (const goWork of goWorkFiles) {
          const workDeps = Object.fromEntries(Object.entries(filterDepsForMember(deps[mode], goWork.memberPath))
            .filter(([key]) => baseType(key.split(fieldSep)[0]) === "replace"));
          if (Object.keys(workDeps).length) {
            const [updatedWork] = updateGoMod(goWork.content, workDeps);
            if (updatedWork !== goWork.content) write(goWork.file, updatedWork);
          }
        }
      } else if (mode === "cargo") {
        updateMembers(mode, [...cargoMemberFiles, ...(plainFiles.cargo ?? [])], updateCargoToml);
      } else if (mode === "npm") {
        updateMembers(mode, pnpmCatalogFiles, (content, localDeps, member) =>
          updatePnpmWorkspaceOverrideValues(updatePnpmWorkspace(content, localDeps), member.memberPath));
        updateMembers(mode, [...pnpmMemberFiles, ...(plainFiles.npm ?? [])], updatePackageJson);
      } else {
        updateMembers(mode, plainFiles[mode] ?? [], updatePyprojectToml);
      }
    }
  }

  const output = buildOutput(deps);
  if (errors.length) output.errors = errors;
  return output;
}
