import {parseCliArgs} from "./cli.ts";
import {parseArgList, parseMixedArg} from "./config.ts";

test("recovers swallowed short option clusters", () => {
  const single = parseCliArgs(["-T", "-u", "package.json"]);
  expect(single.args).toMatchObject({timeout: true, update: true});
  expect(single.positionals).toEqual(["package.json"]);

  const clustered = parseCliArgs(["-T", "-uj", "package.json"]);
  expect(clustered.args).toMatchObject({timeout: true, update: true, json: true});
  expect(clustered.positionals).toEqual(["package.json"]);

  const {args, positionals} = parseCliArgs(["-i", "-ug", "react", "package.json"]);
  expect(args.include).toEqual([]);
  expect(parseMixedArg(args.include)).toBe(true);
  expect(args.update).toBe(true);
  expect(args.greatest).toEqual(["react"]);
  expect(positionals).toEqual(["package.json"]);

  expect(parseMixedArg(parseCliArgs(["--greatest", "react", "--greatest"]).args.greatest)).toBe(true);
  expect(parseMixedArg(parseCliArgs(["-g", "react", "-g", "-uj"]).args.greatest)).toBe(true);
  expect(parseArgList(parseCliArgs(["-g", "-M", "-Mu"]).args.modes)).toEqual(["u"]); // a recovered `true` is not "all"

  const ordered = parseCliArgs([
    "-g", "-ulreact=*", "-l", "react=<19",
    "-g", "-uT1000", "-T", "2000",
    "-g", "-ufcluster.json", "-f", "explicit.json",
    "package.json",
  ]);
  expect(ordered.args.pin).toEqual(["react=*", "react=<19"]);
  expect(ordered.args.timeout).toBe("2000");
  expect(ordered.args.file).toEqual(["cluster.json", "explicit.json"]);
  expect(ordered.positionals).toEqual(["package.json"]);

  const accepted = parseCliArgs(["-uj", "-T1000", "--", "--bogus", "-z", "-1"]);
  expect(accepted.args).toMatchObject({update: true, json: true, timeout: "1000"});
  expect(accepted.positionals).toEqual(["--bogus", "-z", "-1"]);
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
