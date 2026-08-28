// ------------------------------------------------------------------------------------------------
//                tsup.config.ts - Build orchestration for @agen-ai/agent-runtime - Dependencies: tsup
// ------------------------------------------------------------------------------------------------

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.d.ts.map',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/__tests__/**',
  ],
  format: ['esm'],
  sourcemap: false,
  dts: false,
  tsconfig: './tsconfig.json',
  clean: true,
  bundle: false,
  splitting: false,
  treeshake: false,
  minify: false,
  target: 'es2022',
  platform: 'neutral',
  shims: false,
});
