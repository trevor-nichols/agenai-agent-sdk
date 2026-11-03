import { recoveryRecordDigest } from '../journal/schema.js';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { RecoveryEnvelope } from './schema.js';
import { noIdAbsenceDigest } from './schema.js';
import { originalRecoverySnapshot, validateOriginalMemberContinuation } from './validation.js';
import type { AcceptedBarrierDecisionRef, AttemptTerminalRef, FinalInventoryDecisionRef, GenerationTerminalRef,
  NativeOutcomeRef, ReceiptRef, TypedReceiptScope } from './receipts.js';
import { sameReceipt } from './receipts.js';
import { assertDecisionBinding, sdkDecisionReceipt, terminalDecisionMember } from './sdkDecisions.js';
import type { BarrierAcceptanceDecision, FinalInventoryDecision, GenerationTerminalDecision, MemberTerminalDecision, SdkDecision } from './sdkDecisions.js';
import { createGenerationTerminalDecision } from './decisions.js';
import { planFinalInventory, resourceCompletionAnchor } from './plans.js';
import { immutable, RecoveryJournalError } from './scalars.js';

export interface RecoveryEvidencePorts {
  readSdkDecision(ref: ReceiptRef): Promise<SdkDecision>;
  findSdkDecision(scope: TypedReceiptScope): Promise<Readonly<{ ref: ReceiptRef; decision: SdkDecision }> | undefined>;
  verifyNativeBarrier(envelope: RecoveryEnvelope, decision: BarrierAcceptanceDecision): Promise<void>;
  verifyOutcome(envelope: RecoveryEnvelope, ref: NativeOutcomeRef): Promise<Readonly<{ previousHistory: AttemptTerminalRef | null }>>;
}
export interface RecoveryEvidenceGraph {
  readonly records: readonly SandboxRecoveryRecord[];
  readonly terminalMembers: readonly MemberTerminalDecision[];
  readonly barriers: readonly BarrierAcceptanceDecision[];
  readonly preferredHistoryHead: AttemptTerminalRef | null;
  readonly finalInventory: Readonly<{ ref: FinalInventoryDecisionRef; decision: FinalInventoryDecision }> | null;
  readonly terminal: Readonly<{ ref: GenerationTerminalRef; decision: GenerationTerminalDecision }> | null;
}
function invalid(message: string): never { throw new RecoveryJournalError('evidence', message); }
function sameTerminal(left: AttemptTerminalRef | null, right: AttemptTerminalRef | null): boolean {
  return left === null ? right === null : right !== null && sameReceipt(left, right);
}
function exactSdk(envelope: RecoveryEnvelope, ref: ReceiptRef, decision: SdkDecision): void {
  assertDecisionBinding(envelope, decision);
  if (!sameReceipt(ref, sdkDecisionReceipt(decision))) invalid('Stored SDK evidence does not match its exact framed receipt.');
}
export async function validateRecoveryEvidence(envelope: RecoveryEnvelope, ports: RecoveryEvidencePorts): Promise<RecoveryEvidenceGraph> {
  const original = originalRecoverySnapshot(envelope);
  const generation = envelope.projection.snapshot.generation;
  if (original.generation.kind !== 'dirty' || generation.kind !== 'dirty') return invalid('Recovery evidence lost the original dirty generation.');
  const terminalMembers: MemberTerminalDecision[] = [];
  const records: SandboxRecoveryRecord[] = [];
  for (const prior of original.generation.members) {
    const current = generation.members.find((member) => member.memberId === prior.memberId);
    if (current) { records.push(current.checkpoint.record); continue; }
    const terminal = envelope.memberTerminals.find((member) => member.memberId === prior.memberId);
    if (!terminal) return invalid('An original retired member lacks its immutable manifest reference.');
    const decision = await ports.readSdkDecision(terminal.receipt);
    exactSdk(envelope, terminal.receipt, decision);
    if (decision.kind !== 'member_terminal') return invalid('Original retirement references a foreign SDK decision kind.');
    const member = terminalDecisionMember(decision);
    validateOriginalMemberContinuation(prior, member);
    const retired = generation.retired.find((entry) => entry.memberId === prior.memberId);
    if (!retired || decision.memberId !== prior.memberId || decision.memberSequence !== prior.memberSequence
      || decision.bindingDigest !== prior.binding.identityDigest || retired.bindingDigest !== decision.bindingDigest
      || retired.checkpointDigest !== decision.checkpointDigest || terminal.checkpointDigest !== decision.checkpointDigest
      || recoveryRecordDigest(decision.record) !== terminal.checkpointDigest
      || JSON.stringify(decision.memberProof.generation.kind === 'dirty' ? decision.memberProof.generation.identity : null)
        !== JSON.stringify(original.generation.identity)) return invalid('Terminal SDK evidence replaces an original member identity or retirement.');
    terminalMembers.push(decision); records.push(decision.record);
  }
  for (const terminal of terminalMembers) {
    const prior = original.generation.members.find((member) => member.memberId === terminal.memberId);
    if (!prior) return invalid('Terminal evidence lost its original member.');
    const member = terminalDecisionMember(terminal);
    for (const resource of terminal.record.resources) {
      const before = prior.roles.find((role) => role.role === resource.role);
      const after = member.roles.find((role) => role.role === resource.role);
      if (resource.identity.kind === 'creating' && before?.presence.kind === 'possibly_present' && before.presence.returnedId === null
        && (before.create.kind === 'pending' || before.create.kind === 'uncertain')
        && after?.create.kind === 'settled' && after.create.outcome === 'absent'
        && !envelope.noIdAbsences.some((row) => row.memberId === terminal.memberId && row.role === resource.role)) {
        return invalid('An original retired no-ID create cannot silently become absent.');
      }
    }
  }
  const barriers: BarrierAcceptanceDecision[] = [];
  const barrierCache = new Map<string, BarrierAcceptanceDecision>();
  const readBarrier = async (ref: AcceptedBarrierDecisionRef): Promise<BarrierAcceptanceDecision> => {
    const cached = barrierCache.get(ref.digest);
    if (cached) return cached;
    const decision = await ports.readSdkDecision(ref);
    exactSdk(envelope, ref, decision);
    if (decision.kind !== 'barrier_acceptance' || decision.attempt !== ref.attempt) return invalid('No-ID evidence references a foreign observation attempt.');
    await ports.verifyNativeBarrier(envelope, decision);
    barrierCache.set(ref.digest, decision); barriers.push(decision);
    return decision;
  };
  for (const row of envelope.noIdAbsences) {
    const barrier = await readBarrier(row.barrier);
    if (barrier.transport.admittedAtSequence > row.settledAtSequence) return invalid('Original name absence precedes its producer barrier.');
    const current = generation.members.find((member) => member.memberId === row.memberId);
    const terminal = terminalMembers.find((member) => member.memberId === row.memberId);
    const member = current ?? (terminal ? terminalDecisionMember(terminal) : undefined);
    const ledger = member?.roles.find((entry) => entry.role === row.role);
    const resource = member?.checkpoint.record.resources.find((entry) => entry.role === row.role);
    if (!ledger || !resource || resource.identity.kind !== 'creating' || ledger.create.kind !== 'settled'
      || ledger.create.outcome !== 'absent' || ledger.create.effect !== row.createEffect || ledger.create.receiptDigest !== noIdAbsenceDigest(row)
      || ledger.create.atSequence !== row.settledAtSequence || ledger.presence.kind !== 'absent'
      || ledger.presence.reference !== resource.name || ledger.presence.fingerprint !== null
      || ledger.presence.inspectedAtSequence !== row.settledAtSequence
      || ledger.presence.noLateProducerAfter !== barrier.transport.admittedAtSequence) return invalid('Original name absence and its historical barrier receipt disagree.');
  }
  if (envelope.phase.kind === 'cleanup') {
    const current = await readBarrier(envelope.phase.barrier);
    if (JSON.stringify(current.transport) !== JSON.stringify(envelope.transport)) return invalid('Current cleanup transport does not bind its exact accepted restoration.');
  }
  let cursor = envelope.historyHead;
  let preferredHistoryHead = cursor;
  while (cursor) {
    let previous: AttemptTerminalRef | null;
    if (cursor.scope === 'decision') {
      const decision = await readBarrier(cursor);
      previous = decision.previousHistory;
    } else {
      const outcome = await ports.verifyOutcome(envelope, cursor);
      const accepted = await ports.findSdkDecision({ kind: 'barrier_acceptance', scope: cursor.attempt });
      if (accepted) {
        exactSdk(envelope, accepted.ref, accepted.decision);
        if (accepted.ref.scope !== 'decision' || accepted.decision.kind !== 'barrier_acceptance'
          || accepted.decision.attempt !== cursor.attempt || !sameTerminal(outcome.previousHistory, accepted.decision.previousHistory)) {
          return invalid('Completed acceptance contradicts its observer-session history.');
        }
        await readBarrier(accepted.ref);
        if (cursor === envelope.historyHead) preferredHistoryHead = accepted.ref;
        previous = accepted.decision.previousHistory;
      } else previous = outcome.previousHistory;
    }
    if (previous && previous.attempt >= cursor.attempt) return invalid('Attempt history must decrease monotonically without cycles.');
    cursor = previous;
  }
  let finalInventory: RecoveryEvidenceGraph['finalInventory'] = null;
  const final = envelope.phase.kind === 'terminal_ready'
    ? { ref: envelope.phase.finalInventory, decision: await ports.readSdkDecision(envelope.phase.finalInventory) }
    : await ports.findSdkDecision({ kind: 'final_inventory', scope: 'generation' });
  if (final) {
    exactSdk(envelope, final.ref, final.decision);
    if (final.ref.scope !== 'transaction' || final.ref.slot !== 'final_inventory' || final.decision.kind !== 'final_inventory') return invalid('Final inventory references a foreign SDK decision.');
    if (final.decision.completionAnchor !== resourceCompletionAnchor(envelope)) return invalid('Final inventory does not match the actual fully settled canonical projection.');
    // This pure check requires no current endpoint or renewed producer observation.
    planFinalInventory(envelope, final.decision, final.ref);
    for (const row of final.decision.resources) {
      const terminal = terminalMembers.find((entry) => entry.memberId === row.memberId);
      if (!terminal) return invalid('Final resource observation has no exact original terminal member.');
      const resource = terminal.record.resources.find((entry) => entry.role === row.role);
      const role = terminalDecisionMember(terminal).roles.find((entry) => entry.role === row.role);
      const reference = resource?.identity.kind === 'identified' ? resource.identity.id
        : role?.presence.kind === 'absent' ? role.presence.reference : resource?.name;
      const fingerprint = resource?.identity.kind === 'identified' ? resource.identity.fingerprint : null;
      if (!resource || row.name !== resource.name || row.reference !== reference || row.fingerprint !== fingerprint) return invalid('Final inventory replaces an original resource name, acquired ID or fingerprint.');
    }
    finalInventory = { ref: final.ref, decision: final.decision };
  }
  let terminal: RecoveryEvidenceGraph['terminal'] = null;
  const sealed = await ports.findSdkDecision({ kind: 'generation_terminal', scope: 'generation' });
  if (sealed) {
    exactSdk(envelope, sealed.ref, sealed.decision);
    if (envelope.phase.kind !== 'terminal_ready' || sealed.ref.scope !== 'transaction' || sealed.ref.slot !== 'generation_terminal'
      || sealed.decision.kind !== 'generation_terminal') return invalid('Generation handback evidence precedes irreversible resource completion.');
    const expected = createGenerationTerminalDecision(envelope, sealed.decision.terminal);
    if (!sameReceipt(sdkDecisionReceipt(expected), sealed.ref)) return invalid('Generation manifest does not name the exact original clean successor.');
    terminal = { ref: sealed.ref, decision: sealed.decision };
  }
  return immutable({ records, terminalMembers, barriers, preferredHistoryHead, finalInventory, terminal });
}
