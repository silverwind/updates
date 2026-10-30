import {cwd, platform, stderr} from "node:process";
import {styleText} from "node:util";
import {join, dirname, basename, relative, resolve} from "node:path";
import {statSync, realpathSync, truncateSync, writeFileSync, readFileSync, accessSync, type Stats} from "node:fs";
import {readFile} from "node:fs/promises";
import {parseToml} from "./utils/toml.ts";
import {
  githubActionsVersioning, pep440Versioning, satisfies, valid, validRange, type Versioning,
} from "./utils/semver.ts";
import {timerel} from "timerel";
import {
  npmTypes, uvTypes, goTypes, cargoTypes, cargoTargetTypes, expandDepTypes, parseUvDependencies, nonPackageEngines,
  parseDuration, parsePositiveInt, matchesAny, memoizeAsync, timestamp, forgeDirs, modeByFileName, pMap, tryOrNull,
  walkUpSync, getOrSet, shortenHash, shortenPair,
} from "./utils/utils.ts";
import {
  fieldSep, normalizeUrl, fetchTimeout, goProbeTimeout, maxSockets,
  doFetch, fetchActionTags, fetchForge, fetchForgeReleases, findVersion, findNewVersion, getInfoUrl, getLimiter,
  passesCooldown, stripv, hashRe, isVersionLikeRef, defaultApiUrls, formatVersionPrecision, getExecFile,
  coerceToVersion, goPinAllowsDowngrade, goVersionPredicate, pypiReleaseDate, redactUrlCredentials, forgeTokenHint,
  type Dep, type Deps, type DepsByMode, type Limiter, type Output as ModeOutput, type ModeContext, type TagEntry,
} from "./modes/shared.ts";
import {flushCacheWrites} from "./utils/fetchCache.ts";
import {cliBaseConfig, loadConfig, configMixedToRegexes, patternsToRegexSet, validatePin} from "./config.ts";
import type {Config, Override} from "./config.ts";
import {matchesRenovateRule, testRenovateMatcher, type RenovateVersionRule} from "./utils/renovate.ts";
import {
  fetchNpmInfo, fetchNpmVersionInfo, fetchJsrInfo, isJsr, isLocalDep, isCatalogRef,
  parseJsrDependency, parseNpmAlias, updatePackageJson, updateVersionRange, normalizeRange, checkUrlDep,
  resolutionsBasePackage, selectorTypes, npmTargetName,
} from "./modes/npm.ts";
import {
  fetchPypiInfo, isPypiRange, normalizePep503, pypiSatisfies, updatePyprojectToml, updateRequirement,
} from "./modes/pypi.ts";
import {
  resolveGoProxyChain, parseGoNoProxy,
  parseGoMod, parseGoModule, parseGoWork, resolveGoWorkModule, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, goModulePathForVersion, shortenGoHash, shortenGoVersion, shortenGoModule,
} from "./modes/go.ts";
import {
  parseActionRef, parseUsesLine, getForgeApiBaseUrl, walkYamlPair, yamlLines,
  fetchActionTagDate, formatActionVersion,
  updateWorkflowFile, isWorkflowFile, resolveWorkflowFiles, resolveSelfApiUrl,
  type ActionRef, type YamlPathEntry,
} from "./modes/actions.ts";
import {
  parseDockerImageRef, parseDockerTag, extractDockerRefs, dockerImageNames,
  fetchDockerTagDigest, fetchRegistryTagDate,
  isDockerfile, isDockerFileName, dockerExactFileNames,
  dockerTagVersion, fetchDockerInfo, findDockerVersion, getDockerInfoUrl,
  updateDockerfile, updateComposeFile, updateWorkflowDockerImages,
  type DockerImageRef,
} from "./modes/docker.ts";
import {
  isMakeFileName, makeExactFileNames, makeAssignmentValues, parseGoInstalls, parseImages, parseMakeImageValue,
  resolveGoModuleRoot, formatMakeImageSpec, updateMakefile,
  type MakeDockerImage,
} from "./modes/make.ts";
import {isShellFileName, shellAssignmentValues} from "./modes/shell.ts";
import {
  annotationMode, forgeDatasourceRe, parseAnnotations, unsupportedAnnotationField,
  updateAnnotatedLines,
} from "./modes/annotations.ts";
import {
  fetchCratesIoInfo, updateCargoToml, updateCargoRange, cargoToNpmRange, parseCargoLock, findLockedVersion,
} from "./modes/cargo.ts";
import {
  baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, pnpmCatalogEntries,
  updatePnpmWorkspace, type WorkspaceMember,
} from "./utils/workspace.ts";
import {
  compilePathPatterns, defaultExcludePaths, discoverFiles, isDependencyFile, passesPathFilters, type PathFilters,
} from "./utils/files.ts";

const allowedVersionsRe = /^(!?)\/(.*)\/(i?)$/;

/** A sha pin whose comment names a branch or other moving ref, so only its digest ever moves. */
const isDigestOnlyPin = (info: {isHash: boolean, comment: string}): boolean =>
  info.isHash && Boolean(info.comment) && !isVersionLikeRef(info.comment);

/** A dependency whose lookup failed. Every other dependency is still resolved and written. */
export type DepError = {
  mode: string,
  /** The dependency type, or the file path for file-scoped dependencies, as in `results` */ type: string,
  name: string,
  error: string,
};

/** `errors` is absent unless a lookup failed, keeping a clean run's shape unchanged. */
export type Output = ModeOutput & {errors?: Array<DepError>};

export type {Config, Override, Dep, Deps, DepsByMode};
export {cliBaseConfig as cliConfigBaseDir, defaultExcludePaths};

const modeOrder = [...new Set(Object.values(modeByFileName)), "actions", "docker"];
const defaultModes = new Set(modeOrder);

const forgeWebUrls: Record<string, string> = {github: "https://github.com", gitea: "https://gitea.com", forgejo: "https://code.forgejo.org"};

async function pickDatedVersion(
  versions: Array<string>, opts: Parameters<typeof findVersion>[2], versionDate: (version: string) => Promise<string>,
): Promise<{version: string, date: string} | null> {
  const selectOpts = {...opts, cooldownDays: undefined};
  for (let attempt = 0; attempt < 100; attempt++) {
    const picked = findVersion({}, versions, selectOpts);
    if (!picked) return null;
    if (!opts.cooldownDays) return {version: picked, date: ""};
    const date = await versionDate(picked);
    if (passesCooldown(date, opts.cooldownDays, opts.now)) return {version: picked, date};
    versions = versions.filter(version => version !== picked);
  }
  return null;
}

const semversByPrecision = {
  patch: new Set(["patch"]),
  minor: new Set(["patch", "minor"]),
  major: new Set(["patch", "minor", "major"]),
};

const workspaceFileOf: Record<string, string> = {"go.mod": "go.work", "package.json": "pnpm-workspace.yaml"};
const workspaceFileNames = new Set(Object.values(workspaceFileOf));

const apiUrl = (value: unknown, fallback: string) => normalizeUrl(typeof value === "string" ? value : fallback);

function realPath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

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

const selectorName = (depType: string, name: string) => selectorTypes.has(depType) ? resolutionsBasePackage(name) : name;

const cooldownToDays = (cooldown: number | string) => typeof cooldown === "number" && cooldown >= 0 ? cooldown : parseDuration(String(cooldown));

function depNames(name: string, kind: string): Array<string> {
  if (kind === "go") return [name, shortenGoModule(name)];
  if (kind === "docker") return dockerImageNames(name);
  if (kind === "pypi") return [name, normalizePep503(name)];
  return [name];
}

type DependencyIdentity = {packageName: string, depName: string, names: Array<string>};

const writeVerbose = (text: string) => console.error(redactUrlCredentials(text));

function canInclude({packageName, depName, names}: DependencyIdentity, mode: string, {include, exclude}: {include: Set<RegExp>, exclude: Set<RegExp>}, depType: string): boolean {
  if (depType === "engines" && nonPackageEngines.includes(depName)) return false;
  if (mode === "pypi" && depName === "python") return false;
  if (!include.size && !exclude.size) return true;
  for (const matcher of exclude) {
    if (names.some(value => testRenovateMatcher(matcher, value, packageName, depName))) return false;
  }
  for (const matcher of include) {
    if (names.some(value => testRenovateMatcher(matcher, value, packageName, depName))) return true;
  }
  return !include.size;
}

