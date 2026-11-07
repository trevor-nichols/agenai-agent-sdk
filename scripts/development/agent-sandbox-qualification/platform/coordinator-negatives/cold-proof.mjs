import assert from 'node:assert/strict';

export function backendEvents(buffers) {
  return buffers.flatMap((bytes) => bytes.toString('utf8').split('\n').flatMap((line) => {
    const match = /^\[([^\]]+)\]\[com\.docker\.backend\.([^\]]+)\] (.*)$/u.exec(line);
    return match && Number.isFinite(Date.parse(match[1])) ? [{ at: Date.parse(match[1]), source: match[2], message: match[3], line }] : [];
  })).sort((a, b) => a.at - b.at);
}

export function assertCachedPrecondition({ settings, first, second, events, startedAt, finishedAt }) {
  assert.equal(settings.useResourceSaver, true, 'Actual Desktop Resource Saver must be enabled.');
  assert(Number.isSafeInteger(settings.autoPauseTimeoutSeconds) && settings.autoPauseTimeoutSeconds > 0);
  assert(second.at - first.at >= 1000, 'Two actual Engine samples must be separated.');
  assert.equal(first.info.ID, second.info.ID);
  assert.equal(first.info.SystemTime, second.info.SystemTime, 'Engine time advanced; actual cached responses are unproven.');
  assert(first.at - Date.parse(first.info.SystemTime) >= 30_000, 'Cached Engine clock must actually lag wall time.');
  const selected = events.filter(({ at }) => at >= startedAt && at <= finishedAt);
  const cached = selected.filter(({ source, message }) => source === 'apicache' && /cache << GET \/(?:v1\.52\/)?info$/u.test(message));
  for (const sample of [first, second]) assert(cached.some(({ at }) => Math.abs(at - sample.at) <= 500),
    'Contemporaneous actual Docker cache responses are required for each sample.');
  assert(!selected.some(({ source, message }) => source === 'idle' && /idle -> busy|starting VM/u.test(message)),
    'Desktop woke during cold admission; do not dispatch the cold-admission controller.');
}

/** Members each cold scenario owns, in admission order, and those that must dispatch a primary process. */
const EXPECTED = Object.freeze({
  ms004: () => ({ members: ['a', 'b'], dispatched: ['a', 'b'] }),
  single: () => ({ members: ['a'], dispatched: ['a'] }),
  joint: () => ({ members: ['a', 'b'], dispatched: ['a', 'b'] }),
  'idle-reentry': () => ({ members: ['a', 'c'], dispatched: ['a', 'c'] }),
  'foreign-network': () => ({ members: ['a'], dispatched: ['a'] }),
  'engine-restart': (outcome) => ({ members: outcome.admission ? ['a', 'b'] : ['a'], dispatched: ['a'] }),
});

const removed = (network) => network.absence.length === 2 && network.absence.every(({ status }) => status === 404);

/** Re-checks a Resource Saver row's retained outcome against Desktop's own log, independently of the controller's assertions. */
export function assertResourceSaverOutcome(kind, outcome, events, generation) {
  assert.equal(outcome.kind, kind); assert.equal(outcome.generation, generation);
  for (const idle of outcome.idle ?? []) {
    assert(events.some(({ line }) => line === idle.stopLine), 'A recorded VM stop is absent from the retained Desktop log.');
    assert(events.some(({ at, source, message }) => at > idle.stoppedAt && source === 'idle' && message === 'starting VM'),
      'Desktop never restarted the VM after a recorded stop.');
  }
  if (kind === 'idle-reentry') {
    assert.equal(outcome.idle.length, 2); assert(removed(outcome.foreignNetwork));
    assert.deepEqual(outcome.checks.map(({ phase }) => phase), ['stopped-without-members', 'foreign-network-present', 'foreign-network-removed', 'after-c']);
    assert(outcome.checks.every(({ state }) => state.kind === 'active' && state.generation === generation));
  } else if (kind === 'foreign-network') {
    assert.equal(outcome.fence.state.kind, 'fenced'); assert.equal(outcome.fence.check, 'external_topology');
    assert.equal(outcome.admission.length, 1); assert(removed(outcome.foreignNetwork));
  } else if (kind === 'engine-restart') {
    assert.equal(outcome.idle.length, 1); assert(['active', 'fenced'].includes(outcome.atStop.kind));
    assert.equal(outcome.admission === undefined, outcome.atStop.kind === 'fenced', 'Only an active coordinator may admit the waking member.');
    assert.equal(outcome.fence.state.kind, 'fenced'); assert.equal(outcome.fence.state.failure.kind, 'authority_lost');
    assert(['engine_restart', 'external_topology', 'other'].includes(outcome.fence.check), 'The first fencing check must be recorded.');
    if (outcome.fence.check === 'engine_restart') assert.equal(outcome.fence.state.failure.source, 'engine');
  }
}

