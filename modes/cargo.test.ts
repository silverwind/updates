import {updateCargoToml} from "./cargo.ts";
import {fieldSep} from "./shared.ts";

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

test("extended table with build-dependencies", () => {
  const input = `[build-dependencies.cc]\nversion = "1.0.0"\n`;
  const deps = {
    [`build-dependencies${fieldSep}cc`]: {old: "1.0.0", new: "1.1.0"} as any,
  };
  expect(updateCargoToml(input, deps)).toBe(`[build-dependencies.cc]\nversion = "1.1.0"\n`);
});
