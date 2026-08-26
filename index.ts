#!/usr/bin/env node
import {argv, stdout, stderr, exit} from "node:process";
import {runCli} from "./cli.ts";

for (const stream of [stdout, stderr]) (stream as any)._handle?.setBlocking?.(true);

exit(await runCli(argv.slice(2), {
  stdout: text => stdout.write(text),
  stdoutIsTTY: stdout.isTTY,
  moduleUrl: import.meta.url,
}));
