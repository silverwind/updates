import {defineConfig} from "vitest/dist/config.js";
import {backend} from "vitest-config-silverwind";

export default defineConfig(backend({url: import.meta.url}));
