import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNeverStarted } from './cold-history.mjs';

test('cold container-history gate rejects an actually started helper despite final zero PID and 404', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-cold-history-'));
  const id = 'a'.repeat(64), target = `/v1.52/containers/${id}/json`;
  const retained = async (name, value) => {
    const path = join(directory, name), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const history = [
    { kind: 'child_spawn', pid: 101, args: ['open', 'b'.repeat(64)] },
    { kind: 'child_close', pid: 101, code: 0, signal: null },
    { kind: 'request', id: 1, method: 'POST', target: '/v1.52/containers/create?name=original' },
    { kind: 'response', id: 1, method: 'POST', target: '/v1.52/containers/create?name=original', status: 201,
      complete: true, bodyBase64: Buffer.from(JSON.stringify({ Id: id })).toString('base64') },
    { kind: 'closed', requests: 1, active: [], activeChildren: [], complete: true },
  ];
  try {
    let body = await retained('inspection.json', { Id: id, Name: '/original', State: { Running: false, Pid: 0, StartedAt: '0001-01-01T00:00:00Z' } });
    const index = (inspection) => ({ completeness: 'complete', entries: [
      { sequence: 1, complete: true, status: 200, target, body: inspection },
      { sequence: 2, complete: true, status: 404, target },
      { sequence: 3, complete: true, status: 404, target: '/v1.52/containers/original/json' },
    ] });
    let report = { engineCapture: { index: await retained('index.json', index(body)) } };
    assert.equal((await assertNeverStarted(report, history)).containers[0].id, id);
    body = await retained('inspection.json', { Id: id, Name: '/original', State: { Running: false, Pid: 0, StartedAt: '2026-10-30T10:00:00Z' } });
    report = { engineCapture: { index: await retained('index.json', index(body)) } };
    await assert.rejects(assertNeverStarted(report, history), /0001/u);
    const started = history.slice(0, -1).concat({ kind: 'request', id: 2, method: 'POST', target: `/v1.52/containers/${id}/start` },
      { kind: 'closed', requests: 2, active: [], activeChildren: [], complete: true });
    await assert.rejects(assertNeverStarted(report, started), /independent native process absence/u);
  } finally { await rm(directory, { recursive: true }); }
});
