// ------------------------------------------------------------------------------------------------
//                platforms.test.ts - Synthetic platform admission through the public lifecycle
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('closed Docker profiles enforce controller, daemon, image and recovery boundaries', { timeout: 60_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--test',
    '--test-reporter=tap', fileURLToPath(new URL('./fixtures/platform-admission.ts', import.meta.url))], {
    timeout: 55_000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.match(result.stdout, /# fail 0\b/u);
});
