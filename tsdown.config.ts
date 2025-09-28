import {nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig(nodeLib({
  url: import.meta.url,
  minify: true,
  sourcemap: false,
}));
