import assert from 'node:assert/strict';

export function errorContains(error, predicate, seen = new Set()) {
  if (!(error instanceof Error) || seen.has(error)) return false;
  assert(seen.size < 64, 'Original fault error graph exceeded its bounded census.'); seen.add(error);
  return predicate(error) || errorContains(error.cause, predicate, seen)
    || error instanceof AggregateError && error.errors.some((nested) => errorContains(nested, predicate, seen));
}

export function everyFailureBranch(error, predicate) {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((nested) => everyFailureBranch(nested, predicate));
  return errorContains(error, predicate);
}

// A rejected terminal caller checkpoint follows completed physical cleanup: destroy settles through canonical
// cleanup and no operation fails, so the public workflow continues.
export function assertTerminalCheckpointFault({ selected, entry, fault, injected, cause }) {
  assert(injected && cause && fault && fault.boundary === selected.boundary && selected.boundary === 'destroyed'
    && fault.record.phase === 'destroyed' && fault.record.operationId === entry.owner.recoveryRecord.operationId,
  'The exact original terminal B checkpoint was not the injected boundary.');
  assert.deepEqual(fault.record, entry.owner.recoveryRecord, 'The rejected checkpoint must be B\'s final original record.');
  assert.equal(entry.owner.state.kind, 'destroyed', 'Physical destruction must settle independently of the rejected caller checkpoint.');
  assert.deepEqual(entry.operationFailures ?? [], [], 'A rejected terminal caller checkpoint cannot fail an original operation.');
  return { operation: 'destroy', disposition: 'canonical_cleanup_settled', operationId: fault.record.operationId };
}

// Typed public SDK outcomes of an original authority fence; shared by control-loss and topology faults.
// The example reports the SDK's one typed stop reason, the process exit, with this exact message.
export const stoppedExitMessage = `Original primary exited during active membership: ${JSON.stringify({ kind: 'unavailable', reason: 'sandbox_stopped' })}`;

// The SDK fails a stopped member's readers with its typed stop reason, which sdkFenceFailure admits. The example also
// reports the process exit as an untyped error; that report is attributable to a selected fault only as the exact
// retained reader error of a member the classified domain stopped.
export function stoppedMemberExits(workflowError, labels) {
  const exits = new Set();
  for (const { member, operation, error } of workflowError?.cleanupFailures ?? []) {
    if (operation !== 'readers' || !labels.includes(member)) continue;
    for (const nested of error instanceof AggregateError ? error.errors : [error]) {
      if (nested instanceof Error && nested.code === undefined && nested.message === stoppedExitMessage) exits.add(nested);
    }
  }
  return exits;
}

// Independent broker controls arm forbidden-listener counters that only the same member's next continuity consumes.
// Once a selected fault enters, the SDK stops the failed member and, under a group fence, every member; stopping
// removes their brokers, so their controls are superseded: never run and never credited. Injected topology fences
// the whole group. A live peer that the observing coordinator still holds active keeps every control.
export function supersededContinuityControl(observation, { faultEntered = false, failedMember = null, topologyInjected = false } = {}) {
  if (!faultEntered) return null;
  if (topologyInjected) return 'selected_topology_fence';
  if (observation.member === failedMember) return 'selected_failed_member';
  return observation.coordinator?.kind === 'active' ? null : 'coordinator_not_active';
}

export function sdkFenceFailure(error, sdk) {
  return error instanceof sdk.SandboxStateError || error instanceof sdk.SandboxOperationError
    && ['driver_failure', 'stream_failure', 'cancelled'].includes(error.code)
    || error.name === 'DockerDesktopCoordinatorError' && error.failure?.kind === 'authority_lost';
}

export function assertCheckpointFault({ selected, primary, entry, fault, cause }) {
  assert(fault && fault.record.operationId === entry.owner.recoveryRecord.operationId && fault.boundary === selected.boundary,
    'The selected exact original B checkpoint was not the injected boundary.');
  const operation = selected.kind === 'interrupt' || selected.boundary !== 'destroyed' ? 'start' : 'destroy';
  const failures = (entry.operationFailures ?? []).filter((failure) => failure.operation === operation);
  const code = selected.kind === 'interrupt' ? 'cancelled' : 'persistence_failure';
  const original = failures.find((failure) => errorContains(failure.error, (error) => error.name === 'SandboxOperationError' && error.code === code)
    && everyFailureBranch(primary, (error) => error === failure.error));
  assert(original, 'Expected original SDK checkpoint failure is absent or an unrelated failure also entered.');
  if (selected.kind === 'persistence') assert(errorContains(original.error, (error) => error === cause), 'Persistence failure lost the exact rejected callback cause.');
  else assert.equal(entry.cancellation.signal.reason, cause, 'Acquisition cancellation did not use its exact original member signal.');
  const resource = fault.record.resources.find(({ role }) => role === 'compute');
  assert(['creating', 'identified'].includes(selected.boundary) ? resource.identity.kind === selected.boundary : fault.record.phase === selected.boundary,
    'Captured original checkpoint does not match the selected physical boundary.');
  return { operation, code, operationId: original.record.operationId, originalRecord: original.record };
}
