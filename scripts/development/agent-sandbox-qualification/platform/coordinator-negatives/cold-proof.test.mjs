import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCachedPrecondition, assertColdOutcome, assertResourceSaverOutcome, backendEvents } from './cold-proof.mjs';

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

test('cold admission requires a first-attempt pass, one generation, the recorded bridge replacement and original cleanup', () => {
  const member = (label) => ({ label, process: { reservationId: 'primary' }, finalState: { kind: 'destroyed' }, absence: [{ status: 404 }] });
  const actual = { scenario: { kind: 'ms004' }, report: { status: 'pass', scenarioCompleted: true, primaryFailure: null, input: { sha256: 'input' },
    coordinator: { generation: 'generation', final: { kind: 'closed', result: 'clean', generation: 'generation' } },
    cleanupFailures: [], members: [member('a'), member('b')], defaultBridgeReplacement: { before: 'old', after: 'new' },
    initialNetworks: ['old'], finalNetworks: ['new'], engineCapture: { completeness: 'complete' } },
  before: { info: { ID: 'daemon', SystemTime: '2026-10-30T09:58:00Z' }, networks: [{ Name: 'bridge', Id: 'old' }], containers: [], volumes: [] },
  after: { info: { ID: 'daemon', SystemTime: '2026-10-30T10:00:02Z' }, networks: [{ Name: 'bridge', Id: 'new' }], containers: [], volumes: [] },
  child: { code: 0, signal: null, truncated: false, startedAt: 1000, finishedAt: 2000 },
  events: [{ at: 1100, source: 'idle', message: 'idle -> busy (reason: /v1.52/containers/create)' },
    { at: 1200, source: 'idle', message: 'starting VM' }, { at: 1300, source: 'apicache', message: 'invalidated Docker API cache' }],
  workflowEvents: [{ kind: 'coordinator-activated', at: new Date(1050).toISOString() }], sourceInputSha256: 'input' };
  assert.equal(assertColdOutcome(actual).outcome, 'first_attempt_cold_admission_with_original_cleanup');
  const desktop498 = structuredClone(actual);
  desktop498.events = [{ at: 1100, source: 'idle', message: 'starting VM' }, { at: 1100, source: 'engines', message: 'engine start requested' },
    { at: 1100, source: 'idle', message: 'idle -> busy (was idle for 6m2s; reason: [1 calls to /v1.52/containers/create from ])' },
    { at: 1300, source: 'apicache', message: 'invalidated Docker API cache' }];
  assert.equal(assertColdOutcome(desktop498).outcome, 'first_attempt_cold_admission_with_original_cleanup');
  for (const [change, expected] of [
    [(value) => { value.child.code = 1; }, /pass on its first attempt/u],
    [(value) => { value.workflowEvents.push({ kind: 'attempt-failed' }); }, /must not fail its attempt/u],
    [(value) => { value.report.members.pop(); }, /deep-equal/u],
    [(value) => { value.report.resourceSaver = { kind: 'single' }; }, /strictly equal/u],
    [(value) => { delete value.report.members[0].process; }, /dispatch its primary process/u],
    [(value) => { value.report.defaultBridgeReplacement = null; }, /deep-equal/u],
    [(value) => { value.report.finalIdentityFailure = { message: 'census' }; }, /strictly equal/u],
    [(value) => { value.report.cleanupFailures.push({ message: 'pending' }); }, /deep-equal/u],
    [(value) => { value.workflowEvents.push({ kind: 'coordinator-activated' }); }, /one original generation/u],
    [(value) => { value.events = []; }, /create-triggered/u],
    [(value) => { value.events.unshift({ at: 1060, source: 'idle', message: 'starting VM' },
      { at: 1060, source: 'idle', message: 'idle -> busy (reason: [1 calls to /v1.52/images/json from ])' }); }, /create-triggered/u],
    [(value) => { value.events.splice(1, 1); }, /create-triggered/u],
    [(value) => { value.workflowEvents[0].at = new Date(1150).toISOString(); }, /before the SDK create wakes it/u],
    [(value) => { value.after.containers.push({ Id: 'leaked' }); }, /borrowed container/u],
  ]) {
    const value = structuredClone(actual); change(value); assert.throws(() => assertColdOutcome(value), expected);
  }
  const restart = structuredClone(actual);
  restart.scenario = { kind: 'engine-restart' }; delete restart.report.members[1].process;
  restart.report.resourceSaver = outcomes()['engine-restart'];
  restart.events.push({ at: 1500, source: 'idle', message: 'VM stopped', line: 'stop' }, { at: 1600, source: 'idle', message: 'starting VM' });
  assert.equal(assertColdOutcome(restart).outcome, 'resource_saver_engine-restart');
  delete restart.report.members[0].process;
  assert.throws(() => assertColdOutcome(restart), /dispatch its primary process/u);
  const fencedAtStop = structuredClone(actual);
  fencedAtStop.scenario = { kind: 'engine-restart' }; fencedAtStop.report.members.pop();
  fencedAtStop.report.resourceSaver = { ...outcomes()['engine-restart'], atStop: { kind: 'fenced' }, admission: undefined };
  fencedAtStop.events.push({ at: 1500, source: 'idle', message: 'VM stopped', line: 'stop' }, { at: 1600, source: 'idle', message: 'starting VM' });
  assert.equal(assertColdOutcome(fencedAtStop).outcome, 'resource_saver_engine-restart');
});

