// https://peps.python.org/pep-0508/
export function parseUvDependencies(specs: Array<string>) {
  const ret: Array<{name: string, version: string}> = [];
  for (const spec of specs) {
    const [name, version] = spec.replaceAll(/\s+/g, "").split(/[<>=~]+/);
    if (name && /^[0-9.a-z]+$/.test(version)) {
      ret.push({name, version});
    }
  }
  return ret;
}

export function makeGoProxies(GOPROXY: string | undefined, defaultGoProxy: string): Array<string> {
  if (GOPROXY) {
    return GOPROXY.split(/[,|]/).map(s => s.trim()).filter(s => {
      return Boolean(s) && s !== "direct" && s !== "off";
    }).map(s => {
      return !/^(file|https|http):\/\//.test(s) ? `https://${s}` : s;
    });
  } else {
    return [defaultGoProxy];
  }
}

export const npmTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "resolutions",
  "packageManager",
];

export const optionalNpmTypes = [
  "engines",
];

export const nonPackageEngines = [
  "node",
  "deno",
  "bun",
];

export const poetryTypes = [
  "tool.poetry.dependencies",
  "tool.poetry.dev-dependencies",
  "tool.poetry.test-dependencies",
  "tool.poetry.group.dev.dependencies",
  "tool.poetry.group.test.dependencies",
];

export const uvTypes = [
  "project.dependencies",
  "project.optional-dependencies",
  "dependency-groups.dev",
  "dependency-groups.lint",
  "dependency-groups.test",
];

export const goTypes = [
  "deps",
];
