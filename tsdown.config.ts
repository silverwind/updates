import {nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig(nodeLib({
  url: import.meta.url,
  entry: "index.ts", // https://github.com/rolldown/tsdown/issues/518
  minify: true,
  sourcemap: false,
}));
