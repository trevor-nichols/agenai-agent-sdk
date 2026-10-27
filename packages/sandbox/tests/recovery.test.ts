// ------------------------------------------------------------------------------------------------
//                recovery.test.ts - Fixed recovery evidence and explicit persistence behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxValidationError, parseSandboxRecoveryPolicy, parseSandboxRecoveryRecord } from '../src/index.js';

function record() {
  return {
    format: 'agenai.sandbox-recovery.v3', backendId: 'engine', backendRevision: '1',
    namespace: 'caller-1', operationId: 'operation-1', sandboxId: 'sandbox-1',
    imageDigest: `sha256:${'a'.repeat(64)}`, policyDigest: `sha256:${'b'.repeat(64)}`,
    configurationDigest: `sha256:${'d'.repeat(64)}`,
    phase: 'reserved', authority: { kind: 'unverified' },
    resources: [{ role: 'compute', name: 'compute-1', identity: { kind: 'planned' } }],
  };
}

test('recovery parsing returns immutable non-callable evidence with initial names', () => {
  const input = record();
  const parsed = parseSandboxRecoveryRecord(input);
  input.resources[0]!.name = 'replacement';
  assert.deepEqual(parsed.resources, [{ role: 'compute', name: 'compute-1', identity: { kind: 'planned' } }]);
  assert.deepEqual(parsed.authority, { kind: 'unverified' });
  assert.equal(parsed.phase, 'reserved');
  assert.equal(parsed.format, 'agenai.sandbox-recovery.v3');
  assert.equal(parsed.configurationDigest, `sha256:${'d'.repeat(64)}`);
  assert.equal(Object.isFrozen(parsed.resources[0]!.identity), true);
  assert.equal('destroy' in parsed, false);
  assert.equal('owner' in parsed, false);
});

test('recovery distinguishes entered unresolved acquisition from identified incarnation', () => {
  const parsed = parseSandboxRecoveryRecord({
    ...record(), phase: 'starting', authority: { kind: 'verified', backendIdentity: 'engine-installation-1' },
    resources: [
      { role: 'compute', name: 'compute-1', identity: { kind: 'creating' } },
      { role: 'storage', name: 'storage-1', identity: { kind: 'identified', id: 'volume-1', fingerprint: `sha256:${'c'.repeat(64)}` } },
      { role: 'export', name: 'export-1', identity: { kind: 'planned' } },
    ],
  });
  assert.deepEqual(parsed.resources.map((resource) => resource.identity), [
    { kind: 'creating' },
    { kind: 'identified', id: 'volume-1', fingerprint: `sha256:${'c'.repeat(64)}` },
    { kind: 'planned' },
  ]);
  assert.deepEqual(parsed.authority, { kind: 'verified', backendIdentity: 'engine-installation-1' });
});

test('recovery rejects arbitrary payloads, unverified effects, ambiguous identities and oversized envelopes', () => {
  const base = record();
  const invalid = [
    { ...base, format: 'future-version' },
    { ...base, format: 'agenai.sandbox-recovery.v1' },
    { ...base, format: 'agenai.sandbox-recovery.v2' },
    { ...base, configurationDigest: 'configuration-without-digest' },
    { ...base, env: { API_KEY: 'must-not-persist' } },
    { ...base, endpoint: 'unix:///not-authority' },
    { ...base, payload: 'x'.repeat(65_536) },
    { ...base, imageDigest: 'image-tag:latest' },
    { ...base, phase: 'running' },
    { ...base, resources: [{ role: 'compute', name: 'compute-1', identity: { kind: 'creating' } }] },
    { ...base, authority: { kind: 'verified', backendIdentity: 'engine-1' }, resources: [{ role: 'storage', name: 'storage-1', identity: { kind: 'identified', id: 'volume-name-only' } }] },
    { ...base, resources: [base.resources[0], { ...base.resources[0], name: 'duplicate-role' }] },
    { ...base, resources: [base.resources[0], { ...base.resources[0], role: 'storage' }] },
    { ...base, namespace: 'é'.repeat(33) },
    { ...base, operationId: 'x'.repeat(257) },
    { ...base, resources: [{ role: 'compute', name: 'compute-1', identity: { kind: 'planned', id: 'contradictory' } }] },
  ];
  for (const candidate of invalid) assert.throws(() => parseSandboxRecoveryRecord(candidate), SandboxValidationError);
});

test('v3 recovery retains the complete closed topology and rejects extra or repeated roles', () => {
  const resources = ['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'filesystem', 'route_observer']
    .map((role, index) => ({ role, name: `${role}-1`, identity: { kind: 'identified', id: `${role}-id-1`, fingerprint: `sha256:${String(index).repeat(64)}` } }));
  const input = { ...record(), phase: 'running', authority: { kind: 'verified', backendIdentity: 'engine-1' }, resources };
  const parsed = parseSandboxRecoveryRecord(input);
  assert.deepEqual(parsed.resources, resources);
  assert.equal(parsed.format, 'agenai.sandbox-recovery.v3');
  for (const candidate of [
    { ...input, resources: [...resources, { role: 'initializer', name: 'initializer-1', identity: { kind: 'planned' } }] },
    { ...input, resources: resources.map((resource) => resource.role === 'filesystem' ? { ...resource, role: 'initializer' } : resource) },
    { ...input, resources: resources.map((resource) => resource.role === 'filesystem' ? { ...resource, role: 'egress_broker' } : resource) },
    { ...input, resources: resources.map((resource) => resource.role === 'filesystem' ? { ...resource, name: 'egress_broker-1' } : resource) },
  ]) assert.throws(() => parseSandboxRecoveryRecord(candidate), SandboxValidationError);
});

test('explicit persistence preserves the immutable checkpoint and propagates persistence failure', async () => {
  const snapshots: unknown[] = [];
  const policy = parseSandboxRecoveryPolicy({ kind: 'persisted', async persist(value: unknown) { snapshots.push(value); } });
  assert.equal(policy.kind, 'persisted');
  if (policy.kind !== 'persisted') throw new Error('Expected persistent recovery');
  const checkpoint = parseSandboxRecoveryRecord(record());
  await policy.persist(checkpoint);
  assert.deepEqual(snapshots, [checkpoint]);
  const failure = new Error('checkpoint storage failed');
  const failing = parseSandboxRecoveryPolicy({ kind: 'persisted', async persist() { throw failure; } });
  if (failing.kind !== 'persisted') throw new Error('Expected persistent recovery');
  await assert.rejects(failing.persist(checkpoint), (error: unknown) => error === failure);
  const synchronous = parseSandboxRecoveryPolicy({ kind: 'persisted', persist() {} });
  if (synchronous.kind !== 'persisted') throw new Error('Expected persistent recovery');
  await assert.rejects(synchronous.persist(checkpoint), SandboxValidationError);
  assert.deepEqual(parseSandboxRecoveryPolicy({ kind: 'in_process' }), { kind: 'in_process' });
  for (const input of [{ kind: 'in_process', persist() {} }, { kind: 'persisted' }, { kind: 'persisted', persist: 'path' }]) {
    assert.throws(() => parseSandboxRecoveryPolicy(input), SandboxValidationError);
  }
});
