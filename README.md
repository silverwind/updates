# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://api.travis-ci.org/silverwind/updates.svg?style=flat)](https://travis-ci.org/silverwind/updates)
> Fast npm dependency updating tool

<p align="center">
  <img src="https://i.imgur.com/jBjNoKO.png"/>
</p>

`updates` is a CLI tool which checks for npm dependency updates of the current project and optionally updates `package.json`. It is typically able to complete in less than a second.

## Install

```console
$ npm i -g updates
```

# Usage
```
usage: updates [options]

  Options:
    -u, --update                  Update versions and write package.json
    -p, --prerelease [<pkg,...>]  Consider prerelease versions
    -g, --greatest [<pkg,...>]    Prefer greatest over latest version
    -i, --include <pkg,...>       Include only given packages
    -e, --exclude <pkg,...>       Exclude given packages
    -t, --types <type,...>        Check only given dependency types
    -E, --error-on-outdated       Exit with error code 2 on outdated packages
    -r, --registry <url>          Use given registry URL
    -f, --file <path>             Use given package.json file
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -e semver
    $ updates -u -t devDependencies
```

## Examples

### Check for updates
```console
$ updates
NAME        OLD       NEW
chalk       1.3.0     2.3.0
got         ^7.0.1    ^8.0.1
minimist    ^1.0.0    ^1.2.0
```
### Update package.json
```console
$ updates -u
NAME        OLD       NEW
chalk       1.3.0     2.3.0
got         ^7.0.1    ^8.0.1
minimist    ^1.0.0    ^1.2.0
╭────────────────────────╮
│  package.json updated  │
╰────────────────────────╯
```
### JSON Output

The JSON output is an option with possible properties `results`, `message` and `error`:

```console
$ updates -j | jq
{
  "results": {
    "chalk": {
      "old": "1.3.0",
      "new": "2.3.0"
    },
    "got": {
      "old": "^7.0.1",
      "new": "^8.0.1"
    },
    "minimist": {
      "old": "^1.0.0",
      "new": "^1.2.0"
    }
  }
}
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
