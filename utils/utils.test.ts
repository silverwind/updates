import {highlightDiff, parseUvDependencies, parseDuration} from "./utils.ts";

const c = (s: string) => `[${s}]`;

test("highlightDiff", () => {
  // equal strings return unchanged
  expect(highlightDiff("1.0.0", "1.0.0", c)).toBe("1.0.0");
  // major version diff
  expect(highlightDiff("1.0.0", "2.0.0", c)).toBe("[1.0.0]");
  expect(highlightDiff("2.0.0", "1.0.0", c)).toBe("[2.0.0]");
  // minor version diff
  expect(highlightDiff("1.0.0", "1.2.0", c)).toBe("1.[0.0]");
  expect(highlightDiff("1.2.0", "1.0.0", c)).toBe("1.[2.0]");
  // patch version diff
  expect(highlightDiff("1.0.0", "1.0.3", c)).toBe("1.0.[0]");
  expect(highlightDiff("1.0.3", "1.0.0", c)).toBe("1.0.[3]");
  // multi-digit numbers stay intact
  expect(highlightDiff("10.0.0", "12.0.0", c)).toBe("[10.0.0]");
  expect(highlightDiff("12.0.0", "10.0.0", c)).toBe("[12.0.0]");
  expect(highlightDiff("1.10.0", "1.12.0", c)).toBe("1.[10.0]");
  // v prefix preserved
  expect(highlightDiff("v5", "v6", c)).toBe("v[5]");
  expect(highlightDiff("v10", "v12", c)).toBe("v[10]");
  expect(highlightDiff("v10.0", "v12.0", c)).toBe("v[10.0]");
  // range prefixes preserved
  expect(highlightDiff("^4", "^5", c)).toBe("^[4]");
  expect(highlightDiff("^1.0.0", "^2.0.0", c)).toBe("^[1.0.0]");
  expect(highlightDiff("~1.0.0", "~1.5.0", c)).toBe("~1.[0.0]");
  expect(highlightDiff(">=2.0.0", ">=2.6.5", c)).toBe(">=2.[0.0]");
  // prerelease
  expect(highlightDiff("4.0.0-alpha.2", "4.0.0-beta.11", c)).toBe("4.0.0-[alpha.2]");
  // hashes (no common prefix)
  expect(highlightDiff("537ccb7", "6941e05", c)).toBe("[537ccb7]");
});

test("parseUvDependencies", () => {
  expect(parseUvDependencies([
    "tqdm >=4.66.2,<5",
    "torch ==2.2.2",
    "transformers[torch] >=4.39.3",
    "mollymawk ==0.1.0",
    "types-requests==2.32.0.20240622",
    "types-paramiko==3.4.0.20240423",
    "ty>=0.0.1a15",
  ])).toMatchInlineSnapshot(`
    [
      {
        "name": "torch",
        "version": "2.2.2",
      },
      {
        "name": "transformers[torch]",
        "version": "4.39.3",
      },
      {
        "name": "mollymawk",
        "version": "0.1.0",
      },
      {
        "name": "types-requests",
        "version": "2.32.0.20240622",
      },
      {
        "name": "types-paramiko",
        "version": "3.4.0.20240423",
      },
      {
        "name": "ty",
        "version": "0.0.1a15",
      },
    ]
  `);
});

test("parseDuration", () => {
  expect(parseDuration("7")).toBe(7);
  expect(parseDuration("2y")).toBe(730);
  expect(parseDuration("3m")).toBe(90);
  expect(parseDuration("1w")).toBe(7);
  expect(parseDuration("2d")).toBe(2);
  expect(parseDuration("12h")).toBe(0.5);
  expect(parseDuration("6h")).toBe(0.25);
  expect(parseDuration("86400s")).toBe(1);
  expect(parseDuration("10s")).toBeCloseTo(10 / 86400);
  expect(() => parseDuration("abc")).toThrow("Invalid cooldown value");
  expect(() => parseDuration("12x")).toThrow("Invalid cooldown value");
});
