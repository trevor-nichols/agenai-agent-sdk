import assert from 'node:assert/strict';
import test from 'node:test';
import { backendEvents } from '../coordinator-negatives/cold-proof.mjs';
import { idleObservation } from './desktop-idle.mjs';
import { firstFenceCheck } from './resource-saver.mjs';

const log = (...lines) => backendEvents([Buffer.from(`${lines.join('\n')}\n`)]);
const STOP = '[2026-11-07T01:38:18.139Z][com.docker.backend.idle] VM stopped';
const READ = (second) => `[2026-11-07T01:38:${second}.000Z][com.docker.backend.apicache] cache << GET /v1.52/info`;
const since = Date.parse('2026-11-07T01:38:00Z');

test('an idle observation needs a VM stop after the given time and two cached health reads before any wake', () => {
  const observed = idleObservation(log(STOP, READ(19), READ(20)), since);
  assert.deepEqual(observed, { stoppedAt: Date.parse('2026-11-07T01:38:18.139Z'), stopLine: STOP,
    cachedReads: [Date.parse('2026-11-07T01:38:19Z'), Date.parse('2026-11-07T01:38:20Z')] });
  assert.equal(idleObservation(log(STOP, READ(19)), since), null);
  assert.equal(idleObservation(log(STOP, READ(19), READ(20)), Date.parse('2026-11-07T01:38:19Z')), null);
  assert.equal(idleObservation(log(READ(17), STOP, READ(19)), since), null);
  assert.equal(idleObservation(log(STOP, READ(19), '[2026-11-07T01:38:19.500Z][com.docker.backend.idle] starting VM', READ(20)), since), null);
  assert.equal(idleObservation(log(STOP, READ(19), '[2026-11-07T01:38:19.600Z][com.docker.backend.apicache] cache << GET /v1.52/networks'), since), null);
});

test('the fence check is named from the retained cause chain', () => {
  const restarted = { message: 'Desktop coordinator authority was lost.',
    cause: { message: 'Desktop Engine restarted while the coordinator owned resources in its VM.' } };
  assert.equal(firstFenceCheck(restarted), 'engine_restart');
  assert.equal(firstFenceCheck({ message: 'outer', errors: [{ message: 'External Desktop Engine topology changed.' }] }), 'external_topology');
  assert.equal(firstFenceCheck({ message: 'Desktop host observer identity changed.' }), 'other');
  assert.equal(firstFenceCheck(null), 'other');
});
