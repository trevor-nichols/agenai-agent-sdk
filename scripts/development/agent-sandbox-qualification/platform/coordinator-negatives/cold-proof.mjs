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
    'Desktop woke during cold admission; do not dispatch the expected-negative controller.');
}

function failures(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...failures(value.cause), ...(Array.isArray(value.errors) ? value.errors.flatMap(failures) : [])];
}

export function assertColdOutcome({ report, before, after, events, workflowEvents, child, sourceInputSha256 }) {
  assert.equal(child.code, 1, 'The ordinary exploratory controller must retain its actual failed result.');
  assert.equal(child.signal, null); assert.equal(child.truncated, false);
  assert.equal(report.status, 'fail'); assert.notEqual(report.scenarioCompleted, true);
  assert.equal(report.input.sha256, sourceInputSha256);
  assert.equal(report.vmPreparation, undefined, 'A warmed row is not a cold negative.');
  assert.equal(workflowEvents.filter(({ kind }) => kind === 'coordinator-activated').length, 1, 'Exactly one original generation may activate.');
  assert.equal(workflowEvents.filter(({ kind }) => kind === 'attempt-failed').length, 1);
  const chain = failures(report.primaryFailure);
  assert(chain.some(({ failure }) => failure?.kind === 'authority_lost'), 'A generic startup error is not the required authority fence.');
  assert(chain.some(({ message }) => message === 'External Desktop Engine topology changed.'),
    'Expected original external-topology rejection is absent.');
  assert.deepEqual(report.cleanupFailures, []);
  assert.deepEqual(report.coordinator.final, { kind: 'closed', result: 'clean', generation: report.coordinator.generation });
  assert(report.members.length > 0);
  for (const member of report.members) {
    assert.equal(member.process, undefined, 'Cold rejection must precede primary dispatch.');
    assert.equal(member.finalState.kind, 'destroyed');
    assert(member.absence.length > 0 && member.absence.every(({ status }) => status === 404));
  }
  const oldBridge = before.networks.find(({ Name }) => Name === 'bridge');
  const newBridge = after.networks.find(({ Name }) => Name === 'bridge'); assert(oldBridge && newBridge);
  assert.notEqual(oldBridge.Id, newBridge.Id, 'Actual VM-wake default-bridge replacement is unproven.');
  assert.deepEqual(before.networks.filter(({ Name }) => Name !== 'bridge').map(({ Id }) => Id).sort(),
    after.networks.filter(({ Name }) => Name !== 'bridge').map(({ Id }) => Id).sort());
  assert.deepEqual(report.initialNetworks, before.networks.map(({ Id }) => Id).sort());
  assert.deepEqual(report.finalNetworks, after.networks.map(({ Id }) => Id).sort());
  assert.deepEqual(after.containers, before.containers, 'A borrowed container or acquired SDK resource remains changed.');
  assert.deepEqual(after.volumes, before.volumes, 'A borrowed volume or acquired SDK resource remains changed.');
  assert.equal(after.info.ID, before.info.ID);
  assert(Date.parse(after.info.SystemTime) > Date.parse(before.info.SystemTime));
  const selected = events.filter(({ at }) => at >= child.startedAt && at <= child.finishedAt);
  assert(selected.some(({ source, message }) => source === 'idle' && /idle -> busy .*containers\/create/u.test(message)),
    'Actual SDK create-triggered Resource Saver wake is unproven.');
  assert(selected.some(({ source, message }) => source === 'idle' && message === 'starting VM'));
  assert(selected.some(({ source, message }) => source === 'apicache' && /invalidat(?:ing|ed) (?:the )?Docker API cache/u.test(message)));
  assert.equal(report.engineCapture?.completeness, 'complete');
  if (report.finalIdentityFailure) {
    assert.equal(report.finalIdentityFailure.name, 'AssertionError');
    assert(report.finalIdentityFailure.message.startsWith('Original Engine network census did not return to its initial identities.'));
  }
  return { oldBridgeId: oldBridge.Id, newBridgeId: newBridge.Id, generation: report.coordinator.generation,
    outcome: 'expected_external_topology_fence_before_primary_with_original_cleanup', originalControllerStatus: report.status };
}
