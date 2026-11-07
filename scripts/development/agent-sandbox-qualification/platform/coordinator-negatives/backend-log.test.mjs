import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBackendLogs } from './backend-log.mjs';

test('backend log reads include the newest rotation so a row spanning one keeps its earlier lines', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'backend-log-')));
  try {
    const current = join(directory, 'com.docker.backend.log');
    await writeFile(`${current}.20261106-182012.013`, 'older\n');
    await writeFile(`${current}.20261107-024000.500`, 'rotated\n');
    await writeFile(`${current}.bak`, 'unrelated\n');
    await writeFile(current, 'current\n');
    const logs = await readBackendLogs([current]);
    assert.deepEqual(logs.map(({ bytes }) => bytes.toString()), ['rotated\n', 'current\n']);
    assert.deepEqual(logs.map(({ index }) => index), [0, 1]);
  } finally { await rm(directory, { recursive: true }); }
});