function outcomes() {
  const active = (phase, members = 0) => ({ phase, state: { kind: 'active', generation: 'generation', members: Array(members).fill({}) } });
  const network = { absence: [{ status: 404 }, { status: 404 }] };
  const idle = { stoppedAt: 1500, stopLine: 'stop' };
  return {
    'idle-reentry': { kind: 'idle-reentry', generation: 'generation', idle: [idle, idle], foreignNetwork: network,
      checks: ['stopped-without-members', 'foreign-network-present', 'foreign-network-removed', 'after-c'].map((phase) => active(phase)) },
    'foreign-network': { kind: 'foreign-network', generation: 'generation', foreignNetwork: network, admission: [{ label: 'a' }],
      fence: { check: 'external_topology', state: { kind: 'fenced', failure: { kind: 'authority_lost', source: 'host' } } } },
    'engine-restart': { kind: 'engine-restart', generation: 'generation', idle: [idle], atStop: { kind: 'active' }, admission: { label: 'b', result: 'rejected' },
      fence: { check: 'engine_restart', state: { kind: 'fenced', failure: { kind: 'authority_lost', source: 'engine' } } } },
  };
}

test('Resource Saver outcomes require their own positive evidence and a VM restart after every recorded stop', () => {
  const events = [{ at: 1500, source: 'idle', message: 'VM stopped', line: 'stop' }, { at: 1600, source: 'idle', message: 'starting VM' }];
  for (const [kind, outcome] of Object.entries(outcomes())) {
    assert.doesNotThrow(() => assertResourceSaverOutcome(kind, outcome, events, 'generation'));
    assert.throws(() => assertResourceSaverOutcome(kind, outcome, events, 'other-generation'), /strictly equal/u);
  }
  for (const [kind, change, expected] of [
    ['idle-reentry', (value) => { value.checks[1].state.kind = 'fenced'; }, /falsy value/u],
    ['idle-reentry', (value) => { value.foreignNetwork.absence[1].status = 200; }, /falsy value/u],
    ['idle-reentry', (value) => { value.idle.pop(); }, /strictly equal/u],
    ['foreign-network', (value) => { value.fence.check = 'engine_restart'; }, /strictly equal/u],
    ['engine-restart', (value) => { delete value.fence.check; }, /must be recorded/u],
    ['engine-restart', (value) => { value.fence.state.failure.source = 'host'; }, /strictly equal/u],
    ['engine-restart', (value) => { value.fence.state.failure.kind = 'identity_conflict'; }, /strictly equal/u],
    ['engine-restart', (value) => { value.atStop.kind = 'fenced'; }, /Only an active coordinator/u],
  ]) {
    const value = structuredClone(outcomes()[kind]); change(value);
    assert.throws(() => assertResourceSaverOutcome(kind, value, events, 'generation'), expected);
  }
  const hostFirst = structuredClone(outcomes()['engine-restart']);
  hostFirst.fence.check = 'other'; hostFirst.fence.state.failure.source = 'host';
  assert.doesNotThrow(() => assertResourceSaverOutcome('engine-restart', hostFirst, events, 'generation'));
  assert.throws(() => assertResourceSaverOutcome('engine-restart', outcomes()['engine-restart'], events.slice(0, 1), 'generation'),
    /never restarted the VM/u);
  assert.throws(() => assertResourceSaverOutcome('engine-restart', outcomes()['engine-restart'], events.slice(1), 'generation'),
    /recorded VM stop is absent/u);
});
