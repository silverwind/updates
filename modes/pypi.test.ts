import {updatePyprojectToml, fetchPypiInfo} from "./pypi.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

test("replaces >= operator", () => {
  const input = `dependencies = [\n  "requests >=2.28.0",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}requests`]: {old: "2.28.0", new: "2.31.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "requests >=2.31.0",\n]\n`);
});

test("replaces == operator", () => {
  const input = `dependencies = [\n  "flask ==2.3.0",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}flask`]: {old: "2.3.0", new: "2.4.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "flask ==2.4.0",\n]\n`);
});

test("replaces ~= operator", () => {
  const input = `dependencies = [\n  "django ~=4.2.0",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}django`]: {old: "4.2.0", new: "4.3.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "django ~=4.3.0",\n]\n`);
});

test("package with extras", () => {
  const input = `dependencies = [\n  "transformers[torch] >=4.39.3",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}transformers[torch]`]: {old: "4.39.3", new: "4.40.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "transformers[torch] >=4.40.0",\n]\n`);
});

test("preserves surrounding content", () => {
  const input = [
    `[project]`,
    `name = "my-project"`,
    `version = "1.0.0"`,
    `dependencies = [`,
    `  "requests >=2.28.0",`,
    `  "flask >=2.3.0",`,
    `  "click >=8.1.0",`,
    `]`,
    ``,
  ].join("\n");
  const deps = {
    [`dependencies${fieldSep}flask`]: {old: "2.3.0", new: "2.4.0"} as any,
  };
  const result = updatePyprojectToml(input, deps);
  expect(result).toContain(`"flask >=2.4.0"`);
  expect(result).toContain(`name = "my-project"`);
  expect(result).toContain(`"requests >=2.28.0"`);
  expect(result).toContain(`"click >=8.1.0"`);
});

test("uses oldOrig when present", () => {
  const input = `dependencies = [\n  "requests >=2.28.0",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}requests`]: {old: "2.28.0", oldOrig: "2.28.0", new: "2.31.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "requests >=2.31.0",\n]\n`);
});

// fetchPypiInfo
test("fetchPypiInfo happy path", async () => {
  const mockData = {info: {version: "2.31.0"}, releases: {"2.31.0": [{}]}};
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(mockData)}),
  } as unknown as ModeContext;
  const result = await fetchPypiInfo("requests", "dependencies", ctx);
  expect(result).toEqual([mockData, "dependencies", null, "requests"]);
});

test("fetchPypiInfo fetch failure throws", async () => {
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"}),
  } as unknown as ModeContext;
  await expect(fetchPypiInfo("nonexistent", "dependencies", ctx)).rejects.toThrow("404");
});

test("fetchPypiInfo null response throws", async () => {
  const ctx = {
    pypiApiUrl: "https://pypi.org",
    fetchTimeout,
    doFetch: () => Promise.resolve(undefined),
  } as unknown as ModeContext;
  await expect(fetchPypiInfo("nonexistent", "dependencies", ctx)).rejects.toThrow("Unable to fetch");
});

test("operator without space", () => {
  const input = `dependencies = [\n  "requests>=2.28.0",\n]\n`;
  const deps = {
    [`dependencies${fieldSep}requests`]: {old: "2.28.0", new: "2.31.0"} as any,
  };
  expect(updatePyprojectToml(input, deps)).toBe(`dependencies = [\n  "requests>=2.31.0",\n]\n`);
});
