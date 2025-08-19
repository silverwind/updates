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

export const npmDependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "resolutions",
];

export const poetryDependencyTypes = [
  "tool.poetry.dependencies",
  "tool.poetry.dev-dependencies",
  "tool.poetry.test-dependencies",
  "tool.poetry.group.dev.dependencies",
  "tool.poetry.group.test.dependencies",
];

export const uvDependencyTypes = [
  "project.dependencies",
  "project.optional-dependencies",
  "dependency-groups.dev",
  "dependency-groups.lint",
  "dependency-groups.test",
];

export const goDependencyTypes = [
  "deps",
];
