import {nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig([
  nodeLib({
    url: import.meta.url,
    entry: ["index.ts", "api.ts"],
    minify: true,
    dts: false,
    outputOptions: {
      codeSplitting: true,
      chunkFileNames: "[name].js",
      manualChunks: (id: string) => id.includes("/index.ts") ? undefined : "shared",
    },
  }),
  nodeLib({
    url: import.meta.url,
    entry: ["api.ts"],
    clean: false,
    dts: {entry: ["api.ts"], emitDtsOnly: true, tsgo: true},
  }),
]);
