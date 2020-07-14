# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates)
> Flexible npm dependency update tool

![](./screenshot.png)

`updates` is a CLI tool which checks for npm dependency updates of the current project and optionally updates `package.json`. It is highly configurable and is typically able to complete in less than a second.

```
$ updates
NAME      OLD      NEW      AGE       INFO
p-map     3.0.0    4.0.0    3 days    https://github.com/sindresorhus/p-map
rrdir     4.0.0    5.0.0    11 days   https://github.com/silverwind/rrdir
eslint    6.7.2    6.8.0    3 months  https://github.com/eslint/eslint
rimraf    3.0.0    3.0.2    28 days   https://github.com/isaacs/rimraf
versions  7.0.5    8.2.3    1 day     https://github.com/silverwind/versions
updates   6941e05  815cc8b  16 hours  https://github.com/silverwind/updates
```

## Usage

```bash
npm i -D updates
```

Then, check for new updates:
```bash
npx updates
```

When changes are satisfactory, update `package.json` and reinstall modules:
```bash
npx updates -u && rm -rf node_modules && npm i
```

To only reinstall modules when updates are available:
```bash
npx updates -uU && rm -rf node_modules && npm i
```

On a CI, it might be desireable to fail a build when updates are available:
```bash
npx updates -E
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
$ updates -j | jq
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
