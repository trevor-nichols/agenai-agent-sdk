import { DockerEngine } from '../../engine/client.js';
import { DockerApi } from '../../resources/api.js';
import { dockerCoordinatedBackendRevision } from '../../policy/profiles.js';
import { coordinatorDigest, coordinatorEngineKey } from '../../network/desktop/coordinator/journal/schema.js';
import type { CoordinatorSnapshot } from '../../network/desktop/coordinator/journal/schema.js';
import { DESKTOP_COORDINATOR_POLICY, DESKTOP_COORDINATOR_POLICY_DIGEST } from '../../network/desktop/coordinator/policy.js';
import type { RecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { activeRecoveryHelper } from '../../network/desktop/coordinator/administrativeRecovery/helperSuccession.js';
import type { CurrentTransportAdmission, RecoveryClaim } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { openPreparedExecutable } from '../preparedExecutable.js';
import type { PreparedExecutable } from '../preparedExecutable.js';
import { readDesktopCoordinatorSourceDigest } from '../prepareDesktopCoordinator.js';
import { DockerDesktopRecoveryError } from './contracts.js';
import type { DockerDesktopRecoveryController, DockerDesktopRecoveryHelper } from './contracts.js';
import type { DesktopRecoveryConfiguration } from './options.js';
import { openRecoveryNativeOwner } from './native/owner.js';
import type { RecoveryNativeError, RecoveryNativeOwner } from './native/owner.js';
import { captureRecoveryTransport } from './restoration/transport.js';
import type { RecoveryTransportObservation } from './restoration/transport.js';

export function transportAdmission(observed: RecoveryTransportObservation, admittedAtSequence: number): CurrentTransportAdmission {
  return Object.freeze({ kind: 'sdk-current-transport.v1', admittedAtSequence,
    endpointDigest: observed.endpoint.digest, nativeFactsDigest: observed.nativeFactsDigest,
    engineFactsDigest: observed.engineFactsDigest });
}

export function sameTransport(left: CurrentTransportAdmission, right: CurrentTransportAdmission): boolean {
  return left.endpointDigest === right.endpointDigest && left.nativeFactsDigest === right.nativeFactsDigest
    && left.engineFactsDigest === right.engineFactsDigest;
}

/** Keeps both exact prepared executables owned until the original physical claim is joined. */
export class RecoveryAuthority {
  readonly api: DockerApi;
  readonly endpoint: string;
  readonly daemonId: string;
  private originalExecutable: PreparedExecutable | undefined;
  private holder: RecoveryNativeOwner | undefined;

  constructor(readonly configuration: DesktopRecoveryConfiguration,
    private readonly owner: DockerDesktopRecoveryController, private readonly onLoss: (cause: RecoveryNativeError) => void) {
    this.endpoint = configuration.original.route.identity.engine.endpoint;
    this.daemonId = configuration.original.route.identity.engine.id;
    this.api = new DockerApi(new DockerEngine(this.endpoint.slice(7)), DESKTOP_COORDINATOR_POLICY.commandTimeoutMs);
  }

  get native(): RecoveryNativeOwner {
    if (!this.holder) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.owner);
    return this.holder;
  }

  get holderLost(): boolean { return this.holder !== undefined && !this.holder.claimed; }

  async open(): Promise<void> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new DockerDesktopRecoveryError({ kind: 'unsupported', reason: 'profile' }, this.owner);
    }
    if (await readDesktopCoordinatorSourceDigest() !== this.configuration.original.helper.sourceDigest) {
      throw new DockerDesktopRecoveryError({ kind: 'preparation_invalid' }, this.owner);
    }
    this.originalExecutable ??= await openPreparedExecutable(this.configuration.original.helper.executable);
    await this.originalExecutable.verify();
    this.holder ??= await openRecoveryNativeOwner({ helper: this.configuration.helper,
      engineKey: coordinatorEngineKey(this.daemonId).slice(7), endpoint: this.endpoint.slice(7), onLoss: this.onLoss });
    await this.holder.opened;
  }

  async claim(): Promise<RecoveryClaim> {
    const opened = await this.native.opened;
    return { rootDevice: opened.rootDevice, rootInode: opened.rootInode,
      lockDevice: opened.lockDevice, lockInode: opened.lockInode };
  }

  async assertOriginal(snapshot: CoordinatorSnapshot, expectedGeneration: string): Promise<void> {
    const conflict = (scope: 'engine' | 'generation' | 'configuration') => {
      throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope }, this.owner);
    };
    if (snapshot.daemonId !== this.daemonId || snapshot.engineKey !== coordinatorEngineKey(this.daemonId)) conflict('engine');
    const generation = snapshot.generation;
    if (expectedGeneration !== (generation.kind === 'dirty' ? generation.identity.generationId : generation.lastGenerationId)) conflict('generation');
    if (generation.kind === 'clean') return;
    if (generation.members.some((member) => member.checkpoint.record.backendRevision
      !== dockerCoordinatedBackendRevision('desktop-apple-virtualization-native-arm64'))) {
      throw new DockerDesktopRecoveryError({ kind: 'unsupported', reason: 'profile' }, this.owner);
    }
    const identity = generation.identity;
    if (generation.basis.exclusionDigest !== coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(await this.claim()))) conflict('generation');
    if (identity.coordinationPolicyDigest !== DESKTOP_COORDINATOR_POLICY_DIGEST
      || identity.hostPreparationDigest !== this.configuration.original.sharedDigest
      || identity.engineBindingDigest !== coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({
        daemonId: this.daemonId, shared: this.configuration.original.sharedDigest }))
      || identity.nativeAssetDigest !== coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(this.configuration.original.helper))) conflict('configuration');
  }

  assertPreparation(envelope: RecoveryEnvelope, expectedHelper: DockerDesktopRecoveryHelper = this.configuration.helper,
    expectedProfileDigest = this.native.currentIssuer.profileDigest): void {
    const expected = { configuredEndpoint: this.endpoint, sharedDigest: this.configuration.original.sharedDigest,
      originalHelper: this.configuration.original.helper, recoveryHelper: envelope.preparation.recoveryHelper };
    if (JSON.stringify(expected) !== JSON.stringify(envelope.preparation)
      || JSON.stringify(activeRecoveryHelper(envelope)) !== JSON.stringify(expectedHelper)
      || envelope.format !== 'agenai.docker-desktop-recovery.v1' && envelope.activeProfileDigest !== expectedProfileDigest) {
      throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'configuration' }, this.owner);
    }
  }

  assertExpectedPredecessor(envelope: RecoveryEnvelope, expected: DockerDesktopRecoveryHelper): void {
    if (envelope.format === 'agenai.docker-desktop-recovery.v1') {
      throw new DockerDesktopRecoveryError({ kind: 'unsupported', reason: 'original_format' }, this.owner);
    }
    const predecessor = envelope.format === 'agenai.docker-desktop-recovery.v2'
      ? envelope.preparation.recoveryHelper : envelope.previousIssuers[1].helper;
    if (JSON.stringify(expected) !== JSON.stringify(predecessor)) {
      throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'configuration' }, this.owner);
    }
  }

  async capture(signal?: AbortSignal): Promise<RecoveryTransportObservation> {
    await this.originalExecutable?.verify(signal);
    return captureRecoveryTransport(this.native, this.api, this.endpoint, this.daemonId, signal);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    const holder = this.holder;
    if (holder) {
      try { await holder.close(); this.holder = undefined; }
      catch (cause) {
        if (holder.closeJoined) this.holder = undefined;
        failures.push(cause);
      }
    }
    // Native close settles only after its child exits, including authority-loss rejection.
    if (this.originalExecutable) {
      try { await this.originalExecutable.close(); this.originalExecutable = undefined; }
      catch (cause) { failures.push(cause); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Recovery authority cleanup did not settle every executable descriptor.');
  }
}
