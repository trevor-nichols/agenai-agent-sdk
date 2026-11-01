// ------------------------------------------------------------------------------------------------
//                memberEffects.ts - Once-only member effects under the original canonical writer
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxStateError, SandboxUnsupportedError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import { DOCKER_API } from '../../../policy/config.js';
import { inspectResource, resourceKind } from '../../../resources/inspect.js';
import type { ResourceInspection } from '../../../resources/inspect.js';
import { coordinatorDigest } from './journal/schema.js';
import type { CoordinatorMember, ResourceAction, ResourceRole, RoleLedger, WorkOwnership } from './journal/schema.js';
import type {
  DesktopCoordinatorControlledRole, DesktopCoordinatorCreateOperation, DesktopCoordinatorMember,
  DesktopCoordinatorMemberJournal, DesktopCoordinatorMemberOwner, DesktopCoordinatorStartedRole,
  DesktopCoordinatorStartOperation,
} from './member.js';
import { DESKTOP_COORDINATOR_POLICY } from './policy.js';
import { DesktopCoordinatorOriginalCleanup } from './recovery/original.js';

type CheckpointMode = 'caller_persisted' | 'canonical_cleanup';
interface OriginalCreate { readonly actual: Promise<unknown>; readonly dispatched: () => boolean }

class MemberEffects implements DesktopCoordinatorMember {
  private closed = false;
  private sinkFailure: SandboxOperationError | undefined;
  private readonly callbacks = new Set<Promise<void>>();
  private readonly creates = new Map<ResourceRole, OriginalCreate>();
  private readonly requestedCreates = new Set<ResourceRole>();
  private readonly requestedStarts = new Set<DesktopCoordinatorStartedRole>();
  private cleanupTail: Promise<void> = Promise.resolve();
  private readonly controlClosures = new Map<DesktopCoordinatorControlledRole, Promise<void>>();
  private readonly failedControls = new Set<ResourceRole>();
  private readonly originalCleanup: DesktopCoordinatorOriginalCleanup;

  constructor(private readonly journal: DesktopCoordinatorMemberJournal, private readonly owner: DesktopCoordinatorMemberOwner) {
    this.originalCleanup = new DesktopCoordinatorOriginalCleanup(journal, owner, () => this.callbacks.size === 0);
  }

  get allocation() { return this.journal.allocation; }
  get census() { return this.journal.census; }

  private member(): CoordinatorMember {
    const generation = this.journal.snapshot().generation;
    const member = generation.kind === 'dirty' ? generation.members.find((candidate) => candidate.memberId === this.journal.memberId) : undefined;
    if (!member) throw new SandboxStateError('The original coordinated sandbox member is no longer registered.');
    return member;
  }

  private resource(role: ResourceRole): SandboxRecoveryResource {
    const resource = this.owner.record().resources.find((candidate) => candidate.role === role);
    if (!resource) throw new SandboxStateError('The original coordinated member does not own this resource role.');
    return resource;
  }

  private retain(record: SandboxRecoveryRecord): SandboxRecoveryRecord {
    const parsed = parseSandboxRecoveryRecord(record);
    this.owner.retain(parsed);
    return parsed;
  }

  private async persist(record: SandboxRecoveryRecord): Promise<CheckpointMode> {
    if (this.sinkFailure) return 'canonical_cleanup';
    const actual = Promise.resolve().then(() => this.owner.persist(record));
    this.callbacks.add(actual);
    try { await actual; return 'caller_persisted'; }
    catch (cause) {
      this.sinkFailure ??= cause instanceof SandboxOperationError ? cause
        : new SandboxOperationError('persistence_failure', 'Sandbox recovery checkpoint failed.', { cause });
      this.closeAdmission();
      await this.journal.apply({ kind: 'caller_sink_failed', memberId: this.journal.memberId }, 'member');
      return 'canonical_cleanup';
    } finally { this.callbacks.delete(actual); }
  }

