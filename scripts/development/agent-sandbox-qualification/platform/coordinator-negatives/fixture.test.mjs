import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Engine } from '../../engine.mjs';
import { createReplacement } from './fixture.mjs';

test('same-name fixture keeps the exact returned ID through lost delete acknowledgement without another delete', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-fixture-'));
  const socket = join(directory, 'e.sock'), id = 'b'.repeat(64), image = `sha256:${'c'.repeat(64)}`;
  const calls = []; let actual = null;
  const server = http.createServer(async (request, response) => {
    calls.push([request.method, request.url]);
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actual = { Id: id, Name: '/reused', Config: body, State: { Running: false, Pid: 0, StartedAt: '0001-01-01T00:00:00Z' }, Mounts: [], HostConfig: body.HostConfig };
      response.writeHead(201); response.end(JSON.stringify({ Id: id })); return;
    }
    if (request.method === 'DELETE') { actual = null; response.destroy(); return; }
    if (actual && request.url !== `/v1.52/containers/${'a'.repeat(64)}/json`) response.end(JSON.stringify(actual));
    else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  const checkpoint = {};
  const fixture = createReplacement({ engine: new Engine(socket, '1.52', { requestMs: 1000, outputBytes: 65536 }),
    guard: { select() {} }, image, selected: { originalId: 'a'.repeat(64), name: 'reused' }, checkpoint, async save() {} });
  try {
    await fixture.create();
    assert.equal(checkpoint.id, id); assert.equal((await fixture.preserved()).replacementId, id);
    await assert.rejects(fixture.remove(), /socket hang up|ECONNRESET/u);
    await fixture.remove();
    assert.equal(checkpoint.removed, true);
    assert.deepEqual(calls.filter(([method]) => method === 'DELETE'), [['DELETE', `/v1.52/containers/${id}?force=true&v=false`]]);
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); }
});
