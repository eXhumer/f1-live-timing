import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
