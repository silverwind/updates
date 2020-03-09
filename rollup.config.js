const {writeSync} = require("tempy");
const {name} = require("./package.json");
const tempFile = writeSync("module.exports = null");

module.exports = {
  input: `${name}.js`,
  output: {
    file: name,
    name,
    format: "cjs",
  },
  plugins: [
    require("rollup-plugin-hashbang")(),
    require("@rollup/plugin-json")(),
    require("@rollup/plugin-node-resolve")({
      preferBuiltins: true,
      customResolveOptions: {
        packageFilter: (pkg) => {
          if (pkg.name === "cacache") {
            return {main: tempFile};
          }
          return pkg;
        }
      }
    }),
    require("@rollup/plugin-commonjs")(),
    require("rollup-plugin-terser").terser({output: {comments: false}}),
  ],
};
