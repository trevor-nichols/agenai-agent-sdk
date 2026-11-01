import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installGuard } from './guard.mjs';

test('negative qualification refuses writes before dispatch and cleanup cannot target a reused name or foreign ID', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-guard-'));
  const socketPath = join(directory, 'e.sock'), dispatched = [];
  const server = http.createServer((request, response) => { dispatched.push([request.method, request.url]); response.end('{}'); });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const guard = installGuard({ socketPath, path: join(directory, 'trace.jsonl'), records: [{ resources: [
    { role: 'compute', name: 'reused-compute', identity: { kind: 'identified', id: 'a'.repeat(64) } },
    { role: 'compute', name: 'acknowledged-cut-compute', identity: { kind: 'identified', id: 'c'.repeat(64) } },
  ] }], completedDeletes: [`/v1.52/containers/${'c'.repeat(64)}?force=true&v=false`] });
  const invoke = (method, path) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path, agent: false }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', reject); request.end();
  });
  let trace;
  try {
    await invoke('GET', '/v1.52/info');
    await assert.rejects(invoke('POST', '/v1.52/containers/create'), /unauthorized HTTP effect/u);
    guard.select({ kind: 'cleanup' });
    for (const reference of ['reused-compute', 'b'.repeat(64)]) {
      await assert.rejects(invoke('DELETE', `/v1.52/containers/${reference}?force=true&v=false`), /unauthorized HTTP effect/u);
    }
    await invoke('GET', `/v1.52/containers/${'c'.repeat(64)}/json`);
    await assert.rejects(invoke('DELETE', `/v1.52/containers/${'c'.repeat(64)}?force=true&v=false`), /unauthorized HTTP effect/u);
    await invoke('DELETE', `/v1.52/containers/${'a'.repeat(64)}?force=true&v=false`);
    assert.deepEqual(dispatched, [['GET', '/v1.52/info'], ['GET', `/v1.52/containers/${'c'.repeat(64)}/json`],
      ['DELETE', `/v1.52/containers/${'a'.repeat(64)}?force=true&v=false`]]);
    assert.equal(guard.snapshot().filter(({ dispatch }) => dispatch === 'blocked').length, 4);
  } finally {
    guard.restore(); await new Promise((resolve) => server.close(resolve));
    trace = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    await rm(directory, { recursive: true });
  }
  assert.equal(trace.length, 7);
});

test('a full evidence census still forwards exact original cleanup and reports incomplete qualification', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-full-'));
  const socketPath = join(directory, 'e.sock'); let deleted = false;
  const server = http.createServer((request, response) => { if (request.method === 'DELETE') deleted = true; response.end('{}'); });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const guard = installGuard({ socketPath, path: join(directory, 'trace.jsonl'), records: [{ resources: [
    { role: 'compute', name: 'original', identity: { kind: 'identified', id: 'a'.repeat(64) } },
  ] }] });
  const invoke = (method, path) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path, agent: false }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', reject); request.end();
  });
  try {
    for (let index = 0; index < 8192; index++) await invoke('GET', '/v1.52/info');
    guard.select({ kind: 'cleanup' });
    await invoke('DELETE', `/v1.52/containers/${'a'.repeat(64)}?force=true&v=false`);
    assert.equal(deleted, true); assert.equal(guard.snapshot().length, 8192);
    assert(guard.failures().length > 0, 'A finite evidence prefix cannot qualify the complete operation.');
  } finally { guard.restore(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); }
});
