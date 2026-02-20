# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates) [![](https://depx.co/api/badge/updates)](https://depx.co/pkg/updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for dependency updates. It is typically able to complete in less than a second.

# Supported files

- `package.json` - supports all npm package managers
- `pyproject.toml` - supports `uv` and `poetry`
- `go.mod` - supports go dependencies
- `.{github,gitea,forgejo}` - supports actions

# Usage

```bash
# check for updates
npx updates

# update package.json and install new dependencies
npx updates -u && npm i
```

## Options

|Option|Description|
|:-|:-|
|`-u, --update`|Update versions and write package file|
|`-f, --file <path,...>`|File or directory to use, defaults to current directory|
|`-i, --include <pkg,...>`|Include only given packages|
|`-e, --exclude <pkg,...>`|Exclude given packages|
|`-p, --prerelease [<pkg,...>]`|Consider prerelease versions|
|`-R, --release [<pkg,...>]`|Only use release versions, may downgrade|
|`-g, --greatest [<pkg,...>]`|Prefer greatest over latest version|
|`-t, --types <type,...>`|Dependency types to update|
|`-P, --patch [<pkg,...>]`|Consider only up to semver-patch|
|`-m, --minor [<pkg,...>]`|Consider only up to semver-minor|
|`-d, --allow-downgrade [<pkg,...>]`|Allow version downgrades when using latest version|
|`-C, --cooldown <days>`|Minimum package age in days|
|`-l, --pin <pkg=range>`|Pin package to given semver range|
|`-E, --error-on-outdated`|Exit with code 2 when updates are available and 0 when not|
|`-U, --error-on-unchanged`|Exit with code 0 when updates are available and 2 when not|
|`-r, --registry <url>`|Override npm registry URL|
|`-S, --sockets <num>`|Maximum number of parallel HTTP sockets opened. Default: 96|
|`-M, --modes <mode,...>`|Which modes to enable. Either `npm`, `pypi`, `go`. Default: `npm,pypi,go`|
|`-j, --json`|Output a JSON object|
|`-n, --no-color`|Disable color output|
|`-v, --version`|Print the version|
|`-V, --verbose`|Print verbose output to stderr|
|`-h, --help`|Print the help|

Options that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times. If an option has a optional `pkg` argument but none is given, the option will be applied to all packages instead. All `pkg` options support glob matching via `*` or regex (on CLI, wrap the regex in slashes, e.g. `'/^foo/'`).

## Config File

The module can be configured with `updates.config.{ts,js,mjs,mts}` in your repo root.

```ts
import type {Config} from "updates";

export default {
  exclude: [
    "semver",
    "@vitejs/*",
    /^react(-dom)?$/,
  ],
  pin: {
    "typescript": "^5.0.0",
  },
} satisfies Config;
```

### Config Options

- `include` *Array\<string | RegExp>*: Array of packages to include
- `exclude` *Array\<string | RegExp>*: Array of packages to exclude
- `types` *Array\<string>*: Array of package types to use
- `registry` *string*: URL to npm registry
- `minAge` *number*: Minimum package age in hours
- `pin` *Record\<string, string>*: Pin packages to semver ranges

CLI arguments have precedence over options in the config file. `include`, `exclude`, and `pin` options are merged.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
