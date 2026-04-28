import {cwd, platform, stderr} from "node:process";
import {styleText} from "node:util";
import {join, dirname, basename, resolve} from "node:path";
import {lstatSync, readdirSync, truncateSync, writeFileSync, accessSync, type Stats} from "node:fs";
import {readFile} from "node:fs/promises";
import {parseToml} from "./utils/toml.ts";
import {valid, validRange} from "./utils/semver.ts";
import {timerel} from "timerel";
import {npmTypes, uvTypes, goTypes, cargoTypes, parseUvDependencies, nonPackageEngines, parseDuration, matchesAny, getProperty, timestamp, pMap} from "./utils/utils.ts";
import {
  type Dep, type Deps, type DepsByMode, type Output, type ModeContext,
  type PackageRepository, type PackageInfo,
  fieldSep, normalizeUrl, fetchTimeout, goProbeTimeout,
  doFetch, findVersion, findNewVersion, coerceToVersion, getInfoUrl, getGithubTokens,
  passesCooldown, stripv, hashRe as npmHashRe,
} from "./modes/shared.ts";
import {loadConfig, configMixedToRegexes, patternsToRegexSet} from "./config.ts";
import type {Config} from "./config.ts";
import {
  fetchNpmInfo, fetchNpmVersionInfo, fetchJsrInfo, isJsr, isLocalDep, parseJsrDependency,
  getNpmrc, updatePackageJson, updateVersionRange, normalizeRange, checkUrlDep,
} from "./modes/npm.ts";
import {fetchPypiInfo, updatePyprojectToml} from "./modes/pypi.ts";
import {
  resolveGoProxy, parseGoNoProxy, isGoPseudoVersion,
  parseGoMod, parseGoWork, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, shortenGoVersion,
} from "./modes/go.ts";
import {
  type ActionRef, type TagEntry,
  actionsUsesRe, parseActionRef, getForgeApiBaseUrl,
  fetchActionTags, fetchActionTagDate, formatActionVersion,
  updateWorkflowFile, isWorkflowFile, resolveWorkflowFiles,
} from "./modes/actions.ts";
import {
  type DockerImageRef,
  parseDockerTag, extractDockerRefs,
  getExtractionRegex, isDockerfile, isDockerFileName, dockerExactFileNames,
  fetchDockerInfo, findDockerVersion, getDockerInfoUrl,
  updateDockerfile, updateComposeFile, updateWorkflowDockerImages,
  composeImageRe, workflowContainerRe, workflowDockerUsesRe,
} from "./modes/docker.ts";
import {fetchCratesIoInfo, updateCargoToml, updateCargoRange, parseCargoLock, findLockedVersion} from "./modes/cargo.ts";
import {baseType, filterDepsForMember, resolveWorkspaceMembers, parsePnpmWorkspace, type WorkspaceMember} from "./utils/workspace.ts";

export type {Config, Dep, Deps, DepsByMode, Output};

const modeByFileName: Record<string, string> = {
  "pnpm-workspace.yaml": "npm",
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "go.work": "go",
  "go.mod": "go",
  "Cargo.toml": "cargo",
};

const defaultModes = new Set(["npm", "pypi", "go", "cargo", "actions", "docker"]);

const apiUrl = (val: unknown, dflt: string | (() => string)) => typeof val === "string" ? normalizeUrl(val) : (typeof dflt === "function" ? dflt() : dflt);

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
    dep.age = timerel(date, {noAffix: true});
  }
}

function countDeps(deps: DepsByMode): number {
  let num = 0;
  for (const mode of Object.keys(deps)) {
    num += Object.keys(deps[mode]).length;
  }
  return num;
}

