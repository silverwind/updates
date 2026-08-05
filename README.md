# updates
[![](https://img.shields.io/npm/v/updates.svg?style=flat)](https://www.npmjs.org/package/updates) [![](https://img.shields.io/npm/dm/updates.svg)](https://www.npmjs.org/package/updates) [![](https://packagephobia.com/badge?p=updates)](https://packagephobia.com/result?p=updates) [![](https://depx.co/api/badge/updates)](https://depx.co/pkg/updates)

![](./screenshot.png)

`updates` is a CLI tool which checks for dependency updates. It is typically able to complete in less than a second.

## Supported files

- `package.json`, `pnpm-workspace.yaml` - npm dependencies
- `pyproject.toml` - uv dependencies
- `go.mod`, `go.work` - go dependencies
- `Cargo.toml` - rust dependencies, including workspaces
- `.{github,gitea,forgejo}/workflows` - actions and docker images
- `Dockerfile*`, `compose*.{yml,yaml}`, `docker-*.{yml,yaml}` - docker images
- `Makefile`, `*.mk` - go tool versions in `go install` paths and docker image tags

A docker image is keyed by image *and* tag, so a multi-stage file that references one image at two tags yields a row for each, labelled `image:tag`. Only LTS `ubuntu` tags are offered, as Renovate does.

A `pnpm-workspace.yaml` `catalog:` and `catalogs:` entry is resolved and rewritten in the workspace file. A member's `catalog:` or `catalog:<name>` value only names a catalog, so it is not reported on its own and stays as authored. An `npm:<pkg>@<range>` alias is resolved as the aliased package while the manifest keeps the alias as its key, and the `npm:<pkg>@` prefix is written back with the new range.

## Usage

```bash
# check for updates
npx updates

# update package.json and install new dependencies
npx updates -u && npm i
```

## Options

|Option|Description|
|:-|:-|
|`-u, --update`|Update versions and write dependency file|
|`-f, --file <path,...>`|File or directory to use, defaults to current directory|
|`-M, --modes <mode,...>`|Which modes to enable. Either `npm`, `pypi`, `go`, `cargo`, `actions`, `docker`, `make`. Default: `npm,pypi,go,cargo,actions,docker,make`|
|`-i, --include <dep,...>`|Include only given dependencies|
|`-e, --exclude <dep,...>`|Exclude given dependencies|
|`-l, --pin <dep=range>`|Pin dependency to given semver range|
|`-C, --cooldown <duration>`|Minimum dependency age. A bare number is days, or suffix one of `y` (365 days), `m` (30 days), `w`, `d`, `h`, `s`, so `5m` is five months and there is no minutes unit. A version the registry publishes no date for is never offered while a cooldown is active|
|`-p, --prerelease [<dep,...>]`|Consider prerelease versions|
|`-R, --release [<dep,...>]`|Only use release versions, may downgrade|
|`-g, --greatest [<dep,...>]`|Prefer greatest over latest version|
|`-t, --types <type,...>`|Dependency types to update|
|`-P, --patch [<dep,...>]`|Consider only up to semver-patch|
|`-m, --minor [<dep,...>]`|Consider only up to semver-minor|
|`-d, --allow-downgrade [<dep,...>]`|Allow version downgrades when using latest version|
|`-s, --sockets <num>`|Maximum number of parallel HTTP sockets opened. Default: 25|
|`-T, --timeout <ms>`|Network request timeout in ms (go probes use half). Default: 5000|
|`-r, --registry <url>`|Override npm registry URL|
|`-I, --indirect`|Include indirect Go dependencies|
|`-E, --error-on-outdated`|Exit with code 2 when updates are available and 0 when not|
|`-U, --error-on-unchanged`|Exit with code 0 when updates are available and 2 when not|
|`-j, --json`|Output a JSON object|
|`-x, --no-cache`|Disable HTTP cache|
|`-c, --color`|Force color output|
|`-n, --no-color`|Disable color output|
|`-v, --version`|Print the version|
|`-V, --verbose`|Print verbose output to stderr|
|`-h, --help`|Print the help|

Options that take multiple arguments can take them either via comma-separated value or by specifying the option multiple times. If an option has a optional `dep` argument but none is given, the option will be applied to all dependencies instead. The `dep` options support glob matching via `*` or regex (on CLI, wrap the regex in slashes, e.g. `'/^foo/'`), except `-l/--pin`, whose `dep` is an exact dependency name.

An invalid `--sockets`, `--timeout` or `--pin` range aborts the run rather than being ignored. `--sockets` and `--timeout` are rounded to a whole number.

## Failed Lookups

A dependency whose version could not be looked up is reported on its own and does not hold back the other results, which are still printed and written. Such a run always exits with code 1, ahead of any `-E` or `-U` signal, so a failure never passes as either "outdated" or "up to date". With `-j` the failures are listed in an `errors` array of `{mode, type, name, error}` objects alongside any `results`.

Without `-j` a failure prints to stdout as `mode name: error`, dropping the `type`, so a docker or make failure names no file. A run where every lookup failed prints those lines alone, without the usual "All dependencies are up to date." message.

## Config File

The module can be configured with `updates.config.{ts,js,mjs,mts}` in your repo root.

```ts
import type {Config} from "updates";

export default {
  pin: {
    "typescript": "^6",
  },
} satisfies Config;
```

### Config Options

- `include` *Array\<string | RegExp>*: Array of dependencies to include
- `exclude` *Array\<string | RegExp>*: Array of dependencies to exclude
- `types` *Array\<string>*: Array of dependency types to use
- `registry` *string*: URL to npm registry
- `cooldown` *number | string*: Minimum dependency age. A bare number is days, or suffix one of `y` (365 days), `m` (30 days), `w`, `d`, `h`, `s`, so `"5m"` is five months and there is no minutes unit. A version the registry publishes no date for is never offered while a cooldown is active
- `pin` *Record\<string, string>*: Pin dependencies to semver ranges, keyed by exact dependency name
- `files` *Array\<string>*: File or directory paths to use
- `modes` *Array\<string>*: Which modes to enable
- `update` *boolean*: Update versions and write dependency files
- `indirect` *boolean*: Include indirect Go dependencies
- `timeout` *number*: Network request timeout in ms
- `sockets` *number*: Maximum number of parallel HTTP sockets
- `noCache` *boolean*: Disable HTTP cache
- `json` *boolean*: Output a JSON object
- `verbose` *boolean*: Print verbose output to stderr
- `errorOnOutdated` *boolean*: Exit with code 2 when updates are available
- `errorOnUnchanged` *boolean*: Exit with code 0 when updates are available and 2 when not
- `color` *boolean*: Force color output
- `noColor` *boolean*: Disable color output
- `greatest` *boolean | Array\<string | RegExp>*: Prefer greatest over latest version
- `prerelease` *boolean | Array\<string | RegExp>*: Consider prerelease versions
- `release` *boolean | Array\<string | RegExp>*: Only use release versions
- `patch` *boolean | Array\<string | RegExp>*: Consider only up to semver-patch
- `minor` *boolean | Array\<string | RegExp>*: Consider only up to semver-minor
- `allowDowngrade` *boolean | Array\<string | RegExp>*: Allow version downgrades
- `overrides` *Array\<Override>*: Per-package option overrides matched by name (see [Overrides](#overrides))
- `inherit` *object*: Opt-in to inheriting select fields from other tools' configs (see [Renovate config](#renovate-config))

CLI arguments have precedence over options in the config file. `include`, `exclude`, and `pin` options are merged.

### Overrides

`overrides` applies options to a subset of dependencies, matched by name. Each override has `include` and/or `exclude` patterns (glob or `RegExp`, omit `include` to match all) plus any of these options: `cooldown`, `greatest`, `prerelease`, `release`, `patch`, `minor`, `allowDowngrade`. A matching override takes precedence over the corresponding top-level option, and when several overrides match the same dependency, the last one wins.

```ts
import type {Config} from "updates";

export default {
  cooldown: "7d",
  overrides: [
    {include: ["@myorg/*"], cooldown: 0},      // no cooldown for your own scope
    {include: [/^@aws-sdk/], cooldown: "14d"}, // longer cooldown for a noisy publisher
    {exclude: ["typescript"], greatest: true}, // greatest for everything but typescript
  ],
} satisfies Config;
```

A `cooldown` of `0` in an override disables a global cooldown for the matched dependencies. `patch` takes precedence over `minor`, so an override that sets `minor` has no effect while `patch` is enabled for that dependency. `pin` is not an override option since it is already per-package via [`pin`](#config-options).

### Renovate config

If a [Renovate](https://docs.renovatebot.com/) config is found, `ignoreDeps`, `enabled` and `allowedVersions` in `packageRules` are inherited as `include`/`exclude`/`pin`, evaluated in order as Renovate does. A rule matching on anything but package names is skipped, and a preset in `extends` that cannot be fetched is an error. `allowedVersions` filters candidates but never downgrades, as it is a ceiling in Renovate too. `minimumReleaseAge` is *not* inherited as `cooldown` by default, opt in via:

```ts
export default {
  inherit: {
    renovate: {cooldown: true},
  },
} satisfies Config;
```

Values in `updates.config` override anything inherited. `pin` merges per dependency, where an authored entry replaces the ceiling of the same name and may downgrade into its range.

## API

`updates` can be used as a library:

```ts
import {updates} from "updates";

const output = await updates({
  files: ["package.json"],
  include: [/^react/],
  modes: ["npm"],
});
//=> {
//=>   "results": {
//=>     "npm": {
//=>       "dependencies": {
//=>         "react": {
//=>           "old": "18.0.0",
//=>           "new": "19.2.0",
//=>           "info": "https://github.com/facebook/react",
//=>           "age": "2d"
//=>         }
//=>       }
//=>     }
//=>   }
//=> }
```

The `updates()` function accepts all [config options](#config-options). A lookup that failed is reported in an `errors` array on the return value, absent when nothing failed, see [Failed Lookups](#failed-lookups).

## Environment Variables

|Variable|Description|
|:-|:-|
|`UPDATES_FORGE_TOKENS`|Comma-separated list of `host:token` pairs for authenticating against forge APIs (e.g. `github.com:ghp_xxx,localhost:3500:tok_xxx`). The host must match the URL exactly, port included|
|`UPDATES_GITHUB_API_TOKEN`|GitHub API token for authenticating forge API requests|
|`GITHUB_API_TOKEN`|Fallback GitHub API token|
|`GH_TOKEN`|Fallback GitHub API token|
|`GITHUB_TOKEN`|Fallback GitHub API token|
|`HOMEBREW_GITHUB_API_TOKEN`|Fallback GitHub API token|
|`GOPROXY`|Go module proxy list, honored as go itself does: `,` falls through to the next entry when the module is absent there, `\|` on any error, `off` fails the lookup and `direct` resolves through the VCS, both ending the list. A bare host gains an implicit `https://`. `direct` runs the `go` binary, so under the default list any module the proxy does not carry needs `go` on `PATH`. Default: `https://proxy.golang.org,direct`|
|`GONOPROXY`|Comma-separated list of Go module patterns to fetch directly, bypassing the proxy. Patterns are matched with go's `path.Match`, where `*` does not cross a `/`, and a match on a leading path element covers the whole subtree|
|`GOPRIVATE`|Fallback for `GONOPROXY` when not set|

Token resolution order for forge APIs: `UPDATES_FORGE_TOKENS` (matched by host) > `UPDATES_GITHUB_API_TOKEN` > `GITHUB_API_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > `HOMEBREW_GITHUB_API_TOKEN`. The GitHub token fallback is only sent to GitHub itself; any other forge host (e.g. one referenced in a workflow `uses:`) is authenticated only with a matching `UPDATES_FORGE_TOKENS` entry, and otherwise receives no credentials.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
