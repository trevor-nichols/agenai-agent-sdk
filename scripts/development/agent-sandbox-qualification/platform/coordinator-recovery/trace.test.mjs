import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installCleanupTrace } from './trace.mjs';

test('cleanup trace dispatches exact original reads/deletes and rejects creation, attachment, wrong-ID deletion and another socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-rg-'));
  const socketPath = join(directory, 'e.sock'); const tracePath = join(directory, 'trace.jsonl');
  const arrived = [];
  const server = http.createServer((request, response) => { arrived.push({ method: request.method, path: request.url }); response.end('{}'); });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const id = 'a'.repeat(64);
  const record = { resources: [{ role: 'route_observer', name: 'original-observer', identity: { kind: 'identified', id } }] };
  const trace = installCleanupTrace({ socketPath, path: tracePath, records: [record] });
  const request = (method, path) => new Promise((resolve, reject) => {
    const call = http.request({ socketPath, method, path }, (response) => { response.resume(); response.once('end', resolve); });
    call.once('error', reject); call.end();
  });
  try {
    await request('GET', '/v1.52/containers/original-observer/json');
    await request('DELETE', `/v1.52/containers/${id}?force=true&v=false`);
    for (const [method, path] of [['POST', '/v1.52/containers/create'], ['POST', `/v1.52/containers/${id}/start`],
      ['POST', `/v1.52/containers/${id}/attach`], ['PUT', `/v1.52/containers/${id}/archive`],
      ['DELETE', `/v1.52/containers/${'b'.repeat(64)}?force=true&v=false`]]) {
      assert.throws(() => http.request({ socketPath, method, path }), /before dispatch/u);
    }
    assert.throws(() => http.request({ socketPath: join(directory, 'other.sock'), method: 'GET', path: '/info' }), /before dispatch/u);
    assert.deepEqual(arrived, [{ method: 'GET', path: '/v1.52/containers/original-observer/json' },
      { method: 'DELETE', path: `/v1.52/containers/${id}?force=true&v=false` }]);
    assert.deepEqual({ ...trace.summarize(), bytes: undefined, scope: undefined }, {
      requests: 8, bytes: undefined, gets: 1, deletes: 1, blocked: 6, forbiddenDispatches: 0, scope: undefined,
    });
  } finally {
    trace.restore(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  const entries = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 8); assert.deepEqual(entries.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(entries.map(({ dispatch }) => dispatch), ['admitted', 'admitted', ...Array(6).fill('blocked')]);
  await rm(directory, { recursive: true });
});
