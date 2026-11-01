import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { failure, observe } from '../../coordinator/evidence.mjs';
import { everyFailureBranch, sdkFenceFailure, stoppedExitMessage } from './faults.mjs';

// A fence makes the SDK stop every member and fail its owned streams with the typed fence failure, which
// sdkFenceFailure admits. The example's exit receipt separately reports compute removal.

function fencedStopSignature(error) {
  if (!(error instanceof Error) || error instanceof AggregateError || error.name !== 'Error' || error.cause !== undefined) return false;
  return error.code === undefined && error.message === stoppedExitMessage;
}

// Injects only into a healthy group and holds the original workflow until the SDK has fenced and closed
// every member's public admission. Stop signatures that surface later are then fence consequences.
export async function captureTopologyFence({ inject, coordinator, members, sdk, timeoutMs, signal, evidence }) {
  const states = () => members.map(({ label, owner }) => ({ label, state: owner.state }));
  const receipt = { format: 'agenai.sandbox-concurrency-original-topology-fence.v1', requestedAt: new Date().toISOString(),
    coordinatorBefore: coordinator.state, memberStatesBefore: states(), injectedAt: null, fencedAt: null, coordinator: null,
    memberStates: [], rejections: [], completedAt: null };
  const rejections = [];
  try {
    assert.equal(receipt.coordinatorBefore.kind, 'active', 'Unregistered topology must enter an active original group.');
    for (const { label, owner } of members) {
      assert.equal(owner.state.kind, 'ready', `Original ${label.toUpperCase()} must be ready before unregistered topology enters.`);
      assert(receipt.coordinatorBefore.members.some((member) => member.kind === 'active' && member.sandboxId === owner.id),
        `Original ${label.toUpperCase()} must be an active coordinated member before unregistered topology enters.`);
    }
    await inject(); receipt.injectedAt = new Date().toISOString();
    const deadline = performance.now() + timeoutMs;
    while (coordinator.state.kind === 'active') {
      signal.throwIfAborted();
      assert(performance.now() < deadline, 'Unregistered topology did not fence the original group.');
      await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
    receipt.fencedAt = new Date().toISOString(); receipt.coordinator = coordinator.state; receipt.memberStates = states();
    assert.equal(receipt.coordinator.kind, 'fenced', 'Unregistered topology must fence the original group.');
    assert.equal(receipt.coordinator.failure.kind, 'authority_lost');
    for (const entry of members) {
      const requestedAt = new Date().toISOString(); let rejected;
      try { await observe(entry.sandbox.files.stat('.'), timeoutMs, 'Original topology-fence public admission rejection'); }
      catch (error) { rejected = error; }
      receipt.rejections.push({ label: entry.label, requestedAt, rejectedAt: new Date().toISOString(),
        failure: failure(rejected), state: entry.owner.state, originalRecord: entry.owner.recoveryRecord });
      assert(rejected instanceof sdk.SandboxStateError,
        `Original ${entry.label.toUpperCase()} public live-file admission did not reject with SandboxStateError before the workflow resumed.`);
      rejections.push({ label: entry.label, error: rejected });
    }
    receipt.completedAt = new Date().toISOString();
    return { receipt, rejections };
  } finally { receipt.evidence = await evidence.file('topology-fence-original-admission.json', receipt); }
}

export function assertTopologyFenceOutcome({ primary, fence, coordinator, sdk }) {
  assert(fence?.receipt.completedAt, 'Unregistered-topology qualification requires its original pre-resume fence receipt.');
  assert.deepEqual(coordinator.state.failure, fence.receipt.coordinator.failure,
    'A later coordinator transition cannot replace the original topology fence.');
  assert(fence.receipt.memberStatesBefore.every(({ label }) => fence.rejections.some((value) => value.label === label
    && value.error instanceof sdk.SandboxStateError)), 'An unregistered-topology fence requires every original member admission rejection.');
  assert(everyFailureBranch(primary, (error) => sdkFenceFailure(error, sdk) || fencedStopSignature(error)),
    'An unrelated error cannot satisfy an injected control/topology failure.');
  return { fencedAt: fence.receipt.fencedAt, members: fence.rejections.map(({ label }) => label) };
}
