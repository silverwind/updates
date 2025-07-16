import {defineConfig} from "vite";
import {nodeCli} from "vite-config-silverwind";
import dts from "vite-plugin-dts";

export default defineConfig(nodeCli({
  url: import.meta.url,
  build: {
    target: "node20",
    minify: false,
  },
  plugins: [
    dts({include: "index.ts"}),
  ],
}));
