import {defineConfig} from "vite";
import {lib} from "vite-config-silverwind";

export default defineConfig(lib({
  url: import.meta.url,
  noDts: true,
  build: {
    target: "node18",
    minify: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    mainFields: ["module"],
  },
}));
