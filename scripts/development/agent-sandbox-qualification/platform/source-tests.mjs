// ------------------------------------------------------------------------------------------------
//                source-tests.mjs - Selected platform source tests and their owned Node command
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function sourceTestCommand({ integrationRoot, row, testConcurrency = null }) {
  const selectedTests = row === 'datasets' ? ['datasets.test.ts', 'recovery.test.ts']
    : (await readdir(integrationRoot)).filter((name) => name.endsWith('.test.ts') && name !== 'datasets.test.ts').sort();
  assert(selectedTests.length > 0);
  const files = selectedTests.map((name) => join(integrationRoot, name));
  return { command: process.execPath, args: ['--import', 'tsx', '--test',
    ...(testConcurrency === null ? [] : [`--test-concurrency=${testConcurrency}`]), ...files],
    selection: { files, requestedTestConcurrency: testConcurrency, effectiveTestConcurrency: testConcurrency ?? 'node-default' } };
}
