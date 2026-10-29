import {env} from "node:process";

// asserting on the awaited reason keeps assertions synchronous, vitest binds async ones to the last started concurrent test
export async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

export const sequential = (test as any).serial ?? test;

export function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

export async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, env[name]]));
  setEnv(values);
  try {
    return await fn();
  } finally {
    setEnv(saved);
  }
}
