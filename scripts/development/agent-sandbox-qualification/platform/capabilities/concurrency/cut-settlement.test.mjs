import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha } from '../../coordinator/evidence.mjs';
import { canonicalAfterCut, leaseSettled } from './cut-settlement.mjs';

const engine = 'e'.repeat(64);
const envelope = (snapshot) => {
  const payload = Buffer.from(JSON.stringify({ format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${engine}`, ...snapshot }));
  return Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engine}\n${sha(payload)}\n`), payload]);
};
const digest = (bytes) => {
  const payload = bytes.subarray(bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1);
  return `sha256:${createHash('sha256').update('agenai.desktop-coordinator.snapshot.v1\0').update(payload).digest('hex')}`;
};
const dirty = (generationId, extra = {}) => ({ kind: 'dirty', identity: { generationId }, ...extra });
const members = [{ memberId: 'a' }, { memberId: 'b' }];
const cut = envelope({ sequence: 41, previousDigest: `sha256:${'0'.repeat(64)}`, generation: dirty('g', { queue: [], members }) });
const next = (overrides = {}) => envelope({ sequence: 42, previousDigest: digest(cut), generation: dirty('g', { queue: [{ effectSequence: 9 }], members }), ...overrides });

test('lease settlement requires every leased helper stopped and never a compute stop', () => {
  const stopped = ['filesystem', 'egress_broker', 'egress_relay', 'route_observer'].map((role) => ({ role, running: false }));
  assert.equal(leaseSettled([{ role: 'compute', running: true }, ...stopped]), true);
  assert.equal(leaseSettled([{ role: 'compute', running: false }, ...stopped]), true);
  assert.equal(leaseSettled([...stopped.slice(1), { role: 'filesystem', running: true }]), false);
  assert.equal(leaseSettled([{ role: 'compute', running: false }]), false, 'Compute alone cannot prove helper lease expiry.');
  assert.equal(leaseSettled([]), false);
});

test('unchanged canonical bytes settle every cut', () => {
  for (const successor of [true, false]) assert.deepEqual(canonicalAfterCut(cut, Buffer.from(cut), { successor }), { kind: 'unchanged' });
});

test('a self-suspension cut admits exactly the one in-flight holder publication', () => {
  assert.deepEqual(canonicalAfterCut(cut, next(), { successor: true }), { kind: 'successor', sequence: 42, previousDigest: digest(cut) });
});

test('a response cut admits no canonical change', () => {
  assert.throws(() => canonicalAfterCut(cut, next(), { successor: false }), /changed before the selected signal/u);
});

test('a changed generation, a second publication or a foreign predecessor is refused', () => {
  assert.throws(() => canonicalAfterCut(cut, next({ generation: dirty('other') }), { successor: true }), /generation changed/u);
  assert.throws(() => canonicalAfterCut(cut, next({ generation: { kind: 'clean' } }), { successor: true }), /cannot settle the generation/u);
  assert.throws(() => canonicalAfterCut(cut, next({ sequence: 43 }), { successor: true }), /beyond the one publication/u);
  assert.throws(() => canonicalAfterCut(cut, next({ previousDigest: `sha256:${'1'.repeat(64)}` }), { successor: true }), /does not extend/u);
});

test('a successor that retires or adds a cut member is refused', () => {
  for (const changed of [[{ memberId: 'a' }], [...members, { memberId: 'c' }]]) {
    assert.throws(() => canonicalAfterCut(cut, next({ generation: dirty('g', { queue: [], members: changed }) }), { successor: true }),
      /changed the cut member set/u);
  }
});
