# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for npm and poetry dependency updates of the current project and optionally updates `package.json`/`pyproject.toml`. It is highly configurable and is typically able to complete in less than a second.

# Usage

`bun` and `node` are officially supported. `deno` should work as well. For bun, replace `npx` with `bunx` and `npm` with `bun`.

```bash
# check for updates
npx updates

# update package.json and install new dependencies
npx updates -u && npm i
```

## Options

See `--help`. Options that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times.

If an option has a optional `pkg` argument but none is given, the option will be applied to all packages instead.

All `pkg` options support glob matching via [picomatch](https://github.com/micromatch/picomatch) or regex (on CLI, wrap the regex in slashes, e.g. `'/^foo/'`).

## Notes

The module uses global `fetch` under the hood. In Node.js HTTP proxies from environment are [not supported](https://github.com/nodejs/undici/issues/1650), but it's still possible to enable `updates` to use them by installing the `undici` dependency into your project.

## Config File

The config file is used to configure certain options of the module. CLI arguments have precedence over options in the config file, except for `include` and `exclude` options which are merged.

```js
export default {
  exclude: [
    "semver",
    "@vitejs/*",
    /^react(-dom)?$/,
  ],
};
```

### Config File Locations

The config file can be placed in these locations, relative to `package.json`:

- `updates.config.js`
- `updates.config.mjs`
- `.config/updates.js`
- `.config/updates.mjs`

### Config File Options

- `include` *Array[String|Regexp]*: Array of dependencies to include
- `exclude` *Array[String|Regexp]*: Array of dependencies to exclude
- `types` *Array[String]*: Array of dependency types
- `registry` *String*: URL to npm registry

© [silverwind](https://github.com/silverwind), distributed under BSD licence
