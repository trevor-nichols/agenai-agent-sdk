import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseCanonicalEnvelope } from '../../coordinator-recovery/canonical.mjs';

// Helper and observer controls hold controller leases. Compute runs the SDK keeper and holds none, so a paused
// controller cannot stop it: process death is not a compute-stop receipt, and recovery removes compute exactly.
export const leasedRoles = Object.freeze(['filesystem', 'egress_broker', 'egress_relay', 'route_observer']);

export function leaseSettled(states) {
  const leased = states.filter(({ role }) => leasedRoles.includes(role));
  return leased.length > 0 && leased.every(({ running }) => !running);
}

const payloadOf = (bytes) => {
  let offset = 0;
  for (let line = 0; line < 3; line++) offset = bytes.indexOf(10, offset) + 1;
  return bytes.subarray(offset);
};
const snapshotDigest = (payload) => `sha256:${createHash('sha256')
  .update('agenai.desktop-coordinator.snapshot.v1').update('\0').update(payload).digest('hex')}`;

// The native holder is a separate process that keeps running when the original worker freezes itself. A commit
// it already read can still publish, so a self-suspension cut taken inside the workflow admits exactly that one
// successor of its preserved bytes. A response cut is quiescent by construction and admits no change.
export function canonicalAfterCut(cutBytes, liveBytes, { successor }) {
  if (Buffer.compare(cutBytes, liveBytes) === 0) return Object.freeze({ kind: 'unchanged' });
  assert(successor, 'Canonical bytes changed before the selected signal.');
  const cut = parseCanonicalEnvelope(cutBytes).value, live = parseCanonicalEnvelope(liveBytes).value;
  assert.equal(live.generation.kind, 'dirty', 'An in-flight original publication cannot settle the generation.');
  assert.equal(live.generation.identity.generationId, cut.generation.identity.generationId, 'Canonical generation changed after the cut.');
  assert.equal(live.sequence, cut.sequence + 1, 'Canonical advanced beyond the one publication in flight at the cut.');
  assert.equal(live.previousDigest, snapshotDigest(payloadOf(cutBytes)), 'Canonical successor does not extend the preserved cut bytes.');
  // Recovery treats a member absent from the canonical as destroyed, so the successor must keep the cut's members.
  const members = (snapshot) => (snapshot.generation.members ?? []).map(({ memberId }) => memberId).sort();
  assert.deepEqual(members(live), members(cut), 'Canonical successor changed the cut member set.');
  return Object.freeze({ kind: 'successor', sequence: live.sequence, previousDigest: live.previousDigest });
}
