import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {env} from "node:process";
import {fetchNpmInfo} from "./npm.ts";
import {type Config, type ModeContext, fetchTimeout} from "./shared.ts";

test("fetchNpmInfo resolves registries and tokens in pnpm's order: cli, pnpm_config__auth, workspace yaml, global yaml, global _auth, npmrc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "updates-pnpm-auth-"));
  const originals = {pnpm_config__auth: env.pnpm_config__auth, PNPM_CONFIG__AUTH: env.PNPM_CONFIG__AUTH, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME};
  const requests: Array<[string, string | null]> = [];
  const ctx = {fetchTimeout, noCache: true, doFetch: (url: string, opts: RequestInit) => {
    requests.push([url, new Headers(opts.headers).get("authorization")]);
    return Promise.resolve({ok: true, text: () => Promise.resolve("{}"), headers: new Headers()});
  }} as unknown as ModeContext;
  const fetch = (name: string, config: Config = {}) => fetchNpmInfo(name, "dependencies", config, {}, ctx, dir);
  try {
    mkdirSync(join(dir, "xdg", "pnpm"), {recursive: true});
    writeFileSync(join(dir, "xdg", "pnpm", "config.yaml"), [
      "registries:", "  '@gy': https://gy.test", "  '@ws': https://gy.test",
      "_auth:", "  https://ws.test/:", '    "@ws":', "      authToken: ws-scoped",
      "  https://ga.test:", '    "@":', "      authToken: ga-default", '    "@ga":', "      authToken: ga-scoped",
      '    "@gy":', "      authToken: ga-gy", '    "@ws":', "      authToken: ga-ws", "",
    ].join("\n"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "registries:\n  '@ws': https://ws.test\n  '@org': https://ws.test\n");
    writeFileSync(join(dir, ".npmrc"), [
      "registry=https://npmrc.test", "@org:registry=https://npmrc.test", "@ws:registry=https://npmrc.test",
      "@gy:registry=https://npmrc.test", "@ga:registry=https://npmrc.test", "@npmrc:registry=https://npmrc.test/sub/",
      "//env.test/:@org:_authToken=npmrc-org", "//ws.test/:@ws:_authToken=npmrc-ws",
      "//npmrc.test/sub/:_authToken=npmrc-default", "//npmrc.test/:@npmrc:_authToken=npmrc-scoped", "",
    ].join("\n"));
    env.XDG_CONFIG_HOME = join(dir, "xdg");
    env.pnpm_config__auth = "";
    env.PNPM_CONFIG__AUTH = JSON.stringify({"https://upper.test": {"@upper": {authToken: "upper"}}});
    await fetch("@upper/pkg");
    env.pnpm_config__auth = JSON.stringify({"https://env.test/": {"@org": {authToken: "env-org"}}});
    for (const name of ["@org/pkg", "@ws/pkg", "@gy/pkg", "@ga/pkg", "@npmrc/pkg", "lodash"]) await fetch(name);
    await fetch("lodash", {registry: "https://cli.test"});
    expect(requests).toEqual([
      ["https://upper.test/@upper%2fpkg", "Bearer upper"],
      ["https://env.test/@org%2fpkg", "Bearer env-org"],
      ["https://ws.test/@ws%2fpkg", "Bearer ws-scoped"],
      ["https://gy.test/@gy%2fpkg", null],
      ["https://ga.test/@ga%2fpkg", "Bearer ga-scoped"],
      ["https://npmrc.test/sub/@npmrc%2fpkg", "Bearer npmrc-scoped"],
      ["https://ga.test/lodash", "Bearer ga-default"],
      ["https://cli.test/lodash", null],
    ]);
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    rmSync(dir, {recursive: true});
  }
});
