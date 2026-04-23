import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync, mkdirSync, cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execPath, argv, stdout, stderr, env, exit} from "node:process";
import {startBenchServer} from "./server.ts";

const execFileAsync = promisify(execFile);

const script = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

type Scenario = {
  name: string,
  fixture: string,
  modes: string,
  extraArgs?: string[],
  writes?: boolean,
};

const scenarios: Scenario[] = [
  {name: "npm-small", fixture: "npm-test", modes: "npm"},
  {name: "npm-1500", fixture: "npm-1500", modes: "npm"},
  {name: "npm-1500-update", fixture: "npm-1500", modes: "npm", extraArgs: ["-u"], writes: true},
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

function median(nums: number[]): number {
  const sorted = nums.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums: number[], p: number): number {
  const sorted = nums.toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runOnce(scenario: Scenario, url: string, cacheDir: string): Promise<number> {
  let fixtureDir = join(fixturesRoot, scenario.fixture);
  let tmpFixture: string | null = null;
  if (scenario.writes) {
    tmpFixture = mkdtempSync(join(tmpdir(), "updates-bench-fixture-"));
    cpSync(fixtureDir, tmpFixture, {recursive: true});
    fixtureDir = tmpFixture;
  }
  const args = [
    script, "-j", "-n", "-M", scenario.modes,
    "-f", fixtureDir,
    "--forgeapi", url,
    "--pypiapi", url,
    "--jsrapi", url,
    "--goproxy", url,
    "--cargoapi", url,
    "--dockerapi", url,
    "--registry", url,
    ...(scenario.extraArgs ?? []),
  ];
  const start = performance.now();
  try {
    await execFileAsync(execPath, args, {
      env: {...env, XDG_CACHE_HOME: cacheDir, LOCALAPPDATA: cacheDir, GH_TOKEN: "", GITHUB_TOKEN: "", UPDATES_GITHUB_API_TOKEN: ""},
      maxBuffer: 32 * 1024 * 1024,
    });
    return performance.now() - start;
  } finally {
    if (tmpFixture) rmSync(tmpFixture, {recursive: true, force: true});
  }
}

type Result = {scenario: string, mode: "cold" | "warm", median: number, p95: number, runs: number[]};

async function benchScenario(scenario: Scenario, url: string, iters: number): Promise<Result[]> {
  const cacheDir = mkdtempSync(join(tmpdir(), "updates-bench-"));
  // Discarded warmup absorbs JIT + server-side response-cache priming bias.
  await runOnce(scenario, url, cacheDir);
  try {
    const cold: number[] = [];
    for (let iter = 0; iter < iters; iter++) {
      rmSync(cacheDir, {recursive: true, force: true});
      mkdirSync(cacheDir, {recursive: true});
      cold.push(await runOnce(scenario, url, cacheDir));
    }
    const warm: number[] = [];
    for (let iter = 0; iter < iters; iter++) warm.push(await runOnce(scenario, url, cacheDir));
    return [
      {scenario: scenario.name, mode: "cold", median: median(cold), p95: percentile(cold, 95), runs: cold},
      {scenario: scenario.name, mode: "warm", median: median(warm), p95: percentile(warm, 95), runs: warm},
    ];
  } finally {
    rmSync(cacheDir, {recursive: true, force: true});
  }
}

function fmt(ms: number): string {
  return `${ms.toFixed(0).padStart(5)}ms`;
}

async function main() {
  const iters = Number(argv[2]) || 5;
  const filter = argv[3];
  const latencyMs = Number(env.BENCH_LATENCY_MS) || 0;

  const {server, url, requests} = await startBenchServer(0, latencyMs);
  stderr.write(`bench server: ${url}\n`);
  stderr.write(`iterations:   ${iters}\n`);
  if (latencyMs) stderr.write(`latency:      ${latencyMs}ms per request\n`);
  stderr.write("\n");

  const all: Result[] = [];
  try {
    for (const scenario of scenarios) {
      if (filter && !scenario.name.includes(filter)) continue;
      const startReq = requests.count;
      stderr.write(`> ${scenario.name.padEnd(20)} `);
      const [cold, warm] = await benchScenario(scenario, url, iters);
      const reqs = requests.count - startReq;
      stderr.write(`cold ${fmt(cold.median)} (p95 ${fmt(cold.p95)})  warm ${fmt(warm.median)} (p95 ${fmt(warm.p95)})  reqs=${reqs}\n`);
      all.push(cold, warm);
    }
  } finally {
    server.close();
  }

  stdout.write(`${JSON.stringify({iters, results: all}, null, 2)}\n`);
}

main().catch(err => {
  stderr.write(`bench failed: ${err?.stack || err}\n`);
  exit(1);
});
