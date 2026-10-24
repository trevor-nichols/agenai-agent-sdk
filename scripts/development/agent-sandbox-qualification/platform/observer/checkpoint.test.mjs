// ------------------------------------------------------------------------------------------------
//                checkpoint.test.mjs - Concurrent registry checkpoints preserve ordered snapshots
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createObserverCheckpoint } from './checkpoint.mjs';

test('concurrent callers publish snapshots in entry order and join every actual atomic write', async (t) => {
  const root = await mkdtemp('/var/tmp/agenai-observer-checkpoint-');
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, 'record.json');
  const checkpoint = createObserverCheckpoint(path);
  const record = { sequence: 0, scope: '' };
  const writes = [];
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    record.sequence = sequence; record.scope = String(sequence).repeat(4096);
    writes.push(checkpoint.write(record));
  }
  record.sequence = -1; record.scope = 'caller mutated after snapshot admission';
  await Promise.all(writes); await checkpoint.join();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sequence: 32, scope: '32'.repeat(4096) });
  assert.deepEqual(await readdir(root), ['record.json']);
});
