import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { coversAllocation } from './denial.mjs';

test('the qualification request barrier completes original intent evidence before upstream mutation dispatch', async (t) => {
  const directory = await mkdtemp('/var/tmp/concurrency-denial-');
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const dispatched = [];
  const upstream = http.createServer((request, response) => { dispatched.push({ method: request.method, target: request.url }); response.writeHead(201); response.end('{"Id":"original-created"}'); });
  const upstreamPath = join(directory, 'upstream.sock'); upstream.listen(upstreamPath); await once(upstream, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl'), async observeRequest(value) { entered.resolve(value); await released.promise; } });
  t.after(async () => { released.resolve(); await proxy.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const response = new Promise((resolve, reject) => {
    const request = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/networks/create', agent: false }, resolve);
    request.once('error', reject); request.end('{"Name":"original-member"}');
  });
  assert.deepEqual(await entered.promise, { method: 'POST', target: '/v1.52/networks/create', traceId: 0 });
  assert.deepEqual(dispatched, []);
  released.resolve(); const actual = await response; const body = []; for await (const chunk of actual) body.push(chunk);
  assert.equal(actual.statusCode, 201); assert.equal(Buffer.concat(body).toString(), '{"Id":"original-created"}');
  assert.deepEqual(dispatched, [{ method: 'POST', target: '/v1.52/networks/create' }]);
});

test('immutable coverage must contain the whole candidate allocation rather than merely its gateway', () => {
  assert.equal(coversAllocation(['10.240.0.0/24'], '10.240.0.16/28'), true);
  assert.equal(coversAllocation(['10.240.0.16/29'], '10.240.0.16/28'), false);
  assert.equal(coversAllocation(['10.240.0.32/28', '::/0'], '10.240.0.16/28'), false);
});
