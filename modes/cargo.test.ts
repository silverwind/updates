import {updateCargoToml, fetchCratesIoInfo} from "./cargo.ts";
import {type ModeContext, fetchTimeout, fieldSep} from "./shared.ts";

test("simple form: name = \"version\"", () => {
  const input = `[dependencies]\nserde = "1.0.0"\n`;
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.0.1"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dependencies]\nserde = "1.0.1"\n`);
});

test("simple form: name = 'version' (single quotes)", () => {
  const input = `[dependencies]\nserde = '1.0.0'\n`;
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "2.0.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dependencies]\nserde = '2.0.0'\n`);
});

test("inline table: name = { version = \"x.y.z\", features = [...] }", () => {
  const input = `[dependencies]\nserde = { version = "1.0.0", features = ["derive"] }\n`;
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.1.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dependencies]\nserde = { version = "1.1.0", features = ["derive"] }\n`);
});

test("extended table: [dependencies.name] with version = \"x.y.z\"", () => {
  const input = `[dependencies.serde]\nversion = "1.0.0"\nfeatures = ["derive"]\n`;
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.2.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dependencies.serde]\nversion = "1.2.0"\nfeatures = ["derive"]\n`);
});

test("preserves surrounding content", () => {
  const input = [
    `[package]`,
    `name = "my-crate"`,
    `version = "0.1.0"`,
    ``,
    `[dependencies]`,
    `serde = "1.0.0"`,
    `tokio = { version = "1.28.0", features = ["full"] }`,
    ``,
    `[dev-dependencies]`,
    `rand = "0.8.5"`,
    ``,
  ].join("\n");
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", new: "1.0.1"} as any,
    [`dependencies${fieldSep}tokio`]: {old: "1.28.0", new: "1.30.0"} as any,
  };
  const result = updateCargoToml(input, deps);
  expect(result).toContain(`serde = "1.0.1"`);
  expect(result).toContain(`version = "1.30.0", features = ["full"]`);
  expect(result).toContain(`name = "my-crate"`);
  expect(result).toContain(`rand = "0.8.5"`);
});

test("uses oldOrig when present", () => {
  const input = `[dependencies]\nserde = "1.0.0"\n`;
  const deps = {
    [`dependencies${fieldSep}serde`]: {old: "1.0.0", oldOrig: "1.0.0", new: "1.0.2"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dependencies]\nserde = "1.0.2"\n`);
});

test("extended table with dev-dependencies", () => {
  const input = `[dev-dependencies.tokio]\nversion = "1.28.0"\nfeatures = ["full"]\n`;
  const deps = {
    [`dev-dependencies${fieldSep}tokio`]: {old: "1.28.0", new: "1.30.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[dev-dependencies.tokio]\nversion = "1.30.0"\nfeatures = ["full"]\n`);
});

// fetchCratesIoInfo
test("fetchCratesIoInfo happy path", async () => {
  const responseData = {
    versions: [
      {num: "1.0.200", created_at: "2025-01-15T12:00:00Z", yanked: false},
      {num: "1.0.100", created_at: "2024-06-01T12:00:00Z", yanked: false},
      {num: "1.0.0", created_at: "2024-01-01T12:00:00Z", yanked: false},
    ],
  };
  const ctx = {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(responseData)}),
  } as unknown as ModeContext;
  const [data, type, registry, name] = await fetchCratesIoInfo("serde", "dependencies", ctx);
  expect(type).toBe("dependencies");
  expect(registry).toBeNull();
  expect(name).toBe("serde");
  expect(data["dist-tags"].latest).toBe("1.0.200");
  expect(Object.keys(data.versions)).toEqual(["1.0.200", "1.0.100", "1.0.0"]);
  expect(data.time["1.0.200"]).toBe("2025-01-15T12:00:00Z");
});

test("fetchCratesIoInfo filters yanked versions", async () => {
  const responseData = {
    versions: [
      {num: "2.0.0", created_at: "2025-02-01T00:00:00Z", yanked: true},
      {num: "1.0.0", created_at: "2024-01-01T00:00:00Z", yanked: false},
    ],
  };
  const ctx = {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve(responseData)}),
  } as unknown as ModeContext;
  const [data] = await fetchCratesIoInfo("serde", "dependencies", ctx);
  expect(Object.keys(data.versions)).toEqual(["1.0.0"]);
  expect(data["dist-tags"].latest).toBe("1.0.0");
});

test("fetchCratesIoInfo fetch failure throws", async () => {
  const ctx = {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: false, status: 404, statusText: "Not Found"}),
  } as unknown as ModeContext;
  await expect(fetchCratesIoInfo("nonexistent", "dependencies", ctx)).rejects.toThrow("404");
});

test("fetchCratesIoInfo invalid JSON throws", async () => {
  const ctx = {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.reject(new Error("parse error"))}),
  } as unknown as ModeContext;
  await expect(fetchCratesIoInfo("serde", "dependencies", ctx)).rejects.toThrow("Invalid JSON");
});

test("fetchCratesIoInfo empty versions", async () => {
  const ctx = {
    cratesIoUrl: "https://crates.io",
    fetchTimeout,
    doFetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({versions: []})}),
  } as unknown as ModeContext;
  const [data] = await fetchCratesIoInfo("serde", "dependencies", ctx);
  expect(data.versions).toEqual({});
  expect(data.time).toEqual({});
  expect(data["dist-tags"].latest).toBe("");
});

test("extended table with build-dependencies", () => {
  const input = `[build-dependencies.cc]\nversion = "1.0.0"\n`;
  const deps = {
    [`build-dependencies${fieldSep}cc`]: {old: "1.0.0", new: "1.1.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[build-dependencies.cc]\nversion = "1.1.0"\n`);
});
