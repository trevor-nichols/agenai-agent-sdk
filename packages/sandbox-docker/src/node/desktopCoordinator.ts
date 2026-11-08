import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DockerEngine } from '../engine/client.js';
import { DockerApi } from '../resources/api.js';
import { reconcileSandboxRecovery } from '@agen-ai/sandbox/backend';
import { DOCKER_BACKEND_ID, parseCoordinatedDockerCleanupConfig } from '../policy/config.js';
import { configurationBackendRevision } from '../recovery/identity.js';
import { verifyDesktopCoordinatorDaemon } from '../policy/preflight.js';
import {
  createDesktopCoordinatorRecoveryFacade, DockerDesktopCoordinatorError,
} from '../network/desktop/coordinator/contracts.js';
import { registerDesktopCoordinatorAuthority } from '../network/desktop/coordinator/binding.js';
import type {
  DockerDesktopCoordinator, DockerDesktopCoordinatorAuthority, DockerDesktopCoordinatorCleanupOpen, DockerDesktopCoordinatorFailure,
  DockerDesktopCoordinatorGenerationState, DockerDesktopCoordinatorOperationOptions, DockerDesktopCoordinatorOptions,
  DockerDesktopCoordinatorRecovery, DockerDesktopCoordinatorState,
} from '../network/desktop/coordinator/contracts.js';
import { parseCoordinatorOperation, observeCoordinatorOperation } from '../network/desktop/coordinator/operations.js';
import type { CoordinatorOperation } from '../network/desktop/coordinator/operations.js';
import { DESKTOP_COORDINATOR_POLICY, DESKTOP_COORDINATOR_POLICY_DIGEST } from '../network/desktop/coordinator/policy.js';
import { DesktopCoordinatorSequence } from '../network/desktop/coordinator/sequence.js';
import {
  coordinatorDigest, coordinatorEngineKey, encodeCoordinatorSnapshot, parseCoordinatorSnapshot, snapshotDigest,
} from '../network/desktop/coordinator/journal/schema.js';
import type { CoordinatorFault, CoordinatorSnapshot } from '../network/desktop/coordinator/journal/schema.js';
import {
  beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition,
} from '../network/desktop/coordinator/journal/plans.js';
import type { CoordinatorEvent, CoordinatorPlan } from '../network/desktop/coordinator/journal/plans.js';
import { parseDesktopCoordinatorConfiguration } from './desktopCoordinatorOptions.js';
import type { DesktopCoordinatorConfiguration } from './desktopCoordinatorOptions.js';
import { openPreparedExecutable } from './preparedExecutable.js';
import { readDesktopCoordinatorSourceDigest } from './prepareDesktopCoordinator.js';
import { inspectDesktopCoordinatorEndpoint } from './desktopCoordinatorEndpoint.js';
import type { DesktopCoordinatorEndpointBinding } from './desktopCoordinatorEndpoint.js';
import { DesktopCoordinatorHolder, DesktopCoordinatorHolderError } from './desktopCoordinatorHolder.js';
import type { DesktopCoordinatorHolderIdentity } from './desktopCoordinatorHolder.js';
import { captureDesktopCoordinatorBaseline, captureDesktopCoordinatorIdentity } from './desktopCoordinatorBaseline.js';
import type { DesktopCoordinatorBaseline } from './desktopCoordinatorBaseline.js';
import { DesktopCoordinatorMembers } from '../network/desktop/coordinator/members.js';
import { DesktopCoordinatorTopologyOwner } from '../network/desktop/coordinator/topologyOwner.js';
import { DesktopEngineRestartedError } from '../network/desktop/coordinator/liveBaseline.js';
import type { DesktopCoordinatorMember, DesktopCoordinatorMemberOwner } from '../network/desktop/coordinator/member.js';
import { createDesktopCoordinatorRecoveryMembers } from '../network/desktop/coordinator/recovery/members.js';
import { captureDesktopCleanupInput, desktopCleanupIdentityConflict, parseDesktopCleanupExpected } from './desktopCoordinatorCleanup.js';

interface NativeAuthority {
  readonly holder: DesktopCoordinatorHolder;
  readonly endpoint: DesktopCoordinatorEndpointBinding;
  readonly daemonId: string;
  readonly api: DockerApi;
}

const authorityFaults = {
  native_holder: 'exclusion', host: 'host', socket: 'endpoint', engine: 'engine', vm: 'vm', proxy: 'proxy',
  observer: 'no_observer', control: 'unknown_outcome', freshness: 'observation_timeout',
} satisfies Record<Extract<DockerDesktopCoordinatorFailure, { kind: 'authority_lost' }>['source'], CoordinatorFault>;

function canonicalFenceEvent(snapshot: CoordinatorSnapshot | undefined,
  failure: DockerDesktopCoordinatorFailure | undefined): Extract<CoordinatorEvent, { kind: 'fence' }> | undefined {
  const generation = snapshot?.generation;
  if (generation?.kind !== 'dirty' || generation.state.kind === 'fenced' || generation.state.kind === 'cleanup_only') return undefined;
  const fault = failure?.kind === 'persistence_failed' ? 'storage'
    : failure?.kind === 'authority_lost' ? authorityFaults[failure.source] : 'unknown_outcome';
  return { kind: 'fence', fault };
}

