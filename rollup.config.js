const {unlinkSync} = require("fs");
const {writeSync} = require("tempy");
const {name} = require("./package.json");

const nullTemp = writeSync("export default null;", {extension: "mjs"});
const nullRouted = new Set([
  "cacache",
  "socks-proxy-agent",
  "ssri",
  "stripJsonComments",
  "encoding",
]);

const fnTemp = writeSync("export default () => () => {};", {extension: "mjs"});
const fnRouted = new Set([
  "depd",
  "debug",
]);

module.exports = {
  input: `${name}.js`,
  output: {
    file: name,
    name,
    format: "cjs",
  },
  plugins: [
    require("rollup-plugin-hashbang")(),
    require("@rollup/plugin-json")({
      indent: "",
      preferConst: true,
    }),
    require("@rollup/plugin-node-resolve").default({
      customResolveOptions: {
        packageFilter: pkg => {
          if (nullRouted.has(pkg.name)) return {main: nullTemp, type: "module"};
          if (fnRouted.has(pkg.name)) return {main: fnTemp, type: "module"};
          return pkg;
        },
      }
    }),
    require("@rollup/plugin-commonjs")({
      sourceMap: false,
    }),
    // require("rollup-plugin-terser").terser({
    //   output: {comments: false},
    // }),
  ],
};

process.on("exit", () => {
  unlinkSync(nullTemp);
  unlinkSync(fnTemp);
});