  private cleanupRecord(record: SandboxRecoveryRecord): SandboxRecoveryRecord {
    const member = this.member();
    // A rejected pre-arm caller checkpoint can be ahead of the canonical record. Preserve that
    // attempted neutral record in its owner; the canonical terminal continuation keeps non-dispatch.
    return parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((resource) => {
      const previous = member.checkpoint.record.resources.find((candidate) => candidate.role === resource.role);
      const ledger = member.roles.find((candidate) => candidate.role === resource.role);
      return previous?.identity.kind === 'planned' && resource.identity.kind === 'creating'
        && ledger?.create.kind === 'not_entered' ? previous : resource;
    }) });
  }

  async checkpoint(input: SandboxRecoveryRecord): Promise<void> {
    const record = this.retain(input);
    const mode = await this.persist(record);
    if (mode === 'caller_persisted') {
      await this.journal.apply({ kind: 'checkpoint', memberId: this.journal.memberId, record, mode }, 'member');
      if (record.phase === 'starting' || record.phase === 'running') {
        await this.journal.apply({ kind: 'member_state', memberId: this.journal.memberId,
          state: { kind: record.phase === 'starting' ? 'starting' : 'active' } }, 'member');
      }
    }
    else {
      const continuation = this.cleanupRecord(record);
      if (continuation.phase !== 'starting' && continuation.phase !== 'running') {
        await this.journal.apply({ kind: 'checkpoint', memberId: this.journal.memberId, record: continuation, mode }, 'member');
      }
      this.owner.failed(this.sinkFailure ?? new SandboxOperationError('persistence_failure', 'Sandbox checkpoint authority is closed.'));
      throw this.sinkFailure;
    }
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new SandboxOperationError('cancelled', 'Coordinated sandbox admission is closed.');
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    this.assertOpen(signal);
    await this.journal.assertAuthority('growth', signal);
    this.assertOpen(signal);
  }

  observer(id: string, client: Parameters<DesktopCoordinatorMember['observer']>[1]): void { this.journal.observer(id, client); }
  closeAdmission(): void { this.closed = true; this.journal.closeAdmission(); }
  infrastructureFailed(error: SandboxOperationError): void { this.closeAdmission(); this.journal.fence(error); }
  controlFailed(role: DesktopCoordinatorControlledRole, error: SandboxOperationError): void {
    if (this.failedControls.has(role)) return;
    this.failedControls.add(role);
    this.closed = true;
    this.journal.controlFailed(role, error);
  }
  workEnter(scope: keyof WorkOwnership, token: string): Promise<void> {
    return this.journal.apply({ kind: 'work_enter', memberId: this.journal.memberId, scope, token }, 'member');
  }
  workJoin(scope: keyof WorkOwnership, token: string): Promise<void> {
    return this.journal.apply({ kind: 'work_join', memberId: this.journal.memberId, scope, token }, 'member');
  }

  private async enqueue(role: ResourceRole, action: ResourceAction): Promise<number> {
    await this.journal.apply({ kind: 'queue', memberId: this.journal.memberId, role, action }, 'transition');
    const generation = this.journal.snapshot().generation;
    const queued = generation.kind === 'dirty' ? generation.queue.find((entry) => entry.memberId === this.journal.memberId
      && entry.role === role && entry.action === action) : undefined;
    if (!queued) throw new SandboxStateError('The original member effect lost its acknowledged queue entry.');
    return queued.effectSequence;
  }

  private async arm(effectSequence: number, role: ResourceRole, action: ResourceAction, input: unknown, signal?: AbortSignal): Promise<void> {
    const expectedBeforeDigest = await this.journal.before(role, action, signal);
    await this.journal.apply({ kind: 'arm', effectSequence, expectedBeforeDigest,
      expectedInputDigest: coordinatorDigest('agenai.desktop-coordinator.effect-input.v1', JSON.stringify(input)) }, 'transition');
  }

  private bounded<Value>(perform: () => Promise<Value>): Promise<Value> {
    const deadline = setTimeout(() => {
      const error = new SandboxOperationError('deadline_exceeded', 'Coordinated topology settlement exceeded its physical ownership bound.');
      this.journal.fence(error);
      this.closeAdmission();
      this.owner.failed(error);
    }, DESKTOP_COORDINATOR_POLICY.transitionTimeoutMs);
    deadline.unref();
    return perform().finally(() => clearTimeout(deadline));
  }

  private async cancelQueued(effectSequence: number): Promise<void> {
    const generation = this.journal.snapshot().generation;
    if (generation.kind === 'dirty' && generation.queue.some((entry) => entry.effectSequence === effectSequence)) {
      await this.journal.apply({ kind: 'cancel_queued', effectSequence }, 'settlement');
    }
  }

  private async runQueuedCleanup(effectSequence: number, perform: () => Promise<void>): Promise<void> {
    try { await this.journal.run('cleanup', perform); }
    catch (cause) {
      try { await this.cancelQueued(effectSequence); }
      catch (cancelCause) { throw new AggregateError([cause, cancelCause], 'Original cleanup and its unentered queue cancellation did not both settle.'); }
      throw cause;
    }
  }

  private async nonDispatch(effectSequence: number, role: ResourceRole): Promise<void> {
    const ledger = this.member().roles.find((candidate) => candidate.role === role);
    if (!ledger) throw new SandboxStateError('The original role ledger is absent.');
    const presence = ledger.presence.kind === 'possibly_present'
      ? { kind: 'not_entered' as const, provedAtSequence: this.journal.snapshot().sequence + 1 } : ledger.presence;
    await this.journal.apply({ kind: 'settle', effectSequence, outcome: 'not_dispatched', presence,
      receiptDigest: coordinatorDigest('agenai.desktop-coordinator.non-dispatch.v1', JSON.stringify({ memberId: this.journal.memberId, role, effectSequence })) }, 'settlement');
  }

  async create(role: ResourceRole, signal: AbortSignal | undefined, operation: DesktopCoordinatorCreateOperation): Promise<ResourceInspection> {
    if (this.requestedCreates.has(role) || this.resource(role).identity.kind !== 'planned') throw new SandboxStateError('Original resource creation is once-only.');
    this.requestedCreates.add(role);
    await this.assertCurrent(signal);
    const record = this.owner.record();
    await this.checkpoint({ ...record, resources: record.resources.map((resource) => resource.role === role
      ? { ...resource, identity: { kind: 'creating' } } : resource) });
    this.assertOpen(signal);
    const effectSequence = await this.enqueue(role, 'create');
    try {
      return await this.journal.run('ordinary', () => this.bounded(async () => {
        await this.arm(effectSequence, role, 'create', operation.input, signal);
        let dispatched = false;
        try {
          await this.assertCurrent(signal);
          const actual = Promise.resolve().then(() => {
            this.assertOpen(signal);
            dispatched = true;
            return operation.dispatch(this.resource(role));
          }).then((created) => { this.owner.returned(role, created.id); return created; });
          this.creates.set(role, { actual, dispatched: () => dispatched });
          this.owner.creating(role, actual);
          const created = await actual;
          await this.journal.apply({ kind: 'returned', effectSequence, id: created.id }, 'transition');
          const inspection = await this.inspect(role, created.id);
          if (!inspection || inspection.id !== created.id) throw new SandboxStateError('Docker did not confirm the exact original created resource.');
          operation.validate?.(inspection);
          const next = this.retain({ ...this.owner.record(), resources: this.owner.record().resources.map((resource) => resource.role === role
            ? { ...resource, identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : resource) });
          const observed = await this.journal.after(role, 'create', inspection);
          const mode = await this.persist(next);
          await this.journal.apply({ kind: 'settle', effectSequence, outcome: 'present', record: next, mode,
            presence: this.presence(role, inspection, observed.inspectionDigest), receiptDigest: observed.receiptDigest,
            ...(observed.projection === undefined ? {} : { projection: observed.projection }) }, 'settlement');
          if (this.sinkFailure) { this.owner.failed(this.sinkFailure); throw this.sinkFailure; }
          if (created.warning) throw new SandboxUnsupportedError('Docker warned while creating the requested resource.');
          this.assertOpen(signal);
          return inspection;
        } catch (cause) {
          if (!dispatched) await this.nonDispatch(effectSequence, role);
          else {
            const generation = this.journal.snapshot().generation;
            if (generation.kind === 'dirty' && generation.entered?.effectSequence === effectSequence) this.journal.fence(cause);
          }
          throw cause;
        }
      }), signal);
    } catch (cause) { await this.cancelQueued(effectSequence); throw cause; }
  }

  async start(role: DesktopCoordinatorStartedRole, signal: AbortSignal | undefined, operation: DesktopCoordinatorStartOperation): Promise<ResourceInspection> {
    const previous = this.member().roles.find((candidate) => candidate.role === role);
    if (this.requestedStarts.has(role) || previous?.start.kind !== 'not_entered') throw new SandboxStateError('Original container startup is once-only.');
    this.requestedStarts.add(role);
    await this.assertCurrent(signal);
    const resource = this.resource(role);
    if (resource.identity.kind !== 'identified') throw new SandboxStateError('Container startup requires its exact original identified resource.');
    const id = resource.identity.id;
    const effectSequence = await this.enqueue(role, 'start');
    try {
      return await this.journal.run('ordinary', () => this.bounded(async () => {
        const before = await this.inspect(role, id);
        if (!before?.container || before.container.State.Running
          || before.container.State.Status !== 'created' && before.container.State.Status !== 'exited') {
          throw new SandboxStateError('Original container start requires its exact stopped before-state.');
        }
        await this.arm(effectSequence, role, 'start', { id, action: 'start' }, signal);
        let dispatched = false;
        try {
          await this.assertCurrent(signal);
          operation.beginReadiness?.();
          dispatched = true;
          await this.owner.api.request('POST', `${DOCKER_API}/containers/${encodeURIComponent(id)}/start`);
          await operation.ready;
          const inspection = await this.inspect(role, id);
          if (!inspection) throw new SandboxStateError('The exact original container disappeared before readiness.');
          operation.validate(inspection);
          const observed = await this.journal.after(role, 'start', inspection);
          await this.journal.apply({ kind: 'settle', effectSequence, outcome: 'started',
            presence: this.presence(role, inspection, observed.inspectionDigest), receiptDigest: observed.receiptDigest,
            ...(observed.projection === undefined ? {} : { projection: observed.projection }) }, 'settlement');
          this.assertOpen(signal);
          return inspection;
        } catch (cause) {
          if (!dispatched) await this.nonDispatch(effectSequence, role);
          else {
            const generation = this.journal.snapshot().generation;
            if (generation.kind === 'dirty' && generation.entered?.effectSequence === effectSequence) this.journal.fence(cause);
          }
          throw cause;
        }
      }), signal);
    } catch (cause) { await this.cancelQueued(effectSequence); throw cause; }
  }

  private inspect(role: ResourceRole, reference: string): Promise<ResourceInspection | undefined> {
    return inspectResource(this.owner.api, this.owner.config, this.owner.record(), this.resource(role), reference);
  }

  private presence(role: ResourceRole, inspection: ResourceInspection, inspectionDigest: string): RoleLedger['presence'] {
    const runtime = resourceKind(role) === 'container'
      ? inspection.container?.State.Running ? 'running' : inspection.container?.State.Status === 'created' ? 'created' : 'exited'
      : 'not_applicable';
    return { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint, inspectionDigest, runtime };
  }

  private cleanup(perform: () => Promise<void>): Promise<void> {
    return this.journal.trackCleanup(() => {
      const actual = this.cleanupTail.then(perform, perform);
      this.cleanupTail = actual.catch(() => {});
      return actual;
    });
  }

  controlClose(role: DesktopCoordinatorControlledRole, close: () => Promise<unknown>): Promise<void> {
    const previous = this.controlClosures.get(role);
    if (previous) return previous;
    const actual = this.cleanup(() => this.closeControl(role, close)).catch((cause: unknown) => {
      this.controlClosures.delete(role);
      throw cause;
    });
    this.controlClosures.set(role, actual);
    return actual;
  }

  private async closeControl(role: DesktopCoordinatorControlledRole, close: () => Promise<unknown>): Promise<void> {
    if (this.failedControls.has(role)) {
      // A joined failed attachment does not stop its producer; exact deletion proves that removal.
      await this.journal.runCleanup(() => this.journal.run('cleanup', async () => {
        await this.journal.assertAuthority('cleanup');
        await close();
      }), () => this.originalCleanup.controlClose(role, close));
      return;
    }
    await this.journal.runCleanup(async () => {
      const resource = this.resource(role);
      if (resource.identity.kind !== 'identified') { await close(); return; }
      const id = resource.identity.id;
      const effectSequence = await this.enqueue(role, 'control_close');
      await this.runQueuedCleanup(effectSequence, () => this.bounded(async () => {
        await this.arm(effectSequence, role, 'control_close', { id, action: 'control_close' });
        await this.journal.assertAuthority('cleanup');
        await close();
        const inspection = await this.inspect(role, id);
        if (!inspection) throw new SandboxStateError('Control settlement requires its original container until exact deletion.');
        const observed = await this.journal.after(role, 'control_close', inspection);
        await this.journal.apply({ kind: 'settle', effectSequence, outcome: 'control_joined',
          presence: this.presence(role, inspection, observed.inspectionDigest), receiptDigest: observed.receiptDigest,
          ...(observed.projection === undefined ? {} : { projection: observed.projection }) }, 'settlement');
      }));
    }, () => this.originalCleanup.controlClose(role, close));
  }

  delete(role: ResourceRole): Promise<void> { return this.cleanup(() => this.remove(role)); }

  /** Helpers never auto-remove, so a released producer remains until its exact delete; earlier absence is foreign. */
  private async requireReleased(role: ResourceRole, id: string): Promise<void> {
    try {
      if ((await this.inspect(role, id))?.container) return;
      throw new SandboxOperationError('driver_failure', 'A released Desktop producer disappeared before its exact removal.');
    } catch (cause) { this.journal.fence(cause); throw cause; }
  }

  private async remove(role: ResourceRole): Promise<void> {
    const resource = this.resource(role);
    if (resource.identity.kind === 'planned' || resource.identity.kind === 'creating' && !this.creates.get(role)?.dispatched()) return;
    const remove = async () => { await this.journal.assertAuthority('cleanup'); await this.owner.remove(role); };
    await this.journal.runCleanup(async () => {
      if (resource.identity.kind !== 'identified') throw new SandboxStateError('Canonical exact cleanup requires a settled original identity.');
      const { id, fingerprint } = resource.identity;
      const effectSequence = await this.enqueue(role, 'delete');
      await this.runQueuedCleanup(effectSequence, () => this.bounded(async () => {
        if (this.failedControls.has(role)) await this.requireReleased(role, id);
        await this.arm(effectSequence, role, 'delete', { id, action: 'delete' });
        await remove();
        const observed = await this.journal.after(role, 'delete', undefined);
        const atSequence = this.journal.snapshot().sequence + 1;
        await this.journal.apply({ kind: 'settle', effectSequence, outcome: 'absent', receiptDigest: observed.receiptDigest,
          presence: { kind: 'absent', reference: id, fingerprint,
            inspectedAtSequence: atSequence, noLateProducerAfter: atSequence },
          ...(observed.projection === undefined ? {} : { projection: observed.projection }) }, 'settlement');
      }));
    }, () => this.originalCleanup.remove(role));
  }

  async beginStop(): Promise<void> {
    this.closeAdmission();
    return this.journal.trackCleanup(async () => {
      await this.journal.assertAuthority('cleanup');
      const state = this.member().state;
      if (state.kind !== 'cleanup_pending' && state.kind !== 'retained') {
        await this.journal.apply({ kind: 'member_state', memberId: this.journal.memberId, state: { kind: 'stopping' } }, 'member');
      }
    });
  }

  async stopped(record: SandboxRecoveryRecord): Promise<void> {
    if (this.callbacks.size) throw new SandboxStateError('The original caller checkpoint is still pending.');
    return this.journal.trackCleanup(async () => {
      if (this.journal.isFenced()) {
        return this.journal.runCleanup(() => this.originalCleanup.stopped(record), () => this.originalCleanup.stopped(record));
      }
      await this.journal.stopped();
      const continuation = this.sinkFailure ? this.cleanupRecord(record) : record;
      await this.journal.apply({ kind: 'checkpoint', memberId: this.journal.memberId, record: continuation,
        mode: this.sinkFailure ? 'canonical_cleanup' : 'caller_persisted' }, 'member');
      if (this.member().state.kind !== 'cleanup_pending') {
        await this.journal.apply({ kind: 'member_state', memberId: this.journal.memberId, state: { kind: 'retained' } }, 'member');
      }
    });
  }

  async retire(record: SandboxRecoveryRecord): Promise<void> {
    if (this.callbacks.size) throw new SandboxStateError('Canonical retirement cannot abandon an original caller checkpoint.');
    return this.journal.trackCleanup(async () => {
      if (this.journal.isFenced()) {
        return this.journal.runCleanup(() => this.originalCleanup.retire(record), () => this.originalCleanup.retire(record));
      }
      const continuation = this.sinkFailure ? this.cleanupRecord(record) : record;
      this.originalCleanup.retainRetirement(continuation);
      await this.journal.apply({ kind: 'retire', memberId: this.journal.memberId, record: continuation,
        mode: this.sinkFailure ? 'canonical_cleanup' : 'caller_persisted' }, 'settlement');
    });
  }
}

export function createDesktopCoordinatorMemberEffects(journal: DesktopCoordinatorMemberJournal,
  owner: DesktopCoordinatorMemberOwner): DesktopCoordinatorMember {
  return new MemberEffects(journal, owner);
}
