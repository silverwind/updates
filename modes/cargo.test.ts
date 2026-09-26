import {updateCargoToml, updateCargoRange, cargoToNpmRange, fetchCratesIoInfo, parseCargoLock, findLockedVersion} from "./cargo.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

const sparse = (...records: Array<Record<string, any>>) => records.map(record => JSON.stringify(record)).join("\n");

function sparseCtx(body: string, urls: Array<string> = []): ModeContext {
  return {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    noCache: true,
    doFetch: (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(body));
    },
  } as unknown as ModeContext;
}

test.each([
  [`simple name = "version"`, `[dependencies]\nserde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `[dependencies]\nserde = "1.0.1"\n`],
  [`single-quoted name = 'version'`, `[dependencies]\nserde = '1.0.0'\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "2.0.0"}, `[dependencies]\nserde = '2.0.0'\n`],
  [`dependency without touching a crate named version`, `[dependencies]\nfoo = "1.0.0"\nversion = "1.0.0"\n`,
    `dependencies${fieldSep}foo`, {old: "1.0.0", new: "2.0.0"}, `[dependencies]\nfoo = "2.0.0"\nversion = "1.0.0"\n`],
  [`inline table name = {version, features}`, `[dependencies]\nserde = { version = "1.0.0", features = ["derive"] }\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"}, `[dependencies]\nserde = { version = "1.1.0", features = ["derive"] }\n`],
  [`extended table [dependencies.name]`, `[dependencies.serde]\nversion = "1.0.0"\nfeatures = ["derive"]\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.2.0"}, `[dependencies.serde]\nversion = "1.2.0"\nfeatures = ["derive"]\n`],
  [`spaced dotted workspace table`, `[workspace . dependencies]\nserde = "1.0.0"\n`,
    `workspace.dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `[workspace . dependencies]\nserde = "1.0.1"\n`],
  [`extended table skips comments and multiline strings`, `[dependencies.serde]\n# version = "1.0.0" was old\nnote = """\nversion = "1.0.0"\n"""\nversion = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"}, `[dependencies.serde]\n# version = "1.0.0" was old\nnote = """\nversion = "1.0.0"\n"""\nversion = "1.1.0"\n`],
  [`escaped multiline delimiters`, `[dependencies.serde]\nnote = """\n${"\\".repeat(128)}text\n\\"""\nversion = "1.0.0"\n\\\\"""\nversion = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"}, `[dependencies.serde]\nnote = """\n${"\\".repeat(128)}text\n\\"""\nversion = "1.0.0"\n\\\\"""\nversion = "1.1.0"\n`],
  [`extended table beside a same-named dev entry`, `[dependencies.serde]\nversion = "1.0.0"\n\n[dev-dependencies]\nserde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `[dependencies.serde]\nversion = "1.0.1"\n\n[dev-dependencies]\nserde = "1.0.0"\n`],
  [`indented header beside a same-named dev entry`, `  [dependencies] # pinned\n  serde = "1.0.0"\n\n  [dev-dependencies]\n  serde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `  [dependencies] # pinned\n  serde = "1.0.1"\n\n  [dev-dependencies]\n  serde = "1.0.0"\n`],
  [`multiline delimiter in a comment`, `# """\n[dependencies]\nserde = "1.0.0"\n[dev-dependencies]\nserde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"}, `# """\n[dependencies]\nserde = "1.1.0"\n[dev-dependencies]\nserde = "1.0.0"\n`],
  [`header the description only quotes`, `[package]\ndescription = """\n[dependencies.serde]\nversion = "1.0.0"\n"""\n\n[dependencies]\nserde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `[package]\ndescription = """\n[dependencies.serde]\nversion = "1.0.0"\n"""\n\n[dependencies]\nserde = "1.0.1"\n`],
  [`oldOrig instead of old`, `[dependencies]\nserde = "1.0.0"\n`,
    `dependencies${fieldSep}serde`, {old: "1.0.0", oldOrig: "1.0.0", new: "1.0.2"}, `[dependencies]\nserde = "1.0.2"\n`],
  [`extended dev-dependencies`, `[dev-dependencies.tokio]\nversion = "1.28.0"\nfeatures = ["full"]\n`,
    `dev-dependencies${fieldSep}tokio`, {old: "1.28.0", new: "1.30.0"}, `[dev-dependencies.tokio]\nversion = "1.30.0"\nfeatures = ["full"]\n`],
  [`extended build-dependencies`, `[build-dependencies.cc]\nversion = "1.0.0"\n`,
    `build-dependencies${fieldSep}cc`, {old: "1.0.0", new: "1.1.0"}, `[build-dependencies.cc]\nversion = "1.1.0"\n`],
  [`a workspace member type suffix`, `[dependencies.serde]\nversion = "1.0.0"\n`,
    `dependencies|crates/a${fieldSep}serde`, {old: "1.0.0", new: "1.0.1"}, `[dependencies.serde]\nversion = "1.0.1"\n`],
  [`double-quoted target with escaped quotes`, `[target."cfg(target_os = \\"windows\\")".dependencies]\nserde = "1.0.0"\n`,
    `${JSON.stringify(["target", `cfg(target_os = "windows")`, "dependencies"])}${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"},
    `[target."cfg(target_os = \\"windows\\")".dependencies]\nserde = "1.1.0"\n`],
  [`unicode-escaped target and key`, `[target."cfg(\\u0075nix)".dependencies]\n"\\u0073erde" = "1.0.0"\n`,
    `${JSON.stringify(["target", "cfg(unix)", "dependencies"])}${fieldSep}serde`, {old: "1.0.0", new: "1.1.0"},
    `[target."cfg(\\u0075nix)".dependencies]\n"\\u0073erde" = "1.1.0"\n`],
])("updateCargoToml rewrites a %s", (_name, input, key, dep, expected) => {
  expect(updateCargoToml(input, {[key]: dep as any})).toBe(expected);
});

test("updateCargoToml fails when its dependency table cannot be located", () => {
  expect(() => updateCargoToml(`serde = "1.0.0"\n`, {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.1.0"} as any,
  })).toThrow("Unable to locate Cargo table");
});

test("updateCargoToml rewrites multiple dependencies within one table", () => {
  const input = [
    `[package]`,
    `name = "my-crate"`,
    `version = "0.1.0"`,
    ``,
    `[dependencies]`,
    `"serde" = "1.0.0"`,
    `'tokio' = { version = "1.28.0", features = ["full"] }`,
    ``,
    `[dev-dependencies]`,
    `rand = "0.8.5"`,
    `serde = "1.0.0"`,
    ``,
    `[dependencies."serde_json"]`,
    `version = "1.0.0"`,
    ``,
  ].join("\n");
  expect(updateCargoToml(input, {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.0.1"} as any,
    [`dependencies${fieldSep}tokio`]: {old: "1.28.0", new: "1.30.0"} as any,
    [`dependencies${fieldSep}serde_json`]: {old: "1.0.0", new: "1.0.2"} as any,
  })).toBe(input.replace(`"serde" = "1.0.0"`, `"serde" = "1.0.1"`).replace(`version = "1.28.0"`, `version = "1.30.0"`)
    .replace(`[dependencies."serde_json"]\nversion = "1.0.0"`, `[dependencies."serde_json"]\nversion = "1.0.2"`));
});

test("fetchCratesIoInfo happy path", async () => {
  const urls: Array<string> = [];
  const body = sparse(
    {name: "serde", vers: "1.0.0", yanked: false, pubtime: "2024-01-01T12:00:00Z"},
    {name: "serde", vers: "1.0.100", yanked: false, pubtime: "2024-06-01T12:00:00Z"},
    {name: "serde", vers: "1.0.200+spec-1.1.0", yanked: false, pubtime: "2025-01-15T12:00:00Z"},
  );
  const [data, registry] = await fetchCratesIoInfo("serde", sparseCtx(body, urls));
  expect(urls).toEqual(["https://index.crates.io/se/rd/serde"]);
  expect(registry).toBeNull();
  expect(data).toMatchObject({name: "serde", "dist-tags": {latest: "1.0.200"}, time: {"1.0.200": "2025-01-15T12:00:00Z"}});
  expect(Object.keys(data.versions)).toEqual(["1.0.0", "1.0.100", "1.0.200"]);
});

test("fetchCratesIoInfo reads every version of a large index body distilled to the fields it reads", async () => {
  const bulk = {cksum: "c".repeat(64), deps: [{name: "dep", req: "^1", features: ["a", "b"]}], features: {default: ["std"]}};
  const records = Array.from({length: 200}, (_, i) => ({name: "bulky", vers: `1.${i}.0`, yanked: i === 199, pubtime: "2025-01-01T00:00:00Z", ...bulk}));
  const body = sparse(...records);
  expect(body.length).toBeGreaterThan(16384);
  const [data] = await fetchCratesIoInfo("bulky", sparseCtx(body));
  expect(Object.keys(data.versions).length).toBe(199);
  expect(data.versions["1.0.0"]).toEqual({});
  expect(data["dist-tags"].latest).toBe("1.198.0");
  expect(data.time["1.198.0"]).toBe("2025-01-01T00:00:00Z");
});

test("fetchCratesIoInfo shards the index path by name length", async () => {
  for (const [name, path] of [["a", "1/a"], ["ab", "2/ab"], ["abc", "3/a/abc"], ["Serde_JSON", "se/rd/serde_json"]]) {
    const urls: Array<string> = [];
    await fetchCratesIoInfo(name, sparseCtx(sparse({vers: "1.0.0"}), urls));
    expect(urls).toEqual([`https://index.crates.io/${path}`]);
  }
});

test.each([
  ["the highest release, not the newest published", ["2.0.0", "1.9.1", "3.0.0-rc.1"], "2.0.0"],
  ["a prerelease when nothing is released", ["0.1.0-alpha.1", "0.1.0-alpha.2"], "0.1.0-alpha.2"],
])("fetchCratesIoInfo latest is %s", async (_name, versions, latest) => {
  const [data] = await fetchCratesIoInfo("latest", sparseCtx(sparse(...versions.map(vers => ({vers})))));
  expect(data["dist-tags"].latest).toBe(latest);
});

test("fetchCratesIoInfo fetch failure throws", async () => {
  const ctx = {...sparseCtx(""), doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"})} as unknown as ModeContext;
  await expect(fetchCratesIoInfo("nonexistent", ctx)).rejects.toThrow("404");
});

test("fetchCratesIoInfo invalid JSON throws", async () => {
  await expect(fetchCratesIoInfo("serde-bad-json", sparseCtx("{not json"))).rejects.toThrow("Invalid JSON");
});

test("fetchCratesIoInfo empty versions", async () => {
  expect((await fetchCratesIoInfo("serde-empty", sparseCtx("")))[0]).toEqual({name: "serde-empty", versions: {}, time: {}, "dist-tags": {latest: ""}});
});

test("target sections", () => {
  const input = [
    `[target.'cfg(feature = "foo.bar")'.dependencies]`,
    `libc = "0.2.0"`,
    ``,
    `[target . x86_64-pc-windows-msvc . dependencies . winapi]`,
    `version = "0.3.0"`,
    ``,
    `[target.'cfg(windows)'.build-dependencies.cc]`,
    `version = "1.0.0"`,
    ``,
    `[dev-dependencies]`,
    `libc = "0.2.0"`,
    ``,
  ].join("\n");
  expect(updateCargoToml(input, {
    [`${JSON.stringify(["target", `cfg(feature = "foo.bar")`, "dependencies"])}|crates/a${fieldSep}libc`]:
      {old: "0.2.0", new: "0.2.1"} as any,
    [`${JSON.stringify(["target", "x86_64-pc-windows-msvc", "dependencies"])}${fieldSep}winapi`]:
      {old: "0.3.0", new: "0.3.9"} as any,
    [`${JSON.stringify(["target", "cfg(windows)", "build-dependencies"])}${fieldSep}cc`]:
      {old: "1.0.0", new: "1.1.0"} as any,
  })).toBe(input.replace(`libc = "0.2.0"`, `libc = "0.2.1"`).replace(`version = "0.3.0"`, `version = "0.3.9"`)
    .replace(`version = "1.0.0"`, `version = "1.1.0"`));
});

test("parseCargoLock collects valid package versions", () => {
  const lock = `
[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.201"

[[package]]
name = "bad"
version = "not-a-version"

[[package]]
name = "rand"
version = "0.8.5"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
  expect(parseCargoLock(lock)).toEqual(new Map([["serde", ["1.0.200", "1.0.201"]], ["rand", ["0.8.5"]]]));
  expect(parseCargoLock("")).toEqual(new Map());
});

const locked = new Map([
  ["serde", ["1.0.200"]],
  ["twoLines", ["0.8.5", "0.9.0"]],
  ["patched", ["1.0.100", "1.0.200"]],
  ["wide", ["1.0.5", "1.5.0", "2.0.0"]],
  ["list", ["0.1.6"]],
]);

test.each([
  ["serde", "1.0", "1.0.200"],
  ["twoLines", "0.8", "0.8.5"],
  ["twoLines", "0.9", "0.9.0"],
  ["twoLines", "^0.8", "0.8.5"],
  ["patched", "1.0", "1.0.200"],
  ["wide", ">= 1.0.0, < 2.0.0", "1.5.0"],
  ["wide", "1.0.*", "1.0.5"],
  ["wide", "1.*", "1.5.0"],
  ["list", "0.1.0, 0.1.4, 0.1.6", "0.1.6"],
  ["unknown", "1.0", undefined],
])("findLockedVersion %s %s", (name, range, expected) => {
  expect(findLockedVersion(locked, name, range)).toBe(expected);
});

test.each([
  ["1", "2.0.0", "2"],
  ["1.0", "1.1.0", "1.1"],
  ["1.0", "2.0.0", "2.0"],
  ["1.0.0", "1.0.1", "1.0.1"],
  ["1.0.0", "1.1.0", "1.1.0"],
  ["1.0.0", "2.0.0", "2.0.0"],
  ["^1.0", "1.1.0", "^1.1"],
  ["^1.0.0", "1.1.0", "^1.1.0"],
  ["^1.0.0", "2.0.0", "^2.0.0"],
  ["~1.0.0", "1.0.5", "~1.0.5"],
  ["~1.0", "1.0.5", "~1.0"],
  [">=1.0.0", "2.0.0", ">=2.0.0"],
  ["1.*", "2.1.0", "2.*"],
  ["1.0.*", "1.1.0", "1.1.*"],
  ["0.8.*", "0.9.0", "0.9.*"],
  ["1.x", "2.1.0", "2.x"],
  ["1.0.*", "1.1.0-rc.1", "1.1.0-rc.1"],
  ["  = 1.0.0", "1.1.0", "  = 1.1.0"],
  [">= 0.1.21, < 0.2.0", "0.1.24", ">= 0.1.24, < 0.2.0"],
  [">= 0.1.21, <= 0.2.0", "0.1.24", ">= 0.1.24, <= 0.2.0"],
  [">= 0.0.1, < 0.1", "0.2.1", ">= 0.2.1, < 0.3"],
  [">=1.0.0,<2.0.0", "1.5.0", ">=1.5.0,<2.0.0"],
  ["<2.0.0", "1.5.0", "<2.0.0"],
  ["<1.3.4", "1.5.0", "<1.5.1"],
])("updateCargoRange %s to %s", (range, version, expected) => {
  expect(updateCargoRange(range, version)).toBe(expected);
});

test("cargoToNpmRange swaps comma separators for whitespace", () => {
  expect([">= 1.0.0, < 2.0.0", ">=1.0.0,<2.0.0", "  1.0.0", "0.1.0, 0.1.4, 0.1.6", "1.*, 2.*", "^1.0"].map(cargoToNpmRange))
    .toEqual([">= 1.0.0 < 2.0.0", ">=1.0.0 <2.0.0", "^1.0.0", "^0.1.0 ^0.1.4 ^0.1.6", "1.* 2.*", "^1.0"]);
});
