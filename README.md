# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates) [![](https://depx.co/api/badge/updates)](https://depx.co/pkg/updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for dependency updates. It is typically able to complete in less than a second.

# Supported files

- `package.json`: supports all npm package managers
- `pyproject.toml`: supports formats of `uv` and `poetry`
- `go.mod`: experimental go support, will not be discovered go.mod in directory mode

# Usage

```bash
# check for updates
npx updates

# update package.json and install new dependencies with your favorite package manager
npx updates -u && npm i
```

## Options

See `--help`. Options that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times. If an option has a optional `pkg` argument but none is given, the option will be applied to all packages instead.

All `pkg` options support glob matching via `*` or regex (on CLI, wrap the regex in slashes, e.g. `'/^foo/'`).

## Config File

The config file is used to configure certain options of the module. It is placed at `updates.config.{js,ts,mjs,mts}` or `.config/updates.config.{js,ts,mjs,mts}`, relative to `package.json` / `pyproject.toml` / `go.mod`.

Since Node.js v22.18.0, typescript configuration files work out of the box. For older node versions, set `NODE_OPTIONS="--experimental-strip-types"` in your environment.

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

CLI arguments have precedence over options in the config file. `include`, `exclude`, and `pin` options are merged, with CLI values taking precedence for the same package.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
