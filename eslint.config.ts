import silverwind from "eslint-config-silverwind";
import {defineConfig} from "eslint/config";

export default defineConfig(...silverwind, {
  ignores: ["fixtures/invalid-config/**"],
});
