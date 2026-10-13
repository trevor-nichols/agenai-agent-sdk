// ------------------------------------------------------------------------------------------------
//                tsup.config.ts - ACP adapter build orchestration - Dependencies: tsup
// ------------------------------------------------------------------------------------------------

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
  ],
  format: ['esm'],
  sourcemap: false,
  dts: false,
  tsconfig: './tsconfig.json',
  clean: false,
  bundle: false,
  splitting: false,
  treeshake: false,
  minify: false,
  target: 'esnext',
  platform: 'node',
  shims: false,
});
