import {parseCliArgs} from "./cli.ts";
import {parseMixedArg} from "./config.ts";

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
});
