// Run in-process so Node's test-child supervisor does not intercept the owned cleanup signals.
import './walkthrough.test.js';
import './native/tests/native.test.js';
import './native/tests/pending-cleanup.test.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runToolActionsProof } from './native/tests/tool-actions-proof.js';

const guardArgument = process.argv[2];
if (process.argv.length !== 3 || !guardArgument) throw new Error('Supply the explicit neutral guard file for the source test command.');
const guardFile = resolve(process.cwd(), guardArgument);

// This explicit supervisor stays outside the neutral child guard, as in the packed proof.
test('native runner counts distinct lifecycle tool observations, stops at threshold and drains later events without approving them', async (t) => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'approval-tool-actions-')));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await runToolActionsProof({ fixtureRoot,
    childFile: fileURLToPath(new URL('./native/tests/tool-actions-child.ts', import.meta.url)),
    guardFile, cwd: process.cwd(),
    source: { loader: 'tsx', tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) },
  });
});
