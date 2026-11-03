import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { coordinatorDigest } from '../../network/desktop/coordinator/journal/schema.js';
import { DesktopCoordinatorSequence } from '../../network/desktop/coordinator/sequence.js';
import { validateRecoveryEvidence } from '../../network/desktop/coordinator/administrativeRecovery/evidence.js';
import { RecoveryPublicationOwner } from '../../network/desktop/coordinator/administrativeRecovery/publication.js';
import { createRecoveryEnvelope, planHelperReplacement, transitionRecovery } from '../../network/desktop/coordinator/administrativeRecovery/plans.js';
import { assertSupportedRecoveryOrigin, originalFrameDigest, originalRecoverySnapshot, recoveryKeyFor } from '../../network/desktop/coordinator/administrativeRecovery/validation.js';
import type { RecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { FIRST_SUCCESSOR_PROFILE } from '../../network/desktop/coordinator/administrativeRecovery/helperSuccession.js';
import { isRecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { rawDigest, RecoveryJournalError } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { originArchiveRefSchema, receiptScope, sameReceipt } from '../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import type { BarrierAcceptanceDecision } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { RecoveryAuthority, sameTransport, transportAdmission } from './authority.js';
import { DockerDesktopRecoveryError } from './contracts.js';
import type { DockerDesktopRecoveryController, DockerDesktopRecoveryControllerOptions, DockerDesktopRecoveryFailure,
  DockerDesktopRecoveryState } from './contracts.js';
import { recoveryError } from './errors.js';
import { RecoveryEvidence } from './evidence.js';
import { RecoveryMembers } from './members.js';
import { RecoveryObservation } from './observation.js';
import { RecoveryOperations } from './operations.js';
import { parseDesktopRecoveryConfiguration, parseRecoveryOpenInput } from './options.js';
import type { DesktopRecoveryConfiguration, RecoveryOpenInput } from './options.js';
import { RecoveryTerminal } from './terminal.js';

class DesktopRecoveryController {
  readonly facade: DockerDesktopRecoveryController;
  private status: DockerDesktopRecoveryState = Object.freeze({ kind: 'inert' });
  private request: RecoveryOpenInput | undefined;
  private get expected(): string | undefined { return this.request?.expectedGeneration; }
  private readonly authority: RecoveryAuthority;
  private readonly operations: RecoveryOperations;
  private readonly sequence = new DesktopCoordinatorSequence();
  private publication: RecoveryPublicationOwner | undefined;
  private evidence: RecoveryEvidence | undefined;
  private observation: RecoveryObservation | undefined;
  private terminal: RecoveryTerminal | undefined;
  private cleanup: RecoveryMembers | undefined;
  private closedRecords: readonly SandboxRecoveryRecord[] = Object.freeze([]);
  private admission = false;
  private initialPendingTemp = false;
  private handbackComplete = false;

  constructor(configuration: DesktopRecoveryConfiguration) {
    const controller = this;
    const exact = (receiver: unknown) => {
      if (receiver !== controller.facade) throw new TypeError('Docker Desktop recovery requires its original controller.');
    };
    this.facade = Object.freeze<DockerDesktopRecoveryController>({
      get state() { exact(this); return controller.status; },
      get members() { exact(this); return controller.records(); },
      open(input, options) {
        exact(this);
        const operation = controller.operations.parse(options);
        let request: RecoveryOpenInput;
        try { request = parseRecoveryOpenInput(input); }
        catch (cause) { throw recoveryError(cause, controller.facade, { kind: 'invalid_input' }); }
        if (controller.expected && request.expectedGeneration !== controller.expected) throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'generation' }, controller.facade);
        if (controller.request && request.replaceHelper && JSON.stringify(request.replaceHelper) !== JSON.stringify(controller.request.replaceHelper)) {
          throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'configuration' }, controller.facade);
        }
        controller.request ??= request;
        return controller.operations.run('open', operation, () => controller.perform(() => controller.open(), { kind: 'preparation_invalid' }));
      },
      beginObservation(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.run('begin', operation, () => controller.perform(async () => {
          controller.assertMutable(); controller.admission = false;
          await controller.joinMembers();
          await controller.reconcilePublication();
          if (await controller.terminal?.discoverAndCompleteIfResourceComplete()) { await controller.finishClosed(); return; }
          const observation = controller.requireObservation();
          const current = controller.current();
          const attempt = 'ordinal' in current.phase ? current.phase.ordinal : current.nextAttempt;
          controller.status = Object.freeze({ kind: 'observing', generation: current.origin.generationId, attempt, phase: 'arming' });
          await observation.begin(); controller.refresh();
        }, { kind: 'observation_incomplete', reason: 'producer' }));
      },
      observeStopped(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.run('stopped', operation, () => controller.perform(async () => {
          controller.assertMutable(); await controller.reconcilePublication();
          await controller.requireObservation().stopped(); controller.refresh();
        }, { kind: 'observation_incomplete', reason: 'stopped_interval' }));
      },
      finishObservation(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.run('finish', operation, () => controller.perform(async () => {
          controller.assertMutable(); await controller.reconcilePublication();
          const current = controller.current();
          if (current.phase.kind === 'stopped') controller.status = Object.freeze({ kind: 'observing',
            generation: current.origin.generationId, attempt: current.phase.ordinal, phase: 'finishing' });
          await controller.requireObservation().finish();
          await controller.refreshTransport(); controller.admission = true; controller.refresh();
        }, { kind: 'observation_incomplete', reason: 'restoration' }));
      },
      reconcile(input, options) {
        exact(this); controller.assertAdmission();
        if (!controller.cleanup) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, controller.facade);
        return controller.cleanup.reconcile(input, options);
      },
      settle(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.settle(operation, [
          ...(controller.cleanup?.pending ?? []), controller.sequence.settle(),
          ...(controller.publication ? [controller.publication.settle()] : []),
        ]);
      },
      close(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.run('close', operation, () => controller.perform(() => controller.close(), { kind: 'persistence_failed', boundary: 'terminal' }));
      },
      release(options) {
        exact(this);
        const operation = controller.operations.parse(options);
        return controller.operations.run('release', operation, () => controller.perform(() => controller.release(), { kind: 'persistence_failed', boundary: 'release' }));
      },
    });
    this.operations = new RecoveryOperations(this.facade);
    this.authority = new RecoveryAuthority(configuration, this.facade, (cause) => this.fail(cause, { kind: 'authority_lost', source: 'native_holder' }));
  }

  private records(): readonly SandboxRecoveryRecord[] {
    if (this.status.kind === 'closed' || this.status.kind === 'released') return this.closedRecords;
    if (this.publication?.current.format === 'agenai.docker-desktop-coordinator.v1') return this.terminal?.records ?? this.closedRecords;
    return this.cleanup?.records ?? this.closedRecords;
  }

  private current(): RecoveryEnvelope {
    const state = this.publication?.current;
    if (!state || !isRecoveryEnvelope(state)) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    return state;
  }

  private requireObservation(): RecoveryObservation {
    if (!this.observation) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    return this.observation;
  }

  private async open(): Promise<void> {
    if (this.handbackComplete) { await this.finishClosed(); return; }
    if (this.status.kind === 'closed' || this.status.kind === 'ready' || this.status.kind === 'observing' || this.status.kind === 'terminal_ready') return;
    if (this.status.kind === 'released' || !this.expected) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    this.admission = false;
    this.status = Object.freeze({ kind: 'opening', expectedGeneration: this.expected });
    await this.joinMembers();
    await this.authority.open();
    if (!this.publication) {
      const observed = await this.authority.native.readCanonical();
      this.initialPendingTemp = observed.pendingTemp;
      this.publication = new RecoveryPublicationOwner({
        readCanonical: () => this.authority.native.readCanonical(),
        commitCanonical: (expected, text) => this.authority.native.commitCanonical(expected, text),
        discardUnpublishedTemp: (expected) => this.authority.native.discardUnpublishedCanonicalTemp(expected),
      }, observed.text);
    }
    await this.reconcilePublication();
    let state = this.publication.current;
    const original = isRecoveryEnvelope(state) ? originalRecoverySnapshot(state) : state;
    await this.authority.assertOriginal(original, this.expected);
    const expectedHelper = this.request?.replaceHelper?.expected;
    let replacement: RecoveryEnvelope | undefined;
    if (isRecoveryEnvelope(state)) {
      if (expectedHelper && (state.format === 'agenai.docker-desktop-recovery.v1'
        || state.format === 'agenai.docker-desktop-recovery.v2' && JSON.stringify(expectedHelper) === JSON.stringify(state.activeHelper))) {
        this.authority.assertPreparation(state, expectedHelper, state.format === 'agenai.docker-desktop-recovery.v2'
          ? FIRST_SUCCESSOR_PROFILE : this.authority.native.currentIssuer.profileDigest);
        replacement = planHelperReplacement(state, expectedHelper, this.authority.configuration.helper, this.authority.native.currentIssuer.profileDigest);
      } else {
        this.authority.assertPreparation(state);
        if (expectedHelper) this.authority.assertExpectedPredecessor(state, expectedHelper);
      }
    } else if (expectedHelper && state.generation.kind === 'dirty') throw new DockerDesktopRecoveryError({ kind: 'unsupported', reason: 'original_format' }, this.facade);
    if (this.initialPendingTemp) {
      await this.publication.reconcile();
      this.initialPendingTemp = false;
    }
    const existing = await this.authority.native.rebindExistingGeneration(original.authorityId, this.expected, this.publication.digest);
    this.evidence ??= new RecoveryEvidence(this.authority.native, this.authority.native.currentIssuer.profileDigest);
    this.terminal ??= new RecoveryTerminal(this.authority, this.evidence, this.publication, expectedHelper);
    if (replacement) {
      if (existing.kind !== 'bound_existing') throw new RecoveryJournalError('evidence', 'Helper succession requires the existing original evidence namespace.');
      await this.assertOriginArchive(replacement);
      const graph = await validateRecoveryEvidence(state.format === 'agenai.docker-desktop-recovery.v2' ? state : replacement, this.evidence);
      if (graph.barriers.length || !replacement.historyHead || !graph.preferredHistoryHead || !sameReceipt(replacement.historyHead, graph.preferredHistoryHead)) {
        throw new RecoveryJournalError('evidence', 'Helper succession cannot adopt an outcome with a completed preferred barrier acceptance.');
      }
      await this.publication.publish(replacement);
      state = this.publication.current;
      if (!isRecoveryEnvelope(state)) throw new RecoveryJournalError('evidence', 'Helper succession lost its recovery envelope.');
      this.authority.assertPreparation(state);
    }
    if (existing.kind === 'bound_existing') {
      if (await this.terminal.discoverAndCompleteIfResourceComplete()) { await this.finishClosed(); return; }
    } else if (isRecoveryEnvelope(state)) {
      throw new RecoveryJournalError('evidence', 'Original recovery envelope has no immutable origin namespace.');
    }
    if (!isRecoveryEnvelope(state) && state.generation.kind === 'clean') {
      if (expectedHelper) throw new DockerDesktopRecoveryError({ kind: 'unsupported', reason: 'original_format' }, this.facade);
      if (existing.kind !== 'absent') throw new RecoveryJournalError('evidence', 'Clean canonical state does not join its existing recovery transaction.');
      await this.authority.capture(); await this.finishClosed(); return;
    }
    if (!isRecoveryEnvelope(state)) {
      assertSupportedRecoveryOrigin(state);
      const observed = await this.authority.capture();
      const claim = await this.authority.claim();
      const framedDigest = originalFrameDigest(this.publication.text, state);
      const archive = originArchiveRefSchema.parse({ scope: 'transaction', slot: 'origin_archive',
        digest: framedDigest, bytes: Buffer.byteLength(this.publication.text) + 148 });
      // Eligibility and the full bounded envelope are checked before creating the native origin namespace.
      const envelope = createRecoveryEnvelope(this.publication.text, { claim, archive,
        preparation: { configuredEndpoint: this.authority.endpoint, sharedDigest: this.authority.configuration.original.sharedDigest,
          originalHelper: this.authority.configuration.original.helper, recoveryHelper: this.authority.configuration.helper },
        transport: transportAdmission(observed, state.sequence + 1) });
      await this.authority.native.bindOrigin({ authorityId: state.authorityId, generationId: this.expected,
        recoveryKey: recoveryKeyFor(state, rawDigest(this.publication.text), coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(claim))),
        originFrameDigest: framedDigest, expectedCanonicalPayloadDigest: this.publication.digest });
      const retained = await this.authority.native.archiveCurrentCanonical('origin_archive', this.publication.digest);
      if (!sameReceipt(archive, retained.ref) || retained.text !== this.publication.text) throw new RecoveryJournalError('evidence', 'Original archive does not preserve the exact canonical bytes.');
      await this.publication.publish(envelope);
    }
    const envelope = this.current();
    if (!replacement) await this.assertOriginArchive(envelope);
    await validateRecoveryEvidence(envelope, this.evidence);
    this.observation ??= new RecoveryObservation(this.authority, this.evidence, this.publication);
    await this.observation.resumeInterrupted();
    await this.refreshTransport();
    await this.publication.publish(transitionRecovery(this.current(), { kind: 'clear_release' }));
    this.cleanup ??= this.createMembers();
    await this.cleanup.initialize();
    await this.cleanup.adapter.resumeDestroyedMembers();
    this.admission = true; this.refresh();
  }

  private async assertOriginArchive(envelope: RecoveryEnvelope): Promise<void> {
    const origin = await this.authority.native.readReceipt(receiptScope(envelope.origin.archive), envelope.origin.archive);
    if (!origin || origin.text !== Buffer.from(envelope.origin.payloadBase64, 'base64').toString('utf8')) throw new RecoveryJournalError('evidence', 'Recovery origin archive differs from its exact original bytes.');
  }

  private createMembers(): RecoveryMembers {
    const evidence = this.evidence;
    if (!evidence) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    return new RecoveryMembers({ api: this.authority.api, current: () => this.current(),
      publish: async (next, boundary) => {
        try { await this.publication?.publish(next); }
        catch (cause) { throw this.fail(cause, { kind: 'persistence_failed', boundary }); }
      },
      assertAuthority: async (signal) => {
        try { this.assertMutable(); await this.refreshTransport(signal); }
        catch (cause) { throw this.fail(cause, { kind: 'authority_lost', source: 'engine' }); }
      },
      run: (perform) => this.sequence.run('cleanup', perform),
      readSdkDecision: (ref) => evidence.readSdkDecision(ref),
      publishSdkDecision: async (decision) => (await this.authority.native.publishSdkDecision(decision)).ref,
      assertBarrierCurrent: (decision, signal) => this.assertBarrierCurrent(decision, signal),
    }, this.facade, () => this.assertAdmission());
  }

  private async assertBarrierCurrent(decision: BarrierAcceptanceDecision, signal?: AbortSignal): Promise<void> {
    const observed = await this.authority.capture(signal);
    if (!sameTransport(decision.transport, transportAdmission(observed, this.current().sequence))) {
      await this.publication?.publish(transitionRecovery(this.current(), { kind: 'refresh_transport',
        transport: transportAdmission(observed, this.current().sequence) }));
      throw new DockerDesktopRecoveryError({ kind: 'observation_incomplete', reason: 'composition' }, this.facade);
    }
  }

  private async refreshTransport(signal?: AbortSignal): Promise<void> {
    const observed = await this.authority.capture(signal);
    await this.publication?.publish(transitionRecovery(this.current(), { kind: 'refresh_transport',
      transport: transportAdmission(observed, this.current().sequence) }));
  }

  private async reconcilePublication(): Promise<void> {
    if (this.publication?.pending) await this.publication.reconcile();
  }

  private assertMutable(): void {
    if (this.status.kind === 'closed' || this.status.kind === 'released' || this.current().phase.kind === 'terminal_ready') {
      throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    }
  }

  private assertAdmission(): void {
    if (!this.admission || this.operations.pending || this.status.kind !== 'ready') throw new DockerDesktopRecoveryError({ kind: 'busy' }, this.facade);
  }

  private async joinMembers(): Promise<void> {
    await this.cleanup?.settle();
    await this.sequence.settle();
  }

  private async close(): Promise<void> {
    if (this.status.kind === 'closed') return;
    if (this.handbackComplete) { await this.finishClosed(); return; }
    if (this.status.kind === 'released' || !this.terminal) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    this.admission = false; await this.joinMembers(); await this.reconcilePublication();
    if (await this.terminal.discoverAndCompleteIfResourceComplete()) { await this.finishClosed(); return; }
    await this.requireObservation().abandon();
    await this.cleanup?.adapter.resumeDestroyedMembers();
    const generation = this.current().projection.snapshot.generation;
    if (generation.kind !== 'dirty' || generation.members.length || generation.queue.length || generation.entered !== null) {
      throw new DockerDesktopRecoveryError({ kind: 'retained_ownership',
        members: generation.kind === 'dirty' ? generation.members.map((member) => member.memberId) : [], pendingOperation: false }, this.facade);
    }
    await this.terminal.finish(); await this.finishClosed();
  }

  private async finishClosed(): Promise<void> {
    this.closedRecords = this.terminal?.records ?? this.closedRecords;
    this.handbackComplete = true;
    await this.authority.close();
    if (!this.expected) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    this.status = Object.freeze({ kind: 'closed', generation: this.expected, result: 'clean' });
  }

  private async release(): Promise<void> {
    try { await this.releaseActual(); }
    catch (cause) {
      if (this.authority.holderLost) {
        try { await this.authority.close(); }
        catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], 'Retained recovery release and lost native descriptor cleanup both reported failure.'); }
      }
      throw cause;
    }
  }

  private async releaseActual(): Promise<void> {
    if (this.status.kind === 'released' || this.status.kind === 'closed') return;
    if (this.handbackComplete) { await this.finishClosed(); return; }
    if (!this.expected) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.facade);
    this.admission = false; await this.joinMembers(); await this.reconcilePublication();
    if (this.publication && isRecoveryEnvelope(this.publication.current)) {
      await this.observation?.abandon();
      await this.publication.publish(transitionRecovery(this.current(), { kind: 'request_release' }));
      this.closedRecords = this.cleanup?.records ?? this.closedRecords;
    }
    await this.authority.close();
    this.status = Object.freeze({ kind: 'released', generation: this.expected, result: 'retained' });
  }

  private refresh(): void {
    const current = this.current();
    const phase = current.phase;
    if (phase.kind === 'terminal_ready') this.status = Object.freeze({ kind: 'terminal_ready', generation: current.origin.generationId });
    else if (phase.kind === 'armed' || phase.kind === 'stopped' || phase.kind === 'attempt_prepared') {
      this.status = Object.freeze({ kind: 'observing', generation: current.origin.generationId,
        attempt: phase.ordinal, phase: phase.kind === 'attempt_prepared' ? 'arming' : phase.kind });
    } else this.status = Object.freeze({ kind: 'ready', generation: current.origin.generationId,
      barrier: phase.kind === 'cleanup' ? 'accepted' : 'required' });
  }

  private fail(cause: unknown, fallback: DockerDesktopRecoveryFailure): DockerDesktopRecoveryError {
    const error = recoveryError(cause, this.facade, fallback);
    this.admission = false;
    if (this.status.kind !== 'closed' && this.status.kind !== 'released') this.status = Object.freeze(this.expected
      ? { kind: 'fenced', generation: this.expected, failure: error.failure }
      : { kind: 'blocked', failure: error.failure });
    return error;
  }

  private async perform(action: () => Promise<void>, fallback: DockerDesktopRecoveryFailure): Promise<void> {
    try { await action(); }
    catch (cause) { throw this.fail(cause, fallback); }
  }
}

export function createDockerDesktopRecoveryController(options: DockerDesktopRecoveryControllerOptions): DockerDesktopRecoveryController {
  return new DesktopRecoveryController(parseDesktopRecoveryConfiguration(options)).facade;
}
