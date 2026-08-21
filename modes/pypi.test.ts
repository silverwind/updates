import {updatePyprojectToml, fetchPypiInfo, pypiSatisfies} from "./pypi.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";
import {parseUvDependencies} from "../utils/utils.ts";

test("preserves surrounding content", () => {
  const input = [
    `[project]`,
    `name = "my-project"`,
    `version = "1.0.0"`,
    `dependencies = [`,
    `  "requests >=2.28.0",`,
    `  "requests-oauthlib >=2.28.0",`,
    `  "flask >=2.3.0",`,
    `  "click >=8.1.0",`,
    `]`,
    ``,
  ].join("\n");
  const deps = {
    [`project.dependencies${fieldSep}flask`]: {old: "2.3.0", new: "2.4.0"} as any,
    [`project.dependencies${fieldSep}click`]: {old: "8.1.0", new: "8.2.0"} as any,
    [`project.dependencies${fieldSep}requests`]: {old: "2.28.0", new: "2.31.0"} as any,
  };
  const result = updatePyprojectToml(input, deps);
  expect(result).toContain(`"flask >=2.4.0"`);
  expect(result).toContain(`name = "my-project"`);
  expect(result).toContain(`"requests >=2.31.0"`);
  expect(result).toContain(`"requests-oauthlib >=2.28.0"`);
  expect(result).toContain(`"click >=8.2.0"`);
});

test("rewrites only the dependency's originating group", () => {
  const input = [
    `[project]`,
    `dependencies = ["pkg>=1.0"]`,
    ``,
    `[project.optional-dependencies]`,
    `extra = ["pkg>=1.0"]`,
    ``,
    `[dependency-groups]`,
    `"test.unit" = ["pkg>=1.0"]`,
    ``,
  ].join("\n");
  const deps = {
    [`project.optional-dependencies.extra${fieldSep}pkg`]: {old: "1.0", new: "2.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(input.replace(`extra = ["pkg>=1.0"]`, `extra = ["pkg>=2.0"]`));
});

test("fetchPypiInfo happy path", async () => {
  const mockData = {info: {version: "2.31.0"}, releases: {"2.31.0": [{}]}};
  let url = "";
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    doFetch: (input: string) => {
      url = input;
      return Promise.resolve({ok: true, text: () => Promise.resolve(JSON.stringify(mockData)), headers: new Headers()});
    },
  } as unknown as ModeContext;
  const result = await fetchPypiInfo("Foo_Bar.baz", ctx);
  expect(result).toEqual([{...mockData, name: "Foo_Bar.baz"}, null]);
  expect(url).toBe("https://pypi.org/pypi/foo-bar-baz/json");
});

test("fetchPypiInfo shares a normalized request in flight", async () => {
  let requests = 0;
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    noCache: true,
    doFetch: async () => {
      requests++;
      await new Promise(resolve => setImmediate(resolve));
      return {ok: true, text: () => Promise.resolve(JSON.stringify({info: {}, releases: {}})), headers: new Headers()};
    },
  } as unknown as ModeContext;
  await Promise.all([fetchPypiInfo("Foo_Bar", ctx), fetchPypiInfo("foo-bar", ctx)]);
  expect(requests).toBe(1);
});

test("fetchPypiInfo preserves yank and upload metadata through the size reducer", async () => {
  const files = (allYanked: boolean) => Array.from({length: 40}, (_, idx) => ({
    filename: `pkg-${idx}.whl`,
    url: `https://files.pythonhosted.org/packages/${"0".repeat(200)}/pkg-${idx}.whl`,
    upload_time_iso_8601: idx === 39 ? "2024-12-01T00:00:00.000000Z" : "2025-01-01T00:00:00.000000Z",
    yanked: allYanked || idx === 39,
  }));
  const mockData = {info: {name: "pkg", version: "1.0.1"}, releases: {"1.0.0": files(false), "1.0.1": files(true)}};
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    noCache: true,
    doFetch: () => Promise.resolve({ok: true, text: () => Promise.resolve(JSON.stringify(mockData)), headers: new Headers()}),
  } as unknown as ModeContext;
  const [data] = await fetchPypiInfo("reduced-pkg", ctx);
  expect(data.releases["1.0.0"]).toHaveLength(40);
  expect(data.releases["1.0.0"][0]).toEqual({
    upload_time_iso_8601: "2025-01-01T00:00:00.000000Z",
  });
  expect(data.releases["1.0.0"][39]).toEqual({
    upload_time_iso_8601: "2024-12-01T00:00:00.000000Z",
    yanked: true,
  });
  expect(data.releases["1.0.1"]).toHaveLength(40);
  expect(data.releases["1.0.1"].every((file: any) => file.yanked)).toBe(true);
});

