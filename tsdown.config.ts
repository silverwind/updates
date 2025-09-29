import {nodeCli} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig(nodeCli({
  url: import.meta.url,
  minify: true,
  sourcemap: false,
}));
