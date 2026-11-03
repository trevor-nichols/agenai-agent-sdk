import { parseSandboxRecoveryRecord, SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../../policy/config.js';
import { inspectPath, resourceKind } from '../../../../resources/inspect.js';
import type { DockerApi } from '../../../../resources/api.js';
import { validateRecord } from '../../../../recovery/identity.js';
import { coordinatorDigest, recoveryRecordDigest } from '../journal/schema.js';
import type { CoordinatorSnapshot, ResourceRole } from '../journal/schema.js';
import type { CoordinatorEvent } from '../journal/plans.js';
import type { DesktopCoordinatorCleanupJournal } from '../recovery/contracts.js';
import { createDesktopCoordinatorRecoveryMembers } from '../recovery/members.js';
import { createMemberTerminalDecision } from './decisions.js';
import { planCleanupTransition, planNameAbsence } from './plans.js';
import { sameReceipt } from './receipts.js';
import type { ReceiptRef } from './receipts.js';
import type { MemberTerminal, RecoveryEnvelope } from './schema.js';
import { originalRecoverySnapshot, validateOriginalMemberContinuation } from './validation.js';
import { assertDecisionBinding, sdkDecisionReceipt, terminalDecisionMember } from './sdkDecisions.js';
import type { BarrierAcceptanceDecision, MemberTerminalDecision, SdkDecision } from './sdkDecisions.js';
import { immutable, RecoveryJournalError } from './scalars.js';

export interface RecoveryCleanupAdapterPorts {
  readonly api: DockerApi;
  current(): RecoveryEnvelope;
  publish(next: RecoveryEnvelope, boundary: 'member' | 'transition' | 'settlement'): Promise<void>;
  assertAuthority(signal?: AbortSignal): Promise<void>;
  run<Value>(perform: () => Promise<Value>): Promise<Value>;
  readSdkDecision(ref: ReceiptRef): Promise<SdkDecision>;
  publishSdkDecision(decision: SdkDecision): Promise<ReceiptRef>;
  assertBarrierCurrent(decision: BarrierAcceptanceDecision, signal?: AbortSignal): Promise<void>;
}

export class RecoveryCleanupJournalAdapter implements DesktopCoordinatorCleanupJournal {
  readonly api: DockerApi;
  private readonly recovery;
  private publicationTail: Promise<void> = Promise.resolve();

  constructor(private readonly ports: RecoveryCleanupAdapterPorts) {
    this.api = ports.api;
    this.recovery = createDesktopCoordinatorRecoveryMembers(this);
  }
  snapshot(): CoordinatorSnapshot { return this.ports.current().projection.snapshot; }
  assertAuthority(signal?: AbortSignal): Promise<void> { return this.ports.assertAuthority(signal); }
  run<Value>(perform: () => Promise<Value>): Promise<Value> { return this.ports.run(perform); }
  settle(): Promise<void> { return this.publicationTail; }

  apply(event: CoordinatorEvent, boundary: 'member' | 'transition' | 'settlement'): Promise<void> {
    const actual = this.publicationTail.then(async () => {
      let terminal: MemberTerminal | undefined;
      if (event.kind === 'retire') {
        const decision = createMemberTerminalDecision(this.ports.current(), event.memberId);
        const receipt = await this.ports.publishSdkDecision(decision);
        if (receipt.scope !== 'member' || !sameReceipt(receipt, sdkDecisionReceipt(decision))) {
          throw new RecoveryJournalError('evidence', 'Member retirement lacks its exact immutable manifest publication.');
        }
        terminal = { memberId: decision.memberId, memberSequence: decision.memberSequence,
          checkpointDigest: decision.checkpointDigest, receipt };
      }
      await this.ports.publish(planCleanupTransition(this.ports.current(), event, terminal), boundary);
    });
    this.publicationTail = actual.catch(() => {});
    return actual;
  }

  async settleCreatingAbsence(input: Readonly<{ memberId: string; role: ResourceRole; record: SandboxRecoveryRecord }>): Promise<boolean> {
    const envelope = this.ports.current();
    if (envelope.phase.kind !== 'cleanup' || resourceKind(input.role) !== 'container') return false;
    const generation = envelope.projection.snapshot.generation;
    if (generation.kind !== 'dirty') return false;
    const member = generation.members.find((entry) => entry.memberId === input.memberId);
    const resource = member?.checkpoint.record.resources.find((entry) => entry.role === input.role);
    const supplied = input.record.resources.find((entry) => entry.role === input.role);
    const ledger = member?.roles.find((entry) => entry.role === input.role);
    if (!member || !resource || !supplied || resource.name !== supplied.name || resource.identity.kind !== 'creating'
      || supplied.identity.kind !== 'creating' || ledger?.create.kind !== 'uncertain'
      || ledger.presence.kind !== 'possibly_present' || ledger.presence.returnedId !== null) return false;
    const decision = await this.ports.readSdkDecision(envelope.phase.barrier);
    if (decision.kind !== 'barrier_acceptance' || !sameReceipt(sdkDecisionReceipt(decision), envelope.phase.barrier)) {
      throw new RecoveryJournalError('evidence', 'Name absence requires its exact accepted barrier decision.');
    }
    assertDecisionBinding(envelope, decision);
    await this.ports.assertBarrierCurrent(decision);
    await this.assertAuthority();
    const response = await this.api.request('GET', inspectPath(resource, resource.name), { statuses: [200, 404] });
    await this.assertAuthority();
    await this.ports.assertBarrierCurrent(decision);
    if (response.statusCode !== 404) throw new SandboxStateError('The original creating name is present and requires exact cleanup acquisition.');
    const current = this.ports.current();
    if (current.phase.kind !== 'cleanup' || !sameReceipt(current.phase.barrier, envelope.phase.barrier)) {
      throw new RecoveryJournalError('evidence', 'Original barrier changed during exact name inspection.');
    }
    const inspectionDigest = coordinatorDigest('agenai.docker-desktop-recovery.name-inspection.v1', JSON.stringify({
      recoveryKey: current.recoveryKey, memberId: input.memberId, role: input.role,
      name: resource.name, checkpointDigest: member.checkpoint.digest, statusCode: 404,
      endpointDigest: current.transport.endpointDigest, barrier: envelope.phase.barrier }));
    await this.ports.publish(planNameAbsence(current, { memberId: input.memberId, role: input.role,
      inspectionDigest, barrier: envelope.phase.barrier }), 'settlement');
    return true;
  }

  async resumeDestroyedMembers(): Promise<void> {
    await this.run(async () => {
      for (;;) {
        const generation = this.snapshot().generation;
        if (generation.kind !== 'dirty') return;
        const member = generation.members.find((entry) => entry.checkpoint.record.phase === 'destroyed'
          && generation.entered?.memberId !== entry.memberId && !generation.queue.some((queued) => queued.memberId === entry.memberId)
          && entry.roles.every((role) => (role.presence.kind === 'absent' || role.presence.kind === 'not_entered')
            && [role.create, role.start, role.controlClose, role.delete].every((cell) => cell.kind !== 'pending' && cell.kind !== 'uncertain')));
        if (!member) return;
        if (Object.values(member.work).some((scope) => scope.kind !== 'joined' && scope.kind !== 'not_entered')) {
          await this.apply({ kind: 'settle_recovered_work', memberId: member.memberId,
            proofDigest: coordinatorDigest('agenai.desktop-recovery.terminal-work.v1', JSON.stringify(member.roles)) }, 'settlement');
        }
        await this.apply({ kind: 'retire', memberId: member.memberId, record: member.checkpoint.record, mode: 'canonical_cleanup' }, 'settlement');
      }
    });
  }
  async members(): Promise<readonly SandboxRecoveryRecord[]> {
    const envelope = this.ports.current();
    const original = originalRecoverySnapshot(envelope);
    const generation = envelope.projection.snapshot.generation;
    if (original.generation.kind !== 'dirty' || generation.kind !== 'dirty') throw new RecoveryJournalError('invalid', 'Recovery lost its original generation.');
    const records: SandboxRecoveryRecord[] = [];
    for (const member of original.generation.members) {
      const current = generation.members.find((entry) => entry.memberId === member.memberId);
      if (current) records.push(current.checkpoint.record);
      else records.push((await this.readTerminal(member.memberId)).record);
    }
    return immutable(records);
  }
  private async readTerminal(memberId: string): Promise<MemberTerminalDecision> {
    const envelope = this.ports.current();
    const terminal = envelope.memberTerminals.find((entry) => entry.memberId === memberId);
    if (!terminal) throw new RecoveryJournalError('evidence', 'Original retired member has no terminal manifest reference.');
    const decision = await this.ports.readSdkDecision(terminal.receipt);
    if (decision.kind !== 'member_terminal' || !sameReceipt(terminal.receipt, sdkDecisionReceipt(decision))) throw new RecoveryJournalError('evidence', 'Original member terminal evidence does not match its exact reference.');
    assertDecisionBinding(envelope, decision);
    const member = terminalDecisionMember(decision);
    const original = originalRecoverySnapshot(envelope);
    const generation = this.snapshot().generation;
    const prior = original.generation.kind === 'dirty' ? original.generation.members.find((entry) => entry.memberId === memberId) : undefined;
    const retired = generation.kind === 'dirty' ? generation.retired.find((entry) => entry.memberId === memberId) : undefined;
    if (prior) validateOriginalMemberContinuation(prior, member);
    if (!prior || !retired || JSON.stringify(decision.memberProof.generation.kind === 'dirty' ? decision.memberProof.generation.identity : null)
      !== JSON.stringify(original.generation.kind === 'dirty' ? original.generation.identity : null)
      || member.binding.identityDigest !== prior.binding.identityDigest || retired.bindingDigest !== member.binding.identityDigest
      || retired.checkpointDigest !== decision.checkpointDigest || terminal.checkpointDigest !== decision.checkpointDigest) {
      throw new RecoveryJournalError('evidence', 'Original terminal manifest changes its member or retirement binding.');
    }
    return decision;
  }
  async reconcile(config: DockerSandboxConfig, record: SandboxRecoveryRecord, signal?: AbortSignal): Promise<SandboxReconciliation> {
    const generation = this.snapshot().generation;
    if (generation.kind === 'dirty' && generation.members.some((entry) => entry.memberId === record.operationId)) {
      return this.recovery.reconcile(config, record, signal);
    }
    return this.run(async () => {
      signal?.throwIfAborted();
      if (!this.ports.current().memberTerminals.some((entry) => entry.memberId === record.operationId)) {
        return { kind: 'conflict', reason: 'No original canonical recovery member matches this record.' };
      }
      const decision = await this.readTerminal(record.operationId);
      const envelope = this.ports.current();
      if (!config.coordination || config.coordination.authorityId !== envelope.authorityId || config.coordination.engineKey !== envelope.engineKey
        || JSON.stringify(config.coordination.generation) !== JSON.stringify(envelope.projection.snapshot.generation.kind === 'dirty'
          ? envelope.projection.snapshot.generation.identity : null) || !validateRecord(record, config)
        || recoveryRecordDigest(record) !== decision.checkpointDigest) {
        return { kind: 'conflict', reason: 'Cleanup requires the exact terminal canonical record and original configuration.' };
      }
      const terminal = parseSandboxRecoveryRecord(decision.record);
      if (terminal.resources.some((resource) => resource.identity.kind === 'creating')) {
        return { kind: 'matched', owner: Object.freeze({ recoveryRecord: terminal,
          stop: () => Promise.resolve(), destroy: () => Promise.resolve() }) };
      }
      return { kind: 'absent', record: terminal };
    });
  }
}
