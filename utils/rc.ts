import {readFileSync, statSync} from "node:fs";
import {join, dirname} from "node:path";
import {env, platform, cwd} from "node:process";

function parseIni(content: string): Record<string, string> {
  if (/^\s*\{/.test(content)) {
    return JSON.parse(content);
  }
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
  return result;
}

function readConfigFile(filePath: string): Record<string, string> | undefined {
  try {
    return parseIni(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function findUp(filename: string): string | undefined {
  let dir = cwd();
  while (true) {
    const filePath = join(dir, filename);
    try {
      statSync(filePath);
      return filePath;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseEnvVars(prefix: string): Record<string, any> {
  const result: Record<string, any> = {};
  const prefixLower = prefix.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase().startsWith(prefixLower)) {
      const keyPath = key.substring(prefix.length).split("__").filter(Boolean);
      if (keyPath.length === 0) continue;
      let cursor: Record<string, any> = result;
      for (let i = 0; i < keyPath.length; i++) {
        const subKey = keyPath[i];
        if (i === keyPath.length - 1) {
          cursor[subKey] = value;
        } else {
          if (cursor[subKey] === undefined) cursor[subKey] = {};
          if (typeof cursor[subKey] === "object") cursor = cursor[subKey];
          else break;
        }
      }
    }
  }
  return result;
}

export default function rc(name: string, defaults: Record<string, any> = {}): Record<string, any> {
  const win = platform === "win32";
  const home = win ? env.USERPROFILE : env.HOME;

  const configs: Array<Record<string, any>> = [{...defaults}];
  const configFiles: string[] = [];

  function addConfigFile(filePath: string | undefined) {
    if (!filePath || configFiles.includes(filePath)) return;
    const config = readConfigFile(filePath);
    if (config) {
      configs.push(config);
      configFiles.push(filePath);
    }
  }

  if (!win) {
    addConfigFile(join("/etc", name, "config"));
    addConfigFile(join("/etc", `${name}rc`));
  }

  if (home) {
    addConfigFile(join(home, ".config", name, "config"));
    addConfigFile(join(home, ".config", name));
    addConfigFile(join(home, `.${name}`, "config"));
    addConfigFile(join(home, `.${name}rc`));
  }

  addConfigFile(findUp(`.${name}rc`));

  const envConfig = parseEnvVars(`${name}_`);
  if (envConfig.config) addConfigFile(envConfig.config);

  return Object.assign({}, ...configs, envConfig,
    configFiles.length ? {configs: configFiles, config: configFiles[configFiles.length - 1]} : undefined,
  );
}
