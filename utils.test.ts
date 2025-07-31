import {parseUvDependencies} from "./utils.ts";

test("parseUvDependencies", () => {
  expect(parseUvDependencies([
    "tqdm >=4.66.2,<5",
    "torch ==2.2.2",
    "transformers[torch] >=4.39.3",
    "mollymawk ==0.1.0"
  ])).toMatchInlineSnapshot(`
    [
      {
        "name": "torch",
        "version": "2.2.2",
      },
      {
        "name": "transformers[torch]",
        "version": "4.39.3",
      },
      {
        "name": "mollymawk",
        "version": "0.1.0",
      },
    ]
  `);
});
