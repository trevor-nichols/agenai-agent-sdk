import assert from 'node:assert/strict';
import { parseSandboxRecoveryRecord, parseSandboxRequest } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../src/policy/config.js';
import { newRecoveryRecord } from '../../src/recovery/identity.js';
import { resourceKind } from '../../src/resources/inspect.js';
import { beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition } from '../../src/network/desktop/coordinator/journal/plans.js';
import type { CoordinatorEvent } from '../../src/network/desktop/coordinator/journal/plans.js';
import type { CoordinatorSnapshot } from '../../src/network/desktop/coordinator/journal/schema.js';
import { sandboxRequest } from './engine.js';

/** A full historical resource graph produced through the ordinary journal transitions. */
export function identifiedRecoveryJournalFixture(config: DockerSandboxConfig, seed: CoordinatorSnapshot): CoordinatorSnapshot {
  const original = seed.generation;
  if (original.kind !== 'dirty') assert.fail('Expected an original generation binding.');
  const digest = original.basis.engineDigest;
  const began = beginCoordinatorGeneration(createInitialCoordinatorSnapshot(seed), {
    identity: original.identity, basis: { kind: 'host_engine_only', hostDigest: original.basis.hostDigest,
      engineDigest: digest, exclusionDigest: original.basis.exclusionDigest, atSequence: 1 },
  });
  if (began.kind === 'rejected') assert.fail(began.reason);
  let snapshot = began.snapshot;
  const apply = (event: CoordinatorEvent) => {
    const plan = planCoordinatorTransition(snapshot, event);
    if (plan.kind === 'rejected') assert.fail(plan.reason);
    snapshot = plan.snapshot;
  };
  const request = parseSandboxRequest({ policy: { ...sandboxRequest({ kind: 'restricted_https',
    destinations: [{ hostname: 'api.example.com', port: 443 }] }).policy, files: { kind: 'read_write' } } });
  for (let slot = 0; slot < 4; slot += 1) {
    let record = newRecoveryRecord(config, request);
    if (record.backendRevision !== 'engine-1.52-v7-desktop-apple-virtualization-native-arm64') assert.fail('Expected native Desktop binding.');
    apply({ kind: 'register', record, slot, binding: { profile: 'desktop-apple-virtualization-native-arm64',
      backendRevision: record.backendRevision, configurationIdentityDigest: record.configurationDigest } });
    const resources = [...record.resources].sort((left, right) => Number(right.role === 'route_observer') - Number(left.role === 'route_observer'));
    for (const resource of resources) {
      record = parseSandboxRecoveryRecord({ ...record, phase: 'starting', authority: { kind: 'verified', backendIdentity: seed.daemonId },
        resources: record.resources.map((entry) => entry.role === resource.role ? { ...entry, identity: { kind: 'creating' } } : entry) });
      apply({ kind: 'checkpoint', memberId: record.operationId, record, mode: 'caller_persisted' });
      apply({ kind: 'queue', memberId: record.operationId, role: resource.role, action: 'create' });
      if (snapshot.generation.kind !== 'dirty') assert.fail('Expected queued create.');
      const effectSequence = snapshot.generation.queue[0]?.effectSequence; assert(effectSequence);
      apply({ kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest });
      const id = `${record.operationId}-${resource.role}`;
      apply({ kind: 'returned', effectSequence, id });
      record = parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((entry) => entry.role === resource.role
        ? { ...entry, identity: { kind: 'identified', id, fingerprint: digest } } : entry) });
      apply({ kind: 'settle', effectSequence, outcome: 'present', receiptDigest: digest, record,
        presence: { kind: 'present', id, fingerprint: digest, inspectionDigest: digest,
          runtime: resourceKind(resource.role) === 'container' ? 'created' : 'not_applicable' } });
      if (slot === 0 && resource.role === 'route_observer') {
        apply({ kind: 'queue', memberId: record.operationId, role: resource.role, action: 'start' });
        if (snapshot.generation.kind !== 'dirty') assert.fail('Expected queued observer start.');
        const start = snapshot.generation.queue[0]?.effectSequence; assert(start);
        apply({ kind: 'arm', effectSequence: start, expectedBeforeDigest: digest, expectedInputDigest: digest });
        apply({ kind: 'settle', effectSequence: start, outcome: 'started', receiptDigest: digest,
          presence: { kind: 'present', id, fingerprint: digest, inspectionDigest: digest, runtime: 'running' } });
        apply({ kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
          externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: original.basis.exclusionDigest,
          projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
      }
    }
  }
  apply({ kind: 'reopen_cleanup' });
  return snapshot;
}
