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
      // Entry plus lazily-imported chunks (dns/renovate) stay out of the
      // hot-path shared chunk so startup doesn't pay their cost.
      manualChunks: (id: string) => {
        if (["index.ts", "dns.ts", "renovate.ts"].includes(basename(id))) return undefined;
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
