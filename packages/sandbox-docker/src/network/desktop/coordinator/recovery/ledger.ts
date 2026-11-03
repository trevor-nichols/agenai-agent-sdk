// ------------------------------------------------------------------------------------------------
//                ledger.ts - Exact cleanup observations against original canonical action receipts
// ------------------------------------------------------------------------------------------------

import { SandboxStateError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import { resourceKind } from '../../../../resources/inspect.js';
import type { ResourceInspection } from '../../../../resources/inspect.js';
import { actionCell, coordinatorDigest, recoveryRecordDigest } from '../journal/schema.js';
import type { ActionReceipt, CoordinatorMember, ResourceAction, ResourceRole, RoleLedger } from '../journal/schema.js';
import type { DesktopCoordinatorCleanupJournal } from './contracts.js';

export function originalCoordinatorMember(journal: Pick<DesktopCoordinatorCleanupJournal, 'snapshot'>, memberId: string): CoordinatorMember {
  const generation = journal.snapshot().generation;
  const member = generation.kind === 'dirty' ? generation.members.find((entry) => entry.memberId === memberId) : undefined;
  if (!member) throw new SandboxStateError('Cleanup no longer owns this original coordinator member.');
  return member;
}

export function returnedResourceReference(member: CoordinatorMember, role: ResourceRole): string | undefined {
  const resource = member.checkpoint.record.resources.find((entry) => entry.role === role);
  if (resource?.identity.kind === 'identified') return resource.identity.id;
  const ledger = member.roles.find((entry) => entry.role === role);
  if (ledger?.presence.kind === 'possibly_present') return ledger.presence.returnedId ?? undefined;
  if (ledger?.presence.kind === 'absent' && ledger.create.kind === 'settled' && ledger.create.outcome === 'absent') return ledger.presence.reference;
  return undefined;
}

export function assertCleanupAcquisition(member: CoordinatorMember, role: ResourceRole, id: string): ActionReceipt {
  const ledger = member.roles.find((entry) => entry.role === role);
  const create = ledger?.create;
  if (!create || create.kind === 'not_entered' || create.kind === 'not_applicable') {
    throw new SandboxStateError('Cleanup cannot adopt a resource without its original create arm.');
  }
  if (create.kind === 'settled' && create.outcome !== 'present' || ledger?.presence.kind === 'absent') {
    throw new SandboxStateError('An absent or never-dispatched original create cannot be adopted for cleanup.');
  }
  const returned = returnedResourceReference(member, role);
  if (returned !== undefined && returned !== id) throw new SandboxStateError('Cleanup observation replaced the originally returned resource ID.');
  return create;
}

export class DesktopCleanupLedger {
  private retirement: Readonly<{ record: SandboxRecoveryRecord; bindingDigest: string; generationId: string }> | undefined;

  constructor(private readonly journal: DesktopCoordinatorCleanupJournal, readonly memberId: string) {}

  get member(): CoordinatorMember { return originalCoordinatorMember(this.journal, this.memberId); }

  retainRetirement(record: SandboxRecoveryRecord): void {
    const generation = this.journal.snapshot().generation;
    if (generation.kind !== 'dirty') throw new SandboxStateError('Cleanup lost its original dirty generation before retirement.');
    this.retirement = { record, bindingDigest: this.member.binding.identityDigest, generationId: generation.identity.generationId };
  }

  async confirmRetirement(): Promise<SandboxRecoveryRecord | undefined> {
    if (!this.retirement) return undefined;
    const generation = this.journal.snapshot().generation;
    if (generation.kind !== 'dirty' || generation.identity.generationId !== this.retirement.generationId) return undefined;
    const retired = generation.retired.find((entry) => entry.memberId === this.memberId);
    if (retired?.bindingDigest !== this.retirement.bindingDigest || retired.checkpointDigest !== recoveryRecordDigest(this.retirement.record)) return undefined;
    await this.journal.apply({ kind: 'close_admission' }, 'settlement');
    return this.retirement.record;
  }

  private role(role: ResourceRole): RoleLedger {
    const ledger = this.member.roles.find((entry) => entry.role === role);
    if (!ledger) throw new SandboxStateError('Cleanup lost its original resource-role ledger.');
    return ledger;
  }

  private continuation(record: SandboxRecoveryRecord, role?: ResourceRole): SandboxRecoveryRecord {
    const original = this.member.checkpoint.record;
    return parseSandboxRecoveryRecord({ ...original,
      phase: record.phase === 'starting' || record.phase === 'running' ? original.phase : record.phase,
      authority: original.authority.kind === 'unverified' ? record.authority : original.authority,
      resources: original.resources.map((resource) => resource.role === role
        ? record.resources.find((candidate) => candidate.role === role) ?? resource : resource) });
  }

  async cancelQueued(): Promise<void> {
    const generation = this.journal.snapshot().generation;
    if (generation.kind !== 'dirty') return;
    for (const entry of generation.queue.filter((candidate) => candidate.memberId === this.memberId)) {
      await this.journal.apply({ kind: 'cancel_queued', effectSequence: entry.effectSequence }, 'settlement');
    }
  }

  private receipt(role: ResourceRole, action: ResourceAction, value: unknown): string {
    return coordinatorDigest('agenai.desktop-coordinator.exact-cleanup.v1', JSON.stringify({ memberId: this.memberId, role, action, value }));
  }

  private async settle(role: ResourceRole, action: ResourceAction,
    outcome: Extract<ActionReceipt, { kind: 'settled' }>['outcome'], presence: RoleLedger['presence'], record: SandboxRecoveryRecord): Promise<void> {
    const cell = this.role(role)[actionCell(action)];
    const receiptDigest = this.receipt(role, action, { outcome, presence });
    if (cell.kind === 'pending') {
      const generation = this.journal.snapshot().generation;
      if (generation.kind !== 'dirty' || generation.entered?.effectSequence !== cell.effect) {
        throw new SandboxStateError('Original pending cleanup action lost its entered receipt.');
      }
      await this.journal.apply({ kind: 'settle', effectSequence: cell.effect, outcome, presence, record,
        mode: 'canonical_cleanup', receiptDigest, projection: { kind: 'none' } }, 'settlement');
    } else if (cell.kind === 'uncertain') {
      if (outcome === 'not_dispatched') throw new SandboxStateError('Fresh cleanup cannot invent original non-dispatch.');
      await this.journal.apply({ kind: 'resolve_uncertain', memberId: this.memberId, role, action, outcome, presence, record,
        receiptDigest, projection: { kind: 'none' } }, 'settlement');
    }
  }

  async present(role: ResourceRole, record: SandboxRecoveryRecord, inspection: ResourceInspection): Promise<void> {
    const create = assertCleanupAcquisition(this.member, role, inspection.id);
    if (create.kind === 'settled') return;
    const runtime = resourceKind(role) === 'container'
      ? inspection.container?.State.Running ? 'running' : inspection.container?.State.Status === 'created' ? 'created' : 'exited'
      : 'not_applicable';
    await this.settle(role, 'create', 'present', { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint,
      inspectionDigest: this.receipt(role, 'create', inspection), runtime }, this.continuation(record, role));
  }

  async joinedControl(role: ResourceRole, record: SandboxRecoveryRecord, inspection: ResourceInspection): Promise<void> {
    const ledger = this.role(role);
    if (ledger.controlClose.kind === 'pending' || ledger.controlClose.kind === 'uncertain') {
      const runtime = inspection.container?.State.Running ? 'running' : inspection.container?.State.Status === 'created' ? 'created' : 'exited';
      await this.settle(role, 'control_close', 'control_joined', { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint,
        inspectionDigest: this.receipt(role, 'control_close', inspection), runtime }, this.continuation(record, role));
    }
  }

  private async armDelete(effectSequence: number, expectedBeforeDigest: string, expectedInputDigest: string): Promise<void> {
    try {
      await this.journal.apply({ kind: 'arm', effectSequence, expectedBeforeDigest, expectedInputDigest }, 'transition');
    } catch (cause) {
      const generation = this.journal.snapshot().generation;
      if (generation.kind === 'dirty' && generation.queue.some((entry) => entry.effectSequence === effectSequence
        && entry.memberId === this.memberId && entry.action === 'delete')) {
        try { await this.journal.apply({ kind: 'cancel_queued', effectSequence }, 'settlement'); }
        catch (cancelCause) { throw new AggregateError([cause, cancelCause], 'Exact cleanup arm and original unentered intent cancellation did not both settle.'); }
      }
      throw cause;
    }
  }

  async prepareDelete(role: ResourceRole, record: SandboxRecoveryRecord, inspection: ResourceInspection): Promise<void> {
    const ledger = this.role(role);
    const cell = ledger.delete;
    if (ledger.presence.kind === 'absent') throw new SandboxStateError('An exactly absent original resource cannot be resurrected for cleanup.');
    if (cell.kind === 'settled' && cell.outcome === 'absent') throw new SandboxStateError('An exactly absent original resource cannot be resurrected for cleanup.');
    if (cell.kind === 'pending') {
      const generation = this.journal.snapshot().generation;
      if (generation.kind !== 'dirty' || generation.entered?.effectSequence !== cell.effect || generation.entered.action !== 'delete') {
        throw new SandboxStateError('The original delete retry lost its exact pending receipt.');
      }
      return;
    }
    await this.journal.apply({ kind: 'queue', memberId: this.memberId, role, action: 'delete' }, 'transition');
    const generation = this.journal.snapshot().generation;
    const effect = generation.kind === 'dirty' ? generation.queue.find((entry) => entry.memberId === this.memberId && entry.role === role && entry.action === 'delete') : undefined;
    if (!effect) throw new SandboxStateError('Exact cleanup lost its original delete intent.');
    const proof = this.receipt(role, 'delete', { resource: record.resources.find((entry) => entry.role === role), inspection });
    await this.armDelete(effect.effectSequence, proof, this.receipt(role, 'delete', { id: inspection.id }));
  }

  async absent(role: ResourceRole, record: SandboxRecoveryRecord): Promise<boolean> {
    let ledger = this.role(role);
    if (ledger.create.kind === 'not_entered' || ledger.create.kind === 'settled' && ledger.create.outcome === 'not_dispatched') return true;
    const supplied = record.resources.find((entry) => entry.role === role);
    const reference = returnedResourceReference(this.member, role) ?? (supplied?.identity.kind === 'identified' ? supplied.identity.id : undefined);
    if (reference === undefined) return this.journal.settleCreatingAbsence?.({ memberId: this.memberId, role, record }) ?? false;
    const continuation = this.continuation(record, role);
    const identity = continuation.resources.find((entry) => entry.role === role)?.identity;
    const presence = (): RoleLedger['presence'] => ({ kind: 'absent', reference,
      fingerprint: identity?.kind === 'identified' ? identity.fingerprint : null,
      inspectedAtSequence: this.journal.snapshot().sequence + 1, noLateProducerAfter: this.journal.snapshot().sequence + 1 });
    if (ledger.create.kind === 'pending' || ledger.create.kind === 'uncertain') {
      await this.settle(role, 'create', 'absent', presence(), continuation);
      ledger = this.role(role);
    }
    if (ledger.create.kind === 'settled' && ledger.create.outcome === 'absent') return true;
    const generation = this.journal.snapshot().generation;
    if (generation.kind !== 'dirty') throw new SandboxStateError('Cleanup lost its original dirty generation.');
    if (generation.entered !== null && (generation.entered.memberId !== this.memberId || generation.entered.role !== role)) return false;
    const actions: readonly ResourceAction[] = ['start', 'control_close', 'delete'];
    const ordered = [...actions].sort((left, right) => Number(this.role(role)[actionCell(right)].kind === 'pending')
      - Number(this.role(role)[actionCell(left)].kind === 'pending'));
    for (const action of ordered) {
      const cell = this.role(role)[actionCell(action)];
      if (cell.kind === 'pending' || cell.kind === 'uncertain') {
        await this.settle(role, action, action === 'control_close' ? 'control_joined' : 'absent', presence(), continuation);
      }
    }
    if (this.role(role).presence.kind === 'absent') return true;
    if (identity?.kind !== 'identified') throw new SandboxStateError('Exact known-ID cleanup lost its original acquired fingerprint.');
    await this.journal.apply({ kind: 'queue', memberId: this.memberId, role, action: 'delete' }, 'transition');
    const queued = this.journal.snapshot().generation;
    const effect = queued.kind === 'dirty' ? queued.queue.find((entry) => entry.memberId === this.memberId && entry.role === role && entry.action === 'delete') : undefined;
    if (!effect) throw new SandboxStateError('Exact cleanup lost its original delete intent.');
    const proof = this.receipt(role, 'delete', { reference, absence: true });
    await this.armDelete(effect.effectSequence, proof, proof);
    await this.settle(role, 'delete', 'absent', presence(), continuation);
    return true;
  }

  async terminal(phase: 'stopped' | 'destroyed', record: SandboxRecoveryRecord, recovered: boolean): Promise<SandboxRecoveryRecord> {
    const current = this.continuation({ ...record, phase });
    await this.journal.apply({ kind: 'checkpoint', memberId: this.memberId, record: current, mode: 'canonical_cleanup' }, 'member');
    if (recovered && phase === 'destroyed') await this.journal.apply({ kind: 'settle_recovered_work', memberId: this.memberId,
      proofDigest: this.receipt('compute', 'delete', this.member.roles) }, 'settlement');
    if (phase === 'destroyed') {
      this.retainRetirement(current);
      await this.journal.apply({ kind: 'retire', memberId: this.memberId, record: current, mode: 'canonical_cleanup' }, 'settlement');
    }
    return current;
  }
}

export function identifiedCleanupRecord(record: SandboxRecoveryRecord, resource: SandboxRecoveryResource,
  inspection: ResourceInspection): SandboxRecoveryRecord {
  return parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((candidate) => candidate.role === resource.role
    ? { ...candidate, identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : candidate) });
}