async function resolveFiles(
  filesArg: Array<string> | undefined, dir: string, pathFilters: PathFilters, isPatternFile: (file: string) => boolean,
): Promise<Map<string, string>> {
  const resolvedFiles = new Map<string, string>();
  const realPaths = new Set<string>();
  const add = (file: string, root = dir) => {
    if (resolvedFiles.has(file)) return;
    const canonical = realPath(file);
    if (realPaths.has(canonical)) return;
    realPaths.add(canonical);
    resolvedFiles.set(file, root);
  };

  const roots: Array<string> = [];
  for (const arg of filesArg ?? []) {
    let stat: Stats;
    try {
      stat = statSync(arg);
    } catch (err) {
      throw new Error(`Unable to open ${arg}: ${(err as Error).message}`);
    }
    if (stat.isFile()) {
      const file = realPath(arg);
      add(file, dirname(file));
    } else if (stat.isDirectory()) roots.push(realPath(arg));
    else throw new Error(`${arg} is neither a file nor directory`);
  }
  if (!filesArg?.length) roots.push(dir);
  const discoveries = Promise.all(roots.map(async root =>
    (await discoverFiles(root, pathFilters, Boolean(filesArg?.length), isPatternFile)).map(file => [file, root] as const)));

  if (!filesArg?.length) {
    const forgeDirSet = new Set<string>(forgeDirs);
    const candidates = [...Object.keys(modeByFileName), ...dockerExactFileNames, ...makeExactFileNames, ...forgeDirs];
    for (const [filename, path] of findUpSync(candidates, dir)) {
      if (dirname(path) === dir) continue; // the searched directory's own files come from discoverFiles
      for (const file of forgeDirSet.has(filename) ? resolveWorkflowFiles(path) : [resolve(path)]) {
        if (passesPathFilters(relative(dir, file).replaceAll("\\", "/"), pathFilters)) add(file);
      }
    }
  }
  for (const [file, root] of (await discoveries).flat()) add(file, root);

  const workspaceFiles = Array.from(resolvedFiles).filter(([file]) => workspaceFileNames.has(basename(file)));
  return workspaceFiles.length ? new Map([...workspaceFiles, ...resolvedFiles]) : resolvedFiles;
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
  const results = new Map<string, Map<string, Map<string, Dep>>>();
  const rowsPerName = new Map<string, number>();
  const modes = Object.entries(deps).sort(([left], [right]) => modeOrder.indexOf(left) - modeOrder.indexOf(right));
  for (const [mode, modeDeps] of modes) {
    for (const key of Object.keys(modeDeps)) {
      const id = rowId(mode, key);
      rowsPerName.set(id, (rowsPerName.get(id) ?? 0) + 1);
    }
  }
  for (const [mode, modeDeps] of modes) {
    for (const [key, {oldPrint, newPrint, oldOrig, date: _date, cooldownDays: _cooldownDays, ...props}] of Object.entries(modeDeps)) {
      const [type, name, ref, identity] = key.split(fieldSep);
      if (typeof oldPrint === "string") props.old = oldPrint;
      else if (typeof oldOrig === "string" && !isJsr(oldOrig)) props.old = oldOrig;
      if (typeof newPrint === "string") props.new = newPrint;
      if (mode === "go") Object.assign(props, shortenPair(props.old, props.new, shortenGoVersion, shortenGoHash));
      else if (mode === "actions") Object.assign(props, shortenPair(props.old, props.new, stripv));

      const label = ref && rowsPerName.get(rowId(mode, key))! > 1 ?
        mode === "pypi" ? ref : `${name}${mode === "actions" ? "@" : ":"}${displayKey(ref)}` : name;
      const rows = getOrSet(getOrSet(results, mode, () => new Map()), displayKey(type), () => new Map());
      const existing = rows.get(label);
      if (existing?.old === props.old && existing.new === props.new) continue;
      rows.set(existing && identity ? `${label} ${displayKey(identity)}` : label, props);
    }
  }
  return {results: Object.fromEntries(Array.from(results, ([mode, types]) => [mode, Object.fromEntries(Array.from(types,
    ([type, typeDeps]) => [type, Object.fromEntries([...typeDeps].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))]))]))};
}

function versionAllowedPredicate(mode: string, allowedVersions: string): (version: string, tag?: string) => boolean {
  const regex = allowedVersionsRe.exec(allowedVersions);
  if (regex) {
    const versionRe = new RegExp(regex[2], regex[3]);
    return (version, tag) => versionRe.test(tag ?? (mode === "go" ? `v${version}` : version)) !== Boolean(regex[1]);
  }
  if (mode === "pypi") return isPypiRange(allowedVersions) ? version => pypiSatisfies(version, allowedVersions) :
    version => satisfies(valid(version) || coerceToVersion(version), allowedVersions);
  if (!validRange(allowedVersions)) throw new Error(`Invalid ${mode} allowedVersions: ${allowedVersions}`);
  if (mode === "docker") return version => satisfies(dockerTagVersion(version), allowedVersions);
  return version => satisfies(version, allowedVersions);
}

function goVersionConstraints(
  opts: Omit<Parameters<typeof findNewVersion>[1], "mode" | "range"> & {allowedVersions?: string}, currentVersion: string,
) {
  const accepts = goVersionPredicate({...opts, range: currentVersion});
  const isVersionAllowed = opts.allowedVersions ? versionAllowedPredicate("go", opts.allowedVersions) : null;
  return {
    accepts: isVersionAllowed ? (version: string) => accepts(version) && isVersionAllowed(version) : accepts,
    allowMajor: opts.semvers.has("major"),
    pinAllowsDowngrade: goPinAllowsDowngrade(opts, currentVersion),
    cooldownDays: opts.cooldownDays, now: opts.now,
  };
}

function filterVersionData(data: Record<string, any>, mode: string, allowedVersions: string | undefined) {
  if (!allowedVersions) return data;
  const isVersionAllowed = versionAllowedPredicate(mode, allowedVersions);
  const key = mode === "pypi" ? "releases" : mode === "docker" ? "tags" : "versions";
  return {...data, [key]: Object.fromEntries(Object.entries(data[key] ?? {})
    .filter(([version]) => isVersionAllowed(version)))};
}

export type UpdatesOptions = Config & {
  forgeapi?: string; // test-only
  pypiapi?: string; // test-only
  jsrapi?: string; // test-only
  goproxy?: string; // test-only
  cargoapi?: string; // test-only
  dockerapi?: string; // test-only
};

export async function updates(opts: UpdatesOptions = {}): Promise<Output> {
  const {enableDnsCache} = await import("./utils/dns.ts");
  const disposeDnsCache = enableDnsCache();
  try {
    return await runUpdates(opts);
  } catch (err) {
    throw new Error(redactUrlCredentials((err as Error)?.message || String(err)));
  } finally {
    disposeDnsCache();
  }
}

