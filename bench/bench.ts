import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync, mkdirSync, cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execPath, argv, stdout, stderr, env} from "node:process";
import {startBenchServer} from "./server.ts";

const execFileAsync = promisify(execFile);

const script = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

type Scenario = {name: string, fixture: string, modes: string, update?: boolean};

const scenarios: Scenario[] = [
  {name: "npm-small", fixture: "npm-test", modes: "npm"},
  {name: "npm-1500", fixture: "npm-1500", modes: "npm"},
  {name: "npm-1500-update", fixture: "npm-1500", modes: "npm", update: true},
  {name: "pnpm-workspace", fixture: "pnpm-workspace", modes: "npm"},
  {name: "pypi", fixture: "uv", modes: "pypi"},
  {name: "go", fixture: "go", modes: "go"},
  {name: "go-workspace", fixture: "go-workspace", modes: "go"},
  {name: "cargo", fixture: "cargo", modes: "cargo"},
  {name: "cargo-workspace", fixture: "cargo-workspace", modes: "cargo"},
  {name: "actions", fixture: "actions", modes: "actions"},
  {name: "actions-many", fixture: "actions-many", modes: "actions"},
  {name: "docker", fixture: "docker", modes: "docker"},
];

function stats(nums: number[]): {median: number, p95: number} {
  const sorted = nums.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)],
  };
}

async function runOnce({fixture, modes, update}: Scenario, url: string, cacheDir: string): Promise<number> {
  const fixtureDir = update ? mkdtempSync(join(tmpdir(), "updates-bench-fixture-")) : join(fixturesRoot, fixture);
  if (update) cpSync(join(fixturesRoot, fixture), fixtureDir, {recursive: true});
  const apiFlags = ["forgeapi", "pypiapi", "jsrapi", "goproxy", "cargoapi", "dockerapi", "registry"].flatMap(flag => [`--${flag}`, url]);
  const start = performance.now();
  try {
    await execFileAsync(execPath, [script, "-j", "-n", "-M", modes, "-f", fixtureDir, ...apiFlags, ...(update ? ["-u"] : [])], {
      env: {...env, XDG_CACHE_HOME: cacheDir, XDG_CONFIG_HOME: cacheDir, LOCALAPPDATA: cacheDir, GH_TOKEN: "",
        GITHUB_TOKEN: "", UPDATES_GITHUB_API_TOKEN: ""},
      maxBuffer: 32 * 1024 * 1024,
    });
    return performance.now() - start;
  } finally {
    if (update) rmSync(fixtureDir, {recursive: true, force: true});
  }
}

type Result = {scenario: string, mode: "cold" | "warm", median: number, p95: number, runs: number[]};

async function benchScenario(scenario: Scenario, url: string, iters: number): Promise<Result[]> {
  const cacheDir = mkdtempSync(join(tmpdir(), "updates-bench-"));
  try {
    await runOnce(scenario, url, cacheDir); // Discarded warmup absorbs JIT and server response-cache priming bias.
    const cold: number[] = [];
    for (let iter = 0; iter < iters; iter++) {
      rmSync(cacheDir, {recursive: true, force: true});
      mkdirSync(cacheDir, {recursive: true});
      cold.push(await runOnce(scenario, url, cacheDir));
    }
    const warm: number[] = [];
    for (let iter = 0; iter < iters; iter++) warm.push(await runOnce(scenario, url, cacheDir));
    return [
      {scenario: scenario.name, mode: "cold", ...stats(cold), runs: cold},
      {scenario: scenario.name, mode: "warm", ...stats(warm), runs: warm},
    ];
  } finally {
    rmSync(cacheDir, {recursive: true, force: true});
  }
}

const fmt = (ms: number) => `${ms.toFixed(0).padStart(5)}ms`;
const iters = Number(argv[2]) || 5;
const latencyMs = Number(env.BENCH_LATENCY_MS) || 0;
const {server, url, requests} = await startBenchServer(latencyMs);
stderr.write(`bench server: ${url}\niterations:   ${iters}\n${latencyMs ? `latency:      ${latencyMs}ms per request\n` : ""}\n`);

const results: Result[] = [];
try {
  for (const scenario of scenarios.filter(({name}) => !argv[3] || name.includes(argv[3]))) {
    const startRequests = requests.count;
    stderr.write(`> ${scenario.name.padEnd(20)} `);
    const [cold, warm] = await benchScenario(scenario, url, iters);
    stderr.write(`cold ${fmt(cold.median)} (p95 ${fmt(cold.p95)})  warm ${fmt(warm.median)} (p95 ${fmt(warm.p95)})  reqs=${requests.count - startRequests}\n`);
    results.push(cold, warm);
  }
} finally {
  server.close();
}
stdout.write(`${JSON.stringify({iters, results}, null, 2)}\n`);
