import {env, platform} from "node:process";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";

type Tokens = Record<string, string>;

const memo = new Map<string, Promise<Tokens>>();

function tokensPath(): string {
  const configDir = env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config"));
  return join(configDir, "updates", "tokens.json");
}

async function readTokensFile(path: string): Promise<Tokens> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(data);
  } catch (err: any) {
    throw new Error(`Could not parse ${path}: ${err.message}`);
  }
}

export function readTokens(): Promise<Tokens> {
  const path = tokensPath();
  if (!memo.has(path)) memo.set(path, readTokensFile(path));
  return memo.get(path)!;
}

async function writeTokens(tokens: Tokens): Promise<void> {
  const path = tokensPath();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(`${path}.tmp`, `${JSON.stringify(tokens, null, 2)}\n`, {mode: 0o600});
  await rename(`${path}.tmp`, path);
  memo.set(path, Promise.resolve(tokens));
}

export async function storeToken(host: string, token: string): Promise<void> {
  await writeTokens({...await readTokens(), [host]: token});
}

export async function removeToken(host: string): Promise<boolean> {
  const tokens = {...await readTokens()};
  if (!Object.hasOwn(tokens, host)) return false;
  delete tokens[host];
  await writeTokens(tokens);
  return true;
}
