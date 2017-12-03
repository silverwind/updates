# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://api.travis-ci.org/silverwind/updates.svg?style=flat)](https://travis-ci.org/silverwind/updates)
> Fast npm dependency update checking tool

`updates` is a lightweight tool that checks for npm dependency updates and optionally automatically updates `package.json`. Unlike other similar tools, it has no dependency on any package manager but instead works directly with the npm registry.

## Install:

```sh
$ npm install -g updates
$ yarn global add updates
```

## Example:
```sh
$ updates
NAME      RANGE      NEWRANGE
got       ^8.0.1     ^8.0.1
semver    ^5.4.1     ^5.4.1
eslint    ^4.12.1    ^4.12.1
$ updates -u
package.json updated!
$ time updates
All packages are up to date.
updates  0.28s user 0.06s system 82% cpu 0.417 total
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
