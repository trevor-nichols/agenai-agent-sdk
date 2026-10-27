// ------------------------------------------------------------------------------------------------
//                cleanup.test.mjs - Retained exact observer cleanup remains idempotent after disposal
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupDaemonObserver } from './index.mjs';

test('disposed observer cleanup verifies exact absence without executing historical scope queries', async (t) => {
  const root = await mkdtemp('/var/tmp/agenai-observer-cleanup-');
  const socketPath = join(root, 'engine.sock');
  const containerId = 'c'.repeat(64);
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    if (request.method === 'GET' && request.url === '/v1.52/info') response.end(JSON.stringify({ ID: 'exact-original-daemon' }));
    else if (request.method === 'GET' && request.url === `/v1.52/containers/${containerId}/json`) { response.writeHead(404); response.end('{"message":"absent"}'); }
    else { response.writeHead(500); response.end('{"message":"unexpected mutation or stale observer exec"}'); }
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true }); });
  const recordPath = join(root, 'record.json');
  const operationId = '12345678-1234-4123-8123-123456789abc';
  const previous = { name: 'Error', message: 'The original cleanup failure remains recorded after recovery.' };
  const record = { format: 'agenai.sandbox-daemon-observer.v1', endpoint: `unix://${socketPath}`, daemonId: 'exact-original-daemon',
    operationId, name: `agenai-kernel-observer-${operationId}`, containerId, observerRemoved: true,
    observationsPath: join(root, 'observations.jsonl'), finalCensus: { kernelEmpty: true, scopes: 1 },
    scopes: [{ computeId: 'd'.repeat(64), emptyObservations: 2 }], failures: [previous] };
  await writeFile(recordPath, JSON.stringify(record));
  for (let count = 0; count < 2; count += 1) {
    const recovered = await cleanupDaemonObserver({ endpoint: record.endpoint, recordPath });
    assert.equal(recovered.observerRemoved, true); assert.deepEqual(recovered.failures, [previous]);
  }
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1.52/info' }, { method: 'GET', path: `/v1.52/containers/${containerId}/json` },
    { method: 'GET', path: '/v1.52/info' }, { method: 'GET', path: `/v1.52/containers/${containerId}/json` },
  ]);
  const scopes = (count) => Array.from({ length: count }, (_, index) => ({ computeId: (index + 1).toString(16).padStart(64, '0'), emptyObservations: 2 }));
  for (const changed of [
    { ...record, maxScopes: 129 },
    { ...record, scopes: scopes(129), finalCensus: { kernelEmpty: true, scopes: 129 } },
    { ...record, maxScopes: 256, scopes: scopes(257), finalCensus: { kernelEmpty: true, scopes: 257 } },
    { ...record, scopes: [record.scopes[0], record.scopes[0]], finalCensus: { kernelEmpty: true, scopes: 2 } },
    { ...record, maxScopes: 256, finalCensus: { kernelEmpty: true, scopes: 0 } },
  ]) {
    await writeFile(recordPath, JSON.stringify(changed)); const before = calls.length;
    await assert.rejects(cleanupDaemonObserver({ endpoint: record.endpoint, recordPath }), { name: 'AssertionError' });
    assert.equal(calls.length, before, 'Invalid retained capacity or census must reject before Engine effects.');
  }
});