class DesktopCoordinator implements DockerDesktopCoordinator {
  private status: DockerDesktopCoordinatorState = Object.freeze({ kind: 'inert' });
  private admission: 'open' | 'closed' = 'open';
  private native: NativeAuthority | undefined;
  private current: CoordinatorSnapshot | undefined;
  private proposed: CoordinatorSnapshot | undefined;
  private originalGeneration: string | undefined;
  private opening: Promise<unknown> | undefined;
  private activation: Promise<DockerDesktopCoordinatorAuthority> | undefined;
  private cleanupOpening: Promise<DockerDesktopCoordinatorCleanupOpen> | undefined;
  private cleanupStarted = false;
  private cleanupExpected: string | undefined;
  private recovery: DockerDesktopCoordinatorRecovery | undefined;
  private closeActual: Promise<void> | undefined;
  private readonly sequence = new DesktopCoordinatorSequence();
  private health: ReturnType<typeof setTimeout> | undefined;
  private freshness: ReturnType<typeof setTimeout> | undefined;
  private observedAt = 0;
  private retainedFailure: DockerDesktopCoordinatorError | undefined;
  private publicationTail: Promise<void> = Promise.resolve();
  private fencePublication: Promise<void> | undefined;
  private members: DesktopCoordinatorMembers | undefined;
  private topology: DesktopCoordinatorTopologyOwner | undefined;
  private readonly fenced = Promise.withResolvers<void>();

  readonly facade: DockerDesktopCoordinator;

  constructor(private readonly configuration: DesktopCoordinatorConfiguration) {
    const owner = this;
    this.facade = Object.freeze({ get state() { return owner.state; },
      initialize: (options?: DockerDesktopCoordinatorOperationOptions) => owner.initialize(options),
      activate: (options?: DockerDesktopCoordinatorOperationOptions) => owner.activate(options),
      reopenCleanup: (expected?: Readonly<{ expectedGeneration?: string }>, options?: DockerDesktopCoordinatorOperationOptions) => owner.reopenCleanup(expected, options),
      closeAdmission: () => owner.closeAdmission(),
      settle: (options?: DockerDesktopCoordinatorOperationOptions) => owner.settle(options),
      close: (options?: DockerDesktopCoordinatorOperationOptions) => owner.close(options),
    });
  }

  get state(): DockerDesktopCoordinatorState { return this.status; }

  async initialize(options?: DockerDesktopCoordinatorOperationOptions): Promise<void> {
    const operation = this.operation(options);
    this.requireInert(operation);
    this.status = Object.freeze({ kind: 'opening', mode: 'initialize' });
    const actual = this.initializeActual().catch((cause: unknown) => this.openingFailed(cause));
    this.opening = actual;
    return observeCoordinatorOperation(actual, operation, this.facade, () => this.closeAdmission());
  }

