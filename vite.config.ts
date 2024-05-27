import {defineConfig} from "vite";
import {nodeCli} from "vite-config-silverwind";

export default defineConfig(nodeCli({
  url: import.meta.url,
  build: {
    target: "node18",
  },
}));
