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
});
