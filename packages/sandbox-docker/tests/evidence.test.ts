// ------------------------------------------------------------------------------------------------
//                evidence.test.ts - Reject false cleanup claims - Evidence consumer boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCleanupEvidence } from './integration/support/evidence.js';
import type { CleanupEvidenceReport } from './integration/support/evidence.js';

function stoppedAndDestroyed(): CleanupEvidenceReport {
  return { format: 'agenai.sandbox-cleanup-evidence.v1', rows: [
    { label: 'stop-before-export', expected: [{ role: 'compute', id: 'exact-compute-1' }], events: [
      { sequence: 1, kind: 'sdk-close', result: 'fulfilled' },
      { sequence: 2, kind: 'observation', source: 'independent-engine', role: 'compute', id: 'exact-compute-1', httpStatus: 404 },
    ] },
    { label: 'destroy', expected: [{ role: 'compute', id: 'exact-compute-1' }, { role: 'storage', id: 'exact-volume-1' }], events: [
      { sequence: 1, kind: 'sdk-close', result: 'fulfilled' },
      { sequence: 2, kind: 'observation', source: 'independent-engine', role: 'compute', id: 'exact-compute-1', httpStatus: 404 },
      { sequence: 3, kind: 'observation', source: 'independent-engine', role: 'storage', id: 'exact-volume-1', httpStatus: 404 },
      { sequence: 4, kind: 'external-cleanup', role: 'storage', id: 'exact-volume-1' },
    ] },
  ] };
}

test('cleanup evidence admits exact independent absence after SDK close and before external disposal', () => {
  assert.deepEqual(checkCleanupEvidence(JSON.parse(JSON.stringify(stoppedAndDestroyed()))), { kind: 'accepted', rows: 2 });
});

test('cleanup evidence rejects missing, substituted, live and prematurely cleaned resource observations', () => {
  const event = { sequence: 2, kind: 'observation', source: 'independent-engine', role: 'compute', id: 'exact-compute-1', httpStatus: 404 };
  const close = { sequence: 1, kind: 'sdk-close', result: 'fulfilled' };
  for (const [label, events, reason] of [
    ['missing', [close, { sequence: 2, kind: 'sdk-close', result: 'fulfilled' }], /uniquely fulfill/u],
    ['wrong-id', [close, { ...event, id: 'different-compute' }], /identity/u],
    ['wrong-role', [close, { ...event, role: 'storage' }], /identity/u],
    ['live-200', [close, { ...event, httpStatus: 200 }], /absence/u],
    ['failed-observer', [close, { ...event, httpStatus: 503 }], /absence/u],
    ['controller-observer', [close, { ...event, source: 'sdk' }], /independent observation/u],
    ['before-close', [{ ...event, sequence: 1 }, { ...close, sequence: 2 }], /preceded SDK close/u],
    ['early-external-cleanup', [close, { sequence: 2, kind: 'external-cleanup', role: 'compute', id: 'exact-compute-1' }, { ...event, sequence: 3 }], /external cleanup preceded/u],
    ['false-sdk-success', [{ ...close, result: 'rejected' }, event], /SDK close/u],
    ['reordered', [close, { ...event, sequence: 3 }], /ordering/u],
    ['partial-destroy', [close, event], /missing/u],
  ] as const) {
    const expected = label === 'partial-destroy' ? [{ role: 'compute', id: 'exact-compute-1' }, { role: 'storage', id: 'exact-volume-1' }]
      : [{ role: 'compute', id: 'exact-compute-1' }];
    const verdict = checkCleanupEvidence({ format: 'agenai.sandbox-cleanup-evidence.v1', rows: [{ label, expected, events }] });
    assert.equal(verdict.kind, 'rejected', label);
    if (verdict.kind !== 'rejected') throw new Error(`${label} incorrectly accepted.`);
    assert.match(verdict.reason, reason, label);
  }
});

test('cleanup evidence bounds untrusted input and rejects cycles and accessors without invoking them', () => {
  const nested: unknown[] = [];
  let tail = nested;
  for (let index = 0; index < 12; index += 1) { const next: unknown[] = []; tail.push(next); tail = next; }
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let getterReads = 0;
  const accessor = { get rows() { getterReads += 1; return []; } };
  let serializationCalls = 0;
  const serializer = { toJSON() { serializationCalls += 1; return stoppedAndDestroyed(); } };
  for (const input of [nested, cycle, accessor, serializer, { [Symbol('hidden')]: 'value' }, { data: 'x'.repeat(256 * 1024) },
    new Proxy({}, { ownKeys() { throw new Error('Untrusted object trap.'); } }),
    { format: 'agenai.sandbox-cleanup-evidence.v1', rows: Array.from({ length: 129 }, () => ({})) },
    { format: 'agenai.sandbox-cleanup-evidence.v1', rows: [] }]) {
    const verdict = checkCleanupEvidence(input);
    assert.equal(verdict.kind, 'rejected');
  }
  assert.equal(getterReads, 0);
  assert.equal(serializationCalls, 0);
  assert.deepEqual(checkCleanupEvidence(stoppedAndDestroyed()), { kind: 'accepted', rows: 2 });
});
