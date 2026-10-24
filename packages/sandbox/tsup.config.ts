// ------------------------------------------------------------------------------------------------
//                tsup.config.ts - Unbundled side-effect-free Node ESM runtime build
// ------------------------------------------------------------------------------------------------

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts'],
  format: ['esm'],
  sourcemap: false,
  dts: false,
  tsconfig: './tsconfig.json',
  clean: false,
  bundle: false,
  splitting: false,
  treeshake: false,
  minify: false,
  target: 'node22',
  platform: 'node',
  shims: false,
});
