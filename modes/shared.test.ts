import {findNewVersion} from "./shared.ts";

const defaultOpts = {
  allowDowngrade: false as any,
  matchesAny: () => false,
  isGoPseudoVersion: () => false,
};

test("pin downgrade with abbreviated metadata (no time field)", () => {
  // Simulate abbreviated npm metadata: has versions and dist-tags but no time
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "6.0.0": {},
      "6.0.1": {},
      "6.0.2": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.3");
});

test("pin downgrade with full metadata (has time field)", () => {
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "6.0.0": {},
      "6.0.1": {},
      "6.0.2": {},
    },
    time: {
      "5.9.2": "2025-01-01T00:00:00Z",
      "5.9.3": "2025-02-01T00:00:00Z",
      "6.0.0": "2025-03-01T00:00:00Z",
      "6.0.1": "2025-04-01T00:00:00Z",
      "6.0.2": "2025-05-01T00:00:00Z",
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.3");
});

test("pin selects greatest within range when no time data", () => {
  const data = {
    name: "typescript",
    "dist-tags": {latest: "6.0.2"},
    versions: {
      "5.9.2": {},
      "5.9.3": {},
      "5.9.4": {},
      "5.9.5": {},
      "6.0.2": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "6.0.2",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^5.9.3",
  }, defaultOpts);

  expect(result).toBe("5.9.5");
});

test("pin with no downgrade returns null without allow-downgrade", () => {
  const data = {
    name: "react",
    "dist-tags": {latest: "19.0.0"},
    versions: {
      "18.2.0": {},
      "18.3.0": {},
      "18.3.1": {},
      "19.0.0": {},
    },
  };

  const result = findNewVersion(data, {
    mode: "npm",
    range: "18.2.0",
    useGreatest: false,
    useRel: false,
    usePre: false,
    semvers: new Set(["patch", "minor", "major"]),
    pinnedRange: "^18.0.0",
  }, defaultOpts);

  // Should offer upgrade within pinned range (18.2.0 -> 18.3.1)
  expect(result).toBe("18.3.1");
});
