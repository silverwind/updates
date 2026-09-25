#!/usr/bin/env node
import {argv, stdout, stderr, exit, platform, versions} from "node:process";
import {runCli} from "./cli.ts";

for (const stream of [stdout, stderr]) (stream as any)._handle?.setBlocking?.(true);

const exitCode = await runCli(argv.slice(2), {
  stdout: text => stdout.write(text),
  stdoutIsTTY: stdout.isTTY,
  moduleUrl: import.meta.url,
});
if (platform === "win32" && Number(versions.node.split(".")[0]) >= 23) await new Promise(resolve => setTimeout(resolve, 50));
exit(exitCode);
