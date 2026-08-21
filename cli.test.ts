import {parseCliArgs} from "./cli.ts";

test("recovers swallowed short option clusters", () => {
  const single = parseCliArgs(["-T", "-u", "package.json"]);
  expect(single.args).toMatchObject({timeout: true, update: true});
  expect(single.positionals).toEqual(["package.json"]);

  const clustered = parseCliArgs(["-T", "-uj", "package.json"]);
  expect(clustered.args).toMatchObject({timeout: true, update: true, json: true});
  expect(clustered.positionals).toEqual(["package.json"]);

  const {args, positionals} = parseCliArgs(["-i", "-ug", "react", "package.json"]);
  expect(args.include).toEqual([]);
  expect(args.update).toBe(true);
  expect(args.greatest).toEqual(["react"]);
  expect(positionals).toEqual(["package.json"]);
});
