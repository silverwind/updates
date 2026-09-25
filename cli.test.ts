import {parseCliArgs} from "./cli.ts";
import {parseArgList, parseMixedArg} from "./config.ts";

test("recovers swallowed short option clusters", () => {
  const positionals = ["package.json"];
  expect(parseCliArgs(["-T", "-u", "package.json"])).toMatchObject({args: {timeout: true, update: true}, positionals});
  expect(parseCliArgs(["-T", "-uj", "package.json"])).toMatchObject({args: {timeout: true, update: true, json: true}, positionals});

  const recovered = parseCliArgs(["-i", "-ug", "react", "package.json"]);
  expect(recovered).toMatchObject({args: {include: [], update: true, greatest: ["react"]}, positionals});
  expect(parseMixedArg(recovered.args.include)).toBe(true);

  expect(parseMixedArg(parseCliArgs(["--greatest", "react", "--greatest"]).args.greatest)).toBe(true);
  expect(parseMixedArg(parseCliArgs(["-g", "react", "-g", "-uj"]).args.greatest)).toBe(true);
  expect(parseArgList(parseCliArgs(["-g", "-M", "-Mu"]).args.modes)).toEqual(["u"]); // a recovered `true` is not "all"

  expect(parseCliArgs([
    "-g", "-ulreact=*", "-l", "react=<19",
    "-g", "-uT1000", "-T", "2000",
    "-g", "-ufcluster.json", "-f", "explicit.json",
    "package.json",
  ])).toMatchObject({args: {pin: ["react=*", "react=<19"], timeout: "2000", file: ["cluster.json", "explicit.json"]}, positionals});

  expect(parseCliArgs(["-uj", "-T1000", "--", "--bogus", "-z", "-1"]))
    .toMatchObject({args: {update: true, json: true, timeout: "1000"}, positionals: ["--bogus", "-z", "-1"]});
});

test.each(["--bogus", "-z"])("rejects unknown option %s", option => {
  expect(() => parseCliArgs([option])).toThrow(`Unknown option: ${option}`);
});

test("rejects required options without a value", () => {
  for (const name of [
    "file", "modes", "include", "exclude", "pin", "cooldown", "types", "sockets", "timeout", "registry", "login",
    "logout",
  ]) {
    expect(() => parseCliArgs([`--${name}`])).toThrow(`Missing value for --${name}`);
  }
  for (const name of ["allow-downgrade", "greatest", "minor", "patch", "prerelease", "release"]) {
    expect(() => parseCliArgs([`--${name}`])).not.toThrow();
  }
});
