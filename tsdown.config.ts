import {nodeCli, nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig([
  nodeLib({url: import.meta.url}),
  nodeCli({url: import.meta.url, entry: ["cli.ts"]}),
]);
