import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { failure, observe } from '../../coordinator/evidence.mjs';

// A failed control ends its helper (control EOF) before B's accounted removal. The SDK releases that role, so the
// helper's absence settles under B's own removal while the live peer observer keeps the group active.
function assertMemberLocal(state, selected) {
  assert.equal(selected.expectedDomain, 'member_local');
  assert.equal(state.kind, 'active', 'A selected control loss must not fence the original group.');
}

export async function captureControlLossAdmission({ control, coordinator, members, sdk, selected, timeoutMs, signal, evidence }) {
  const b = members.find(({ label }) => label === 'b');
  const receipt = { format: 'agenai.sandbox-concurrency-original-control-admission.v1', injection: control.report.injected,
    requestedAt: new Date().toISOString(), coordinatorBefore: coordinator.state,
    memberStatesBefore: members.map(({ label, owner }) => ({ label, state: owner.state })),
    admissionClosedAt: null, coordinator: null, memberStates: [], rejections: [], completedAt: null };
  const rejections = [];
  try {
    assert(!['destroying', 'destroyed'].includes(b.owner.state.kind), 'Original control admission must be observed before workflow cleanup.');
    const deadline = performance.now() + timeoutMs;
    while (coordinator.state.kind === 'active' && b.owner.state.kind === 'ready') {
      signal.throwIfAborted();
      assert(performance.now() < deadline, 'Original control loss did not close unsafe original B admission.');
      await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
    signal.throwIfAborted();
    receipt.admissionClosedAt = new Date().toISOString(); receipt.coordinator = coordinator.state;
    receipt.memberStates = members.map(({ label, owner }) => ({ label, state: owner.state }));
    assertMemberLocal(receipt.coordinator, selected);
    const requestedAt = new Date().toISOString(); let rejected;
    try { await observe(b.sandbox.files.stat('.'), timeoutMs, 'Original control-loss public admission rejection'); }
    catch (error) { rejected = error; }
    receipt.rejections.push({ label: 'b', requestedAt, rejectedAt: new Date().toISOString(),
      failure: failure(rejected), state: b.owner.state, originalRecord: b.owner.recoveryRecord });
    assert(rejected instanceof sdk.SandboxStateError,
      'Original B public live-file admission did not reject with SandboxStateError before workflow cleanup.');
    rejections.push({ label: 'b', error: rejected });
    receipt.completedAt = new Date().toISOString();
    return { receipt, rejections };
  } finally { receipt.evidence = await evidence.file('control-loss-original-admission.json', receipt); }
}

// Independent supervisor witness of the selected helper and the peer's helper of the same role. The injector proved
// the selected attachment open at injection, so an exited selected helper here stopped after its control loss.
export async function observeHelperExit({ engine, selected, peer, timeoutMs, intervalMs = 25 }) {
  const inspect = async ({ label, id }) => {
    const response = await engine.request('GET', `/containers/${id}/json`, undefined, { allowed: [200, 404] });
    assert(response.status === 404 || response.data.Id === id, 'Helper witness inspected another container.');
    const state = response.status === 200 ? response.data.State : null;
    return { label, id, observedAt: new Date().toISOString(), present: state !== null, running: state?.Running === true,
      status: state?.Status ?? null, exitCode: state?.ExitCode ?? null, finishedAt: state?.FinishedAt ?? null };
  };
  const deadline = performance.now() + timeoutMs;
  for (let polls = 1; ; polls++) {
    const [selectedHelper, peerHelper] = await Promise.all([inspect(selected), inspect(peer)]);
    if (!selectedHelper.running || performance.now() >= deadline) return { selected: selectedHelper, peer: peerHelper, polls };
    await delay(intervalMs);
  }
}

export async function classifyControlLoss({ injected, control, admission, coordinator, selected, observations, sdk }) {
  assert(injected && control.report.injected && control.report.captured.label === 'b');
  assert(admission?.receipt.completedAt && admission.rejections.some(({ label, error }) => label === 'b' && error instanceof sdk.SandboxStateError),
    'Control-loss qualification requires its original pre-cleanup admission receipt.');
  assertMemberLocal(admission.receipt.coordinator, selected);
  assert.equal(coordinator.state.kind, 'active', 'A later coordinator transition cannot replace the original control-loss admission receipt.');
  assert.notEqual(admission.receipt.memberStates.find(({ label }) => label === 'b').state.kind, 'ready');
  assert(observations.some((value) => value.member === 'a' && value.phase === 'cleanup_continuity' && value.continuity),
    'The original peer did not prove held/fresh TLS, file and output continuation after local failure.');
  return { domain: 'member_local' };
}
