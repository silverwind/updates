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
      manualChunks: (id: string) => {
        if (id.includes("/index.ts")) return undefined;
        // Dynamically imported from api.ts / config.ts — keep out of the
        // hot-path shared chunk so startup doesn't pay their cost.
        if (id.includes("/utils/dns.ts") || id.includes("/utils/renovate.ts")) return undefined;
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