test("fetchPypiInfo failure throws", async () => {
  const ctx = {pypiApiUrl: "https://pypi.org", fetchTimeout,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"})} as unknown as ModeContext;
  await expect(fetchPypiInfo("nonexistent", ctx)).rejects.toThrow("404");
});

test("pypiSatisfies handles allowedVersions forms", () => {
  expect(pypiSatisfies("2.1+corp", ">=2,<3")).toBe(true);
  expect(pypiSatisfies("2.1", "")).toBe(true);
  expect(pypiSatisfies("2.1+corp", "2.1")).toBe(true);
  expect(pypiSatisfies("2.2", "2.1")).toBe(false);
  expect(pypiSatisfies("2.1", "[extra]>=2")).toBe(false);
  expect(pypiSatisfies("2.1", `>=2; python_version >= "3.12"`)).toBe(false);
  expect(pypiSatisfies("not-a-version", ">=2")).toBe(false);
  expect(pypiSatisfies("2.1", "not-a-range")).toBe(false);
});

const quoted = (spec: string) => spec.includes(`"`) ? `'${spec}'` : `"${spec}"`;

test.each([
  ["environment marker", `tomli>=1.1.0; python_version < "3.11"`, "1.1.0", "2.2.1", `tomli>=2.2.1; python_version < "3.11"`],
  ["extras and marker", `pytest[testing] >= 7.0.0 ; python_version >= "3.9"`, "7.0.0", "8.3.4", `pytest[testing] >= 8.3.4 ; python_version >= "3.9"`],
  ["parenthesised specifier", "packaging (==20.0.0)", "20.0.0", "24.2", "packaging (==24.2)"],
  ["cap the new version satisfies", "sphinx>=7.0.0,<8", "7.0.0", "7.4.7", "sphinx>=7.4.7,<8"],
  ["violated cap raised at its own precision", "sphinx>=7.0.0,<8", "7.0.0", "8.2.0", "sphinx>=8.2.0,<9"],
  ["violated two-part cap", "sphinx >=7.0.0, <8.0", "7.0.0", "8.2.0", "sphinx >=8.2.0, <8.3"],
  ["violated three-part cap", "protobuf>=3.20.2,<5.0.0", "3.20.2", "5.29.0", "protobuf>=5.29.0,<5.30.0"],
  ["violated cap over a one-part lower bound", "sphinx>=7,<7.4.0", "7", "7.5.1", "sphinx>=7.5.1,<7.5.2"],
  ["violated inclusive cap", "urllib3>=1.26.0,<=2.0", "1.26.0", "2.2.3", "urllib3>=2.2.3,<=2.2.3"],
  ["exclusion the new version misses", "packaging>=20.9,!=22.0", "20.9", "21.3", "packaging>=21.3,!=22.0"],
  ["exclusion the new version hits", "packaging>=20.9,!=22.0", "20.9", "22.0", "packaging>=20.9,!=22.0"],
  ["wildcard exclusion the new version hits", "numpy>=1.20,!=1.25.*", "1.20", "1.25.2", "numpy>=1.20,!=1.25.*"],
  ["cap violated by a prerelease of its own release", "sphinx>=7.0.0,<8", "7.0.0", "8.0.0b1", "sphinx>=8.0.0b1,<9"],
  ["cap violated by a dev release of its own release", "sphinx>=7.0.0,<8.0.0", "7.0.0", "8.0.0.dev1", "sphinx>=8.0.0.dev1,<8.1.0"],
  ["compatible release trimmed to the authored precision", "django~=4.2", "4.2", "4.3.1", "django~=4.3"],
  ["compatible release padded to the authored precision", "django~=4.2.0", "4.2.0", "5.0", "django~=5.0.0"],
  ["ordered local version", "pkg>=1.0", "1.0", "2.0+corp", "pkg>=2.0"],
  ["equality local version", "pkg==1.0", "1.0", "2.0+corp", "pkg==2.0+corp"],
  ["public exclusion hit by a local version", "pkg>=1.0,!=2.0", "1.0", "2.0+corp", "pkg>=1.0,!=2.0"],
  ["local exclusion missed by another local version", "pkg>=1.0,!=2.0+other", "1.0", "2.0+corp", "pkg>=2.0,!=2.0+other"],
  ["epoch-compatible release precision", "pkg~=1!1.4", "1!1.4", "1!1.5.1", "pkg~=1!1.5"],
  ["compatible release suffixes", "pkg~=1!1.4", "1!1.4", "1!1.5.1rc2.post3.dev4+corp", "pkg~=1!1.5rc2.post3.dev4"],
  ["compatible release from another epoch", "pkg>=1!1.4,~=1!1.4", "1!1.4", "2!1.5", "pkg>=1!1.4,~=1!1.4"],
])("updatePyprojectToml handles a %s", (_name, spec, old, newVersion, expected) => {
  const input = `dependencies = [\n  ${quoted(spec)},\n]\n`;
  const deps = {[`dependencies${fieldSep}${/^[\w.-]+/.exec(spec)![0]}`]: {old, new: newVersion} as any};
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  ${quoted(expected)},\n]\n`);
});

test.each([
  "requests >=2.28.0",
  "flask <3,>=2.2",
  "packaging>=20.9,!=22.0",
  "numpy>=1.20,!=1.25.*",
  "sphinx >=7.0.0, <8.0",
  `tomli>=1.1.0; python_version < "3.11"`,
  `wheel (>=0.40.0); python_version < "3.8"`,
  "transformers[torch] >=4.39.3",
  "private-depB[extra1, extra2]~=2.4",
  "types-requests==2.32.0.20240622",
  "urllib3===1.26.0",
  "ty>=0.0.1a15",
])("reader and writer anchor on the same specifier of %s", (spec) => {
  const [before] = parseUvDependencies([spec]);
  const quote = quoted(spec)[0];
  const deps = {[`dependencies${fieldSep}${before.name}`]: {old: before.version, new: "9.9.9"} as any};
  const [after] = parseUvDependencies([updatePyprojectToml(`dependencies = [${quoted(spec)}]`, deps).split(quote)[1]]);
  expect(after.name).toBe(before.name);
  expect(after.version).not.toBe(before.version);
});

test("anchors on the whole version, not a prefix of a longer one", () => {
  const input = `dependencies = [\n  "tomli>=1.1",\n]\ndev = [\n  "tomli>=1.1.5",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}tomli`]: {old: "1.1", new: "2.2.1"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "tomli>=2.2.1",\n]\ndev = [\n  "tomli>=1.1.5",\n]\n`);
});
