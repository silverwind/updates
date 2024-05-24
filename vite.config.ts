import {defineConfig} from "vite";
import {nodeLib} from "vite-config-silverwind";

export default defineConfig(nodeLib({
  url: import.meta.url,
  noDts: true,
  build: {
    target: "node18",
    minify: false,
  },
}));
