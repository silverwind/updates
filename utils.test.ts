import {parseUvDependencies, makeGoProxies} from "./utils.ts";

test("parseUvDependencies", () => {
  expect(parseUvDependencies([
    "tqdm >=4.66.2,<5",
    "torch ==2.2.2",
    "transformers[torch] >=4.39.3",
    "mollymawk ==0.1.0",
    "types-requests==2.32.0.20240622",
    "types-paramiko==3.4.0.20240423",
    "ty>=0.0.1a15",
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
      {
        "name": "types-requests",
        "version": "2.32.0.20240622",
      },
      {
        "name": "types-paramiko",
        "version": "3.4.0.20240423",
      },
      {
        "name": "ty",
        "version": "0.0.1a15",
      },
    ]
  `);
});

test("makeGoProxies", () => {
  expect(makeGoProxies(undefined, "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://bar.com",
    ]
  `);
  expect(makeGoProxies("", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://bar.com",
    ]
  `);
  expect(makeGoProxies("foo.com", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
    ]
  `);
  expect(makeGoProxies("foo.com,baz.com", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
      "https://baz.com",
    ]
  `);
  expect(makeGoProxies("foo.com|baz.com", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
      "https://baz.com",
    ]
  `);
  expect(makeGoProxies("foo.com,direct", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
    ]
  `);
  expect(makeGoProxies("foo.com|direct", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
    ]
  `);
  expect(makeGoProxies("direct", "https://bar.com")).toMatchInlineSnapshot(`[]`);
  expect(makeGoProxies("off|direct", "https://bar.com")).toMatchInlineSnapshot(`[]`);
  expect(makeGoProxies("foo.com|off|direct", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "https://foo.com",
    ]
  `);
  expect(makeGoProxies("http://foo.com", "https://bar.com")).toMatchInlineSnapshot(`
    [
      "http://foo.com",
    ]
  `);
});
