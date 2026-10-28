// asserting on the awaited reason keeps assertions synchronous, vitest binds async ones to the last started concurrent test
export async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}
