# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://api.travis-ci.org/silverwind/updates.svg?style=flat)](https://travis-ci.org/silverwind/updates)
> Fast npm dependency updating tool

<p align="center">
  <img src="https://i.imgur.com/jBjNoKO.png"/>
</p>

`updates` checks for npm dependency updates and optionally updates `package.json`. It is typically able to complete in less than a second. It can also output JSON for easy integration.

## Install

```console
$ npm i -g updates
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
package.json updated!
```
### JSON Output

The resulting JSON object always has the key `results` which lists available updates. Additionally, `message` and `error` properties can be present.

```console
$ updates -j
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
