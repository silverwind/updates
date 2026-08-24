import {nodeLib} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";
import {basename} from "node:path";

export default defineConfig([
  nodeLib({
    url: import.meta.url,
    entry: ["index.ts", "api.ts"],
    minify: true,
    dts: false,
    outputOptions: {
      codeSplitting: true,
      chunkFileNames: "[name].js",
      manualChunks: (id: string) => {
        // the entry and the lazily-imported dns/prewarm chunks stay out of the hot-path shared chunk
        if (["index.ts", "dns.ts", "prewarm.ts"].includes(basename(id))) return undefined;
        return "shared";
      },
    },
  }),
  nodeLib({
    url: import.meta.url,
    entry: ["api.ts"],
    clean: false,
    dts: {entry: ["api.ts"], emitDtsOnly: true, tsgo: true},
  }),
]);
