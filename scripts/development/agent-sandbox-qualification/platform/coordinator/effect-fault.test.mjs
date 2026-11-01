import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Evidence, sha } from './evidence.mjs';
import { effectTarget, installLostAcknowledgement } from './effect-fault.mjs';

test('lost acknowledgement preserves the real original response before delivering an error, with no success callback or mutation replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-la-')); const socketPath = join(directory, 'e.sock');
  const evidence = new Evidence(join(directory, 'out')); await evidence.initialize(Buffer.from('{}'));
  const id = 'a'.repeat(64); const name = 'original-compute'; const original = Buffer.from(` { "Id": "${id}", "Warnings": [] }\n`);
  const arrived = []; let successes = 0; let errorObserved = false;
  const server = http.createServer((request, response) => {
    arrived.push({ method: request.method, path: request.url }); response.statusCode = request.method === 'POST' ? 201 : 200;
    response.write(original.subarray(0, 8)); setImmediate(() => response.end(original.subarray(8)));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const entry = { owner: { recoveryRecord: { resources: [{ role: 'compute', name, identity: { kind: 'creating' } }] } } };
  const fault = installLostAcknowledgement({ socketPath, evidence,
    select: (options) => effectTarget(options, entry, { operation: 'create', role: 'compute' }),
    onResponseCut(receipt) {
      assert.equal(errorObserved, false); assert.equal(receipt.complete, true); assert.equal(receipt.selected.status, 201);
      assert.equal(receipt.selected.body.sha256, sha(original)); assert.deepEqual(readFileSync(receipt.selected.body.path), original);
    } });
  const request = (method, path) => new Promise((resolve, reject) => {
    const call = http.request({ socketPath, method, path }, (response) => {
      successes++; response.resume(); response.once('end', resolve);
    }); call.once('error', (error) => { errorObserved = true; reject(error); }); call.end();
  });
  try {
    await assert.rejects(request('POST', `/v1.52/containers/create?name=${name}`), /lost acknowledgement/u);
    assert.equal(successes, 0); assert.equal(errorObserved, true);
    await request('POST', `/v1.52/containers/create?name=${name}`);
    const result = await fault.close(); assert.equal(result.complete, true); assert.equal(result.transportErrorIssued, true);
    assert.deepEqual(result.failures, []); assert.equal(successes, 1);
    assert.deepEqual(arrived, Array(2).fill({ method: 'POST', path: `/v1.52/containers/create?name=${name}` }));
    const receipt = JSON.parse(await readFile(join(directory, 'out', 'lost-ack-original-receipt.json'), 'utf8'));
    assert.equal(receipt.complete, true); assert.equal(receipt.selected.bytes, original.length);
  } finally {
    await fault.close(); await evidence.close();
    await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true });
  }
});

test('complete original receipt is durable and explicit error is issued before the original request close reaches a close-sensitive caller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-lc-')); const socketPath = join(directory, 'e.sock');
  const evidence = new Evidence(join(directory, 'out')); await evidence.initialize(Buffer.from('{}'));
  const server = http.createServer((_request, response) => { response.statusCode = 204; response.end(); });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const fault = installLostAcknowledgement({ socketPath, evidence, select: () => true });
  let observedError; let prematureClose = false;
  try {
    await new Promise((resolve) => {
      const request = http.request({ socketPath, method: 'DELETE', path: '/v1.52/containers/original', agent: false, headers: { connection: 'close' } });
      request.once('error', (error) => { observedError = error; });
      request.once('close', () => { prematureClose = !observedError; resolve(); }); request.end();
    });
    const report = await fault.close(); assert.equal(prematureClose, false); assert.match(observedError.message, /lost acknowledgement/u);
    assert.equal(report.transportErrorBeforeOriginalClose, true); assert.equal(report.complete, true);
    assert.equal((await readFile(report.selected.body.path)).length, 0);
  } finally { await fault.close(); await evidence.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); }
});

test('incomplete selected response records capture failure and cannot manufacture an original complete acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-lb-')); const socketPath = join(directory, 'e.sock');
  const evidence = new Evidence(join(directory, 'out')); await evidence.initialize(Buffer.from('{}'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '20' }); response.write('x'); setImmediate(() => response.destroy());
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const fault = installLostAcknowledgement({ socketPath, evidence, select: () => true });
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      const call = http.request({ socketPath, method: 'DELETE', path: '/v1.52/containers/original' }, resolve);
      call.once('error', reject); call.end();
    }));
    const result = await fault.close(); assert.equal(result.complete, false); assert(result.failures.length > 0);
    assert.equal(result.selected.body, null); assert.equal(result.transportErrorIssued, true);
  } finally { await fault.close(); await evidence.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); }
});
