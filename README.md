# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for npm dependency updates of the current project and optionally updates `package.json`. It is highly configurable and is typically able to complete in less than a second.

# Installation

```bash
npm i -D updates
```

# Usage

Check for updates:

```bash
npx updates
```

Update `package.json` and install new dependencies:

```bash
npx updates -u
npm i
```

## Deno

There is experimental support for deno, run via:

```bash
deno run -A npm:updates
```

## Options

See `--help` or below for the available options. Option that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times. If an option has a optional `pkg` argument but none is given, the option will be applied to all packages instead.

```
usage: updates [options]

  Options:
    -u, --update                       Update versions and write package.json
    -p, --prerelease [<pkg,...>]       Consider prerelease versions
    -R, --release [<pkg,...>]          Only use release versions, may downgrade
    -g, --greatest [<pkg,...>]         Prefer greatest over latest version
    -i, --include <pkg,...>            Include only given packages
    -e, --exclude <pkg,...>            Exclude given packages
    -t, --types <type,...>             Check only given dependency types
    -P, --patch [<pkg,...>]            Consider only up to semver-patch
    -m, --minor [<pkg,...>]            Consider only up to semver-minor
    -d, --allow-downgrade [<pkg,...>]  Allow version downgrades when using latest version
    -E, --error-on-outdated            Exit with code 2 when updates are available and 0 when not
    -U, --error-on-unchanged           Exit with code 0 when updates are available and 2 when not
    -r, --registry <url>               Override npm registry URL
    -G, --githubapi <url>              Override Github API URL
    -f, --file <path>                  Use given package.json file or module directory
    -S, --sockets <num>                Maximum number of parallel HTTP sockets opened. Default: 96
    -j, --json                         Output a JSON object
    -c, --color                        Force-enable color output
    -n, --no-color                     Disable color output
    -v, --version                      Print the version
    -V, --verbose                      Print verbose output to stderr
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -m -e eslint
    $ updates -u -U && rm -rf node_modules && npm i
```

## JSON Output

The JSON output is an object with possible properties `results`, `message` and `error`:

```bash
updates -j | jq
{
  "results": {
    "dependencies": {
      "p-map": {
        "old": "3.0.0",
        "new": "4.0.0",
        "info": "https://github.com/sindresorhus/p-map",
        "age": "3 days"
      }
    },
    "devDependencies": {
      "eslint": {
        "old": "6.7.2",
        "new": "6.8.0",
        "info": "https://github.com/eslint/eslint",
        "age": "3 months"
      }
    }
  }
}
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
