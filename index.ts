import {cwd, platform, stderr} from "node:process";
import {styleText} from "node:util";
import {join, dirname, basename, resolve} from "node:path";
import {lstatSync, readFileSync, readdirSync, truncateSync, writeFileSync, accessSync, type Stats} from "node:fs";
import {parseToml} from "./utils/toml.ts";
import {valid, validRange} from "./utils/semver.ts";
import {timerel} from "timerel";
import {npmTypes, uvTypes, goTypes, cargoTypes, parseUvDependencies, nonPackageEngines, parseDuration, matchesAny, getProperty, canIncludeByDate, timestamp, pMap} from "./utils/utils.ts";
import {enableDnsCache} from "./utils/dns.ts";
import {
  type Dep, type Deps, type DepsByMode, type Output, type ModeContext,
  type PackageRepository, type PackageInfo,
  fieldSep, normalizeUrl, fetchTimeout, goProbeTimeout,
  doFetch, findVersion, findNewVersion, coerceToVersion, getInfoUrl,
  stripv, hashRe as npmHashRe,
} from "./modes/shared.ts";
import {loadConfig, configMixedToRegexes, patternsToRegexSet} from "./config.ts";
import type {Config} from "./config.ts";
import {
  fetchNpmInfo, fetchNpmVersionInfo, fetchJsrInfo, isJsr, isLocalDep, parseJsrDependency,
  getNpmrc, updatePackageJson, updateNpmRange, normalizeRange, checkUrlDep,
} from "./modes/npm.ts";
import {fetchPypiInfo, updatePyprojectToml} from "./modes/pypi.ts";
import {
  resolveGoProxy, parseGoNoProxy, isGoPseudoVersion,
  parseGoMod, fetchGoProxyInfo, updateGoMod, rewriteGoImports,
  getGoInfoUrl, shortenGoVersion,
} from "./modes/go.ts";
import {
  type ActionRef,
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
import {fetchCratesIoInfo, updateCargoToml} from "./modes/cargo.ts";

export type {Config, Dep, Deps, DepsByMode, Output};

const modeByFileName: Record<string, string> = {
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "go.mod": "go",
  "Cargo.toml": "cargo",
};

const defaultModes = new Set(["npm", "pypi", "go", "cargo", "actions", "docker"]);

function findUpSync(filename: string, dir: string): string | null {
  const path = join(dir, filename);
  try { accessSync(path); return path; } catch {}
  const parent = dirname(dir);
  return parent === dir ? null : findUpSync(filename, parent);
}

function readFileOrThrow(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Unable to open ${file}: ${(err as Error).message}`);
  }
}

function setDepAge(dep: Dep, date: string): void {
  if (date) {
    dep.date = date;
    dep.age = timerel(date, {noAffix: true});
  }
}

function applyCooldown(modeDeps: Deps, cooldown: string | number, now: number): void {
  const days = parseDuration(String(cooldown));
  for (const [key, {date}] of Object.entries(modeDeps)) {
    if (!canIncludeByDate(date, days, now)) {
      delete modeDeps[key];
    }
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
          for (const entry of readdirSync(file)) {
            if (isDockerFileName(entry)) {
              const f = join(file, entry);
              try { if (lstatSync(f).isFile()) resolvedFiles.add(resolve(f)); } catch {}
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
    for (const filename of Object.keys(modeByFileName)) {
      const file = findUpSync(filename, cwd());
      if (file) resolvedFiles.add(resolve(file));
    }
    for (const filename of dockerExactFileNames) {
      const file = findUpSync(filename, cwd());
      if (file) resolvedFiles.add(resolve(file));
    }
    try {
      for (const entry of readdirSync(cwd())) {
        if (isDockerFileName(entry) && !dockerExactFileNames.includes(entry)) {
          const f = join(cwd(), entry);
          try { if (lstatSync(f).isFile()) resolvedFiles.add(resolve(f)); } catch {}
        }
      }
    } catch {}
    const workflowDir = findUpSync(join(".github", "workflows"), cwd());
    if (workflowDir) {
      for (const wf of resolveWorkflowFiles(workflowDir)) resolvedFiles.add(wf);
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
  for (const mode of Object.keys(deps)) {
    for (const props of Object.values(deps[mode])) {
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
    }
  }

  const output: Output = {results: {}};
  for (const mode of Object.keys(deps)) {
    for (const [key, value] of Object.entries(deps[mode])) {
      const [type, name] = key.split(fieldSep);
      if (!output.results[mode]) output.results[mode] = {};
      if (!output.results[mode][type]) output.results[mode][type] = {};
      output.results[mode][type][name] = value;
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
    enableDnsCache();
    dnsCacheEnabled = true;
  }

  const config: Config = {...opts};

  const maxSockets = 25;
  const concurrency = config.sockets ?? maxSockets;
  const userTimeout = config.timeout ?? 0;
  const forgeApiUrl = typeof opts.forgeapi === "string" ? normalizeUrl(opts.forgeapi) : "https://api.github.com";
  const pypiApiUrl = typeof opts.pypiapi === "string" ? normalizeUrl(opts.pypiapi) : "https://pypi.org";
  const jsrApiUrl = typeof opts.jsrapi === "string" ? normalizeUrl(opts.jsrapi) : "https://jsr.io";
  const goProxyUrl = typeof opts.goproxy === "string" ? normalizeUrl(opts.goproxy) : resolveGoProxy();
  const cratesIoUrl = typeof opts.cargoapi === "string" ? normalizeUrl(opts.cargoapi) : "https://crates.io";
  const dockerApiUrl = typeof opts.dockerapi === "string" ? normalizeUrl(opts.dockerapi) : "https://hub.docker.com";
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
    doFetch: (url: string, fetchOpts?: RequestInit) => doFetch(url, fetchOpts, Boolean(config.verbose), logVerbose, magenta, vGreen, vRed),
    verbose: Boolean(config.verbose),
    noCache: Boolean(config.noCache),
  };

  const greatest = configMixedToRegexes(config.greatest);
  const prerelease = configMixedToRegexes(config.prerelease);
  const release = configMixedToRegexes(config.release);
  const patch = configMixedToRegexes(config.patch);
  const minor = configMixedToRegexes(config.minor);
  const allowDowngrade = configMixedToRegexes(config.allowDowngrade);
  const enabledModes = config.modes?.length ? new Set(config.modes) : defaultModes;

  function getSemvers(name: string): Set<string> {
    if (patch === true || matchesAny(name, patch)) return new Set<string>(["patch"]);
    if (minor === true || matchesAny(name, minor)) return new Set<string>(["patch", "minor"]);
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

  const include = patternsToRegexSet(config.include ?? []);
  const exclude = patternsToRegexSet(config.exclude ?? []);
  const configPin: Record<string, string> = config.pin ?? {};

  const deps: DepsByMode = {};
  const maybeUrlDeps: Deps = {};
  const pkgStrs: Record<string, string> = {};
  const filePerMode: Record<string, string> = {};
  const now = Date.now();
  let numDependencies = 0;

  const files = resolveFiles(config.files?.length ? new Set(config.files) : false);

  const wfData: Record<string, {absPath: string, content: string}> = {};
  const dockerFileData: Record<string, {absPath: string, content: string, fileType: string}> = {};

  type ActionDepInfo = ActionRef & {key: string, apiUrl: string};
  const actionDepInfos: Array<ActionDepInfo> = [];
  type DockerDepInfo = {key: string, fullImage: string, ref: DockerImageRef};
  const dockerDepInfos: Array<DockerDepInfo> = [];
  type ModeCtx = {modeConfig: Config, projectDir: string, pin: Record<string, string>};
  const modeConfigs: Record<string, ModeCtx> = {};

  function collectDockerRefs(content: string, relPath: string, regexes: Array<RegExp>): void {
    if (!deps.docker) deps.docker = {};
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

      const content = readFileOrThrow(file);
      const relPath = toRelPath(file);
      wfData[relPath] = {absPath: file, content};

      if (actionsEnabled) {
        if (!deps.actions) deps.actions = {};
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
      const content = readFileOrThrow(file);
      const relPath = toRelPath(file);
      const fileType = isDockerfile(filename) ? "dockerfile" : "compose";
      dockerFileData[relPath] = {absPath: file, content, fileType};
      collectDockerRefs(content, relPath, [getExtractionRegex(filename)]);
      continue;
    }

    const mode = modeByFileName[filename];
    if (!enabledModes.has(mode)) continue;
    filePerMode[mode] = file;
    if (!deps[mode]) deps[mode] = {};

    const projectDir = dirname(resolve(file));
    const modeConfig = projectDir === cwd() ? config : await loadConfig(projectDir);

    const modeInclude = modeConfig !== config && modeConfig?.include ? patternsToRegexSet([...(config.include ?? []), ...modeConfig.include]) : include;
    const modeExclude = modeConfig !== config && modeConfig?.exclude ? patternsToRegexSet([...(config.exclude ?? []), ...modeConfig.exclude]) : exclude;
    const pin: Record<string, string> = {...modeConfig?.pin, ...configPin};

    let dependencyTypes: Array<string> = [];
    if (config.types?.length) {
      dependencyTypes = config.types;
    } else if (modeConfig?.types?.length) {
      dependencyTypes = modeConfig.types;
    } else {
      if (mode === "npm") {
        dependencyTypes = npmTypes;
      } else if (mode === "pypi") {
        dependencyTypes = Array.from(uvTypes);
      } else if (mode === "go") {
        dependencyTypes = config.indirect ? Array.from(goTypes) : goTypes.filter(t => t !== "indirect");
      } else if (mode === "cargo") {
        dependencyTypes = Array.from(cargoTypes);
      }
    }

    let pkg: Record<string, any> = {};
    pkgStrs[mode] = readFileOrThrow(file);

    try {
      if (mode === "npm") {
        pkg = JSON.parse(pkgStrs[mode]);
      } else if (mode === "pypi" || mode === "cargo") {
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
            deps[mode][`${depType}${fieldSep}${name}`] = {old: normalizeRange(version), oldOrig: version} as Dep;
          }
        }
      } else {
        if (typeof obj === "string") {
          const [name, value] = obj.split("@");
          if (canInclude(name, mode, modeInclude, modeExclude, depType)) {
            deps[mode][`${depType}${fieldSep}${name}`] = {old: normalizeRange(value), oldOrig: value} as Dep;
          }
        } else {
          for (const [name, value] of Object.entries(obj)) {
            if (mode === "cargo" && typeof value === "object" && value !== null && "version" in value && !("git" in value) && !("path" in value) && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              const versionStr = String((value as Record<string, string>).version);
              if (validRange(versionStr)) {
                deps[mode][`${depType}${fieldSep}${name}`] = {old: normalizeRange(versionStr), oldOrig: versionStr} as Dep;
              }
            } else if (mode === "npm" && isJsr(value) && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              const parsed = parseJsrDependency(value, name);
              deps[mode][`${depType}${fieldSep}${name}`] = {old: parsed.version, oldOrig: value} as Dep;
            } else if (mode !== "go" && validRange(value) && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              deps[mode][`${depType}${fieldSep}${name}`] = {old: normalizeRange(value), oldOrig: value} as Dep;
            } else if (mode === "npm" && isLocalDep(value) && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              deps[mode][`${depType}${fieldSep}${name}`] = {old: "0.0.0", oldOrig: value} as Dep;
            } else if (mode === "npm" && !isJsr(value) && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              maybeUrlDeps[`${depType}${fieldSep}${name}`] = {old: value} as Dep;
            } else if (mode === "go" && canInclude(name, mode, modeInclude, modeExclude, depType)) {
              deps[mode][`${depType}${fieldSep}${name}`] = {old: shortenGoVersion(value), oldOrig: stripv(value)} as Dep;
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

      await pMap(Object.keys(deps[mode]), async (key) => {
        const [type, name] = key.split(fieldSep);
        let info: PackageInfo | null = null;
        if (mode === "npm") {
          const {oldOrig} = deps[mode][key];
          if (oldOrig && isJsr(oldOrig)) {
            info = await fetchJsrInfo(name, type, ctx);
          } else if (oldOrig && isLocalDep(oldOrig)) {
            try {
              info = await fetchNpmInfo(name, type, modeConfig, argsForNpm, ctx);
            } catch {
              delete deps[mode][key];
              return;
            }
          } else {
            info = await fetchNpmInfo(name, type, modeConfig, argsForNpm, ctx);
          }
        } else if (mode === "go") {
          info = await fetchGoProxyInfo(name, type, deps[mode][key].oldOrig || deps[mode][key].old, projectDir, ctx, goNoProxy);
        } else if (mode === "cargo") {
          info = await fetchCratesIoInfo(name, type, ctx);
        } else {
          info = await fetchPypiInfo(name, type, ctx);
        }
        if (!info) return;

        const [data, , registry] = info;
        if (data?.error) throw new Error(data.error);

        const {useGreatest, usePre, useRel, semvers} = getVersionOpts(data.name);
        const oldRange = deps[mode][key].old;
        const oldOrig = deps[mode][key].oldOrig;
        const pinnedRange = pin[name];
        const newVersion = findNewVersion(data, {
          usePre, useRel, useGreatest, semvers, range: oldRange, mode, pinnedRange,
        }, {allowDowngrade, matchesAny, isGoPseudoVersion});

        let newRange = "";
        if (["go", "pypi", "cargo"].includes(mode) && newVersion) {
          newRange = newVersion;
        } else if (newVersion) {
          if (oldOrig && isLocalDep(oldOrig)) {
            newRange = String(getNpmrc()["save-exact"]) === "true" ? newVersion : `^${newVersion}`;
          } else if (oldOrig && isJsr(oldOrig)) {
            if (oldOrig.startsWith("npm:@jsr/")) {
              const match = /^(npm:@jsr\/[^@]+@)(.+)$/.exec(oldOrig);
              if (match) newRange = `${match[1]}${newVersion}`;
            } else if (oldOrig.startsWith("jsr:@")) {
              const match = /^(jsr:@[^@]+@)(.+)$/.exec(oldOrig);
              if (match) newRange = `${match[1]}${newVersion}`;
            } else if (oldOrig.startsWith("jsr:")) {
              newRange = `jsr:${newVersion}`;
            }
          } else {
            newRange = updateNpmRange(oldRange, newVersion, oldOrig);
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

        deps[mode][key].new = newRange;
        if (oldOrig && isJsr(oldOrig)) deps[mode][key].newPrint = newVersion;

        if (mode === "npm") {
          npmFollowUps.set(key, {name, promise: fetchNpmVersionInfo(data.name, newVersion, modeConfig, argsForNpm, ctx)});
        } else if (mode === "pypi") {
          deps[mode][key].info = getInfoUrl(data as {repository: PackageRepository, homepage: string, info: Record<string, any>}, registry, data.info.name);
        } else if (mode === "go") {
          deps[mode][key].info = getGoInfoUrl(data.newPath || name);
        } else if (mode === "cargo") {
          deps[mode][key].info = `https://crates.io/crates/${name}`;
        }

        if (date) setDepAge(deps[mode][key], date);
      }, {concurrency});

      for (const [key, {name, promise}] of npmFollowUps) {
        const followUp = await promise;
        if (!deps[mode][key]) continue;
        deps[mode][key].info = getInfoUrl({repository: followUp.repository, homepage: followUp.homepage}, null, name);
        if (followUp.date) setDepAge(deps[mode][key], followUp.date);
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
          };
          if (newDate) setDepAge(deps[mode][key], newDate);
        }
      }

      const cooldown = config.cooldown ?? modeConfig.cooldown;
      if (cooldown) applyCooldown(deps[mode], String(cooldown), now);
    })());
  }

  // Actions fetch task
  if (actionDepInfos.length) {
    fetchTasks.push((async () => {
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

        const dateFetches: Array<{key: string, commitSha: string}> = [];

        for (const info of infos) {
          const dep = deps.actions[info.key];
          const infoUrl = `https://${info.host || "github.com"}/${owner}/${repo}`;

          if (info.isHash) {
            const {usePre, useRel} = getVersionOpts(info.name);
            const newVersion = findVersion({}, versions, {
              range: "0.0.0", semvers: new Set(["patch", "minor", "major"]), usePre, useRel,
              useGreatest: true, pinnedRange: configPin[info.name],
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

            dateFetches.push({key: info.key, commitSha: newCommitSha});
          } else {
            const coerced = coerceToVersion(stripv(info.ref));
            if (!coerced) { delete deps.actions[info.key]; continue; }

            const {useGreatest, usePre, useRel, semvers} = getVersionOpts(info.name);
            const newVersion = findVersion({}, versions, {
              range: coerced, semvers, usePre, useRel,
              useGreatest: useGreatest || true, pinnedRange: configPin[info.name],
            });
            if (!newVersion || newVersion === coerced) { delete deps.actions[info.key]; continue; }

            const newTag = tagNames.find(t => stripv(t) === newVersion);
            if (!newTag) { delete deps.actions[info.key]; continue; }

            const formatted = formatActionVersion(newTag, info.ref);
            if (formatted === info.ref) { delete deps.actions[info.key]; continue; }

            dep.new = tagNames.includes(formatted) ? formatted : newTag;
            dep.info = infoUrl;

            const newEntry = tags.find(t => t.name === newTag);
            if (newEntry?.commitSha) {
              dateFetches.push({key: info.key, commitSha: newEntry.commitSha});
            }
          }
        }

        const dates = await Promise.all(dateFetches.map(({commitSha}) => getDate(commitSha)));
        for (const [idx, {key}] of dateFetches.entries()) {
          const dep = deps.actions[key];
          if (dep && dates[idx]) setDepAge(dep, dates[idx]);
        }
      }, {concurrency});

      if (config.cooldown) applyCooldown(deps.actions, String(config.cooldown), now);
      if (!Object.keys(deps.actions).length) delete deps.actions;
    })());
  }

  // Docker fetch task
  if (dockerDepInfos.length) {
    fetchTasks.push((async () => {
      const depsByImage = new Map<string, Array<DockerDepInfo>>();
      for (const info of dockerDepInfos) {
        if (!depsByImage.has(info.fullImage)) depsByImage.set(info.fullImage, []);
        depsByImage.get(info.fullImage)!.push(info);
      }

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
          const result = findDockerVersion(data.tags, oldTag, semvers);
          if (!result) { delete deps.docker[info.key]; continue; }

          dep.new = result.newTag;
          dep.info = getDockerInfoUrl(info.ref);
          setDepAge(dep, result.date);
        }
      }, {concurrency});

      if (config.cooldown) applyCooldown(deps.docker, String(config.cooldown), now);
      if (!Object.keys(deps.docker).length) delete deps.docker;
    })());
  }

  await Promise.all(fetchTasks);

  if (!countDeps(deps)) {
    return {results: {}, message: "All dependencies are up to date."};
  }

  // Handle --update: write files
  if (config.update) {
    // Pre-build update data before buildOutput modifies dep values
    const actionsUpdatesByRelPath = new Map<string, Array<{name: string, oldRef: string, newRef: string}>>();
    if (deps.actions) {
      for (const [key, dep] of Object.entries(deps.actions)) {
        const [relPath, name] = key.split(fieldSep);
        if (!actionsUpdatesByRelPath.has(relPath)) actionsUpdatesByRelPath.set(relPath, []);
        actionsUpdatesByRelPath.get(relPath)!.push({name, oldRef: dep.old, newRef: dep.new});
      }
    }

    const dockerUpdatesByRelPath = new Map<string, Deps>();
    if (deps.docker) {
      for (const [key, dep] of Object.entries(deps.docker)) {
        const [relPath] = key.split(fieldSep);
        if (!dockerUpdatesByRelPath.has(relPath)) dockerUpdatesByRelPath.set(relPath, {});
        dockerUpdatesByRelPath.get(relPath)![key] = dep;
      }
    }

    const output = buildOutput(deps);

    for (const mode of Object.keys(deps)) {
      if (!Object.keys(deps[mode]).length) continue;

      if (mode === "actions") {
        for (const [relPath, actionDeps] of actionsUpdatesByRelPath) {
          const {absPath, content} = wfData[relPath] || {};
          if (!absPath) continue;
          write(absPath, updateWorkflowFile(content, actionDeps));
        }
        continue;
      }

      if (mode === "docker") {
        for (const [relPath, dockerDeps] of dockerUpdatesByRelPath) {
          const fileInfo = dockerFileData[relPath];
          if (!fileInfo) continue;
          const {absPath, fileType} = fileInfo;
          let content: string;
          try { content = readFileSync(absPath, "utf8"); } catch { continue; }
          const updateFn = fileType === "dockerfile" ? updateDockerfile :
            fileType === "compose" ? updateComposeFile : updateWorkflowDockerImages;
          write(absPath, updateFn(content, dockerDeps));
        }
        continue;
      }

      const fileContent = pkgStrs[mode];
      if (mode === "go") {
        const [updatedContent, majorVersionRewrites] = updateGoMod(fileContent, deps[mode]);
        write(filePerMode[mode], updatedContent);
        rewriteGoImports(dirname(resolve(filePerMode[mode])), majorVersionRewrites, write);
      } else if (mode === "cargo") {
        write(filePerMode[mode], updateCargoToml(fileContent, deps[mode]));
      } else {
        const fn = (mode === "npm") ? updatePackageJson : updatePyprojectToml;
        write(filePerMode[mode], fn(fileContent, deps[mode]));
      }
    }

    return output;
  }

  return buildOutput(deps);
}
