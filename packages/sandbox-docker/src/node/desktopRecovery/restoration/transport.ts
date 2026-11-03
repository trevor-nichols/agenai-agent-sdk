import type { DockerApi } from '../../../resources/api.js';
import type { RecoveryNativeOwner } from '../native/owner.js';
import { inspectDesktopCoordinatorEndpoint } from '../../desktopCoordinatorEndpoint.js';
import type { DesktopCoordinatorEndpointBinding } from '../../desktopCoordinatorEndpoint.js';
import type { NativeCurrentAdmissionFacts } from '../native/schemas.js';
import { digestBytes } from '../native/framing.js';
import { immutable } from '../../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { assertRestoredEngine, captureRecoveryEngine, recoveryNativeFactsDigest,
  recoveryStoreIdentityDigest, RecoveryRestorationError } from './engine.js';
import { parseRecoveryMetadata } from './metadata.js';
import type { RecoveryEngineObservation } from './engine.js';

export interface RecoveryTransportObservation {
  readonly endpoint: DesktopCoordinatorEndpointBinding;
  readonly native: NativeCurrentAdmissionFacts;
  readonly engine: RecoveryEngineObservation;
  readonly installationDigests: Readonly<{ components: string; settings: string }>;
  readonly nativeFactsDigest: string;
  readonly engineFactsDigest: string;
  readonly storeIdentityDigest: string;
}

/** Every GET joins its non-pooled connection before the closing native census. */
export async function captureRecoveryTransport(native: RecoveryNativeOwner, api: DockerApi,
  endpoint: string, expectedId: string, signal?: AbortSignal): Promise<RecoveryTransportObservation> {
  signal?.throwIfAborted();
  await native.checkClaim();
  const endpointBefore = await inspectDesktopCoordinatorEndpoint(endpoint, signal);
  // Read-only requests may wake the existing Resource Saver VM before producer admission.
  const primedEngine = await captureRecoveryEngine(api, expectedId, signal);
  const nativeBefore = await native.observeAdmission();
  const captureMetadata = async (source: 'components' | 'settings') => {
    const file = await native.readMetadata(source);
    if (digestBytes(file.bytes) !== nativeBefore.metadata[source].sha256
      || file.bytes.length !== nativeBefore.metadata[source].bytes) {
      throw new RecoveryRestorationError('composition', 'Desktop metadata changed within its native/API bracket.');
    }
    return parseRecoveryMetadata(source, file.bytes).digest;
  };
  const installationDigests = { components: await captureMetadata('components'), settings: await captureMetadata('settings') };
  const engine = await captureRecoveryEngine(api, expectedId, signal);
  assertRestoredEngine(primedEngine, engine);
  const nativeAfter = await native.observeCurrentPeer();
  const endpointAfter = await inspectDesktopCoordinatorEndpoint(endpoint, signal);
  const nativeFactsDigest = recoveryNativeFactsDigest(nativeAfter);
  if (nativeFactsDigest !== recoveryNativeFactsDigest(nativeBefore)
    || endpointBefore.digest !== endpointAfter.digest
    || endpointAfter.physical.device !== nativeAfter.peer.device || endpointAfter.physical.inode !== nativeAfter.peer.inode) {
    throw new RecoveryRestorationError('endpoint', 'Desktop native peer, composition or configured endpoint changed across actual Docker GETs.');
  }
  await native.checkClaim();
  signal?.throwIfAborted();
  return immutable({ endpoint: endpointAfter, native: nativeAfter, engine, installationDigests,
    nativeFactsDigest, engineFactsDigest: engine.engineIdentityDigest, storeIdentityDigest: recoveryStoreIdentityDigest(nativeAfter) });
}

export function assertRecoveryRestoredTransport(before: RecoveryTransportObservation, after: RecoveryTransportObservation): void {
  assertRestoredEngine(before.engine, after.engine);
  if (before.storeIdentityDigest !== after.storeIdentityDigest) {
    throw new RecoveryRestorationError('store', 'Desktop persistent VM disk identity changed across the observed lifecycle.');
  }
  if (before.native.hostBoot !== after.native.hostBoot || before.native.uid !== after.native.uid
    || before.installationDigests.components !== after.installationDigests.components || before.installationDigests.settings !== after.installationDigests.settings) {
    throw new RecoveryRestorationError('composition', 'Desktop host, installation or settings changed across the observed lifecycle.');
  }
}
