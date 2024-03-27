const { defineConfig } = require("rollup");
const terser = require("@rollup/plugin-terser");
const typescript = require("@rollup/plugin-typescript");

module.exports = defineConfig({
  input: [
    "src/library.ts",
    "src/client.ts",
  ],
  output: {
    dir: "dist",
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    terser(),
    typescript(),
  ],
});
