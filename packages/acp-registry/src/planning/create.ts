import type { AcpRegistrySnapshot } from '../catalog/contracts.js';
import { validateAcpRegistrySnapshot } from '../catalog/assert.js';
import { invalidRegistry } from '../shared/errors.js';
import { distributionPreference, registryTarget, selectAcpRegistryDistribution } from '../selection/distribution.js';
import { exactKeys, inputDigest, inputRecord, inputString, plainInput } from '../selection/input.js';
import { deriveAcpInstallPlan } from './derive.js';
import type { AcpInstallPlan, CreateAcpInstallPlanInput } from './contracts.js';

export function createAcpInstallPlan(snapshot: AcpRegistrySnapshot, input: CreateAcpInstallPlanInput): AcpInstallPlan {
  snapshot = validateAcpRegistrySnapshot(snapshot);
  const options = inputRecord(plainInput(input), []);
  exactKeys(options, ['entryIdentity', 'expectedSnapshotDigest', 'expectedEntryDigest', 'target', 'distributionPreference', 'policy', 'packageResolution', 'toolchains', 'binaryIntegrity', 'binaryFormat'], []);
  const expectedSnapshotDigest = inputDigest(options.expectedSnapshotDigest, ['expectedSnapshotDigest']);
  const expectedEntryDigest = inputDigest(options.expectedEntryDigest, ['expectedEntryDigest']);
  if (snapshot.digest !== expectedSnapshotDigest) invalidRegistry('acp_registry_snapshot_stale', ['expectedSnapshotDigest'], 'The selected snapshot does not match the caller-pinned digest.');
  const identity = inputString(options.entryIdentity, ['entryIdentity'], 2_048);
  const entry = snapshot.entries.find((candidate) => candidate.identity === identity);
  if (!entry) invalidRegistry('acp_registry_entry_not_found', ['entryIdentity'], 'The selected source-qualified entry is absent from this snapshot.');
  if (entry.digest !== expectedEntryDigest) invalidRegistry('acp_registry_entry_stale', ['expectedEntryDigest'], 'The selected entry does not match the caller-pinned digest.');
  const target = registryTarget(options.target);
  const preference = distributionPreference(options.distributionPreference);
  const distribution = selectAcpRegistryDistribution(entry, { target, preference });
  return deriveAcpInstallPlan({ source: snapshot.source, sourceIdentity: snapshot.sourceIdentity,
    snapshotDigest: snapshot.digest, rawSnapshotDigest: snapshot.rawDigest,
    entry: { identity: entry.identity, digest: entry.digest, id: entry.id, version: entry.version },
    target, distributionPreference: preference, distribution }, options);
}