  async activate(options?: DockerDesktopCoordinatorOperationOptions): Promise<DockerDesktopCoordinatorAuthority> {
    const operation = this.operation(options);
    if (!this.activation) {
      this.requireInert(operation);
      this.status = Object.freeze({ kind: 'opening', mode: 'activate' });
      this.activation = this.activateActual().catch((cause: unknown) => this.openingFailed(cause));
      this.opening = this.activation;
    } else {
      this.requireNotCancelled(operation);
      if (this.status.kind === 'closed' || this.status.kind === 'draining' || this.status.kind === 'fenced') {
        throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'admission_closed' }, this.facade);
      }
    }
    return observeCoordinatorOperation(this.activation, operation, this.facade, () => {
      const failure: DockerDesktopCoordinatorFailure = { kind: 'interrupted', by: operation.signal?.aborted ? 'signal' : 'deadline', effect: 'owned' };
      this.fence(failure);
    });
  }

  async reopenCleanup(expected?: Readonly<{ expectedGeneration?: string }>,
    options?: DockerDesktopCoordinatorOperationOptions): Promise<DockerDesktopCoordinatorCleanupOpen> {
    const operation = this.operation(options);
    let expectedGeneration: string | undefined;
    try { expectedGeneration = parseDesktopCleanupExpected(expected); }
    catch (cause) { throw new DockerDesktopCoordinatorError({ kind: 'invalid_input' }, this.facade, { cause }); }
    this.requireNotCancelled(operation);
    if (!this.cleanupStarted) {
      this.requireInert(operation);
      this.cleanupStarted = true;
      this.cleanupExpected = expectedGeneration;
      this.status = Object.freeze({ kind: 'opening', mode: 'cleanup' });
    } else {
      if (this.status.kind === 'closed') throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
      if (expectedGeneration !== this.cleanupExpected) throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: 'generation' }, this.facade);
      if (!this.cleanupOpening && !this.native?.holder.claimed) {
        throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
      }
    }
    if (!this.cleanupOpening) {
      const actual = this.reopenCleanupActual(expectedGeneration).catch((cause: unknown) => {
        this.cleanupOpening = undefined;
        return this.cleanupOpeningFailed(cause);
      });
      this.cleanupOpening = actual;
      this.opening = actual;
    }
    return observeCoordinatorOperation(this.cleanupOpening, operation, this.facade, () => {
      this.fence({ kind: 'interrupted', by: operation.signal?.aborted ? 'signal' : 'deadline', effect: 'owned' });
    });
  }

  closeAdmission(): void {
    this.admission = 'closed';
    if (this.status.kind === 'active') this.status = Object.freeze({ kind: 'draining', generation: this.status.generation, members: this.status.members, queuedTransitions: this.status.queuedTransitions, enteredTransitions: this.status.enteredTransitions });
    else if (this.status.kind === 'inert') this.status = Object.freeze({ kind: 'blocked', failure: { kind: 'admission_closed' as const } });
  }

  async settle(options?: DockerDesktopCoordinatorOperationOptions): Promise<void> {
    const operation = this.operation(options);
    this.requireNotCancelled(operation);
    const cut = Promise.allSettled([this.opening, this.members?.settle(), this.sequence.settle(), this.publicationTail, this.closeActual]).then(async () => {
      await this.fencePublication?.catch(() => {});
      if (this.proposed !== undefined) throw this.retainedFailure
        ?? new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true }, this.facade);
    });
    return observeCoordinatorOperation(cut, operation, this.facade);
  }

  async close(options?: DockerDesktopCoordinatorOperationOptions): Promise<void> {
    const operation = this.operation(options);
    this.closeAdmission();
    this.requireNotCancelled(operation);
    if (this.status.kind === 'closed') return Promise.resolve();
    this.closeActual ??= this.closeOwned().catch((cause: unknown) => {
      this.closeActual = undefined;
      throw this.error(cause, { kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true });
    });
    return observeCoordinatorOperation(this.closeActual, operation, this.facade);
  }

  private operation(options: DockerDesktopCoordinatorOperationOptions | undefined): CoordinatorOperation {
    try { return parseCoordinatorOperation(options); }
    catch (cause) { throw new DockerDesktopCoordinatorError({ kind: 'invalid_input' }, this.facade, { cause }); }
  }

  private requireNotCancelled(operation: CoordinatorOperation): void {
    if (operation.signal?.aborted) throw new DockerDesktopCoordinatorError({ kind: 'interrupted', by: 'signal', effect: 'not_entered' }, this.facade);
  }

  private requireInert(operation: CoordinatorOperation): void {
    this.requireNotCancelled(operation);
    if (this.status.kind !== 'inert' || this.admission !== 'open') throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
  }

  private requireOpening(): void {
    if (this.admission !== 'open') throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'admission_closed' }, this.facade);
  }

  private async openNative(mode: 'initialize' | 'open' | 'cleanup'): Promise<DesktopCoordinatorHolderIdentity> {
    if (mode !== 'cleanup') this.requireOpening();
    if (process.platform !== 'darwin' || process.arch !== 'arm64'
      || await readDesktopCoordinatorSourceDigest() !== this.configuration.helper.sourceDigest) {
      throw new DockerDesktopCoordinatorError({ kind: 'preparation_invalid' }, this.facade);
    }
    const executable = await openPreparedExecutable(this.configuration.helper.executable);
    let transferred = false;
    try {
      const { route } = this.configuration;
      const signal = AbortSignal.timeout(DESKTOP_COORDINATOR_POLICY.observationTimeoutMs);
      const endpoint = await inspectDesktopCoordinatorEndpoint(route.identity.engine.endpoint, signal);
      const api = new DockerApi(new DockerEngine(route.identity.engine.endpoint.slice(7)), DESKTOP_COORDINATOR_POLICY.commandTimeoutMs);
      const daemonId = await verifyDesktopCoordinatorDaemon(api, route.identity, signal);
      if ((await inspectDesktopCoordinatorEndpoint(route.identity.engine.endpoint, signal)).digest !== endpoint.digest) {
        throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: 'endpoint' }, this.facade);
      }
      if (mode !== 'cleanup') this.requireOpening();
      const holder = new DesktopCoordinatorHolder(this.configuration.helper.executable.path, mode,
        coordinatorEngineKey(daemonId).slice(7), executable, (cause) => this.nativeLost(cause));
      transferred = true;
      this.native = { holder, endpoint, daemonId, api };
      const opened = await holder.opened;
      // A bootstrapped authority has an empty state until its first commit, so commit it before any other fallible step.
      if (mode === 'initialize' && opened.initial === 'required') {
        const initial = createInitialCoordinatorSnapshot({ authorityId: randomUUID(), daemonId });
        await holder.commit(encodeCoordinatorSnapshot(initial));
        this.current = initial;
      }
      if ((await inspectDesktopCoordinatorEndpoint(route.identity.engine.endpoint, signal)).digest !== endpoint.digest
        || await verifyDesktopCoordinatorDaemon(api, route.identity, signal) !== daemonId) {
        throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: 'endpoint' }, this.facade);
      }
      return opened;
    } finally { if (!transferred) await executable.close(); }
  }

  private async initializeActual(): Promise<void> {
    await this.openNative('initialize');
    const native = this.requireNative();
    const observed = this.parseCurrent((await native.holder.read()).text);
    if (observed.daemonId !== native.daemonId) throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: 'engine' }, this.facade);
    await native.holder.close();
    this.native = undefined;
    this.current = undefined;
    this.status = Object.freeze(this.admission === 'open' ? { kind: 'inert' } : { kind: 'closed', result: 'never_activated' });
  }

  private async activateActual(): Promise<DockerDesktopCoordinatorAuthority> {
    await this.openNative('open');
    const native = this.requireNative();
    this.current = this.parseCurrent((await native.holder.read()).text);
    if (this.current.generation.kind !== 'clean') {
      throw new DockerDesktopCoordinatorError({ kind: 'dirty_generation', generation: this.current.generation.identity.generationId }, this.facade);
    }
    this.requireOpening();
    const baseline = await captureDesktopCoordinatorBaseline(native.api, this.configuration.route, native.endpoint);
    const observedAt = performance.now();
    this.requireOpening();
    const opened = await native.holder.opened;
    const generation = randomUUID();
    const plan = beginCoordinatorGeneration(this.current, {
      identity: { generationId: generation, ordinal: this.current.generation.generationOrdinal + 1,
        coordinationRevision: 'desktop-coordination-v1', coordinationPolicyDigest: DESKTOP_COORDINATOR_POLICY_DIGEST,
        engineBindingDigest: coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({ daemonId: native.daemonId, shared: this.configuration.sharedDigest })),
        endpointBindingDigest: native.endpoint.digest, hostPreparationDigest: this.configuration.sharedDigest,
        nativeAssetDigest: coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(this.configuration.helper)) },
      basis: { kind: 'host_engine_only', hostDigest: baseline.hostDigest, engineDigest: baseline.engineDigest,
        exclusionDigest: coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify({
          rootDevice: opened.rootDevice, rootInode: opened.rootInode, lockDevice: opened.lockDevice, lockInode: opened.lockInode,
        })), atSequence: this.current.sequence + 1 },
    });
    if (plan.kind === 'rejected') throw new DockerDesktopCoordinatorError({ kind: 'capacity_exhausted', resource: 'journal' }, this.facade, { cause: plan.reason });
    this.originalGeneration = generation;
    await this.commit(plan.snapshot, 'generation');
    this.requireOpening();
    this.observedAt = observedAt;
    this.status = Object.freeze({ kind: 'active', observation: 'awaiting_member_observer', ...this.generationState(this.originalGeneration ?? generation) });
    this.installMembers(native, baseline);
    this.assertAdmission();
    if (plan.snapshot.generation.kind !== 'dirty') throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
    const authority = registerDesktopCoordinatorAuthority({ generation, endpoint: this.configuration.route.identity.engine.endpoint,
      configurationDigest: this.configuration.sharedDigest,
      identity: Object.freeze({ protocol: 'agenai.desktop-coordinator.v1', authorityId: plan.snapshot.authorityId,
        engineKey: plan.snapshot.engineKey, daemonId: plan.snapshot.daemonId, generation: plan.snapshot.generation.identity }),
      assertAdmission: () => this.assertAdmission(), enroll: (owner, signal) => this.enroll(owner, signal) });
    this.scheduleHealth();
    this.scheduleFreshness();
    return authority;
  }

  private async reopenCleanupActual(expected?: string): Promise<DockerDesktopCoordinatorCleanupOpen> {
    if (!this.native) await this.openNative('cleanup');
    const native = this.requireNative();
    if (this.proposed !== undefined) await this.resolveFailedPublication(native);
    const observed = await native.holder.read();
    const snapshot = this.parseCurrent(observed.text);
    const opened = await native.holder.opened;
    const conflict = desktopCleanupIdentityConflict(snapshot, this.configuration, {
      daemonId: native.daemonId, endpointDigest: native.endpoint.digest, opened,
    }, expected);
    if (conflict !== undefined) throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: conflict }, this.facade);
    this.current = snapshot;
    this.admission = 'closed';
    if (snapshot.generation.kind === 'dirty') this.originalGeneration = snapshot.generation.identity.generationId;
    await native.holder.enterCleanup();
    if (observed.pendingTemp) await native.holder.discardUnpublishedTemp();
    if (snapshot.generation.kind === 'clean') {
      if (observed.pendingTemp) await this.commit(snapshot, 'clean');
      await native.holder.close();
      this.native = undefined;
      this.status = Object.freeze({ kind: 'closed', result: 'clean', generation: snapshot.generation.lastGenerationId });
      return Object.freeze({ kind: 'absent' });
    }
    await this.assertMemberAuthority('cleanup');
    await this.transition({ kind: 'reopen_cleanup' });
    if (!this.recovery) this.recovery = this.createRecovery(native);
    this.status = Object.freeze(this.retainedFailure
      ? { kind: 'fenced', failure: this.retainedFailure.failure, ...this.generationState(snapshot.generation.identity.generationId) }
      : { kind: 'recovering', ...this.generationState(snapshot.generation.identity.generationId) });
    return Object.freeze({ kind: 'opened', recovery: this.recovery });
  }

  private createRecovery(native: NativeAuthority): DockerDesktopCoordinatorRecovery {
    const snapshot = this.current;
    if (!snapshot || snapshot.generation.kind !== 'dirty') throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
    const binding = Object.freeze({ endpoint: this.configuration.route.identity.engine.endpoint, configurationDigest: this.configuration.sharedDigest,
      identity: Object.freeze({ protocol: 'agenai.desktop-coordinator.v1' as const, authorityId: snapshot.authorityId,
        engineKey: snapshot.engineKey, daemonId: snapshot.daemonId, generation: snapshot.generation.identity }) });
    const members = createDesktopCoordinatorRecoveryMembers({ api: native.api,
      snapshot: () => {
        if (!this.current) throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
        return this.current;
      },
      apply: (event, boundary) => this.transition(event, boundary),
      assertAuthority: (signal) => this.assertMemberAuthority('cleanup', signal),
      run: (perform) => this.sequence.run('cleanup', perform),
    });
    return createDesktopCoordinatorRecoveryFacade(snapshot.generation.identity.generationId, () => members.members,
      async (input, options) => {
        const captured = captureDesktopCleanupInput(input);
        const config = parseCoordinatedDockerCleanupConfig(captured.configuration, binding);
        return reconcileSandboxRecovery({ backendId: DOCKER_BACKEND_ID, backendRevision: configurationBackendRevision(config),
          reconcile: (record, operation) => members.reconcile(config, record, operation?.signal),
        }, captured.record, options);
      });
  }

  private async cleanupOpeningFailed(cause: unknown): Promise<never> {
    if (!this.current || !this.native?.holder.claimed) return this.openingFailed(cause);
    const error = this.error(cause, { kind: 'persistence_failed', boundary: 'settlement' });
    this.fence(error);
    if (!this.originalGeneration) this.status = Object.freeze({ kind: 'blocked', failure: error.failure });
    throw error;
  }

  private installMembers(native: NativeAuthority, baseline: DesktopCoordinatorBaseline): void {
    const assertEndpoint = async (signal: AbortSignal) => {
      if ((await inspectDesktopCoordinatorEndpoint(this.configuration.route.identity.engine.endpoint, signal)).digest !== native.endpoint.digest) {
        throw new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'socket' }, this.facade);
      }
    };
    const topology = new DesktopCoordinatorTopologyOwner({ api: native.api, binding: this.configuration.route,
      initial: { host: baseline.host, engine: baseline.engine }, assertEndpoint,
      captureEngineBaseline: () => captureDesktopCoordinatorBaseline(native.api, this.configuration.route, native.endpoint),
      captureEngineAuthority: () => captureDesktopCoordinatorIdentity(native.api, this.configuration.route, native.endpoint) });
    this.topology = topology;
    this.members = new DesktopCoordinatorMembers({ ordering: this.sequence, topology, fenced: this.fenced.promise,
      snapshot: () => {
        if (!this.current) throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
        return this.current;
      },
      apply: (event, boundary) => this.transition(event, boundary),
      assertAdmission: () => this.assertAdmission(),
      assertAuthority: async (kind, signal) => {
        try { await this.assertMemberAuthority(kind, signal); }
        catch (cause) {
          if (!signal?.aborted) this.fence(this.error(cause, { kind: 'authority_lost', source: 'engine' }));
          throw cause;
        }
      },
      isFenced: () => this.status.kind === 'fenced' || this.status.kind === 'closed',
      fence: (cause) => this.fence(this.error(cause, { kind: 'authority_lost', source: 'control' })),
      observed: () => { this.assertFreshAuthority(); this.observedAt = performance.now(); },
    });
  }

  private enroll(owner: DesktopCoordinatorMemberOwner, signal?: AbortSignal): Promise<DesktopCoordinatorMember> {
    this.assertAdmission();
    if (!this.members) throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
    return this.members.enroll(owner, signal);
  }

  private async assertMemberAuthority(kind: 'growth' | 'cleanup', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const native = this.requireNative();
    if (kind === 'growth') {
      if (this.status.kind !== 'active' && this.status.kind !== 'draining') throw this.retainedFailure
        ?? new DockerDesktopCoordinatorError({ kind: 'admission_closed' }, this.facade);
      this.assertFreshAuthority();
    }
    if (!native.holder.claimed) throw new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'native_holder' }, this.facade);
    if (kind === 'cleanup') await native.holder.enterCleanup();
    else await native.holder.check();
    const operation = signal ?? AbortSignal.timeout(DESKTOP_COORDINATOR_POLICY.commandTimeoutMs);
    const endpoint = await inspectDesktopCoordinatorEndpoint(this.configuration.route.identity.engine.endpoint, operation);
    if (endpoint.digest !== native.endpoint.digest) throw new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'socket' }, this.facade);
    if (await verifyDesktopCoordinatorDaemon(native.api, this.configuration.route.identity, operation) !== native.daemonId) {
      throw new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'engine' }, this.facade);
    }
    if (!native.holder.claimed) throw new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'native_holder' }, this.facade);
    if (kind === 'cleanup' && this.status.kind === 'fenced') this.publishFence();
    if (kind === 'growth' && this.status.kind !== 'active' && this.status.kind !== 'draining') {
      throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'admission_closed' }, this.facade);
    }
  }

  private refreshState(): void {
    if (!this.originalGeneration) return;
    const state = this.generationState(this.originalGeneration);
    if (this.status.kind === 'active') this.status = Object.freeze({ ...this.status, ...state,
      observation: this.topology?.observationKind === 'quiescent' ? 'retained'
        : this.topology?.observationKind === 'full' ? 'current' : 'awaiting_member_observer' });
    else if (this.status.kind === 'draining' || this.status.kind === 'fenced' || this.status.kind === 'recovering') {
      this.status = Object.freeze({ ...this.status, ...state });
    }
  }

  private assertAdmission(): void {
    if (this.status.kind !== 'active' || this.admission !== 'open') throw this.retainedFailure
      ?? new DockerDesktopCoordinatorError({ kind: 'admission_closed' }, this.facade);
    this.assertFreshAuthority();
  }

  private assertFreshAuthority(): void {
    const failure = this.authorityFailure();
    if (failure) {
      this.fence(failure);
      throw this.retainedFailure;
    }
  }

  private authorityFailure(): Extract<DockerDesktopCoordinatorFailure, { kind: 'authority_lost' }> | undefined {
    if (!this.native?.holder.claimed) return { kind: 'authority_lost', source: 'native_holder' };
    if (performance.now() - this.observedAt >= DESKTOP_COORDINATOR_POLICY.authorityFreshnessMs) {
      return { kind: 'authority_lost', source: 'freshness' };
    }
    return undefined;
  }

  private async commit(next: CoordinatorSnapshot, boundary: 'generation' | 'member' | 'transition' | 'settlement' | 'clean'): Promise<void> {
    const native = this.requireNative();
    this.proposed = next;
    try {
      await native.holder.commit(encodeCoordinatorSnapshot(next));
      this.current = next;
      this.proposed = undefined;
      this.refreshState();
    } catch (cause) {
      if (native.holder.claimed) {
        try {
          const observed = this.parseCurrent((await native.holder.read()).text);
          if (snapshotDigest(observed) === snapshotDigest(next)) this.current = observed;
          else if (!this.current || snapshotDigest(observed) !== snapshotDigest(this.current)) {
            throw new DockerDesktopCoordinatorError({ kind: 'journal_invalid', reason: 'substituted' }, this.facade);
          }
        } catch (readCause) {
          cause = new AggregateError([cause, readCause], 'Coordinator publication and original readback did not both settle.');
        }
      }
      const error = this.error(cause, { kind: 'persistence_failed', boundary });
      this.fence(error);
      throw error;
    }
  }

  private transition(event: CoordinatorEvent, boundary: 'member' | 'transition' | 'settlement' | 'clean' = 'settlement'): Promise<void> {
    const actual = this.publicationTail.then(async () => {
      if (this.proposed !== undefined) {
        if (this.status.kind !== 'fenced' && this.status.kind !== 'recovering') throw this.retainedFailure
          ?? new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true }, this.facade);
        await this.resolveFailedPublication(this.requireNative());
      }
      if (!this.current) throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
      const plan: CoordinatorPlan = planCoordinatorTransition(this.current, event);
      if (plan.kind === 'rejected') throw new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true }, this.facade, { cause: plan.reason });
      if (snapshotDigest(plan.snapshot) !== snapshotDigest(this.current)) await this.commit(plan.snapshot, boundary);
      await this.synchronizeBasis(event);
    });
    this.publicationTail = actual.catch(() => {});
    return actual;
  }

  private async synchronizeBasis(event: CoordinatorEvent): Promise<void> {
    if (!this.current || this.current.generation.kind !== 'dirty' || !this.topology
      || this.status.kind !== 'active' && this.status.kind !== 'draining') return;
    const generation = this.current.generation;
    const basis = this.topology.currentBasis(this.current.sequence + 1, generation.basis.exclusionDigest);
    if (basis === undefined) return;
    const candidate = this.topology.observationKind === 'quiescent' && generation.state.kind !== 'quiescent'
      ? { kind: 'quiesce' as const, basis }
      : event.kind === 'settle' && event.outcome === 'started' && this.topology.observationKind === 'full'
        ? { kind: 'full_basis' as const, basis } : undefined;
    if (candidate === undefined) return;
    const planned = planCoordinatorTransition(this.current, candidate);
    if (planned.kind === 'rejected') {
      // Work and final observer settlement can reach quiescence on different journal writes.
      if (candidate.kind === 'quiesce') return;
      throw new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true }, this.facade,
        { cause: planned.reason });
    }
    await this.commit(planned.snapshot, 'settlement');
  }

  private async resolveFailedPublication(native: NativeAuthority): Promise<void> {
    await native.holder.enterCleanup();
    const observed = await native.holder.read();
    const snapshot = this.parseCurrent(observed.text);
    const digest = snapshotDigest(snapshot);
    if ((!this.current || digest !== snapshotDigest(this.current))
      && (!this.proposed || digest !== snapshotDigest(this.proposed))) {
      throw new DockerDesktopCoordinatorError({ kind: 'journal_invalid', reason: 'substituted' }, this.facade);
    }
    this.current = snapshot;
    if (observed.pendingTemp) await native.holder.discardUnpublishedTemp();
    // Readback proves bytes, not a previously failed directory synchronization.
    // Acknowledged publication also settles any original unpublished-temp removal.
    await this.commit(snapshot, snapshot.generation.kind === 'clean' ? 'clean' : 'settlement');
    const fence = this.status.kind === 'fenced' ? canonicalFenceEvent(this.current, this.retainedFailure?.failure) : undefined;
    if (fence) {
      const plan = planCoordinatorTransition(snapshot, fence);
      if (plan.kind === 'rejected') throw new DockerDesktopCoordinatorError({ kind: 'retained_ownership',
        members: this.memberIds(), pendingTransition: true }, this.facade, { cause: plan.reason });
      await this.commit(plan.snapshot, 'settlement');
    }
  }

  private async closeOwned(): Promise<void> {
    await Promise.allSettled([this.opening, this.sequence.settle(), this.publicationTail]);
    await this.fencePublication?.catch(() => {});
    await this.sequence.run('cleanup', async () => {
      const native = this.native;
      if (!native) {
        if (this.status.kind === 'closed') return;
        if (this.originalGeneration) throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: true }, this.facade);
        this.status = Object.freeze({ kind: 'closed', result: 'never_activated' });
        return;
      }
      if (this.cleanupStarted && !this.originalGeneration && this.current && (this.proposed !== undefined || this.retainedFailure)) {
        await this.resolveFailedPublication(native);
      }
      if (this.originalGeneration) {
        if (!native.holder.claimed) throw this.retainedFailure ?? new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'native_holder' }, this.facade);
        if (this.status.kind === 'fenced' || this.proposed !== undefined) await this.resolveFailedPublication(native);
        if (!this.current || this.current.generation.kind === 'dirty' && this.current.generation.identity.generationId !== this.originalGeneration) {
          throw new DockerDesktopCoordinatorError({ kind: 'identity_conflict', scope: 'generation' }, this.facade);
        }
        if (this.current.generation.kind === 'dirty') {
          const generation = this.current.generation;
          if (generation.members.length || generation.queue.length || generation.entered !== null) {
            throw new DockerDesktopCoordinatorError({ kind: 'retained_ownership', members: this.memberIds(), pendingTransition: generation.entered !== null }, this.facade);
          }
          await this.transition({ kind: 'close_admission' });
          await this.transition({ kind: 'clean_close' }, 'clean');
        }
        this.stopHealth();
        await native.holder.close();
        this.native = undefined;
        this.status = Object.freeze(this.current.generation.kind === 'clean' && this.current.generation.lastGenerationId === this.originalGeneration
          ? { kind: 'closed', result: 'clean', generation: this.originalGeneration }
          : { kind: 'closed', result: 'never_activated' });
      } else {
        await native.holder.close();
        this.native = undefined;
        this.status = Object.freeze({ kind: 'closed', result: 'never_activated' });
      }
    });
  }

  private scheduleHealth(): void {
    if (this.status.kind !== 'active' && this.status.kind !== 'draining') return;
    this.health = setTimeout(() => {
      if (this.status.kind !== 'active' && this.status.kind !== 'draining') return;
      void this.sequence.run('observation', async () => {
        if (this.status.kind !== 'active' && this.status.kind !== 'draining') return;
        this.assertFreshAuthority();
        const native = this.requireNative();
        await native.holder.check();
        if (this.topology) await this.topology.assertCurrent();
        else throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
        this.assertFreshAuthority();
        this.observedAt = performance.now();
      }).then(() => this.scheduleHealth(), (cause: unknown) => this.fence(this.error(cause, { kind: 'authority_lost', source: 'host' })));
    }, DESKTOP_COORDINATOR_POLICY.pollIntervalMs);
    this.health.unref();
  }

  private scheduleFreshness(): void {
    if (this.status.kind !== 'active' && this.status.kind !== 'draining') return;
    // This deadline stays outside the physical sequence and native holder's command queue.
    const remaining = this.observedAt + DESKTOP_COORDINATOR_POLICY.authorityFreshnessMs - performance.now();
    this.freshness = setTimeout(() => {
      this.freshness = undefined;
      if (this.status.kind !== 'active' && this.status.kind !== 'draining') return;
      const failure = this.authorityFailure();
      if (failure) this.fence(failure);
      else this.scheduleFreshness();
    }, Math.max(1, remaining));
    this.freshness.unref();
  }

  private stopHealth(): void {
    if (this.health) clearTimeout(this.health);
    if (this.freshness) clearTimeout(this.freshness);
    this.health = undefined;
    this.freshness = undefined;
  }

  private nativeLost(cause: DesktopCoordinatorHolderError): void {
    if (this.originalGeneration) this.fence(this.error(cause, { kind: 'authority_lost', source: 'native_holder' }));
    else this.retainedFailure ??= this.error(cause, { kind: 'authority_lost', source: 'native_holder' });
  }

  private fence(failure: DockerDesktopCoordinatorFailure | DockerDesktopCoordinatorError): void {
    if (this.status.kind === 'closed') return;
    this.admission = 'closed';
    const first = this.retainedFailure === undefined;
    this.retainedFailure ??= failure instanceof DockerDesktopCoordinatorError ? failure
      : new DockerDesktopCoordinatorError(failure, this.facade);
    this.stopHealth();
    if (this.originalGeneration) this.status = Object.freeze({ kind: 'fenced', failure: this.retainedFailure.failure, ...this.generationState(this.originalGeneration) });
    this.publishFence();
    this.fenced.resolve();
    if (first) this.members?.failed(this.retainedFailure);
  }

  private publishFence(): void {
    if (this.fencePublication || !this.native?.holder.claimed || this.proposed !== undefined) return;
    const event = canonicalFenceEvent(this.current, this.retainedFailure?.failure);
    if (!event) return;
    const actual = this.transition(event, 'settlement');
    this.fencePublication = actual;
    void actual.catch(() => {}).finally(() => { if (this.fencePublication === actual) this.fencePublication = undefined; });
  }

  private async openingFailed(cause: unknown): Promise<never> {
    const error = this.error(cause, { kind: 'preparation_invalid' });
    this.retainedFailure ??= error;
    if (this.originalGeneration) this.fence(error);
    else {
      if (this.native) {
        try { await this.native.holder.close(); }
        catch { /* The opening error retains its cause; this owner never dispatched a member effect. */ }
        this.native = undefined;
      }
      this.status = Object.freeze({ kind: 'blocked', failure: error.failure });
    }
    throw error;
  }

  private error(cause: unknown, fallback: DockerDesktopCoordinatorFailure): DockerDesktopCoordinatorError {
    if (cause instanceof DockerDesktopCoordinatorError) return cause;
    if (cause instanceof DesktopEngineRestartedError) {
      return new DockerDesktopCoordinatorError({ kind: 'authority_lost', source: 'engine' }, this.facade, { cause });
    }
    if (cause instanceof DesktopCoordinatorHolderError) {
      const failure: DockerDesktopCoordinatorFailure = cause.reason === 'busy' ? { kind: 'busy' }
        : cause.reason === 'unpublished_temp' ? { kind: 'journal_invalid', reason: 'unpublished_temp' }
        : cause.reason === 'authority_absent' ? { kind: 'journal_invalid', reason: 'missing' }
        : cause.reason === 'authority_partial' || cause.reason === 'directory_open' || cause.reason === 'state_frame_bound' ? { kind: 'journal_invalid', reason: 'corrupt' }
        : cause.claim === 'lost' ? { kind: 'authority_lost', source: 'native_holder' } : fallback;
      return new DockerDesktopCoordinatorError(failure, this.facade, { cause });
    }
    return new DockerDesktopCoordinatorError(fallback, this.facade, { cause });
  }

  private parseCurrent(text: string): CoordinatorSnapshot {
    try {
      const snapshot = parseCoordinatorSnapshot(text);
      if (snapshot.engineKey !== coordinatorEngineKey(this.requireNative().daemonId)) throw new TypeError('Engine key does not match the held authority.');
      return snapshot;
    } catch (cause) { throw new DockerDesktopCoordinatorError({ kind: 'journal_invalid', reason: 'corrupt' }, this.facade, { cause }); }
  }

  private requireNative(): NativeAuthority {
    if (!this.native) throw new DockerDesktopCoordinatorError({ kind: 'invalid_state' }, this.facade);
    return this.native;
  }

  private generationState(generationId: string): DockerDesktopCoordinatorGenerationState {
    const snapshot = this.proposed?.generation.kind === 'dirty' ? this.proposed : this.current;
    const generation = snapshot?.generation;
    const members = generation?.kind === 'dirty' ? generation.members : [];
    return Object.freeze({ generation: generationId, members: Object.freeze(members.map((member) => Object.freeze({
      sandboxId: member.checkpoint.record.sandboxId, operationId: member.memberId,
      kind: member.state.kind === 'reserved' ? 'registered' as const : member.state.kind === 'starting' ? 'acquiring' as const
        : member.state.kind === 'stopping' ? 'draining' as const : member.state.kind,
    }))), queuedTransitions: generation?.kind === 'dirty' ? generation.queue.length : 0,
    enteredTransitions: generation?.kind === 'dirty' && generation.entered !== null ? 1 : 0 });
  }

  private memberIds(): readonly string[] {
    return this.current?.generation.kind === 'dirty' ? this.current.generation.members.map((member) => member.checkpoint.record.sandboxId) : [];
  }
}

export function createDockerDesktopCoordinator(options: DockerDesktopCoordinatorOptions): DockerDesktopCoordinator {
  return new DesktopCoordinator(parseDesktopCoordinatorConfiguration(options)).facade;
}
