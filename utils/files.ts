import {execFile} from "node:child_process";
import {lstatSync, readdirSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {promisify} from "node:util";
import {braceAlternatives, closingIndex, esc, forgeDirs, getOrSet, modeByFileName} from "./utils.ts";
import {isWorkflowFile} from "../modes/actions.ts";
import {isDockerFileName} from "../modes/docker.ts";
import {isMakeFileName} from "../modes/make.ts";

const execFileAsync = promisify(execFile);
const forgeDirNames = new Set<string>(forgeDirs);

/** renovate's `:ignoreModulesAndTests` preset from its `config:recommended` */
export const defaultExcludePaths = [
  "**/node_modules/**",
  "**/bower_components/**",
  "**/vendor/**",
  "**/examples/**",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/__fixtures__/**",
];

export type PathFilters = {includePaths: Array<string>, excludePaths: Array<string>};

function pathGlobSource(glob: string): string { // minimatch with `dot: true`, as renovate matches paths
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    const closing = char === "{" ? closingIndex(glob, index, "{", "}") : char === "[" ? glob.indexOf("]", index) : -1;
    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";
      index += slash ? 2 : 1;
      source += slash ? "(?:.*/)?" : ".*";
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{" && closing !== -1) {
      source += `(?:${braceAlternatives(glob.slice(index + 1, closing)).map(pathGlobSource).join("|")})`;
      index = closing;
    } else if (char === "[" && closing !== -1) {
      source += `[${glob.slice(index + 1, closing).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      index = closing;
    } else {
      source += esc(char);
    }
  }
  return source;
}

const pathGlobs = new Map<string, RegExp>();
const pathGlobRegex = (glob: string) => getOrSet(pathGlobs, glob, () => new RegExp(`^${pathGlobSource(glob)}$`));

/** renovate's `includePaths` and `ignorePaths` matching on a `/`-separated path */
export function passesPathFilters(path: string, {includePaths, excludePaths}: PathFilters): boolean {
  if (includePaths.length && includePaths.every(glob => path !== glob && !pathGlobRegex(glob).test(path))) return false;
  return excludePaths.every(glob => !path.includes(glob) && !pathGlobRegex(glob).test(path));
}

export function isDependencyFile(path: string): boolean {
  const filename = basename(path);
  return Object.hasOwn(modeByFileName, filename) || isDockerFileName(filename) || isMakeFileName(filename) ||
    isWorkflowFile(path);
}

async function gitFiles(root: string): Promise<Array<string> | null> {
  try {
    return (await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root, maxBuffer: 2 ** 30,
    })).stdout.split("\0");
  } catch {
    return null;
  }
}

function ownFiles(root: string): Array<string> { // the directory's own files and those of its forge directories
  try {
    if (root.split(/[\\/]/).some(segment => forgeDirNames.has(segment))) return readdirSync(root, {recursive: true, encoding: "utf8"});
    return readdirSync(root, {withFileTypes: true}).flatMap(entry => entry.isDirectory() && forgeDirNames.has(entry.name) ?
      readdirSync(join(root, entry.name), {recursive: true, encoding: "utf8"}).map(path => join(entry.name, path)) : [entry.name]);
  } catch {
    return [];
  }
}

/** Dependency files below `root`, shallowest first. An explicit root's own files count even when gitignored */
export async function discoverFiles(root: string, filters: PathFilters, explicit: boolean): Promise<Array<string>> {
  const listed = await gitFiles(root);
  const files: Array<string> = [];
  for (const path of [...listed ?? [], ...explicit || !listed ? ownFiles(root) : []]) {
    const file = resolve(root, path);
    if (isDependencyFile(file) && passesPathFilters(path.replaceAll("\\", "/"), filters) &&
      lstatSync(file, {throwIfNoEntry: false})?.isFile()) files.push(file); // skips symlinks, submodules and deleted files
  }
  return files.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
}