function logVerbose(message: string): void {
  console.error(`${timestamp()} ${message}`);
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

function resolveFiles(filesArg: Set<string> | false): Set<string> {
  const resolvedFiles = new Set<string>();

  if (filesArg) {
    for (const file of filesArg) {
      let stat: Stats;
      try {
        stat = lstatSync(file);
      } catch (err) {
        throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
      }

      if (stat?.isFile()) {
        resolvedFiles.add(resolve(file));
      } else if (stat?.isDirectory()) {
        for (const filename of Object.keys(modeByFileName)) {
          const f = join(file, filename);
          let stat: Stats | null = null;
          try { stat = lstatSync(f); } catch {}
          if (stat?.isFile()) resolvedFiles.add(resolve(f));
        }
        try {
          for (const entry of readdirSync(file, {withFileTypes: true})) {
            if (entry.isFile() && isDockerFileName(entry.name)) {
              resolvedFiles.add(resolve(join(file, entry.name)));
            }
          }
        } catch {}
        const normalized = resolve(file).replace(/\\/g, "/");
        let wfDir: string | undefined;
        if (normalized.endsWith(".github/workflows")) wfDir = normalized;
        else if (normalized.endsWith(".github")) wfDir = join(normalized, "workflows");
        else wfDir = join(normalized, ".github", "workflows");
        for (const wf of resolveWorkflowFiles(wfDir)) resolvedFiles.add(wf);
      } else {
        throw new Error(`${file} is neither a file nor directory`);
      }
    }
  } else {
    const workflowsDir = join(".github", "workflows");
    const candidates = [...Object.keys(modeByFileName), ...dockerExactFileNames, workflowsDir];
    for (const [filename, path] of findUpSync(candidates, cwd())) {
      if (filename === workflowsDir) {
        for (const wf of resolveWorkflowFiles(path)) resolvedFiles.add(wf);
      } else {
        resolvedFiles.add(resolve(path));
      }
    }
    try {
      for (const entry of readdirSync(cwd(), {withFileTypes: true})) {
        if (entry.isFile() && isDockerFileName(entry.name) && !dockerExactFileNames.includes(entry.name)) {
          resolvedFiles.add(resolve(join(cwd(), entry.name)));
        }
      }
    } catch {}
  }

  // go.work supersedes go.mod in the same directory
  for (const file of resolvedFiles) {
    if (basename(file) === "go.work") {
      resolvedFiles.delete(join(dirname(file), "go.mod"));
    }
  }

  // pnpm-workspace.yaml supersedes package.json in the same directory
  for (const file of resolvedFiles) {
    if (basename(file) === "pnpm-workspace.yaml") {
      resolvedFiles.delete(join(dirname(file), "package.json"));
    }
  }

  return resolvedFiles;
}

// preserve file metadata on windows
function write(file: string, content: string): void {
  if (platform === "win32") truncateSync(file, 0);
  writeFileSync(file, content, platform === "win32" ? {flag: "r+"} : undefined);
}

function buildOutput(deps: DepsByMode): Output {
  const output: Output = {results: {}};
  for (const mode of Object.keys(deps)) {
    for (const [key, props] of Object.entries(deps[mode])) {
      if (typeof props.oldPrint === "string") props.old = props.oldPrint;
      if (typeof props.newPrint === "string") props.new = props.newPrint;
      if (typeof props.oldOrig === "string" && !isJsr(props.oldOrig)) {
        props.old = mode === "go" ? shortenGoVersion(props.oldOrig) : props.oldOrig;
      }
      if (mode === "go") props.new = shortenGoVersion(props.new);
      if (mode === "actions") {
        props.old = stripv(props.old);
        props.new = stripv(props.new);
      }
      delete props.oldPrint;
      delete props.newPrint;
      delete props.oldOrig;
      delete props.date;

      const [type, name] = key.split(fieldSep);
      const r = output.results[mode] ??= {};
      (r[type] ??= {})[name] = props;
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

  const maxSockets = 25;
  const concurrency = config.sockets ?? maxSockets;
  const userTimeout = config.timeout ?? 0;
  const forgeApiUrl = apiUrl(opts.forgeapi, "https://api.github.com");
  const pypiApiUrl = apiUrl(opts.pypiapi, "https://pypi.org");
  const jsrApiUrl = apiUrl(opts.jsrapi, "https://jsr.io");
  const goProxyUrl = apiUrl(opts.goproxy, resolveGoProxy);
  const cratesIoUrl = apiUrl(opts.cargoapi, "https://crates.io");
  const dockerApiUrl = apiUrl(opts.dockerapi, "https://hub.docker.com");
  const goNoProxy = parseGoNoProxy();

  const useVerboseColor = config.color === true || (config.noColor !== true && stderr.isTTY);
  const colorFn = (color: "magenta" | "green" | "red") => useVerboseColor ? (text: string | number) => styleText(color, String(text)) : String;
  const magenta = colorFn("magenta");
  const vGreen = colorFn("green");
  const vRed = colorFn("red");

  const ctx: ModeContext = {
    fetchTimeout: userTimeout || fetchTimeout,
    goProbeTimeout: userTimeout ? userTimeout / 2 : goProbeTimeout,
    forgeApiUrl,
    pypiApiUrl,
    jsrApiUrl,
    goProxyUrl,
    cratesIoUrl,
    dockerApiUrl,
    doFetch: async (url: string, fetchOpts?: RequestInit) => {
      if (config.verbose) logVerbose(`${magenta(fetchOpts?.method || "GET")} ${url}`);
      const res = await doFetch(url, fetchOpts);
      if (config.verbose) logVerbose(`${res.ok ? vGreen(res.status) : vRed(res.status)} ${url}`);
      return res;
    },
    noCache: Boolean(config.noCache),
  };

  const greatest = configMixedToRegexes(config.greatest);
  const prerelease = configMixedToRegexes(config.prerelease);
  const release = configMixedToRegexes(config.release);
  const patch = configMixedToRegexes(config.patch);
  const minor = configMixedToRegexes(config.minor);
  const allowDowngrade = configMixedToRegexes(config.allowDowngrade);
  const enabledModes = config.modes?.length ? new Set(config.modes) : defaultModes;

  // Kick off `gh auth token` early so the first forge request isn't blocked on a subprocess.
  if (enabledModes.has("actions")) getGithubTokens();

  function getSemvers(name: string): Set<string> {
    if (patch === true || matchesAny(name, patch)) return new Set<string>(["patch"]);
    if (minor === true || matchesAny(name, minor)) return new Set<string>(["patch", "minor"]);
    return new Set<string>(["patch", "minor", "major"]);
  }

  const versionOptsCache = new Map<string, {useGreatest: boolean, usePre: boolean, useRel: boolean, semvers: Set<string>}>();

  function getVersionOpts(name: string) {
    let entry = versionOptsCache.get(name);
    if (!entry) {
      entry = {
        useGreatest: typeof greatest === "boolean" ? greatest : matchesAny(name, greatest),
        usePre: typeof prerelease === "boolean" ? prerelease : matchesAny(name, prerelease),
        useRel: typeof release === "boolean" ? release : matchesAny(name, release),
        semvers: getSemvers(name),
      };
      versionOptsCache.set(name, entry);
    }
    return entry;
  }

  const include = patternsToRegexSet(config.include ?? []);
  const exclude = patternsToRegexSet(config.exclude ?? []);
  const configPin: Record<string, string> = config.pin ?? {};

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const pkgStrs: Record<string, string> = {};
  const filePerMode: Record<string, string> = {};
  const now = Date.now();
  let numDependencies = 0;

  const addDep = (mode: string, depType: string, typePrefix: string, name: string, old: string, oldOrig: string) => {
    deps[mode][`${depType}${typePrefix}${fieldSep}${name}`] = {old, oldOrig} as Dep;
  };

  const files = resolveFiles(config.files?.length ? new Set(config.files) : false);
  const fileApplies = (file: string): boolean => {
    if (isWorkflowFile(file)) return enabledModes.has("actions") || enabledModes.has("docker");
    const filename = basename(file);
    if (isDockerFileName(filename)) return enabledModes.has("docker");
    const mode = modeByFileName[filename];
    return Boolean(mode) && enabledModes.has(mode);
  };
  const fileContents = await prefetchFiles(Array.from(files).filter(fileApplies), concurrency);

  const wfData: Record<string, {absPath: string, content: string}> = {};
  const dockerFileData: Record<string, {absPath: string, content: string, fileType: string}> = {};

  type GoModFileInfo = {absPath: string, content: string, projectDir: string, usePath: string};
  const goModFiles: GoModFileInfo[] = [];
  let goWorkData: {file: string, content: string} | null = null;

  const cargoMemberFiles: WorkspaceMember[] = [];
  let cargoWorkspaceActive = false;

  const pnpmMemberFiles: WorkspaceMember[] = [];
  let pnpmWorkspaceActive = false;

  type ActionDepInfo = ActionRef & {key: string, apiUrl: string};
  const actionDepInfos: Array<ActionDepInfo> = [];
  type DockerDepInfo = {key: string, fullImage: string, ref: DockerImageRef};
  const dockerDepInfos: Array<DockerDepInfo> = [];
  type ModeCtx = {modeConfig: Config, projectDir: string, pin: Record<string, string>};
  const modeConfigs: Record<string, ModeCtx> = {};

  async function resolveModeFilters(projectDir: string) {
    const modeConfig = projectDir === cwd() ? config : await loadConfig(projectDir);
    const modeInclude = modeConfig !== config && modeConfig?.include ? patternsToRegexSet([...(config.include ?? []), ...modeConfig.include]) : include;
    const modeExclude = modeConfig !== config && modeConfig?.exclude ? patternsToRegexSet([...(config.exclude ?? []), ...modeConfig.exclude]) : exclude;
    const pin: Record<string, string> = {...modeConfig?.pin, ...configPin};
    return {modeConfig, modeInclude, modeExclude, pin};
  }

  function resolveDepTypes(mode: string, modeConfig: Config): Array<string> {
    if (config.types?.length) return config.types;
    if (modeConfig?.types?.length) return modeConfig.types;
    if (mode === "npm") return npmTypes;
    if (mode === "pypi") return uvTypes;
    if (mode === "go") return config.indirect ? goTypes : goTypes.filter(t => t !== "indirect");
    if (mode === "cargo") return cargoTypes;
    return [];
  }

  function collectDockerRefs(content: string, relPath: string, regexes: Array<RegExp>): void {
    deps.docker ??= {};
    for (const regex of regexes) {
      for (const {ref} of extractDockerRefs(content, regex)) {
        if (!canInclude(ref.fullImage, "docker", include, exclude, "docker")) continue;
        const key = `${relPath}${fieldSep}${ref.fullImage}`;
        if (deps.docker[key]) continue;
        const parsed = parseDockerTag(ref.tag);
        if (!parsed) continue;
        deps.docker[key] = {old: parsed.version, oldOrig: ref.tag} as Dep;
        dockerDepInfos.push({key, fullImage: ref.fullImage, ref});
      }
    }
  }

  for (const file of files) {
    if (isWorkflowFile(file)) {
      const actionsEnabled = enabledModes.has("actions");
      const dockerEnabled = enabledModes.has("docker");
      if (!actionsEnabled && !dockerEnabled) continue;

      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      wfData[relPath] = {absPath: file, content};

      if (actionsEnabled) {
        deps.actions ??= {};
        const actions = Array.from(content.matchAll(actionsUsesRe), m => parseActionRef(m[1])).filter(a => a !== null);
        for (const action of actions) {
          if (!canInclude(action.name, "actions", include, exclude, "actions")) continue;
          const key = `${relPath}${fieldSep}${action.name}`;
          if (deps.actions[key]) continue;
          deps.actions[key] = {old: action.ref} as Dep;
          actionDepInfos.push({...action, key, apiUrl: getForgeApiBaseUrl(action.host, forgeApiUrl)});
        }
      }

      if (dockerEnabled) {
        dockerFileData[relPath] = {absPath: file, content, fileType: "workflow"};
        collectDockerRefs(content, relPath, [composeImageRe, workflowContainerRe, workflowDockerUsesRe]);
      }
      continue;
    }

    const filename = basename(file);

    if (isDockerFileName(filename)) {
      if (!enabledModes.has("docker")) continue;
      const content = fileContents.get(file)!;
      const relPath = toRelPath(file);
      const fileType = isDockerfile(filename) ? "dockerfile" : "compose";
      dockerFileData[relPath] = {absPath: file, content, fileType};
      collectDockerRefs(content, relPath, [getExtractionRegex(filename)]);
      continue;
    }

    const mode = modeByFileName[filename];
    if (!enabledModes.has(mode)) continue;

    if (filename === "go.work") {
      deps[mode] ??= {};
      const workspaceDir = dirname(resolve(file));
      const workContent = fileContents.get(file)!;
      goWorkData = {file, content: workContent};
      const goWork = parseGoWork(workContent);

      const [filters, useReads] = await Promise.all([
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
      const {modeConfig, modeInclude, modeExclude, pin} = filters;
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      filePerMode[mode] = file;
      modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};

      for (const entry of useReads) {
        if (!entry) continue;
        const {usePath, modPath, content: modContent} = entry;
        const parsed = parseGoMod(modContent);
        const modProjectDir = dirname(modPath);
        goModFiles.push({absPath: modPath, content: modContent, projectDir: modProjectDir, usePath});

        const typePrefix = usePath === "." ? "" : `|${usePath}`;
        for (const depType of dependencyTypes) {
          const obj = parsed[depType as keyof typeof parsed] || {};
          for (const [name, value] of Object.entries(obj)) {
            if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
              addDep(mode, depType, typePrefix, name, shortenGoVersion(value), stripv(value));
            }
          }
        }
      }

      for (const [name, value] of Object.entries(goWork.replace)) {
        if (canInclude(name, mode, modeInclude, modeExclude, "replace")) {
          addDep(mode, "replace", "", name, shortenGoVersion(value), stripv(value));
        }
      }

      numDependencies += Object.keys(deps[mode]).length;
      continue;
    }

    if (filename === "go.mod" && goWorkData) continue;
    if (filename === "package.json" && pnpmWorkspaceActive) continue;

    if (filename === "Cargo.toml") {
      deps[mode] ??= {};
      const cargoContent = fileContents.get(file)!;
      const cargoParsed = parseToml(cargoContent);
      const workspaceDir = dirname(resolve(file));
      filePerMode[mode] = file;

      const lockPath = findUpSync(["Cargo.lock"], workspaceDir).get("Cargo.lock");
      const wsMembers = (cargoParsed.workspace as Record<string, any>)?.members;
      const isWorkspace = Array.isArray(wsMembers) && wsMembers.length;

      const [filters, lockContent, members] = await Promise.all([
        resolveModeFilters(workspaceDir),
        lockPath ? readFile(lockPath, "utf8") : Promise.resolve(null),
        isWorkspace ? resolveWorkspaceMembers(wsMembers, workspaceDir, "Cargo.toml", concurrency) : Promise.resolve([] as WorkspaceMember[]),
      ]);
      const {modeConfig, modeInclude, modeExclude, pin} = filters;
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};
      const lockedVersions = lockContent ? parseCargoLock(lockContent) : new Map<string, string[]>();

      const collectCargoDeps = (parsed: Record<string, any>, typePrefix: string) => {
        for (const depType of dependencyTypes) {
          const obj = getProperty(parsed, depType) || {};
          if (typeof obj !== "object" || Array.isArray(obj)) continue;
          for (const [name, value] of Object.entries(obj)) {
            if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
            if (typeof value === "object" && value !== null && "version" in value && !("git" in value) && !("path" in value)) {
              const versionStr = String((value as Record<string, string>).version);
              if (validRange(versionStr)) {
                addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, name, versionStr) ?? normalizeRange(versionStr), versionStr);
              }
            } else if (typeof value === "string" && validRange(value)) {
              addDep(mode, depType, typePrefix, name, findLockedVersion(lockedVersions, name, value) ?? normalizeRange(value), value);
            }
          }
        }
      };

      if (isWorkspace) {
        cargoWorkspaceActive = true;
        collectCargoDeps(cargoParsed, "");
        cargoMemberFiles.push({absPath: resolve(file), content: cargoContent, memberPath: "."});
        for (const member of members) {
          cargoMemberFiles.push(member);
          try {
            collectCargoDeps(parseToml(member.content), `|${member.memberPath}`);
          } catch (err) {
            throw new Error(`Error parsing ${member.absPath}: ${(err as Error).message}`);
          }
        }
      } else {
        pkgStrs[mode] = cargoContent;
        collectCargoDeps(cargoParsed, "");
      }

      numDependencies += Object.keys(deps[mode]).length;
      continue;
    }

    if (filename === "pnpm-workspace.yaml") {
      deps[mode] ??= {};
      const workspaceDir = dirname(resolve(file));
      const wsContent = fileContents.get(file)!;
      pnpmWorkspaceActive = true;
      const packagePatterns = parsePnpmWorkspace(wsContent);
      const rootPkgPath = join(workspaceDir, "package.json");

      const [filters, rootContent, members] = await Promise.all([
        resolveModeFilters(workspaceDir),
        readFile(rootPkgPath, "utf8").catch(() => null),
        resolveWorkspaceMembers(packagePatterns, workspaceDir, "package.json", concurrency),
      ]);
      const {modeConfig, modeInclude, modeExclude, pin} = filters;
      const dependencyTypes = resolveDepTypes(mode, modeConfig);
      filePerMode[mode] = file;
      modeConfigs[mode] = {modeConfig, projectDir: workspaceDir, pin};

      const collectNpmDeps = (pkg: Record<string, any>, typePrefix: string) => {
        for (const depType of dependencyTypes) {
          const obj: Record<string, string> | string = pkg[depType] || {};
          if (typeof obj === "string") {
            const [name, value] = obj.split("@");
            if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
              addDep(mode, depType, typePrefix, name, normalizeRange(value), value);
            }
          } else if (typeof obj === "object" && !Array.isArray(obj)) {
            for (const [name, value] of Object.entries(obj)) {
              if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
              if (isJsr(value)) {
                addDep(mode, depType, typePrefix, name, parseJsrDependency(value, name).version, value);
              } else if (validRange(value)) {
                addDep(mode, depType, typePrefix, name, normalizeRange(value), value);
              } else if (isLocalDep(value)) {
                addDep(mode, depType, typePrefix, name, "0.0.0", value);
              } else {
                maybeUrlDeps[`${depType}${typePrefix}${fieldSep}${name}`] = {old: value} as Dep;
              }
            }
          }
        }
      };

      if (rootContent !== null) {
        let rootPkg: Record<string, any>;
        try {
          rootPkg = JSON.parse(rootContent);
        } catch (err) {
          throw new Error(`Error parsing ${rootPkgPath}: ${(err as Error).message}`);
        }
        pnpmMemberFiles.push({absPath: resolve(rootPkgPath), content: rootContent, memberPath: "."});
        collectNpmDeps(rootPkg, "");
      }

      for (const member of members) {
        let memberPkg: Record<string, any>;
        try {
          memberPkg = JSON.parse(member.content);
        } catch (err) {
          throw new Error(`Error parsing ${member.absPath}: ${(err as Error).message}`);
        }
        pnpmMemberFiles.push(member);
        collectNpmDeps(memberPkg, `|${member.memberPath}`);
      }

      numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
      continue;
    }

    filePerMode[mode] = file;
    deps[mode] ??= {};

    const projectDir = dirname(resolve(file));
    const {modeConfig, modeInclude, modeExclude, pin} = await resolveModeFilters(projectDir);

    const dependencyTypes = resolveDepTypes(mode, modeConfig);

    let pkg: Record<string, any> = {};
    pkgStrs[mode] = fileContents.get(file)!;

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else if (mode === "pypi") {
        pkg = parseToml(pkgStrs[mode]);
      } else if (mode === "go") {
        const parsed = parseGoMod(pkgStrs[mode]);
        pkg.deps = parsed.deps;
        pkg.indirect = parsed.indirect;
        pkg.replace = parsed.replace;
        pkg.tool = parsed.tool;
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

      if (Array.isArray(obj) && mode === "pypi") {
        for (const {name, version} of parseUvDependencies(obj)) {
          if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
            addDep(mode, depType, "", name, normalizeRange(version), version);
          }
        }
      } else {
        if (typeof obj === "string") {
          const [name, value] = obj.split("@");
          if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
            addDep(mode, depType, "", name, normalizeRange(value), value);
          }
        } else {
          for (const [name, value] of Object.entries(obj)) {
            if (!canInclude(name, mode, modeInclude, modeExclude, depType)) continue;
            if (mode === "npm" && isJsr(value)) {
              addDep(mode, depType, "", name, parseJsrDependency(value, name).version, value);
            } else if (mode !== "go" && validRange(value)) {
              addDep(mode, depType, "", name, normalizeRange(value), value);
            } else if (mode === "npm" && isLocalDep(value)) {
              addDep(mode, depType, "", name, "0.0.0", value);
            } else if (mode === "npm") {
              maybeUrlDeps[`${depType}${fieldSep}${name}`] = {old: value} as Dep;
            } else if (mode === "go") {
              addDep(mode, depType, "", name, shortenGoVersion(value), stripv(value));
            }
          }
        }
      }
    }

    numDependencies += Object.keys(deps[mode]).length + Object.keys(maybeUrlDeps).length;
    modeConfigs[mode] = {modeConfig, projectDir, pin};
  }

  if (deps.actions) numDependencies += Object.keys(deps.actions).length;
  if (deps.docker) numDependencies += Object.keys(deps.docker).length;

  if (numDependencies === 0) {
    return {results: {}, message: "No dependencies found, nothing to do."};
  }

  // Fetch and process all modes in parallel
  const fetchTasks: Array<Promise<void>> = [];
  const argsForNpm = {registry: config.registry};

  for (const mode of Object.keys(modeConfigs)) {
    if (!deps[mode] || !Object.keys(deps[mode]).length && !Object.keys(maybeUrlDeps).length) continue;
    const {modeConfig, projectDir, pin} = modeConfigs[mode];
    fetchTasks.push((async () => {
      const npmFollowUps = new Map<string, {name: string, promise: Promise<{repository?: PackageRepository, homepage?: string, date?: string}>}>();
      const cooldownRaw = config.cooldown ?? modeConfig.cooldown;
      const cooldownDays = cooldownRaw ? parseDuration(String(cooldownRaw)) : 0;
      // Safety net for deps that bypass findNewVersion (URL tarballs, JSR
      // follow-ups). findNewVersion's per-version cooldown filter handles the
      // common case; this catches the rest.
      const dropIfTooNew = (modeDeps: Deps) => {
        if (!cooldownDays) return;
        for (const [k, {date}] of Object.entries(modeDeps)) {
          if (date && (now - Date.parse(date)) / 86400000 < cooldownDays) delete modeDeps[k];
        }
      };

      await pMap(Object.keys(deps[mode]), async (key) => {
        const [type, name] = key.split(fieldSep);
        const baseT = baseType(type);
        const dep = deps[mode][key];
        let info: PackageInfo | null = null;
        if (mode === "npm") {
          const {oldOrig} = dep;
          if (oldOrig && isJsr(oldOrig)) {
            info = await fetchJsrInfo(name, baseT, ctx);
          } else if (oldOrig && isLocalDep(oldOrig)) {
            try {
              info = await fetchNpmInfo(name, baseT, modeConfig, argsForNpm, ctx);
            } catch {
              delete deps[mode][key];
              return;
            }
          } else {
            info = await fetchNpmInfo(name, baseT, modeConfig, argsForNpm, ctx);
          }
        } else if (mode === "go") {
          info = await fetchGoProxyInfo(name, baseT, dep.oldOrig || dep.old, projectDir, ctx, goNoProxy);
        } else if (mode === "cargo") {
          info = await fetchCratesIoInfo(name, baseT, ctx);
        } else {
          info = await fetchPypiInfo(name, type, ctx);
        }
        if (!info) return;

        const [data, , registry] = info;
        if (data?.error) throw new Error(data.error);

        const {useGreatest, usePre, useRel, semvers} = getVersionOpts(data.name);
        const oldRange = dep.old;
        const oldOrig = dep.oldOrig;
        const pinnedRange = pin[name];
        const newVersion = findNewVersion(data, {
          usePre, useRel, useGreatest, semvers, range: oldRange, mode, pinnedRange,
          cooldownDays: cooldownDays || undefined, now: cooldownDays ? now : undefined,
        }, {allowDowngrade, matchesAny, isGoPseudoVersion});

        let newRange = "";
        if (["go", "pypi"].includes(mode) && newVersion) {
          newRange = newVersion;
        } else if (mode === "cargo" && newVersion && oldOrig) {
          newRange = updateCargoRange(oldOrig, newVersion);
        } else if (newVersion) {
          if (oldOrig && isLocalDep(oldOrig)) {
            newRange = String(getNpmrc()["save-exact"]) === "true" ? newVersion : `^${newVersion}`;
          } else if (oldOrig && isJsr(oldOrig)) {
            const match = /^(npm:@jsr\/[^@]+@|jsr:@[^@]+@)(.+)$/.exec(oldOrig);
            if (match) newRange = `${match[1]}${newVersion}`;
            else if (oldOrig.startsWith("jsr:")) newRange = `jsr:${newVersion}`;
          } else {
            newRange = updateVersionRange(oldRange, newVersion, oldOrig);
          }
        }

        if (!newVersion || newVersion === oldRange || oldOrig && (oldOrig === newRange)) {
          delete deps[mode][key];
          return;
        }

        let date = "";
        if (mode === "pypi" && data.releases?.[newVersion]?.[0]?.upload_time_iso_8601) {
          date = data.releases[newVersion][0].upload_time_iso_8601;
        } else if (mode === "go" && data.Time) {
          date = data.Time;
        } else if (mode === "cargo" && data.time?.[newVersion]) {
          date = data.time[newVersion];
        }

        dep.new = newRange;
        if (oldOrig && isJsr(oldOrig)) dep.newPrint = newVersion;

        if (mode === "npm") {
          npmFollowUps.set(key, {name, promise: fetchNpmVersionInfo(data.name, newVersion, modeConfig, argsForNpm, ctx)});
        } else if (mode === "pypi") {
          dep.info = getInfoUrl(data, registry, data.info.name);
        } else if (mode === "go") {
          dep.info = getGoInfoUrl(data.newPath || name);
        } else if (mode === "cargo") {
          dep.info = `https://crates.io/crates/${name}`;
        }

        if (date) setDepAge(dep, date);
      }, {concurrency});

      await Promise.all(Array.from(npmFollowUps, async ([key, {name, promise}]) => {
        const followUp = await promise;
        const dep = deps[mode][key];
        if (!dep) return;
        dep.info = getInfoUrl({repository: followUp.repository, homepage: followUp.homepage}, null, name);
        if (followUp.date) setDepAge(dep, followUp.date);
      }));

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
          };
          if (newDate) setDepAge(deps[mode][key], newDate);
        }
      }

      dropIfTooNew(deps[mode]);
    })());
  }

  // Actions fetch task
  if (actionDepInfos.length) {
    fetchTasks.push((async () => {
      const depsByRepo = new Map<string, {apiUrl: string, owner: string, repo: string, infos: Array<ActionDepInfo>}>();
      for (const info of actionDepInfos) {
        const repoKey = `${info.apiUrl}/${info.owner}/${info.repo}`;
        let entry = depsByRepo.get(repoKey);
        if (!entry) depsByRepo.set(repoKey, entry = {apiUrl: info.apiUrl, owner: info.owner, repo: info.repo, infos: []});
        entry.infos.push(info);
      }

      const actionsCooldownDays = config.cooldown ? parseDuration(String(config.cooldown)) : 0;

      await pMap(depsByRepo.values(), async ({apiUrl, owner, repo, infos}) => {
        const tags = await fetchActionTags(apiUrl, owner, repo, ctx);
        const versions: string[] = [];
        const tagByStripped = new Map<string, string>();
        const entryByName = new Map<string, TagEntry>();
        const commitShaToTag = new Map<string, string>();
        for (const tag of tags) {
          entryByName.set(tag.name, tag);
          const bare = stripv(tag.name);
          if (valid(bare)) {
            versions.push(bare);
            if (!tagByStripped.has(bare)) tagByStripped.set(bare, tag.name);
          }
          if (tag.commitSha) commitShaToTag.set(tag.commitSha, tag.name);
        }

        const dateCache = new Map<string, string>();
        async function getDate(commitSha: string): Promise<string> {
          if (dateCache.has(commitSha)) return dateCache.get(commitSha)!;
          const date = await fetchActionTagDate(apiUrl, owner, repo, commitSha, ctx);
          dateCache.set(commitSha, date);
          return date;
        }

        // Cooldown-aware selection: when cooldown is active, pick the highest
        // version, fetch its commit date, and if it's too new, exclude it and
        // retry. Bounded loop avoids pathological cases (e.g. all versions
        // released within the cooldown window).
        async function pickVersion(opts: Parameters<typeof findVersion>[2]): Promise<{version: string, tag: string, commitSha: string, date: string} | null> {
          const denylist = new Set<string>();
          for (let attempt = 0; attempt < 20; attempt++) {
            const candidates = denylist.size ? versions.filter(v => !denylist.has(v)) : versions;
            const picked = findVersion({}, candidates, opts);
            if (!picked || picked === opts.range) return null;
            const tag = tagByStripped.get(picked);
            if (!tag) { denylist.add(picked); continue; }
            const commitSha = entryByName.get(tag)?.commitSha || "";
            if (!actionsCooldownDays) return {version: picked, tag, commitSha, date: ""};
            const date = commitSha ? await getDate(commitSha) : "";
            if (passesCooldown(date, actionsCooldownDays, now)) return {version: picked, tag, commitSha, date};
            denylist.add(picked);
          }
          return null;
        }

        await pMap(infos, async ({key, host, ref, name: actionName, isHash}) => {
          const dep = deps.actions[key];
          const infoUrl = `https://${host || "github.com"}/${owner}/${repo}`;

          if (isHash) {
            const {usePre, useRel} = getVersionOpts(actionName);
            const result = await pickVersion({
              range: "0.0.0", semvers: new Set(["patch", "minor", "major"]), usePre, useRel,
              useGreatest: true, pinnedRange: configPin[actionName],
            });
            if (!result) { delete deps.actions[key]; return; }

            const {tag: newTag, commitSha: newCommitSha, date} = result;
            if (!newCommitSha || newCommitSha === ref || newCommitSha.startsWith(ref) || ref.startsWith(newCommitSha)) {
              delete deps.actions[key]; return;
            }

            let oldTagName = commitShaToTag.get(ref);
            if (!oldTagName) {
              for (const [sha, name] of commitShaToTag) {
                if (sha.startsWith(ref)) { oldTagName = name; break; }
              }
            }
            dep.old = ref;
            dep.new = newCommitSha.substring(0, ref.length);
            dep.oldPrint = oldTagName || ref.substring(0, 7);
            dep.newPrint = newTag;
            dep.info = infoUrl;
            if (date) setDepAge(dep, date);
          } else {
            const coerced = coerceToVersion(stripv(ref));
            if (!coerced) { delete deps.actions[key]; return; }

            const {useGreatest, usePre, useRel, semvers} = getVersionOpts(actionName);
            const result = await pickVersion({
              range: coerced, semvers, usePre, useRel,
              useGreatest: useGreatest || true, pinnedRange: configPin[actionName],
            });
            if (!result) { delete deps.actions[key]; return; }

            const {tag: newTag, commitSha: newCommitSha, date} = result;
            const formatted = formatActionVersion(newTag, ref);
            if (formatted === ref) { delete deps.actions[key]; return; }

            dep.new = entryByName.has(formatted) ? formatted : newTag;
            dep.info = infoUrl;
            if (newCommitSha && date) setDepAge(dep, date);
            else if (newCommitSha) {
              const fetched = await getDate(newCommitSha);
              if (fetched) setDepAge(dep, fetched);
            }
          }
        }, {concurrency});
      }, {concurrency});

      if (!Object.keys(deps.actions).length) delete deps.actions;
    })());
  }

  // Docker fetch task
  if (dockerDepInfos.length) {
    fetchTasks.push((async () => {
      const depsByImage = new Map<string, Array<DockerDepInfo>>();
      for (const info of dockerDepInfos) {
        let list = depsByImage.get(info.fullImage);
        if (!list) depsByImage.set(info.fullImage, list = []);
        list.push(info);
      }

      const dockerCooldownDays = config.cooldown ? parseDuration(String(config.cooldown)) : 0;

      await pMap(depsByImage.entries(), async ([fullImage, infos]) => {
        let data: Record<string, any>;
        try {
          const [fetchedData] = await fetchDockerInfo(fullImage, "docker", ctx);
          data = fetchedData;
        } catch {
          for (const info of infos) delete deps.docker[info.key];
          return;
        }

        for (const info of infos) {
          const dep = deps.docker[info.key];
          const oldTag = dep.oldOrig || dep.old;
          const {semvers} = getVersionOpts(info.fullImage);
          const result = findDockerVersion(
            data.tags, oldTag, semvers,
            dockerCooldownDays || undefined, dockerCooldownDays ? now : undefined,
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

  await Promise.all(fetchTasks);

  if (!countDeps(deps)) {
    return {results: {}, message: "All dependencies are up to date."};
  }

  // Handle --update: write files
  if (config.update) {
    const updateMembers = (m: string, members: WorkspaceMember[], updateFn: (content: string, deps: Deps) => string) => {
      for (const member of members) {
        const localDeps = filterDepsForMember(deps[m], member.memberPath);
        if (!Object.keys(localDeps).length) continue;
        write(member.absPath, updateFn(member.content, localDeps));
      }
    };
    // Pre-build update data before buildOutput modifies dep values
    const actionsUpdatesByRelPath = new Map<string, Array<{name: string, oldRef: string, newRef: string}>>();
    if (deps.actions) {
      for (const [key, dep] of Object.entries(deps.actions)) {
        const [relPath, name] = key.split(fieldSep);
        let list = actionsUpdatesByRelPath.get(relPath);
        if (!list) actionsUpdatesByRelPath.set(relPath, list = []);
        list.push({name, oldRef: dep.old, newRef: dep.new});
      }
    }

    const dockerUpdatesByRelPath = new Map<string, Deps>();
    if (deps.docker) {
      for (const [key, dep] of Object.entries(deps.docker)) {
        const [relPath] = key.split(fieldSep);
        let map = dockerUpdatesByRelPath.get(relPath);
        if (!map) dockerUpdatesByRelPath.set(relPath, map = {});
        map[key] = dep;
      }
    }

    const output = buildOutput(deps);

    for (const mode of Object.keys(deps)) {
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

      const fileContent = pkgStrs[mode];
      if (mode === "go" && goWorkData) {
        for (const goMod of goModFiles) {
          const localDeps = filterDepsForMember(deps[mode], goMod.usePath);
          if (!Object.keys(localDeps).length) continue;
          const [updatedContent, majorVersionRewrites] = updateGoMod(goMod.content, localDeps);
          if (updatedContent !== goMod.content) write(goMod.absPath, updatedContent);
          rewriteGoImports(goMod.projectDir, majorVersionRewrites, write);
        }
        const workDeps: Deps = {};
        for (const [key, dep] of Object.entries(deps[mode])) {
          if (key.split(fieldSep)[0] === "replace") workDeps[key] = dep;
        }
        if (Object.keys(workDeps).length) {
          const [updatedWork] = updateGoMod(goWorkData.content, workDeps);
          if (updatedWork !== goWorkData.content) write(goWorkData.file, updatedWork);
        }
      } else if (mode === "go") {
        const [updatedContent, majorVersionRewrites] = updateGoMod(fileContent, deps[mode]);
        write(filePerMode[mode], updatedContent);
        rewriteGoImports(dirname(resolve(filePerMode[mode])), majorVersionRewrites, write);
      } else if (mode === "cargo" && cargoWorkspaceActive) {
        updateMembers(mode, cargoMemberFiles, updateCargoToml);
      } else if (mode === "cargo") {
        write(filePerMode[mode], updateCargoToml(fileContent, deps[mode]));
      } else if (mode === "npm" && pnpmWorkspaceActive) {
        updateMembers(mode, pnpmMemberFiles, updatePackageJson);
      } else {
        const fn = (mode === "npm") ? updatePackageJson : updatePyprojectToml;
        write(filePerMode[mode], fn(fileContent, deps[mode]));
      }
    }

    return output;
  }

  return buildOutput(deps);
}
