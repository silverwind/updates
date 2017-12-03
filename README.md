# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://api.travis-ci.org/silverwind/updates.svg?style=flat)](https://travis-ci.org/silverwind/updates)
> Fast npm dependency updating tool

<p align="center">
  <img src="https://i.imgur.com/jBjNoKO.png"/>
</p>

`updates` checks for npm dependency updates and optionally updates `package.json`. It talks directly to the npm registry and is typically able to complete in under a second. It can also output JSON.

## Install

```console
$ npm install -g updates
```

## Examples
### Check for updates
```console
$ updates
PACKAGE         OLD       NEW
got             ^7.1.0    ^8.0.1
p-timeout       ^1.2.0    ^2.0.1
```
### Update package.json
```console
$ updates -u
PACKAGE         OLD       NEW
got             ^7.1.0    ^8.0.1
p-timeout       ^1.2.0    ^2.0.1
package.json updated!
```
### JSON Output
```console
$ updates -j
[
  {
    "name": "got",
    "range": "^7.1.0",
    "newRange": "^8.0.1"
  },
  {
    "name": "p-timeout",
    "range": "^1.2.0",
    "newRange": "^2.0.1"
  }
]
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
