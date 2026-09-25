import {readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {env, platform, cwd} from "node:process";
import {walkUpSync} from "./utils.ts";

export function parseIni(content: string): Record<string, string> {
  if (/^\s*\{/.test(content)) return JSON.parse(content);
  const result: Record<string, string> = {};
  for (const line of content.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (/^'.*'$/s.test(value)) {
      value = value.slice(1, -1);
    } else if (/^".*"$/s.test(value)) {
      try { value = JSON.parse(value); } catch {}
    } else {
      value = value.replace(/\\([\\;#])|[;#].*$/g, "$1").trim();
    }
    result[trimmed.slice(0, eqIndex).trim()] = value;
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

function findUp(filename: string, startDir: string): string | null {
  return walkUpSync(startDir, dir => {
    const filePath = join(dir, filename);
    try {
      if (statSync(filePath).isFile()) return filePath;
    } catch {}
    return null;
  });
}

export function parseEnvVars(prefix: string): Record<string, any> {
  const result: Record<string, any> = {};
  const prefixLower = prefix.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (!key.toLowerCase().startsWith(prefixLower)) continue;
    const keyPath = key.substring(prefix.length).split("__").filter(Boolean);
    const leaf = keyPath.pop();
    if (!leaf) continue;
    let cursor = result;
    for (const subKey of keyPath) {
      cursor[subKey] ??= {};
      cursor = typeof cursor[subKey] === "object" ? cursor[subKey] : {};
    }
    cursor[leaf] = value;
  }
  return result;
}

export default function rc(name: string, defaults: Record<string, any> = {}, startDir: string = cwd()): Record<string, any> {
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  const envConfig = parseEnvVars(`${name}_`);
  const files = new Set([
    ...(platform === "win32" ? [] : [join("/etc", name, "config"), join("/etc", `${name}rc`)]),
    ...(home ? [join(home, ".config", name, "config"), join(home, ".config", name), join(home, `.${name}`, "config"), join(home, `.${name}rc`)] : []),
    findUp(`.${name}rc`, startDir),
    envConfig.config,
  ]);
  return Object.assign({}, defaults, ...Array.from(files).filter(Boolean).map(readConfigFile), envConfig);
}
