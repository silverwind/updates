# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://api.travis-ci.org/silverwind/updates.svg?style=flat)](https://travis-ci.org/silverwind/updates)
> Fast npm dependency updating tool

<p align="center">
  <img src="https://i.imgur.com/tI7rp0g.png"/>
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
    -P, --patch [<pkg,...>]       Consider only up to semver-patch
    -m, --minor [<pkg,...>]       Consider only up to semver-minor
    -E, --error-on-outdated       Exit with error code 2 on outdated packages
    -r, --registry <url>          Use given registry URL
    -f, --file <path>             Use given package.json file or module directory
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -e chalk
    $ updates -u -s minor
    $ updates -u -t devDependencies
```

## Examples

### Check for updates
```console
$ updates
NAME                        OLD       NEW       INFO
string-width                2.1.1     3.0.0     https://github.com/sindresorhus/string-width
eslint                      5.9.0     5.10.0    https://github.com/eslint/eslint
eslint-config-silverwind    2.0.11    2.0.12    https://github.com/silverwind/eslint-config-silverwind
```
### Update package.json
```console
$ updates -u
NAME                        OLD       NEW       INFO
string-width                2.1.1     3.0.0     https://github.com/sindresorhus/string-width
eslint                      5.9.0     5.10.0    https://github.com/eslint/eslint
eslint-config-silverwind    2.0.11    2.0.12    https://github.com/silverwind/eslint-config-silverwind
╭────────────────────────╮
│  package.json updated  │
╰────────────────────────╯
```
### JSON Output

The JSON output is an object with possible properties `results`, `message` and `error`:

```console
$ updates -j | jq
{
  "results": {
    "string-width": {
      "old": "2.1.1",
      "new": "3.0.0",
      "info": "https://github.com/sindresorhus/string-width"
    },
    "eslint": {
      "old": "5.9.0",
      "new": "5.10.0",
      "info": "https://github.com/eslint/eslint"
    },
    "eslint-config-silverwind": {
      "old": "2.0.11",
      "new": "2.0.12",
      "info": "https://github.com/silverwind/eslint-config-silverwind"
    }
  }
}
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
