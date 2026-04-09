import {nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig(
  nodeLib({
    url: import.meta.url,
    entry: ["index.ts", "cli.ts"],
    minify: true,
    dts: {entry: ["index.ts"]},
    outputOptions: {
      codeSplitting: true,
      chunkFileNames: "[name].js",
      manualChunks: (id: string) => id.includes("/cli.ts") ? undefined : "shared",
    },
  }),
);
