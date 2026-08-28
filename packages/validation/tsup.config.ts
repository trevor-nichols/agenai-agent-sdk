// ------------------------------------------------------------------------------------------------
//                tsup.config.ts - Runtime build orchestration for @agenai/validation
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
//                Build Configuration
// ------------------------------------------------------------------------------------------------

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.d.ts.map',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
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
  target: 'es2022',
  platform: 'neutral',
  shims: false,
});