async function runUpdates(opts: UpdatesOptions): Promise<Output> {
  const config: Config = {...opts};
  if (typeof config.timeout === "number") config.timeout = parsePositiveInt(config.timeout, "timeout");

  const concurrency = config.sockets ?? maxSockets;
  const userTimeout = config.timeout ?? 0;
  const goNoProxy = parseGoNoProxy();

  const useVerboseColor = !config.noColor && (config.color || stderr.isTTY);
  const colorFn = (color: "magenta" | "green" | "red") => useVerboseColor ? (text: string | number) => styleText(color, String(text), {validateStream: false}) : String;
  const magenta = colorFn("magenta");
  const vGreen = colorFn("green");
  const vRed = colorFn("red");

  const dependencyIdentities = new Map<string, DependencyIdentity>();
  const resolveDependencyIdentity = (kind: string, packageName: string, depName = packageName): DependencyIdentity =>
    getOrSet(dependencyIdentities, `${kind}${fieldSep}${packageName}${fieldSep}${depName}`, () => ({
      packageName, depName, names: Array.from(new Set([...depNames(depName, kind), ...depNames(packageName, kind)])),
    }));

  let limit: Limiter | undefined;
  const ctx: ModeContext = {
    execFile: async (file, args, execOpts) => (await getExecFile())(file, args, execOpts),
    fetchTimeout: userTimeout || fetchTimeout,
    goProbeTimeout: userTimeout ? Math.max(1, Math.floor(userTimeout / 2)) : goProbeTimeout,
    concurrency,
    forgeApiUrl: apiUrl(opts.forgeapi, defaultApiUrls.forgeapi),
    pypiApiUrl: apiUrl(opts.pypiapi, defaultApiUrls.pypiapi),
    jsrApiUrl: apiUrl(opts.jsrapi, defaultApiUrls.jsrapi),
    goProxyChain: resolveGoProxyChain(opts.goproxy),
    cratesIoUrl: apiUrl(opts.cargoapi, defaultApiUrls.cargoapi),
    dockerApiUrl: apiUrl(opts.dockerapi, defaultApiUrls.dockerapi),
    doFetch: (url: string, fetchOpts?: RequestInit) => (limit ??= getLimiter(ctx))(async () => {
      if (config.verbose) writeVerbose(`${timestamp()} ${magenta(fetchOpts?.method || "GET")} ${url}`);
      const res = await doFetch(url, fetchOpts);
      if (config.verbose) writeVerbose(`${timestamp()} ${res.ok ? vGreen(res.status) : vRed(res.status)} ${url}`);
      return res;
    }),
    noCache: Boolean(config.noCache),
  };
  const dockerTagDigestPromises = new Map<string, Promise<string | null>>();
  const resolveDockerTagDigest = async (image: string, tag: string): Promise<string | null> => {
    const key = `${image}${fieldSep}${tag}`;
    const digestPromise = getOrSet(dockerTagDigestPromises, key, () => fetchDockerTagDigest(image, tag, ctx));
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
      ...override,
      include: override.include?.length ? patternsToRegexSet(override.include) : undefined,
      exclude: override.exclude?.length ? patternsToRegexSet(override.exclude) : undefined,
      cooldownDays: override.cooldown !== undefined ? cooldownToDays(override.cooldown) : undefined,
    }));
    const renovateVersionRules = (source as Config & {renovateVersionRules?: Array<RenovateVersionRule>}).renovateVersionRules ?? [];
    return {
      greatest: configMixedToRegexes(source.greatest),
      prerelease: configMixedToRegexes(source.prerelease),
      release: configMixedToRegexes(source.release),
      patch: configMixedToRegexes(source.patch),
      minor: configMixedToRegexes(source.minor),
      allowDowngrade: configMixedToRegexes(source.allowDowngrade),
      overrides,
      renovateVersionRules,
      hasCooldownOverride: overrides.some(override => override.cooldownDays !== undefined) ||
        renovateVersionRules.some(rule => rule.cooldownDays !== undefined),
    };
  };
  type VersionConfig = ReturnType<typeof compileVersionConfig>;

  type ResolvedVersionOpts = {
    useGreatest: boolean, usePre: boolean, useRel: boolean, semvers: Set<string>,
    allowDowngrade: boolean, cooldownOverride: number | undefined, allowedVersions?: string,
  };
  const versionOptsCache = new WeakMap<VersionConfig, Map<DependencyIdentity, ResolvedVersionOpts>>();

  function getVersionOpts(versionConfig: VersionConfig, identity: DependencyIdentity) {
    const cache = getOrSet(versionOptsCache, versionConfig, () => new Map());
    let entry = cache.get(identity);
    if (!entry) {
      const {packageName, depName, names} = identity;
      const anyMatches = (set: Set<RegExp> | boolean) => names.some(name => matchesAny(name, set));
      let useGreatest = anyMatches(versionConfig.greatest);
      let usePre = anyMatches(versionConfig.prerelease);
      let useRel = anyMatches(versionConfig.release);
      let usePatch = anyMatches(versionConfig.patch);
      let useMinor = anyMatches(versionConfig.minor);
      let allowDown = anyMatches(versionConfig.allowDowngrade);
      let cooldownOverride: number | undefined;

      // imported rules first, local overrides win: "Values in `updates.config` override anything inherited"
      let allowedVersions: string | undefined;
      for (const rule of versionConfig.renovateVersionRules) {
        if (!matchesRenovateRule(rule, packageName, depName)) continue;
        if (rule.allowedVersions !== undefined) allowedVersions = rule.allowedVersions;
        if (rule.cooldownDays !== undefined) cooldownOverride = rule.cooldownDays;
      }

      for (const override of versionConfig.overrides) {
        if (override.include && names.every(name => !matchesAny(name, override.include!)) ||
          override.exclude && names.some(name => matchesAny(name, override.exclude!))) continue;
        if (override.greatest !== undefined) useGreatest = override.greatest;
        if (override.prerelease !== undefined) usePre = override.prerelease;
        if (override.release !== undefined) useRel = override.release;
        if (override.patch !== undefined) usePatch = override.patch;
        if (override.minor !== undefined) useMinor = override.minor;
        if (override.allowDowngrade !== undefined) allowDown = override.allowDowngrade;
        if (override.cooldownDays !== undefined) cooldownOverride = override.cooldownDays;
      }

      const semvers = usePatch ? semversByPrecision.patch : useMinor ? semversByPrecision.minor : semversByPrecision.major;
      entry = {useGreatest, usePre, useRel, semvers, allowDowngrade: allowDown, cooldownOverride, allowedVersions};
      cache.set(identity, entry);
    }
    return entry;
  }

  validatePin(config.pin); // the CLI validates on parse, the programmatic caller has not
  const globalPin: Record<string, string> = config.pin ?? {};
  const resolvePin = (names: Array<string>, filePin: Record<string, string>, noDowngrade?: Config["pinNoDowngrade"]) => {
    const authored = names.find(name => Object.hasOwn(globalPin, name));
    if (authored) return {pinnedRange: globalPin[authored], pinNoDowngrade: false};
    const inherited = names.find(name => Object.hasOwn(filePin, name));
    const inheritedFromRenovate = Boolean(inherited && Array.isArray(noDowngrade) && noDowngrade.includes(inherited));
    return {pinnedRange: inherited && !inheritedFromRenovate ? filePin[inherited] : undefined, pinNoDowngrade: inheritedFromRenovate};
  };
  const now = Date.now();
  const resolveVersionOpts = (
    {versionConfig, pin, cooldownDays, pinNoDowngrade: filePinNoDowngrade}: FileFilters, identity: DependencyIdentity,
    noDowngrade = filePinNoDowngrade,
  ) => {
    const {useGreatest, usePre, useRel, semvers, allowDowngrade, cooldownOverride, allowedVersions} =
      getVersionOpts(versionConfig, identity);
    const {pinnedRange, pinNoDowngrade} = resolvePin(identity.names, pin, noDowngrade);
    const effectiveCooldownDays = cooldownOverride ?? cooldownDays;
    return {
      useGreatest, usePre, useRel, semvers, allowDowngrade, allowedVersions, pinnedRange, pinNoDowngrade,
      cooldownDays: effectiveCooldownDays || undefined, now: effectiveCooldownDays ? now : undefined,
    };
  };

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const depIdentities: Record<string, Map<string, DependencyIdentity>> = {};
  const npmAliases = new Map<string, {name: string, range: string}>();
  const pnpmWorkspaceOverrideKeys = new Map<string, string>();
  const errors: Array<DepError> = [];
  const addKeyError = (mode: string, key: string, err: unknown) => {
    const [type, name] = key.split(fieldSep);
    errors.push({mode, type, name, error: redactUrlCredentials((err as Error)?.message || String(err))});
  };
  const rejectDep = (mode: string, key: string, err: unknown) => {
    delete deps[mode][key];
    addKeyError(mode, key, err);
  };
  const plainFiles: Record<string, Array<WorkspaceMember>> = {};
  const cwdStr = realPath(cwd()); // cwd() keeps Windows 8.3 short names
  const toRelPath = (absPath: string) => absPath.replace(`${cwdStr}/`, "").replace(`${cwdStr}\\`, "");

  const canIncludeDep = (mode: string, key: string, identity: DependencyIdentity, filters: FileFilters, depType: string) => {
    if (!canInclude(identity, mode, filters, depType)) return false;
    (depIdentities[mode] ??= new Map()).set(key, identity);
    return true;
  };

  const addDep = (mode: string, key: string, old: string, oldOrig?: string) => {
    deps[mode][key] = {old, oldOrig} as Dep;
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
    } else if (!isLocalDep(value)) {
      maybeUrlDeps[key] = {old: value} as Dep;
    }
  };

  const collectDeps = (mode: string, pkg: Record<string, any>, typePrefix: string, filters: FileFilters, internalNames?: ReadonlySet<string>) => {
    const uvSources = new Set(Object.keys(pkg.tool?.uv?.sources ?? {}).map(normalizePep503));
    const addUvDeps = (specs: Array<unknown>, depType: string) => {
      for (const {name, version, spec} of parseUvDependencies(specs)) {
        if (uvSources.has(normalizePep503(name))) continue;
        const key = manifestDependencyKey(depType, typePrefix, name, spec);
        if (!canIncludeDep(mode, key, resolveDependencyIdentity(mode, normalizePep503(name), name), filters, depType)) continue;
        addDep(mode, key, normalizeRange(version), version);
      }
    };
    for (const [depType, table] of expandDepTypes(resolveDepTypes(mode, filters.modeConfig), pkg)) {
      const obj = table || {};
      if (Array.isArray(obj)) {
        if (mode === "pypi") addUvDeps(obj, depType);
      } else if (typeof obj === "string") {
        const [name, value] = obj.split("@");
        const key = manifestDependencyKey(depType, typePrefix, name);
        if (canIncludeDep(mode, key, resolveDependencyIdentity(mode, name), filters, depType)) addDep(mode, key, normalizeRange(value), value);
      } else if (mode === "npm" && (depType === "overrides" || depType === "pnpm.overrides")) {
        const root = depType === "overrides" ? ["overrides"] : ["pnpm", "overrides"];
        const collectOverrides = (child: Record<string, any>, parents: Array<string>) => {
          for (const [selector, value] of Object.entries(child)) {
            if (typeof value === "string") {
              const name = resolutionsBasePackage(selector === "." ? parents.at(-1) ?? selector : selector);
              if (internalNames?.has(name)) continue;
              const key = manifestDependencyKey(depType, typePrefix, name, JSON.stringify([...root, ...parents, selector]));
              if (!canIncludeDep(mode, key, resolveDependencyIdentity(mode, npmTargetName(name, value), name), filters, depType)) continue;
              addNpmDep(key, name, value);
            } else if (value && typeof value === "object" && !Array.isArray(value)) {
              collectOverrides(value, [...parents, selector]);
            }
          }
        };
        collectOverrides(obj as Record<string, any>, []);
      } else {
        for (const [name, value] of Object.entries(obj as Record<string, any>)) {
          if (mode === "pypi" && Array.isArray(value)) { addUvDeps(value, `${depType}.${name}`); continue; }
          if (typeof value !== "string") continue;
          if (internalNames?.has(selectorName(depType, name))) continue;
          const key = manifestDependencyKey(depType, typePrefix, name);
          if (!canIncludeDep(mode, key, resolveDependencyIdentity(mode,
            mode === "npm" ? npmTargetName(selectorName(depType, name), value) : mode === "pypi" ? normalizePep503(name) : name,
            name), filters, depType)) continue;
          if (mode === "npm") addNpmDep(key, name, value);
          else if (mode === "go") addDep(mode, key, stripv(value));
          else if (validRange(value)) addDep(mode, key, normalizeRange(value), value);
        }
      }
    }
  };

  const pathFilters: PathFilters = {
    includePaths: config.includePaths ?? [], excludePaths: config.excludePaths ?? defaultExcludePaths,
  };
  const workflowPatterns = compilePathPatterns(config.filePatterns?.actions ?? []);
  const isPatternWorkflow = (file: string) => {
    if (!workflowPatterns.length || isDependencyFile(file)) return false;
    const path = relative(cwdStr, file).replaceAll("\\", "/");
    return workflowPatterns.some(pattern => pattern.test(path));
  };
  const files = await resolveFiles(config.files, cwdStr, pathFilters, isPatternWorkflow);
  const patternWorkflows = new Set(Array.from(files.keys()).filter(isPatternWorkflow));
  const isWorkflow = (file: string) => isWorkflowFile(file) || patternWorkflows.has(file);
  const readsNatively = (file: string) => {
    const filename = basename(file);
    if (isWorkflow(file)) return enabledModes.has("actions") || enabledModes.has("docker");
    if (isDockerFileName(filename)) return enabledModes.has("docker");
    if (isMakeFileName(filename) || isShellFileName(filename)) return enabledModes.has("go") || enabledModes.has("docker");
    return Object.hasOwn(modeByFileName, filename);
  };
  const fileContents = new Map(await pMap(Array.from(files.keys()).filter(file => {
    const filename = basename(file);
    if (Object.hasOwn(workspaceFileOf, filename) && files.has(join(dirname(file), workspaceFileOf[filename]))) return false;
    return isWorkflow(file) || !Object.hasOwn(modeByFileName, filename) || enabledModes.has(modeByFileName[filename]);
  }), async (file): Promise<[string, string]> => {
    try {
      return [file, await readFile(file, "utf8")];
    } catch (err) {
      if (!readsNatively(file)) return [file, ""];
      throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
    }
  }, {concurrency}));

  const fileData: Record<string, {
    absPath: string, fileType?: "dockerfile" | "compose" | "workflow",
    nativeLines?: Set<number>, workflowLines?: Set<number>,
  }> = Object.create(null);

  const goModFiles: WorkspaceMember[] = [];
  const goWorkFiles: WorkspaceMember[] = [];

  const cargoMemberFiles: WorkspaceMember[] = [];
  const pnpmMemberFiles: WorkspaceMember[] = [];
  const pnpmCatalogFiles: WorkspaceMember[] = [];

  const actionDepInfos: Array<ActionRef & {key: string, apiUrl: string, filters: FileFilters, comment: string,
    identity: DependencyIdentity}> = [];
  const dockerDepInfos: Array<{key: string, mode: string, ref: DockerImageRef, filters: FileFilters}> = [];
  type MakeDepInfo = {key: string, filters: FileFilters, identity: DependencyIdentity} & (
    {mode: "go", installPath: string, version: string} |
    {mode: "docker", image: MakeDockerImage}
  );
  const makeDepInfos: Array<MakeDepInfo> = [];
  type AnnotationDepInfo = {
    key: string, mode: string, fields: Record<string, string>, value: string, filters: FileFilters, identity: DependencyIdentity,
    image: MakeDockerImage | null, locations: Array<{line: number, column: number}>,
  };
  const annotationDepInfos = new Map<string, AnnotationDepInfo>();
  const annotatedLines = new Map<string, Set<number>>();
  const modeContextsBySuffix: Record<string, Map<string, FileFilters>> = {};
  const registerModeContext = (mode: string, memberPath: string, filters: FileFilters) => {
    const typeSuffix = memberPath === "." ? "" : `|${memberPath}`;
    (modeContextsBySuffix[mode] ??= new Map()).set(typeSuffix, filters);
    return typeSuffix;
  };
  const cliBase = (opts as {[cliBaseConfig]?: {cliKeys: Array<string>}})[cliBaseConfig];
  const cliKeys = cliBase && new Set(cliBase.cliKeys);
  const configOverrides = Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    value !== undefined && (!cliKeys || cliKeys.has(key))));

  const resolveDirSelfApiUrl = memoizeAsync(resolveSelfApiUrl);
  const resolveDirConfig = memoizeAsync(async (projectDir: string) => {
    const modeConfig = {...await loadConfig(projectDir), ...configOverrides};
    return {
      modeConfig,
      projectDir,
      include: patternsToRegexSet(modeConfig.include ?? []),
      exclude: patternsToRegexSet(modeConfig.exclude ?? []),
      versionConfig: compileVersionConfig(modeConfig),
      pin: modeConfig.pin ?? {},
      pinNoDowngrade: modeConfig.pinNoDowngrade,
      cooldownDays: modeConfig.cooldown ? cooldownToDays(modeConfig.cooldown) : 0,
    };
  });

  function resolveDepTypes(mode: string, modeConfig: Config): Array<string> {
    if (modeConfig.types?.length) return modeConfig.types;
    if (mode === "npm") return npmTypes;
    if (mode === "pypi") return uvTypes;
    if (mode === "go") return modeConfig.indirect ? goTypes : goTypes.filter(type => type !== "indirect");
    if (mode === "cargo") return [...cargoTypes, ...cargoTargetTypes];
    return [];
  }

  type FileFilters = Awaited<ReturnType<typeof resolveDirConfig>>;

  const pnpmWorkspaceOverrides = (content: string) => {
    const entries: Array<{selector: string, value: string, lineNumber: number, valueIndex: number}> = [];
    let inOverridesSection = false;
    for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
      const pair = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*)):\s*(.*)$/.exec(line);
      if (!pair) continue;
      const indent = pair[1].length;
      const key = (pair[2] ?? pair[3] ?? pair[4]).trim();
      if (indent === 0) { inOverridesSection = key === "overrides"; continue; }
      if (!inOverridesSection || !pair[5]) continue;
      const trimmedValue = pair[5].replace(/\s+#.*$/, "").trim();
      const quoted = /^(['"])(.*)\1$/.exec(trimmedValue);
      const value = quoted?.[2] ?? trimmedValue;
      entries.push({selector: key, value, lineNumber, valueIndex: line.length - pair[5].length + Number(Boolean(quoted))});
    }
    return entries;
  };

  function collectDockerRef(ref: DockerImageRef, relPath: string, filters: FileFilters): boolean {
    deps.docker ??= {};
    const key = dependencyKey(relPath, ref.fullImage, `${ref.tag}${ref.digest ? `@${ref.digest}` : ""}`);
    if (!canIncludeDep("docker", key, resolveDependencyIdentity("docker", ref.fullImage), filters, "docker")) return false;
    if (deps.docker[key]) return true;
    const parsed = parseDockerTag(ref.tag);
    if (!parsed && !ref.digest) return false;
    deps.docker[key] = {
      old: parsed?.version ?? ref.tag, oldOrig: ref.tag,
      ...(ref.digest && {oldDigest: ref.digest}), ...(ref.digestOnly && {digestOnly: true}),
    } as Dep;
    dockerDepInfos.push({key, mode: "docker", ref, filters});
    return true;
  }

  const cargoWorkspaceFiles = new Map<string, Record<string, any>>();
  const npmWorkspaceFiles = new Map<string, {pkg: Record<string, any>, packagePatterns: Array<string>}>();
  for (const [file, content] of fileContents) {
    const filename = basename(file);
    try {
      if (filename === "package.json") {
        const pkg = JSON.parse(content);
        const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
        const packagePatterns = Array.isArray(patterns) ? patterns.filter(pattern => typeof pattern === "string") : [];
        if (packagePatterns.length) npmWorkspaceFiles.set(file, {pkg, packagePatterns});
      } else if (filename === "Cargo.toml") {
        const parsed = parseToml(content);
        const members = (parsed.workspace as Record<string, any>)?.members;
        if (Array.isArray(members) && members.length) cargoWorkspaceFiles.set(file, parsed);
      }
    } catch {}
  }

  const workspaceRootCounts: Record<string, number> = {
    cargo: cargoWorkspaceFiles.size,
    go: Array.from(files.keys()).filter(file => basename(file) === "go.work").length,
    npm: npmWorkspaceFiles.size + Array.from(files.keys()).filter(file => basename(file) === "pnpm-workspace.yaml").length,
  };

  const addPlainFile = (mode: string, file: string, content: string, filters: FileFilters): string => {
    const modeFiles = plainFiles[mode] ??= [];
    const memberPath = !modeFiles.length && !workspaceRootCounts[mode] ? "." : toRelPath(file);
    modeFiles.push({absPath: resolve(file), content, memberPath});
    return registerModeContext(mode, memberPath, filters);
  };

  const parseFile = (file: string, parse: () => Record<string, any>): Record<string, any> => {
    try {
      return parse();
    } catch (err) {
      throw new Error(`Error parsing ${file}: ${(err as Error).message}`);
    }
  };

  const workspaceMemberPath = (mode: string, workspaceFile: string, memberPath: string) =>
    workspaceRootCounts[mode] > 1 ? `${toRelPath(workspaceFile)}:${memberPath}` : memberPath;
  const collectNpmWorkspaceMember = (
    workspaceFile: string, member: WorkspaceMember, pkg: Record<string, any>, filters: FileFilters,
    internalNames?: ReadonlySet<string>,
  ) => {
    const memberPath = workspaceMemberPath("npm", workspaceFile, member.memberPath);
    pnpmMemberFiles.push({...member, memberPath});
    collectDeps("npm", pkg, registerModeContext("npm", memberPath, filters), filters, internalNames);
  };
  for (const file of new Set([...cargoWorkspaceFiles.keys(), ...npmWorkspaceFiles.keys(), ...fileContents.keys()])) {
    if (!readsNatively(file)) continue;
    const filename = basename(file);
    const content = fileContents.get(file)!;
    if (isWorkflow(file)) {
      const actionsEnabled = enabledModes.has("actions");
      const dockerEnabled = enabledModes.has("docker");
      const relPath = toRelPath(file);
      const filters = await resolveDirConfig(dirname(file));
      const workflowLines = new Set<number>();
      const nativeLines = new Set<number>();
      fileData[relPath] = {absPath: file, fileType: "workflow", workflowLines, nativeLines};
      const yamlPath: Array<YamlPathEntry> = [];

      for (const [lineNumber, line] of yamlLines(content.split(/\r?\n/))) {
        if (actionsEnabled) {
          const parsed = parseUsesLine(line);
          const action = parsed && parseActionRef(parsed.value);
          if (action) {
            const identity = resolveDependencyIdentity("actions", `${action.owner}/${action.repo}`, action.name);
            if (canInclude(identity, "actions", filters, "actions")) {
              nativeLines.add(lineNumber);
              deps.actions ??= {};
              const comment = parsed.pinnedVersion || /^#\s*(\S+)\s*$/.exec(parsed.comment)?.[1] || "";
              const key = dependencyKey(relPath, action.name, action.isHash && comment ? `${comment}@${action.ref}` : action.ref);
              if (!deps.actions[key]) {
                deps.actions[key] = {old: action.ref} as Dep;
                actionDepInfos.push({...action, key, comment, identity, filters, apiUrl: action.name.startsWith("self:") ?
                  await resolveDirSelfApiUrl(dirname(file)) : getForgeApiBaseUrl(action.host, ctx.forgeApiUrl)});
              }
            }
          }
        }

        if (!dockerEnabled) continue;
        const pair = walkYamlPair(line, yamlPath);
        if (!pair) continue;
        const {indent, key} = pair;
        const container = key === "container" && yamlPath.length === 2 && yamlPath[0].key === "jobs";
        const image = key === "image" && (
          yamlPath.length === 3 && yamlPath[0].key === "jobs" && yamlPath[2].key === "container" ||
          yamlPath.length === 4 && yamlPath[0].key === "jobs" && yamlPath[2].key === "services"
        );
        const uses = key === "uses" && (
          yamlPath.length === 3 && yamlPath[0].key === "jobs" && yamlPath[2].key === "steps" ||
          yamlPath.length === 2 && yamlPath[0].key === "runs" && yamlPath[1].key === "steps"
        );
        if ((container || image || uses) && pair.value) {
          const value = pair.value.replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
          const ref = parseDockerImageRef(value);
          if (ref && collectDockerRef(ref, relPath, filters)) {
            workflowLines.add(lineNumber);
            nativeLines.add(lineNumber);
          }
        }
        yamlPath.push({indent, key});
      }
      continue;
    }

    if (isDockerFileName(filename)) {
      const relPath = toRelPath(file);
      const filters = await resolveDirConfig(dirname(file));
      const fileType = isDockerfile(filename) ? "dockerfile" : "compose";
      const nativeLines = new Set<number>();
      fileData[relPath] = {absPath: file, fileType, nativeLines};
      for (const {ref, lines} of extractDockerRefs(content, fileType)) {
        if (collectDockerRef(ref, relPath, filters)) for (const line of lines) nativeLines.add(line);
      }
      continue;
    }

    if (isMakeFileName(filename) || isShellFileName(filename)) {
      const values = isMakeFileName(filename) ? makeAssignmentValues(content) : shellAssignmentValues(content);
      const goInstalls = enabledModes.has("go") ? parseGoInstalls(values) : [];
      const images = enabledModes.has("docker") ? parseImages(values) : [];
      if (!goInstalls.length && !images.length) continue;
      const relPath = toRelPath(file);
      const filters = await resolveDirConfig(dirname(file));
      const nativeLines = new Set<number>();
      fileData[relPath] = {absPath: file, nativeLines};
      const modeDeps = deps.make ??= {};
      for (const {installPath, version, line} of goInstalls) {
        const key = dependencyKey(relPath, installPath, version);
        const identity = resolveDependencyIdentity("go", installPath);
        if (!canInclude(identity, "go", filters, "go")) continue;
        nativeLines.add(line!);
        if (modeDeps[key]) continue;
        modeDeps[key] = {old: `${installPath}@${version}`, oldPrint: version} as Dep;
        makeDepInfos.push({mode: "go", key, installPath, version, filters, identity});
      }
      for (const image of images) {
        const key = dependencyKey(relPath, image.writtenImage, `${image.ref.tag}${image.digest ? `@${image.digest}` : ""}`);
        const identity = resolveDependencyIdentity("docker", image.writtenImage);
        if (!canInclude(identity, "docker", filters, "docker")) continue;
        if (!parseDockerTag(image.ref.tag)) continue;
        nativeLines.add(image.line!);
        if (modeDeps[key]) continue;
        modeDeps[key] = {old: formatMakeImageSpec(image.writtenImage, image.ref.tag, image.digest), oldPrint: image.ref.tag} as Dep;
        makeDepInfos.push({mode: "docker", key, image, filters, identity});
      }
      continue;
    }

    const mode = modeByFileName[filename];
    const absFile = resolve(file);
    if (filename === "go.mod" && goModFiles.some(member => member.absPath === absFile)) continue;
    if (filename === "package.json" && pnpmMemberFiles.some(member => member.absPath === absFile)) continue;
    if (filename === "Cargo.toml" && cargoMemberFiles.some(member => member.absPath === absFile)) continue;

    const projectDir = dirname(absFile);
    const isSelectedManifest = (absPath: string, authoredPath: string) =>
      passesPathFilters(relative(files.get(file)!, authoredPath).replaceAll("\\", "/"), pathFilters) || files.has(absPath);
    deps[mode] ??= {};

    if (filename === "go.work") {
      const goWork = parseGoWork(content);
      const [filters, useReads] = await Promise.all([
        resolveDirConfig(projectDir),
        pMap(goWork.use, async (usePath) => {
          const modPath = resolveGoWorkModule(projectDir, usePath);
          if (!modPath) return null;
          const modContent = await tryOrNull(readFile(modPath, "utf8"));
          return modContent === null ? null : {usePath, modPath, modContent};
        }, {concurrency}),
      ]);
      const workspacePath = workspaceMemberPath(mode, file, ".");
      const workspaceSuffix = registerModeContext(mode, workspacePath, filters);
      goWorkFiles.push({absPath: file, content, memberPath: workspacePath});

      const goMembers = useReads.filter(entry => entry !== null);
      const internalNames = new Set(goMembers.map(({modContent}) => parseGoModule(modContent)).filter(Boolean));
      for (const {usePath, modPath, modContent} of goMembers) {
        if (!isSelectedManifest(modPath, join(projectDir, usePath, "go.mod"))) continue;
        const memberPath = workspaceMemberPath(mode, file, usePath);
        goModFiles.push({absPath: modPath, content: modContent, memberPath});
        collectDeps(mode, parseGoMod(modContent), registerModeContext(mode, memberPath, filters), filters, internalNames);
      }

      for (const [name, value] of Object.entries(goWork.replace)) {
        const key = manifestDependencyKey("replace", workspaceSuffix, name);
        if (!internalNames.has(name) && canIncludeDep(mode, key, resolveDependencyIdentity(mode, name), filters, "replace")) {
          addDep(mode, key, stripv(value));
        }
      }
      continue;
    }

    if (filename === "Cargo.toml") {
      const cargoParsed = cargoWorkspaceFiles.get(file) ?? parseToml(content);
      const lockPath = findUpSync(["Cargo.lock"], projectDir).get("Cargo.lock");
      const workspace = cargoParsed.workspace as Record<string, any> | undefined;
      const wsMembers = workspace?.members;
      const isWorkspace = Array.isArray(wsMembers) && wsMembers.length > 0;

      const [filters, lockContent, members] = await Promise.all([
        resolveDirConfig(projectDir),
        lockPath ? readFile(lockPath, "utf8") : null,
        isWorkspace ? resolveWorkspaceMembers([...wsMembers, ...(workspace!.exclude ?? []).map((pattern: string) => `!${pattern}`)],
          projectDir, "Cargo.toml", concurrency) : [] as WorkspaceMember[],
      ]);
      const dependencyTypes = resolveDepTypes(mode, filters.modeConfig);
      const lockedVersions = lockContent ? parseCargoLock(lockContent) : new Map<string, string[]>();

      const collectCargoDeps = (parsed: Record<string, any>, typePrefix: string) => {
        for (const [depType, table] of expandDepTypes(dependencyTypes, parsed)) {
          const obj = table || {};
          if (typeof obj !== "object" || Array.isArray(obj)) continue;
          for (const [name, value] of Object.entries(obj as Record<string, any>)) {
            const isTable = typeof value === "object" && value !== null && "version" in value && !("git" in value) && !("path" in value) && !("registry" in value);
            if (!isTable && typeof value !== "string") continue;
            const versionStr = isTable ? value.version : value;
            const crate = isTable && value.package || name;
            const key = manifestDependencyKey(depType, typePrefix, name);
            if (!canIncludeDep(mode, key, resolveDependencyIdentity(mode, crate, name), filters, depType)) continue;
            const range = cargoToNpmRange(versionStr);
            if (!validRange(range)) continue;
            addDep(mode, key, findLockedVersion(lockedVersions, crate, versionStr) ?? normalizeRange(range), versionStr);
          }
        }
      };

      if (isWorkspace) {
        const workspacePath = workspaceMemberPath(mode, file, ".");
        collectCargoDeps(cargoParsed, registerModeContext(mode, workspacePath, filters));
        cargoMemberFiles.push({absPath: absFile, content, memberPath: workspacePath});
        for (const member of members) {
          if (!isSelectedManifest(member.absPath, join(projectDir, member.memberPath, filename))) continue;
          const memberPath = workspaceMemberPath(mode, file, member.memberPath);
          cargoMemberFiles.push({...member, memberPath});
          collectCargoDeps(parseFile(member.absPath, () => parseToml(member.content)), registerModeContext(mode, memberPath, filters));
        }
      } else {
        collectCargoDeps(cargoParsed, addPlainFile(mode, file, content, filters));
      }
      continue;
    }

    if (filename === "package.json" && npmWorkspaceFiles.has(file)) {
      const {pkg: rootPkg, packagePatterns} = npmWorkspaceFiles.get(file)!;
      const [filters, members] = await Promise.all([
        resolveDirConfig(projectDir),
        resolveWorkspaceMembers(packagePatterns, projectDir, "package.json", concurrency),
      ]);
      const parsedMembers = members.map(member => ({member, pkg: parseFile(member.absPath, () => JSON.parse(member.content))}));
      const internalNames = new Set<string>(parsedMembers.map(({pkg}) => pkg.name).filter(name => typeof name === "string" && name));
      collectNpmWorkspaceMember(file, {absPath: absFile, content, memberPath: "."}, rootPkg, filters, internalNames);
      for (const {member, pkg} of parsedMembers) {
        if (isSelectedManifest(member.absPath, join(projectDir, member.memberPath, filename))) {
          collectNpmWorkspaceMember(file, member, pkg, filters, internalNames);
        }
      }
      continue;
    }

    if (filename === "pnpm-workspace.yaml") { // pnpm only treats `workspace:` dependencies as internal
      const packagePatterns = parsePnpmWorkspace(content);
      const rootPkgPath = join(projectDir, "package.json");
      const [filters, rootContent, members] = await Promise.all([
        resolveDirConfig(projectDir),
        tryOrNull(readFile(rootPkgPath, "utf8")),
        resolveWorkspaceMembers(packagePatterns, projectDir, "package.json", concurrency),
      ]);
      const workspaceManifestPath = workspaceMemberPath(mode, file, filename);
      const typeSuffix = registerModeContext(mode, workspaceManifestPath, filters);

      pnpmCatalogFiles.push({absPath: absFile, content, memberPath: workspaceManifestPath});
      for (const {type, name, value} of pnpmCatalogEntries(content)) {
        const key = manifestDependencyKey(type, typeSuffix, name);
        if (canIncludeDep(mode, key, resolveDependencyIdentity(mode, npmTargetName(name, value), name), filters, type)) {
          addNpmDep(key, name, value);
        }
      }
      for (const {selector, value} of pnpmWorkspaceOverrides(content)) {
        const type = "pnpm-workspace.overrides";
        const key = manifestDependencyKey(type, typeSuffix, selector, JSON.stringify(selector));
        if (!canIncludeDep(mode, key, resolveDependencyIdentity(mode, npmTargetName(resolutionsBasePackage(selector), value),
          selector), filters, type)) continue;
        pnpmWorkspaceOverrideKeys.set(key, selector);
        addNpmDep(key, selector, value);
      }

      if (rootContent !== null && isSelectedManifest(rootPkgPath, rootPkgPath)) {
        collectNpmWorkspaceMember(file, {absPath: resolve(rootPkgPath), content: rootContent, memberPath: "."},
          parseFile(rootPkgPath, () => JSON.parse(rootContent)), filters);
      }
      for (const member of members) {
        if (!isSelectedManifest(member.absPath, join(projectDir, member.memberPath, "package.json"))) continue;
        collectNpmWorkspaceMember(file, member, parseFile(member.absPath, () => JSON.parse(member.content)), filters);
      }
      continue;
    }

    const filters = await resolveDirConfig(projectDir);
    const pkg = parseFile(file, () => mode === "npm" ? JSON.parse(content) :
      mode === "pypi" ? parseToml(content) : parseGoMod(content));
    collectDeps(mode, pkg, addPlainFile(mode, file, content, filters), filters);
  }

  for (const [file, content] of fileContents) {
    if (Object.hasOwn(modeByFileName, basename(file))) continue;
    const annotations = parseAnnotations(content);
    if (!annotations.length) continue;
    const relPath = toRelPath(file);
    const filters = await resolveDirConfig(dirname(file));
    const {nativeLines} = fileData[relPath] ??= {absPath: file};
    for (const {line, column, value, fields} of annotations) {
      if (nativeLines?.has(line)) continue;
      getOrSet(annotatedLines, relPath, () => new Set()).add(line);
      const unsupported = unsupportedAnnotationField(fields);
      if (unsupported) {
        if (config.verbose) writeVerbose(`${timestamp()} ${magenta("SKIP")} ${relPath}:${line + 1}: unsupported ${unsupported}`);
        continue;
      }
      const mode = annotationMode(fields.datasource)!;
      if (!enabledModes.has(mode)) continue;
      const image = fields.datasource === "docker" ? parseMakeImageValue(value) : null;
      const install = fields.datasource === "go" ? parseGoInstalls([{name: "", value}])[0] : undefined;
      const packageName = install?.installPath ?? (fields.packageName || fields.lookupName || image?.ref.fullImage || fields.depName);
      const depName = fields.depName || packageName;
      const key = `${dependencyKey(relPath, depName, fields.datasource === "pypi" ? `${depName}==${value}` :
        image ? value.slice(image.writtenImage.length + 1) : install?.version ?? value)}${fieldSep}${JSON.stringify([
        fields.datasource, packageName, fields.registryUrl || "", fields.extractVersion || "", fields.versioning || "", value,
      ])}`;
      const existing = annotationDepInfos.get(key);
      if (existing) { existing.locations.push({line, column}); continue; }
      const identity = resolveDependencyIdentity(fields.datasource,
        fields.datasource === "pypi" ? normalizePep503(packageName) : packageName, depName);
      if (!canInclude(identity, mode, filters, mode)) continue;
      (deps.annotations ??= {})[key] = {old: value, oldPrint: image?.ref.tag ?? install?.version} as Dep;
      annotationDepInfos.set(key, {key, mode, fields, value, filters, identity, image, locations: [{line, column}]});
    }
  }

  const hasMaybeUrlDeps = Object.keys(maybeUrlDeps).length > 0;
  if (!hasDeps(deps) && !hasMaybeUrlDeps) {
    return {results: {}, message: "No dependencies found, nothing to do."};
  }

  const argsForNpm = {needsDates: modeContextsBySuffix.npm?.values().some(entry =>
    entry.cooldownDays || entry.versionConfig.hasCooldownOverride) ?? false};

  const modeTasks = Object.entries(modeContextsBySuffix).map(async ([mode, modeContexts]) => {
    if (!Object.keys(deps[mode]).length && (mode !== "npm" || !hasMaybeUrlDeps)) return;
    const modeConfigEntry = modeContexts.values().next().value!;
    const ctxForType = (type: string) => {
      const barIdx = type.indexOf("|");
      return modeContexts.get(barIdx === -1 ? "" : type.slice(barIdx)) ?? modeConfigEntry;
    };
    const npmFollowUps = new Map<string, {name: string, promise: ReturnType<typeof fetchNpmVersionInfo>}>();
    const modeDeps = deps[mode];
    const lookupDep = async (key: string) => {
      const [type, name, requirement] = key.split(fieldSep);
      const baseT = baseType(type);
      const filters = ctxForType(type);
      const {modeConfig, projectDir} = filters;
      const dep = modeDeps[key];
      const {old: oldRange, oldOrig} = dep;
      const jsrDep = oldOrig && isJsr(oldOrig);
      const npmAlias = npmAliases.get(key);
      const identity = depIdentities[mode].get(key)!;
      const versionOpts = resolveVersionOpts(filters, identity);
      const goConstraints = mode === "go" ? goVersionConstraints(versionOpts, dep.oldOrig || dep.old) : null;
      const info = mode === "npm" ? jsrDep ? fetchJsrInfo(identity.packageName, ctx) :
        fetchNpmInfo(identity.packageName, baseT, modeConfig, argsForNpm, ctx, projectDir, dep.old) :
        mode === "go" ? fetchGoProxyInfo(identity.packageName, type, dep.oldOrig || dep.old, projectDir, ctx, goNoProxy,
          goConstraints!) :
          mode === "cargo" ? fetchCratesIoInfo(identity.packageName, ctx) : fetchPypiInfo(identity.packageName, ctx);

      const [rawData, registry] = await info;
      if (rawData.error) throw new Error(rawData.error);

      dep.cooldownDays = versionOpts.cooldownDays;
      const data = mode === "go" ? rawData : filterVersionData(rawData, mode, versionOpts.allowedVersions);
      const newVersion = findNewVersion(data, {...versionOpts, range: oldRange, mode, acceptsGoVersion: goConstraints ? goConstraints.accepts : undefined});

      let newRange = "";
      if ((mode === "go" || mode === "pypi") && newVersion) {
        newRange = newVersion;
      } else if (mode === "cargo" && newVersion && oldOrig) {
        newRange = updateCargoRange(oldOrig, newVersion);
      } else if (newVersion) {
        if (jsrDep) {
          dep.newPrint = updateVersionRange(oldRange, newVersion, oldRange, baseT);
          newRange = `${oldOrig.slice(0, -oldRange.length)}${dep.newPrint}`;
        } else if (npmAlias) {
          newRange = `npm:${npmAlias.name}@${updateVersionRange(oldRange, newVersion, npmAlias.range, baseT)}`;
        } else {
          newRange = updateVersionRange(oldRange, newVersion, oldOrig, baseT);
        }
      }

      const spec = mode === "pypi" ? requirement : undefined;
      const rewrittenSpec = spec && updateRequirement(spec, oldOrig || oldRange, newRange);
      if (!newVersion || newVersion === oldRange || oldOrig && (oldOrig === newRange) ||
        spec && (!rewrittenSpec || rewrittenSpec === spec)) {
        if (config.verbose && newVersion && newVersion !== oldRange) {
          writeVerbose(`${timestamp()} ${magenta("SKIP")} ${name}: ${oldOrig || oldRange} can not be rewritten to ${newVersion}`);
        }
        delete modeDeps[key];
        return;
      }

      dep.new = newRange;
      if (mode === "npm") {
        npmFollowUps.set(key, {name: identity.packageName, promise: fetchNpmVersionInfo(data.name, newVersion, modeConfig, argsForNpm, ctx, projectDir)});
      } else dep.info = mode === "pypi" ? getInfoUrl(data, registry, data.info.name) :
        mode === "go" ? getGoInfoUrl(data.newPath || name) : `https://crates.io/crates/${data.name}`;

      setDepAge(dep, mode === "pypi" ? pypiReleaseDate(data.releases[newVersion]) :
        mode === "go" ? data.Time : data.time?.[newVersion]);
    };

    await pMap(Object.keys(modeDeps), async (key) => {
      try {
        await lookupDep(key);
      } catch (err) {
        rejectDep(mode, key, err);
      }
    }, {concurrency});

    await Promise.all(Array.from(npmFollowUps, async ([key, {name, promise}]) => {
      const followUp = await promise;
      const dep = modeDeps[key];
      const [type] = key.split(fieldSep);
      if (baseType(type) === "packageManager" && /\+sha\d+\./.test(dep.oldOrig || dep.old)) {
        dep.oldPrint = (dep.oldOrig || dep.old).replace(/\+sha\d+\..*$/, "");
        if (!(name === "yarn" && Number.parseInt(stripv(dep.new)) >= 2)) {
          const integrity = /(?:^|\s)sha512-(\S+)/.exec(followUp.integrity || "");
          if (!integrity) { rejectDep(mode, key, `Unable to fetch sha512 integrity for ${name}@${dep.new}`); return; }
          dep.newPrint = dep.new;
          dep.new = `${dep.new}+sha512.${Buffer.from(integrity[1], "base64").toString("hex")}`;
        }
      }
      dep.info = getInfoUrl(followUp, null, name);
      setDepAge(dep, followUp.date);
    }));

    if (mode === "npm" && hasMaybeUrlDeps) {
      const results = (await pMap(Object.entries(maybeUrlDeps), async ([key, dep]) => {
        try {
          const versionOpts = resolveVersionOpts(ctxForType(key.split(fieldSep)[0]), depIdentities[mode].get(key)!);
          const result = await checkUrlDep(key, dep, ctx, versionOpts);
          return result && {...result, cooldownDays: versionOpts.cooldownDays};
        } catch (err) {
          addKeyError("npm", key, err);
          return null;
        }
      }, {concurrency})).filter(result => result !== null);

      for (const {key, newRange, user, repo, oldRef, newRef, newDate, cooldownDays} of results) {
        const dep: Dep = modeDeps[key] = {
          old: maybeUrlDeps[key].old,
          new: newRange,
          oldPrint: hashRe.test(oldRef) ? shortenHash(oldRef) : oldRef,
          newPrint: hashRe.test(newRef) ? shortenHash(newRef) : newRef,
          info: `https://github.com/${user}/${repo}`,
          cooldownDays,
        };
        setDepAge(dep, newDate);
      }
    }

    for (const [key, {date, cooldownDays}] of Object.entries(modeDeps)) {
      if (cooldownDays && !passesCooldown(date, cooldownDays, now)) delete modeDeps[key];
    }
  });

  type ForgeEntry = Omit<TagEntry, "commitSha"> & {commitSha?: string};
  function forgeVersionTags(
    entries: Array<ForgeEntry>, allowedVersions?: string, versioning: Versioning = githubActionsVersioning,
    includePrerelease = false, extractVersion = "", annotation = false,
  ) {
    const isAllowed = allowedVersions ? versionAllowedPredicate(versioning === pep440Versioning ? "pypi" : "actions", allowedVersions) : null;
    const extract = extractVersion ? new RegExp(extractVersion) : null;
    const byVersion = new Map<string, {written: string, entry: ForgeEntry}>();
    const allowedTags = new Set<string>();
    for (const entry of entries) {
      const written = extract ? extract.exec(entry.name)?.groups?.version : entry.name;
      const version = written && (!annotation || versioning !== githubActionsVersioning || isVersionLikeRef(written)) && versioning.parse(written)?.version;
      if (!version || entry.isStable === false && !includePrerelease || isAllowed && !isAllowed(version, written)) continue;
      allowedTags.add(written);
      if (written.length > (byVersion.get(version)?.written.length ?? 0)) byVersion.set(version, {written, entry});
    }
    return {byVersion, versions: Array.from(byVersion.keys()), allowedTags};
  }
  const commitDates = new Map<string, ReturnType<typeof fetchActionTagDate>>();
  const forgeDate = async (apiUrl: string, owner: string, repo: string, {name, commitSha, releaseTimestamp}: ForgeEntry) => {
    const date = commitSha ? await getOrSet(commitDates, `${apiUrl}/${owner}/${repo}/${commitSha}`,
      () => fetchActionTagDate(apiUrl, owner, repo, commitSha, ctx)) : "";
    if (date === undefined) throw new Error(`Unable to fetch the commit date for ${owner}/${repo}@${name}`);
    return releaseTimestamp && (!date || Date.parse(releaseTimestamp) > Date.parse(date)) ? releaseTimestamp : date;
  };

  const actionsTask = pMap(Map.groupBy(actionDepInfos, info => `${info.apiUrl}/${info.owner}/${info.repo}`).values(), async (infos) => {
    const {apiUrl, owner, repo} = infos[0];
    if (!apiUrl) {
      for (const info of infos) {
        if (info.isHash || isVersionLikeRef(info.ref)) {
          rejectDep("actions", info.key, `Unable to resolve the instance of ${info.name}, set GITEA_SERVER_URL or an origin remote`);
        } else {
          delete deps.actions[info.key];
        }
      }
      return;
    }
    const versionConsumers = infos.filter(info => info.isHash ? !isDigestOnlyPin(info) : isVersionLikeRef(info.ref));
    const needsOlderTags = versionConsumers.some(info => {
      const {allowDowngrade, pinnedRange, pinNoDowngrade} = resolveVersionOpts(info.filters, info.identity);
      return allowDowngrade || Boolean(pinnedRange && !pinNoDowngrade);
    });
    const tagRefs = [
      ...versionConsumers.map(info => info.isHash ? info.comment || info.ref : info.ref),
      ...(apiUrl === defaultApiUrls.forgeapi ? [] : infos.filter(isDigestOnlyPin).map(info => info.comment)),
    ];
    let tags: Array<TagEntry> = [];
    try {
      if (tagRefs.length) {
        tags = await fetchActionTags(apiUrl, owner, repo, ctx, needsOlderTags ? [] : tagRefs, Boolean(versionConsumers.length));
      }
    } catch (err) {
      for (const info of infos) rejectDep("actions", info.key, err);
      return;
    }
    const entryByName = new Map<string, TagEntry>();
    const commitShaToTag = new Map<string, string>();
    for (const tag of tags) {
      entryByName.set(tag.name, tag);
      if (tag.commitSha) commitShaToTag.set(tag.commitSha.toLowerCase(), tag.name);
    }
    const tagsByAllowedVersions = new Map<string | undefined, ReturnType<typeof forgeVersionTags>>();
    const versionTags = (allowedVersions?: string) =>
      getOrSet(tagsByAllowedVersions, allowedVersions, () => forgeVersionTags(tags, allowedVersions));
    const getDate = (commitSha: string, tag: string) => forgeDate(apiUrl, owner, repo,
      {...entryByName.get(tag), name: tag, commitSha});
    const getExactDigest = memoizeAsync(async (exactRef: string): Promise<string> => {
      const tagged = entryByName.get(exactRef)?.commitSha;
      if (tagged) return tagged;
      const path = apiUrl === defaultApiUrls.forgeapi ? "commits" : "branches";
      const url = `${apiUrl}/repos/${owner}/${repo}/${path}/${encodeURIComponent(exactRef)}`;
      const response = await fetchForge(url, ctx);
      if (response.status === 404) return "";
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? `, ${forgeTokenHint(new URL(url).host)}` : "";
        throw new Error(`Received ${response.status} from ${url}${hint}`);
      }
      const body = await response.json();
      return [body?.sha, body?.id, body?.commit?.sha, body?.commit?.id].find(value => typeof value === "string") ?? "";
    });

    await pMap(infos, async (info) => {
      try {
        const {key, host, ref, comment, isHash} = info;
        const normalizedRef = ref.toLowerCase();
        const isPinnedSha = (sha: string) => sha.toLowerCase().startsWith(normalizedRef) || normalizedRef.startsWith(sha.toLowerCase());
        const dep = deps.actions[key];
        const infoUrl = `${info.name.startsWith("self:") ? apiUrl.replace(/\/api\/v1$/, "") : `https://${host || "github.com"}`}/${owner}/${repo}`;

        let oldRef = ref;
        if (isHash) {
          oldRef = comment || commitShaToTag.get(normalizedRef) || commitShaToTag.entries().find(([sha]) => sha.startsWith(normalizedRef))?.[1] || "";
        } else if (!isVersionLikeRef(ref)) {
          oldRef = "";
        }
        if (!oldRef) { delete deps.actions[key]; return; }

        const versionOpts = resolveVersionOpts(info.filters, info.identity);
        const filteredTags = versionTags(versionOpts.allowedVersions);
        const result = isVersionLikeRef(oldRef) ? await pickDatedVersion(filteredTags.versions,
          {...versionOpts, range: oldRef, versioning: githubActionsVersioning}, async version => {
            const {written: tag, entry: {commitSha, releaseTimestamp}} = filteredTags.byVersion.get(version)!;
            if (releaseTimestamp && !passesCooldown(releaseTimestamp, versionOpts.cooldownDays, versionOpts.now)) return releaseTimestamp;
            return commitSha ? getDate(commitSha, tag) : "";
          }) : null;
        if (!result) { // a commented sha pin still follows its ref when no newer version exists
          if (!isHash || !comment) { delete deps.actions[key]; return; }
          const newDigest = await getExactDigest(comment);
          if (!newDigest || isPinnedSha(newDigest)) { delete deps.actions[key]; return; }
          if (versionOpts.cooldownDays) {
            const date = await getDate(newDigest, comment);
            if (!passesCooldown(date, versionOpts.cooldownDays, versionOpts.now)) { delete deps.actions[key]; return; }
          }
          dep.old = comment;
          dep.new = comment;
          dep.oldDigest = ref;
          dep.newDigest = newDigest.substring(0, ref.length);
          dep.digestOnly = true;
          dep.info = infoUrl;
          setDepAge(dep, await tryOrNull(getDate(newDigest, comment)));
          return;
        }
        const {written: newTag, entry: {commitSha: newCommitSha}} = filteredTags.byVersion.get(result.version)!;
        const {date} = result;
        const formatted = formatActionVersion(newTag, oldRef);
        const newRef = filteredTags.allowedTags.has(formatted) ? formatted : newTag;

        if (isHash) {
          const newPrint = comment && entryByName.get(newRef)!.commitSha === newCommitSha ? newRef : newTag;
          if (!newCommitSha || isPinnedSha(newCommitSha) && (!comment || newPrint === oldRef)) { delete deps.actions[key]; return; }
          dep.old = oldRef; // the tag the pinned sha resolved to
          dep.new = newPrint;
          dep.oldDigest = ref;
          dep.newDigest = newCommitSha.substring(0, ref.length);
        } else {
          if (newRef === ref) { delete deps.actions[key]; return; }
          dep.new = newRef;
        }
        dep.info = infoUrl;
        setDepAge(dep, date || (newCommitSha ? await tryOrNull(getDate(newCommitSha, newTag)) : ""));
      } catch (err) {
        rejectDep("actions", info.key, err);
      }
    }, {concurrency});
  }, {concurrency});

  type VersionOpts = ReturnType<typeof resolveVersionOpts>;

  const resolveImage = async (ref: DockerImageRef, digest: string | null | undefined, opts: VersionOpts) => {
    const [data] = await fetchDockerInfo(ref.fullImage, ctx);
    const tagDate = (tag: string) => Object.hasOwn(data.tags, tag) ? data.tags[tag] : undefined;
    const resolveDate = ref.registry ? (tag: string) => fetchRegistryTagDate(ref.fullImage, tag, ctx) : undefined;
    const result = ref.digestOnly ? null : await findDockerVersion(
      filterVersionData(data, "docker", opts.allowedVersions).tags, ref.tag, opts.semvers, opts.cooldownDays, opts.now,
      opts.pinnedRange, opts.usePre, opts.useRel, resolveDate,
    );
    const newTag = result?.newTag ?? ref.tag;
    if (!result && (!digest ||
      !passesCooldown(tagDate(newTag) || (opts.cooldownDays ? await resolveDate?.(newTag) : ""), opts.cooldownDays, opts.now))) return null;
    const newDigest = digest ? await resolveDockerTagDigest(ref.fullImage, newTag) : null;
    return digest && !newDigest ? null : {newTag, newDigest, date: result?.date || tagDate(newTag)};
  };

  type LookupResult = Omit<Partial<Dep>, "date"> & {new: string, date?: string | null};

  const lookupGo = async (
    installPath: string, version: string, opts: VersionOpts, projectDir: string, isModule = false,
  ): Promise<LookupResult | null> => {
    const modulePath = await resolveGoModuleRoot(installPath, projectDir, ctx, goNoProxy);
    if (!modulePath) return null;
    const constraints = goVersionConstraints(opts, stripv(version));
    if (isModule) constraints.allowMajor = false; // a bare version can not move to a new major's module path
    const [data] = await fetchGoProxyInfo(modulePath, "tool", stripv(version), projectDir, ctx, goNoProxy, constraints);
    const newVersion = findNewVersion(data, {...opts, mode: "go", range: stripv(version), acceptsGoVersion: constraints.accepts});
    if (!newVersion) return null;
    const newModulePath = data.newPath ?? goModulePathForVersion(modulePath, newVersion);
    const formatted = formatVersionPrecision(newVersion, version);
    return {new: isModule ? formatted : `${newModulePath}${installPath.slice(modulePath.length)}@${formatted}`,
      newPrint: isModule || formatted === version ? undefined : formatted, info: getGoInfoUrl(newModulePath), date: data.Time};
  };

  const lookupImage = async (image: MakeDockerImage, opts: VersionOpts, tagOnly = false): Promise<LookupResult | null> => {
    const result = await resolveImage(image.ref, image.digest, opts);
    if (!result) return null;
    const spec = formatMakeImageSpec(image.writtenImage, result.newTag, result.newDigest);
    return {new: tagOnly ? spec.slice(image.writtenImage.length + 1) : spec,
      newPrint: tagOnly || image.digest && result.newTag === image.ref.tag ? undefined : result.newTag,
      info: getDockerInfoUrl(image.ref), date: result.date};
  };

  const lookupForge = async (
    [datasource, forge, kind]: RegExpExecArray, {fields, value, identity: {packageName}}: AnnotationDepInfo, opts: VersionOpts,
  ): Promise<LookupResult | null> => {
    const [owner, repo, ...rest] = packageName.split("/");
    if (!repo || rest.length) throw new Error(`Invalid ${datasource} repository ${packageName}`);
    const webUrl = normalizeUrl(fields.registryUrl || forgeWebUrls[forge]);
    const apiUrl = forge !== "github" ? `${webUrl}/api/v1` : webUrl === forgeWebUrls.github ? ctx.forgeApiUrl : `${webUrl}/api/v3`;
    const oldRefs = opts.allowDowngrade || opts.pinnedRange && !opts.pinNoDowngrade || fields.extractVersion ? [] : [value];
    const entries = await (kind === "releases" ? fetchForgeReleases : fetchActionTags)(apiUrl, owner, repo, ctx, oldRefs);
    if (!entries.length) throw new Error(`No ${kind} found for ${owner}/${repo}`);
    const versioning = fields.versioning === "pep440" ? pep440Versioning : githubActionsVersioning;
    const {byVersion, versions, allowedTags} = forgeVersionTags(entries, opts.allowedVersions,
      versioning, opts.usePre || versioning.isRangePrerelease(value), fields.extractVersion, true);
    const dateOf = (entry: ForgeEntry) => forgeDate(apiUrl, owner, repo, entry);
    const selectOpts = {...opts, range: value, versioning};
    const releaseDate = (version: string) => byVersion.get(version)!.entry.releaseTimestamp;
    const released = kind === "releases" && findVersion({}, versions, {...selectOpts, getVersionDate: releaseDate});
    const picked = kind === "releases" ? released && {version: released, date: releaseDate(released) || ""} :
      await pickDatedVersion(versions, selectOpts, version => dateOf(byVersion.get(version)!.entry));
    if (!picked) return null;
    const written = byVersion.get(picked.version)!.written;
    const formatted = versioning === githubActionsVersioning ? formatActionVersion(written, value) : written;
    return {
      new: allowedTags.has(formatted) || !allowedTags.has(value) && allowedTags.values().some(tag => stripv(tag) === stripv(formatted)) ?
        formatted : written, // a value naming a tag stays an existing tag, a version keeps its v-prefix style
      info: `${webUrl}/${owner}/${repo}`, date: picked.date || await tryOrNull(dateOf(byVersion.get(picked.version)!.entry)),
    };
  };

  const lookupAnnotation = async (info: AnnotationDepInfo): Promise<LookupResult | null> => {
    const {fields: {datasource}, mode, value, filters, identity, image} = info;
    const {packageName} = identity;
    const opts = resolveVersionOpts(filters, identity);
    if (datasource === "docker") {
      const target = parseMakeImageValue(`${packageName}:${image?.ref.tag ?? value}`);
      return target && lookupImage(image ? {...image, ref: target.ref} : target, opts, !image);
    }
    if (datasource === "go") return lookupGo(packageName, value.slice(value.indexOf("@") + 1), opts, filters.projectDir, !value.includes("@"));
    const forge = forgeDatasourceRe.exec(datasource);
    if (forge) return lookupForge(forge, info, opts);

    const npmArgs = {needsDates: argsForNpm.needsDates || Boolean(opts.cooldownDays)};
    const [rawData, registry] = mode === "npm" ?
      await fetchNpmInfo(packageName, "dependencies", filters.modeConfig, npmArgs, ctx, filters.projectDir) :
      mode === "pypi" ? await fetchPypiInfo(packageName, ctx) : await fetchCratesIoInfo(packageName, ctx);
    if (rawData.error) throw new Error(rawData.error);
    const data = filterVersionData(rawData, mode, opts.allowedVersions);
    const newVersion = findNewVersion(data, {...opts, mode, range: value});
    if (!newVersion) return null;
    const spec = mode === "pypi" || /[-+]/.test(newVersion) ? newVersion : formatVersionPrecision(newVersion, value);
    if (spec === value) return null;
    if (mode === "pypi") return {new: spec, info: getInfoUrl(data, registry, data.info.name), date: pypiReleaseDate(data.releases[newVersion])};
    if (mode === "cargo") return {new: spec, info: `https://crates.io/crates/${data.name}`, date: data.time[newVersion]};
    const versionInfo = await fetchNpmVersionInfo(data.name, newVersion, filters.modeConfig, npmArgs, ctx, filters.projectDir);
    const date = versionInfo.date || data.time?.[newVersion];
    return passesCooldown(date, opts.cooldownDays, opts.now) ? {new: spec, info: getInfoUrl(versionInfo, null, packageName), date} : null;
  };

  const lookupTask = <T extends {key: string, mode: string}>(infos: Iterable<T>,
    lookup: (info: T) => Promise<LookupResult | null>, modeDeps: Deps) => pMap(infos, async (info) => {
    try {
      const result = await lookup(info);
      if (!result) { delete modeDeps[info.key]; return; }
      if (!/^[\w.+@:/~![\]-]+$/.test(result.new)) throw new Error(`Refusing to write ${JSON.stringify(result.new)}`);
      const {date, ...fields} = result;
      const dep = Object.assign(modeDeps[info.key], fields);
      if (!dep.newPrint) delete dep.oldPrint;
      setDepAge(dep, date);
    } catch (err) {
      delete modeDeps[info.key];
      addKeyError(info.mode, info.key, err);
    }
  }, {concurrency});

  const dockerTask = lookupTask(dockerDepInfos, async ({key, ref, filters}) => {
    const result = await resolveImage(ref, ref.digest, resolveVersionOpts(filters, depIdentities.docker.get(key)!, false));
    return result && {new: result.newTag, info: getDockerInfoUrl(ref), date: result.date, ...(ref.digest && {newDigest: result.newDigest!})};
  }, deps.docker);
  const makeTask = lookupTask(makeDepInfos, info => {
    const opts = resolveVersionOpts(info.filters, info.identity);
    return info.mode === "go" ? lookupGo(info.installPath, info.version, opts, info.filters.projectDir) : lookupImage(info.image, opts);
  }, deps.make);
  const annotationsTask = lookupTask(annotationDepInfos.values(), lookupAnnotation, deps.annotations);

  try {
    await Promise.all([...modeTasks, actionsTask, dockerTask, makeTask, annotationsTask]);
  } finally {
    if (!config.noCache) await flushCacheWrites();
  }

  for (const modeDeps of Object.values(deps)) {
    for (const [key, dep] of Object.entries(modeDeps)) {
      if (dep.new === (dep.oldOrig || dep.old) && dep.newDigest === dep.oldDigest) delete modeDeps[key];
    }
  }

  if (!hasDeps(deps)) {
    return errors.length ? {results: {}, errors} : {results: {}, message: "All dependencies are up to date."};
  }

  const updatePnpmWorkspaceOverrideValues = (content: string, memberPath: string): string => {
    const lines = content.split("\n");
    const entries = new Map(pnpmWorkspaceOverrides(content).map(entry => [entry.selector, entry]));
    for (const [key, selector] of pnpmWorkspaceOverrideKeys) {
      const dep = deps.npm[key];
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

    const writeOrder = (mode: string) => mode === "annotations" ? -1 : Number(mode === "docker");
    for (const mode of Object.keys(deps).sort((left, right) => writeOrder(left) - writeOrder(right))) {
      if (!Object.keys(deps[mode]).length) continue;

      if (["actions", "docker", "make", "annotations"].includes(mode)) {
        for (const [relPath, entries] of Map.groupBy(Object.entries(deps[mode]), ([key]) => key.split(fieldSep)[0])) {
          const {absPath, fileType, workflowLines} = fileData[relPath];
          const content = readFileSync(absPath, "utf8");
          let updated: string;
          if (mode === "actions") {
            updated = updateWorkflowFile(content, entries.map(([key, dep]) => ({
              name: key.split(fieldSep)[1], oldRef: dep.oldDigest ?? dep.old,
              newRef: dep.newDigest ?? dep.new,
              oldComment: actionComments.get(key) || undefined,
              newComment: dep.oldDigest && !dep.digestOnly ? dep.new : undefined,
            })));
          } else if (mode === "annotations") {
            updated = updateAnnotatedLines(content, entries.flatMap(([key, dep]) => annotationDepInfos.get(key)!.locations
              .map(location => ({...location, oldValue: dep.old, newValue: dep.new}))));
          } else if (mode === "make") {
            updated = updateMakefile(content, entries.map(([_key, dep]) => ({oldSpec: dep.old, newSpec: dep.new})),
              annotatedLines.get(relPath));
          } else if (fileType === "workflow") {
            const fileDeps = Object.fromEntries(entries);
            updated = content.split("\n").map((line, lineNumber) =>
              workflowLines!.has(lineNumber) ? updateWorkflowDockerImages(line, fileDeps) : line).join("\n");
          } else {
            updated = (fileType === "dockerfile" ? updateDockerfile : updateComposeFile)(content, Object.fromEntries(entries));
          }
          write(absPath, updated);
        }
      } else if (mode === "go") {
        for (const goMod of [...goModFiles, ...(plainFiles.go ?? [])]) {
          const localDeps = filterDepsForMember(deps[mode], goMod.memberPath);
          if (!Object.keys(localDeps).length) continue;
          const [updatedContent, majorVersionRewrites] = updateGoMod(goMod.content, localDeps);
          if (updatedContent !== goMod.content) write(goMod.absPath, updatedContent);
          rewriteGoImports(dirname(goMod.absPath), majorVersionRewrites, write);
        }
        for (const goWork of goWorkFiles) {
          const workDeps = Object.fromEntries(Object.entries(filterDepsForMember(deps[mode], goWork.memberPath))
            .filter(([key]) => baseType(key.split(fieldSep)[0]) === "replace"));
          if (!Object.keys(workDeps).length) continue;
          const [updatedWork] = updateGoMod(goWork.content, workDeps);
          if (updatedWork !== goWork.content) write(goWork.absPath, updatedWork);
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

  for (const {key, mode} of [...makeDepInfos, ...annotationDepInfos.values()]) {
    const dep = deps.make?.[key] ?? deps.annotations?.[key];
    if (dep) (deps[mode] ??= {})[key] = dep;
  }
  delete deps.make;
  delete deps.annotations;
  const output = buildOutput(deps);
  if (errors.length) output.errors = errors;
  return output;
}