export function assertColdOutcome({ scenario, report, before, after, events, workflowEvents, child, sourceInputSha256 }) {
  assert.equal(child.code, 0, 'The ordinary exploratory controller must pass on its first attempt.');
  assert.equal(child.signal, null); assert.equal(child.truncated, false);
  assert.equal(report.status, 'pass'); assert.equal(report.scenarioCompleted, true); assert.equal(report.primaryFailure, null);
  assert.equal(report.input.sha256, sourceInputSha256);
  assert.equal(report.vmPreparation, undefined, 'A warmed row is not a cold admission.');
  const activations = workflowEvents.filter(({ kind }) => kind === 'coordinator-activated');
  assert.equal(activations.length, 1, 'Exactly one original generation may activate.');
  assert(!workflowEvents.some(({ kind }) => kind === 'attempt-failed'), 'A cold admission must not fail its attempt.');
  assert.deepEqual(report.cleanupFailures, []);
  assert.deepEqual(report.coordinator.final, { kind: 'closed', result: 'clean', generation: report.coordinator.generation });
  const expected = EXPECTED[scenario.kind](report.resourceSaver);
  assert.deepEqual(report.members.map(({ label }) => label), expected.members);
  for (const member of report.members) {
    if (expected.dispatched.includes(member.label)) assert(member.process, 'Every cold-admitted member must dispatch its primary process.');
    assert.equal(member.finalState.kind, 'destroyed');
    assert(member.absence.length > 0 && member.absence.every(({ status }) => status === 404));
  }
  const oldBridge = before.networks.find(({ Name }) => Name === 'bridge');
  const newBridge = after.networks.find(({ Name }) => Name === 'bridge'); assert(oldBridge && newBridge);
  assert.notEqual(oldBridge.Id, newBridge.Id, 'Actual VM-wake default-bridge replacement is unproven.');
  assert.deepEqual(report.defaultBridgeReplacement, { before: oldBridge.Id, after: newBridge.Id });
  assert.deepEqual(before.networks.filter(({ Name }) => Name !== 'bridge').map(({ Id }) => Id).sort(),
    after.networks.filter(({ Name }) => Name !== 'bridge').map(({ Id }) => Id).sort());
  assert.deepEqual(report.initialNetworks, before.networks.map(({ Id }) => Id).sort());
  assert.deepEqual(report.finalNetworks, after.networks.map(({ Id }) => Id).sort());
  assert.deepEqual(after.containers, before.containers, 'A borrowed container or acquired SDK resource remains changed.');
  assert.deepEqual(after.volumes, before.volumes, 'A borrowed volume or acquired SDK resource remains changed.');
  assert.equal(after.info.ID, before.info.ID);
  assert(Date.parse(after.info.SystemTime) > Date.parse(before.info.SystemTime));
  const selected = events.filter(({ at }) => at >= child.startedAt && at <= child.finishedAt);
  const idle = selected.filter(({ source }) => source === 'idle');
  const start = idle.findIndex(({ message }) => message === 'starting VM');
  // Desktop logs the busy transition naming the wake's cause beside the VM start: after it in 4.98, before it in 4.54.
  const cause = [idle[start + 1], idle[start - 1]].find((event) => start >= 0 && event && /idle -> busy/u.test(event.message));
  assert(cause && /containers\/create/u.test(cause.message), 'Actual SDK create-triggered Resource Saver wake is unproven.');
  assert(Math.min(idle[start].at, cause.at) > Date.parse(activations[0].at), 'Activation must read the cold VM before the SDK create wakes it.');
  assert(selected.some(({ source, message }) => source === 'apicache' && /invalidat(?:ing|ed) (?:the )?Docker API cache/u.test(message)));
  assert.equal(report.engineCapture?.completeness, 'complete');
  assert.equal(report.finalIdentityFailure, undefined);
  if (scenario.kind === 'ms004') assert.equal(report.resourceSaver, undefined);
  else assertResourceSaverOutcome(scenario.kind, report.resourceSaver, selected, report.coordinator.generation);
  return { oldBridgeId: oldBridge.Id, newBridgeId: newBridge.Id, generation: report.coordinator.generation, scenario: scenario.kind,
    outcome: scenario.kind === 'ms004' ? 'first_attempt_cold_admission_with_original_cleanup' : `resource_saver_${scenario.kind}`,
    originalControllerStatus: report.status };
}
