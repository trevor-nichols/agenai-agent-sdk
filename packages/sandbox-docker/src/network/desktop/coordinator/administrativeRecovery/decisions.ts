import { encodeCoordinatorSnapshot, snapshotDigest } from '../journal/schema.js';
import { originalFrameDigest, originalRecoverySnapshot } from './validation.js';
import { encodeRecoveryEnvelope, recoveryEnvelopeDigest } from './schema.js';
import type { RecoveryEnvelope } from './schema.js';
import type { TerminalArchiveRef } from './receipts.js';
import { jsonValue, rawDigest, RecoveryJournalError } from './scalars.js';
import { planCleanHandback, resourceCompletionAnchor } from './plans.js';
import { parseSdkDecision, recoveryDecisionBinding } from './sdkDecisions.js';
import type { FinalInventoryDecision, GenerationTerminalDecision, InventoryAbsence, MemberTerminalDecision } from './sdkDecisions.js';

export function createMemberTerminalDecision(envelope: RecoveryEnvelope, memberId: string): MemberTerminalDecision {
  const snapshot = envelope.projection.snapshot;
  const generation = snapshot.generation;
  if (generation.kind !== 'dirty') throw new RecoveryJournalError('transition', 'Member terminal evidence requires original dirty ownership.');
  const member = generation.members.find((entry) => entry.memberId === memberId);
  if (!member) throw new RecoveryJournalError('transition', 'No original current member can be sealed.');
  const original = originalRecoverySnapshot(envelope);
  if (original.generation.kind !== 'dirty') throw new RecoveryJournalError('evidence', 'Terminal member lost its original dirty generation.');
  const receipts = member.roles.flatMap((role) => [role.create, role.start, role.controlClose, role.delete]);
  const effectSequences = receipts.flatMap((cell) => cell.kind === 'pending' || cell.kind === 'uncertain' || cell.kind === 'settled' ? [cell.effect] : []);
  const observations = member.roles.flatMap((role) => role.presence.kind === 'absent'
    ? [role.presence.inspectedAtSequence, role.presence.noLateProducerAfter]
    : role.presence.kind === 'not_entered' ? [role.presence.provedAtSequence] : []);
  const stableSequence = Math.max(original.sequence, member.checkpoint.revision, ...observations,
    ...receipts.flatMap((cell) => cell.kind === 'settled' ? [cell.atSequence] : []),
    ...(member.checkpoint.callerSink.kind === 'failed' ? [member.checkpoint.callerSink.atSequence] : []));
  const proof = { ...snapshot, sequence: stableSequence, previousDigest: envelope.origin.snapshotDigest,
    generation: { ...generation, basis: original.generation.basis,
      nextEffectSequence: Math.max(original.generation.nextEffectSequence, ...effectSequences.map((effect) => effect + 1)),
      members: [member], queue: [], entered: null, retired: [] } };
  const parsed = parseSdkDecision(JSON.stringify({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'member_terminal',
    binding: recoveryDecisionBinding(envelope), memberId, memberSequence: member.memberSequence,
    bindingDigest: member.binding.identityDigest, checkpointDigest: member.checkpoint.digest,
    record: member.checkpoint.record, memberProof: jsonValue(encodeCoordinatorSnapshot(proof)) }));
  if (parsed.kind !== 'member_terminal') throw new RecoveryJournalError('evidence', 'Member sealing produced a foreign SDK decision.');
  return parsed;
}
export function createFinalInventoryDecision(envelope: RecoveryEnvelope, resources: readonly InventoryAbsence[]): FinalInventoryDecision {
  const parsed = parseSdkDecision(JSON.stringify({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'final_inventory',
    binding: recoveryDecisionBinding(envelope), completionAnchor: resourceCompletionAnchor(envelope),
    members: envelope.memberTerminals.map((entry) => entry.receipt), resources }));
  if (parsed.kind !== 'final_inventory') throw new RecoveryJournalError('evidence', 'Final inventory produced a foreign SDK decision.');
  return parsed;
}
export function createGenerationTerminalDecision(envelope: RecoveryEnvelope, terminal: TerminalArchiveRef): GenerationTerminalDecision {
  if (envelope.phase.kind !== 'terminal_ready') throw new RecoveryJournalError('transition', 'Terminal handback requires resource completion.');
  const terminalText = encodeRecoveryEnvelope(envelope);
  const projection = envelope.projection.snapshot;
  if (terminal.digest !== originalFrameDigest(terminalText, projection) || terminal.bytes !== Buffer.byteLength(terminalText) + 148) {
    throw new RecoveryJournalError('evidence', 'Terminal archive does not contain the exact resource-complete canonical frame.');
  }
  const clean = planCleanHandback(envelope);
  const cleanText = encodeCoordinatorSnapshot(clean);
  const parsed = parseSdkDecision(JSON.stringify({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'generation_terminal',
    binding: recoveryDecisionBinding(envelope), claim: envelope.origin.claim, origin: envelope.origin.archive,
    terminal, finalInventory: envelope.phase.finalInventory, terminalEnvelopeDigest: recoveryEnvelopeDigest(envelope),
    terminalRawDigest: rawDigest(terminalText), cleanText, cleanRawDigest: rawDigest(cleanText), cleanSnapshotDigest: snapshotDigest(clean) }));
  if (parsed.kind !== 'generation_terminal') throw new RecoveryJournalError('evidence', 'Generation sealing produced a foreign SDK decision.');
  return parsed;
}
