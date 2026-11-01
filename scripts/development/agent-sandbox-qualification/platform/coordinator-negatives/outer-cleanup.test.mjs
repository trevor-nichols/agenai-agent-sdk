import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finishOuter } from './outer-cleanup.mjs';

test('outer owner retains observer and proxy until the independent original scopes are empty', async () => {
  const calls = []; let empty = true;
  const observer = { record: { observerRemoved: false },
    async assertAllEmpty() { calls.push('census'); assert(empty, 'original scope remains active'); return { kernelEmpty: true }; },
    async close() { calls.push('observer-close'); this.record.observerRemoved = true; } };
  const proxy = { async idle() { calls.push('proxy-join'); }, async close() { calls.push('proxy-close'); } };
  const report = { evidenceFailures: [] };
  const context = { proxy, observer, observerEntered: true, report, socketPath: '/unused-owned-socket', observerFallback: async () => assert.fail() };
  report.originalChildEntered = true;
  await assert.rejects(finishOuter(context), /original generation/u); assert.deepEqual(calls, []);
  report.originalGenerationClosed = true; empty = false;
  await assert.rejects(finishOuter(context), /scope remains active/u);
  assert.deepEqual(calls, ['proxy-join', 'census']); assert.notEqual(report.cleanupComplete, true);
  empty = true; await finishOuter(context);
  assert.deepEqual(calls.slice(2), ['proxy-join', 'census', 'observer-close', 'proxy-close']); assert.equal(report.cleanupComplete, true);
});

test('sticky capture failure keeps qualification failed after confirmed physical proxy retirement', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-outer-'));
  const report = { evidenceFailures: [] };
  const proxy = { async idle() { throw new Error('capture failed after forwarding joined'); },
    async close() { throw new AggregateError([], 'Trace forwarding work failed.'); },
    capacity() { return { connections: { current: 0 }, requests: { current: 0 }, pendingRequests: { current: 0, retiring: 0 } }; } };
  try {
    await finishOuter({ proxy, observer: null, observerEntered: false, socketPath: join(directory, 'retired.sock'), report });
    assert.equal(report.cleanupComplete, true); assert.equal(report.evidenceFailures.length, 2);
  } finally { await rm(directory, { recursive: true }); }
});
