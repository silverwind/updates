// https://peps.python.org/pep-0508/
export function parseUvDependencies(specs: Array<string>) {
  const ret: Array<{name: string, version: string}> = [];
  for (const spec of specs) {
    const [name, version] = spec.replaceAll(/\s+/g, "").split(/[<>=~]+/);
    if (name && /^[0-9.]+$/.test(version)) {
      ret.push({name, version});
    }
  }
  return ret;
}
