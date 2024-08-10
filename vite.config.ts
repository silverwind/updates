import {defineConfig} from "vite";
import {nodeCli} from "vite-config-silverwind";
import dts from "vite-plugin-dts";

export default defineConfig(nodeCli({
  url: import.meta.url,
  build: {
    target: "node18",
  },
  plugins: [
    dts({include: "index.ts"}),
  ],
}));
