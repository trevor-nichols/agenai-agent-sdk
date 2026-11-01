import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCachedPrecondition, assertColdOutcome, backendEvents } from './cold-proof.mjs';

test('cold qualification requires contemporaneous real cache observations before original dispatch', () => {
  const start = Date.parse('2026-10-30T10:00:00Z');
  const events = backendEvents([Buffer.from('[2026-10-30T10:00:00.100Z][com.docker.backend.apicache] cache << GET /v1.52/info\n'
    + '[2026-10-30T10:00:01.200Z][com.docker.backend.apicache] cache << GET /v1.52/info\n')]);
  const actual = { settings: { useResourceSaver: true, autoPauseTimeoutSeconds: 300 },
    first: { at: start + 100, info: { ID: 'daemon', SystemTime: '2026-10-30T09:58:00Z' } },
    second: { at: start + 1200, info: { ID: 'daemon', SystemTime: '2026-10-30T09:58:00Z' } }, events,
    startedAt: start, finishedAt: start + 1500 };
  assert.doesNotThrow(() => assertCachedPrecondition(actual));
  for (const [change, expected] of [
    [(value) => { value.events = []; }, /actual Docker cache/u],
    [(value) => { value.second.info.SystemTime = '2026-10-30T10:00:01Z'; }, /time advanced/u],
    [(value) => { value.events.push({ at: start + 1300, source: 'idle', message: 'starting VM' }); }, /woke during cold admission/u],
    [(value) => { value.settings.useResourceSaver = false; }, /Resource Saver/u],
  ]) {
    const value = structuredClone(actual); change(value); assert.throws(() => assertCachedPrecondition(value), expected);
  }
});

test('expected cold failure requires exact topology fencing, one generation, changed bridge and original cleanup', () => {
  const actual = { report: { status: 'fail', input: { sha256: 'input' }, coordinator: { generation: 'generation',
    final: { kind: 'closed', result: 'clean', generation: 'generation' } },
  primaryFailure: { failure: { kind: 'authority_lost' }, cause: { message: 'External Desktop Engine topology changed.' } },
  cleanupFailures: [], members: [{ finalState: { kind: 'destroyed' }, absence: [{ status: 404 }] }],
  initialNetworks: ['old'], finalNetworks: ['new'], engineCapture: { completeness: 'complete' } },
  before: { info: { ID: 'daemon', SystemTime: '2026-10-30T09:58:00Z' }, networks: [{ Name: 'bridge', Id: 'old' }], containers: [], volumes: [] },
  after: { info: { ID: 'daemon', SystemTime: '2026-10-30T10:00:02Z' }, networks: [{ Name: 'bridge', Id: 'new' }], containers: [], volumes: [] },
  child: { code: 1, signal: null, truncated: false, startedAt: 1000, finishedAt: 2000 },
  events: [{ at: 1100, source: 'idle', message: 'idle -> busy (reason: /v1.52/containers/create)' },
    { at: 1200, source: 'idle', message: 'starting VM' }, { at: 1300, source: 'apicache', message: 'invalidated Docker API cache' }],
  workflowEvents: [{ kind: 'coordinator-activated' }, { kind: 'attempt-failed' }], sourceInputSha256: 'input' };
  assert.equal(assertColdOutcome(actual).outcome, 'expected_external_topology_fence_before_primary_with_original_cleanup');
  for (const [change, expected] of [
    [(value) => { value.report.primaryFailure.cause.message = 'image configuration invalid'; }, /external-topology rejection/u],
    [(value) => { value.report.members[0].process = { pid: 99 }; }, /precede primary dispatch/u],
    [(value) => { value.report.cleanupFailures.push({ message: 'pending' }); }, /deep-equal/u],
    [(value) => { value.workflowEvents.push({ kind: 'coordinator-activated' }); }, /one original generation/u],
    [(value) => { value.events = []; }, /create-triggered/u],
    [(value) => { value.after.containers.push({ Id: 'leaked' }); }, /borrowed container/u],
  ]) {
    const value = structuredClone(actual); change(value); assert.throws(() => assertColdOutcome(value), expected);
  }
});
