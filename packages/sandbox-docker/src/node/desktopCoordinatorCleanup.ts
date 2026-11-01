import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerDesktopCoordinatorFailure } from '../network/desktop/coordinator/contracts.js';
import { coordinatorDigest, coordinatorEngineKey } from '../network/desktop/coordinator/journal/schema.js';
import type { CoordinatorSnapshot } from '../network/desktop/coordinator/journal/schema.js';
import { DESKTOP_COORDINATOR_POLICY_DIGEST } from '../network/desktop/coordinator/policy.js';
import type { DesktopCoordinatorConfiguration } from './desktopCoordinatorOptions.js';
import type { DesktopCoordinatorHolderIdentity } from './desktopCoordinatorHolder.js';

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError('Desktop cleanup input requires a plain data object.');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('Desktop cleanup input rejects unknown fields and accessors.');
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function parseDesktopCleanupExpected(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const { expectedGeneration } = fields(input, ['expectedGeneration']);
  if (expectedGeneration === undefined) return undefined;
  if (typeof expectedGeneration !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(expectedGeneration)) {
    throw new TypeError('Expected generation must be an original version-four UUID.');
  }
  return expectedGeneration;
}

export function captureDesktopCleanupInput(input: unknown): Readonly<{ configuration: unknown; record: SandboxRecoveryRecord }> {
  const value = fields(input, ['configuration', 'record']);
  if (!Object.hasOwn(value, 'configuration') || !Object.hasOwn(value, 'record')) {
    throw new TypeError('Desktop cleanup requires the original member configuration and canonical record.');
  }
  return Object.freeze({ configuration: value.configuration, record: parseSandboxRecoveryRecord(value.record) });
}

export function desktopCleanupIdentityConflict(snapshot: CoordinatorSnapshot, configuration: DesktopCoordinatorConfiguration,
  native: Readonly<{ daemonId: string; endpointDigest: string; opened: DesktopCoordinatorHolderIdentity }>, expected?: string,
): Extract<DockerDesktopCoordinatorFailure, { kind: 'identity_conflict' }>['scope'] | undefined {
  if (snapshot.daemonId !== native.daemonId || snapshot.engineKey !== coordinatorEngineKey(native.daemonId)) return 'engine';
  const current = snapshot.generation;
  if (expected !== undefined && expected !== (current.kind === 'clean' ? current.lastGenerationId : current.identity.generationId)) return 'generation';
  if (current.kind === 'clean') return undefined;
  const identity = current.identity;
  if (identity.endpointBindingDigest !== native.endpointDigest) return 'endpoint';
  const claim = coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify({ rootDevice: native.opened.rootDevice,
    rootInode: native.opened.rootInode, lockDevice: native.opened.lockDevice, lockInode: native.opened.lockInode }));
  if (current.basis.exclusionDigest !== claim) return 'generation';
  if (identity.coordinationPolicyDigest !== DESKTOP_COORDINATOR_POLICY_DIGEST
    || identity.hostPreparationDigest !== configuration.sharedDigest
    || identity.engineBindingDigest !== coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({
      daemonId: native.daemonId, shared: configuration.sharedDigest }))
    || identity.nativeAssetDigest !== coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(configuration.helper))) return 'configuration';
  return undefined;
}
