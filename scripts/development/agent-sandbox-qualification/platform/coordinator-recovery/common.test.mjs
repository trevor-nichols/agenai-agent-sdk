import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha } from '../coordinator/evidence.mjs';
import { originalCanonical } from './common.mjs';

test('canonical evidence preserves complete native framing and refuses corrupt or truncated original bytes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-oc-')));
  const path = join(directory, 'canonical.bin'); const engine = 'c'.repeat(64);
  const payload = Buffer.from(JSON.stringify({ format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${engine}`,
    generation: { kind: 'dirty', identity: { generationId: 'original' } } }));
  const bytes = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engine}\n${sha(payload)}\n`), payload]);
  try {
    await writeFile(path, bytes); const original = await originalCanonical(path);
    assert.deepEqual(original.bytes, bytes); assert.equal(original.identity.sha256, sha(bytes));
    assert.equal(original.payload.sha256, sha(payload)); assert.equal(original.value.generation.identity.generationId, 'original');
    assert.deepEqual(await readFile(path), bytes);
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 2] ^= 1; await writeFile(path, corrupt);
    await assert.rejects(originalCanonical(path), /checksum differs/u);
    await writeFile(path, Buffer.from('AGENAI-SNAPSHOT-1\n'));
    await assert.rejects(originalCanonical(path), /framing is incomplete/u);
  } finally { await rm(directory, { recursive: true }); }
});
