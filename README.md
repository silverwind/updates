# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for npm dependency updates of the current project and optionally updates `package.json`. It is highly configurable and is typically able to complete in less than a second.

## Usage

```bash
# install globally
npm i -g updates

# or install locally as a devDependency and run via `npx updates` or `yarn run updates`
npm i -D updates
```

Then, check for new updates:
```bash
updates
```

When changes are satisfactory, update `package.json` and reinstall modules:
```bash
updates -u && npm i
```

To only reinstall modules when updates are available:
```bash
updates -uU && npm i
```

On a CI, it might be desireable to fail a build when updates are available:
```bash
updates -E
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
    -h, --help                         Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -m -e eslint
    $ updates -u -U && rm -rf node_modules && npm i
```

## JSON Output

The JSON output is an object with possible properties `results`, `message` and `error`:

```console
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
