# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for dependency updates. It is typically able to complete in less than a second. Supported dependencies are:

- npm via `package.json`
- poetry via `pyproject.toml`
- go via `go.mod` (checking only currently, disabled by default when directory is used)

# Usage

```bash
# check for updates
npx updates

# update package.json and install new dependencies with your favorite package manager
npx updates -u && npm i
```

## Options

See `--help`. Options that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times. If an option has a optional `pkg` argument but none is given, the option will be applied to all packages instead.

All `pkg` options support glob matching via [picomatch](https://github.com/micromatch/picomatch) or regex (on CLI, wrap the regex in slashes, e.g. `'/^foo/'`).

## Config File

The config file is used to configure certain options of the module. It is placed at `updates.config.{js,ts,mjs,mts}` or `.config/updates.config.{js,ts,mjs,mts}`, relative to `package.json` / `pyproject.toml` / `go.mod`.

Since Node.js v23.6.0, typescript configuration files work out of the box. For Node between 22.5.x and v23.6.0, set `NODE_OPTIONS="--experimental-strip-types"` in your environment.

```ts
export default {
  exclude: [
    "semver",
    "@vitejs/*",
    /^react(-dom)?$/,
  ],
};
```

### Config Options

- `include` *Array\<string | RegExp>*: Array of dependencies to include
- `exclude` *Array\<string | RegExp>*: Array of dependencies to exclude
- `types` *Array\<string>*: Array of dependency types
- `registry` *string*: URL to npm registry

CLI arguments have precedence over options in the config file, except for `include` and `exclude` options which are merged.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
