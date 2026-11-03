import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { coordinatorDigest, encodeCoordinatorSnapshot, parseCoordinatorSnapshot, recoveryRecordDigest, snapshotDigest } from '../journal/schema.js';
import type { CoordinatorMember, CoordinatorSnapshot } from '../journal/schema.js';
import { attemptTerminalRefSchema, finalInventoryRefSchema, memberTerminalRefSchema, nativeAttemptRefSchema,
  originArchiveRefSchema, terminalArchiveRefSchema } from './receipts.js';
import type { ReceiptRef, TypedReceiptScope } from './receipts.js';
import { claimSchema, digestSchema, immutable, jsonValue, positiveSequenceSchema, rawDigest, RecoveryJournalError,
  requireByteBound, transportAdmissionSchema, uuidSchema } from './scalars.js';
import { restorationEvidenceSchema, restorationEventsDigest, restorationSpansDigest } from './restoration.js';
import type { RecoveryEnvelope } from './schema.js';

export const SDK_DECISION_MAX_PAYLOAD_BYTES = 262_144 - 512;
export const decisionBindingSchema = z.strictObject({ recoveryKey: digestSchema, authorityId: uuidSchema,
  engineKey: digestSchema, daemonId: z.string().min(1).max(256), generationId: uuidSchema,
  originFrameDigest: digestSchema, originRawDigest: digestSchema, claimDigest: digestSchema });
const common = { format: z.literal('agenai.desktop-recovery.sdk-decision.v1'), binding: decisionBindingSchema };
const snapshot: z.ZodType<CoordinatorSnapshot> = z.unknown().transform((value, context) => {
  try { return parseCoordinatorSnapshot(JSON.stringify(value)); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid terminal member proof' }); return z.NEVER; }
});
const record: z.ZodType<SandboxRecoveryRecord> = z.unknown().transform((value, context) => {
  try { return parseSandboxRecoveryRecord(value); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid original terminal recovery record' }); return z.NEVER; }
});
export const barrierAcceptanceDecisionSchema = z.strictObject({ ...common, kind: z.literal('barrier_acceptance'),
  attempt: positiveSequenceSchema, previousHistory: attemptTerminalRefSchema.nullable(), preparedRawDigest: digestSchema,
  native: z.strictObject({ admission: nativeAttemptRefSchema, armed: nativeAttemptRefSchema,
    stopped: nativeAttemptRefSchema, finished: nativeAttemptRefSchema }),
  transport: transportAdmissionSchema, restoration: restorationEvidenceSchema });
export const memberTerminalDecisionSchema = z.strictObject({ ...common, kind: z.literal('member_terminal'),
  memberId: uuidSchema, memberSequence: positiveSequenceSchema, bindingDigest: digestSchema,
  checkpointDigest: digestSchema, record, memberProof: snapshot });
const absenceSchema = z.strictObject({ memberId: uuidSchema,
  role: z.enum(['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'filesystem', 'route_observer']),
  name: z.string().min(1).max(256), reference: z.string().min(1).max(256),
  fingerprint: digestSchema.nullable(), outcome: z.literal('absent'), inspectionDigest: digestSchema });
export const finalInventoryDecisionSchema = z.strictObject({ ...common, kind: z.literal('final_inventory'),
  completionAnchor: digestSchema, members: z.array(memberTerminalRefSchema).max(4), resources: z.array(absenceSchema).max(36) });
export const generationTerminalDecisionSchema = z.strictObject({ ...common, kind: z.literal('generation_terminal'),
  claim: claimSchema, origin: originArchiveRefSchema, terminal: terminalArchiveRefSchema, finalInventory: finalInventoryRefSchema,
  terminalEnvelopeDigest: digestSchema, terminalRawDigest: digestSchema, cleanText: z.string().max(16_384),
  cleanRawDigest: digestSchema, cleanSnapshotDigest: digestSchema });
export const sdkDecisionSchema = z.discriminatedUnion('kind', [barrierAcceptanceDecisionSchema,
  memberTerminalDecisionSchema, finalInventoryDecisionSchema, generationTerminalDecisionSchema]);
export type DecisionBinding = z.infer<typeof decisionBindingSchema>;
export type BarrierAcceptanceDecision = z.infer<typeof barrierAcceptanceDecisionSchema>;
export type MemberTerminalDecision = z.infer<typeof memberTerminalDecisionSchema>;
export type FinalInventoryDecision = z.infer<typeof finalInventoryDecisionSchema>;
export type InventoryAbsence = z.infer<typeof absenceSchema>;
export type GenerationTerminalDecision = z.infer<typeof generationTerminalDecisionSchema>;
export type SdkDecision = z.infer<typeof sdkDecisionSchema>;

export function recoveryDecisionBinding(envelope: RecoveryEnvelope): DecisionBinding {
  return { recoveryKey: envelope.recoveryKey, authorityId: envelope.authorityId, engineKey: envelope.engineKey,
    daemonId: envelope.daemonId, generationId: envelope.origin.generationId,
    originFrameDigest: envelope.origin.framedDigest, originRawDigest: envelope.origin.rawDigest,
    claimDigest: coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(envelope.origin.claim)) };
}
export function assertDecisionBinding(envelope: RecoveryEnvelope, decision: SdkDecision): void {
  if (JSON.stringify(decision.binding) !== JSON.stringify(recoveryDecisionBinding(envelope))) {
    throw new RecoveryJournalError('evidence', 'SDK evidence does not bind the original recovery authority.');
  }
}
export function terminalDecisionMember(decision: MemberTerminalDecision): CoordinatorMember {
  const generation = decision.memberProof.generation;
  if (generation.kind !== 'dirty' || generation.state.kind !== 'cleanup_only' || generation.members.length !== 1
    || generation.queue.length !== 0 || generation.entered !== null || generation.retired.length !== 0) {
    throw new RecoveryJournalError('evidence', 'Member terminal proof must contain exactly its settled original member.');
  }
  const member = generation.members[0];
  if (!member || member.memberId !== decision.memberId || member.memberSequence !== decision.memberSequence
    || member.binding.identityDigest !== decision.bindingDigest || member.checkpoint.digest !== decision.checkpointDigest
    || member.checkpoint.record.phase !== 'destroyed' || recoveryRecordDigest(decision.record) !== decision.checkpointDigest
    || member.roles.some((role) => role.presence.kind !== 'absent' && role.presence.kind !== 'not_entered'
      || [role.create, role.start, role.controlClose, role.delete].some((cell) => cell.kind === 'pending' || cell.kind === 'uncertain'))
    || Object.values(member.work).some((scope) => scope.kind !== 'joined' && scope.kind !== 'not_entered')) {
    throw new RecoveryJournalError('evidence', 'Member terminal evidence retains an original obligation.');
  }
  return member;
}
function validateDecision(decision: SdkDecision): void {
  if (decision.kind === 'member_terminal') { terminalDecisionMember(decision); return; }
  if (decision.kind === 'generation_terminal') {
    if (rawDigest(decision.cleanText) !== decision.cleanRawDigest) throw new RecoveryJournalError('evidence', 'Clean handback bytes do not match their terminal manifest.');
    const clean = parseCoordinatorSnapshot(decision.cleanText);
    if (clean.generation.kind !== 'clean' || clean.authorityId !== decision.binding.authorityId
      || clean.engineKey !== decision.binding.engineKey || clean.daemonId !== decision.binding.daemonId
      || clean.generation.lastGenerationId !== decision.binding.generationId || snapshotDigest(clean) !== decision.cleanSnapshotDigest) throw new RecoveryJournalError('evidence', 'Terminal manifest changes the original generation.');
    return;
  }
  if (decision.kind !== 'barrier_acceptance') return;
  if (decision.previousHistory && decision.previousHistory.attempt >= decision.attempt) throw new RecoveryJournalError('evidence', 'Attempt history must precede the accepted attempt.');
  for (const slot of ['admission', 'armed', 'stopped', 'finished'] as const) {
    const ref = decision.native[slot];
    if (ref.slot !== slot || ref.attempt !== decision.attempt) throw new RecoveryJournalError('evidence', 'Accepted barrier replaces an original native stage.');
  }
  const restoration = decision.restoration;
  if (restoration.engineIdentityDigest !== decision.transport.engineFactsDigest
    || restoration.sourceSpanDigest !== restorationSpansDigest(restoration.spans)
    || restoration.classifiedEventsDigest !== restorationEventsDigest({ events: restoration.events, warnings: restoration.warnings, diagnostics: restoration.diagnostics })) {
    throw new RecoveryJournalError('evidence', 'Restoration evidence does not match its actual classified source graph.');
  }
  for (const span of restoration.spans) if (BigInt(span.end) < BigInt(span.start)) throw new RecoveryJournalError('evidence', 'Restoration source span runs backwards.');
  for (const event of [...restoration.events, ...restoration.warnings, ...restoration.diagnostics]) {
    if (event.spanStart > event.spanEnd || event.spanEnd >= restoration.spans.length) throw new RecoveryJournalError('evidence', 'Restoration event refers outside its captured source interval.');
  }
  const required = ['linux_boot', 'vm_identity', 'containerd_ready', 'dockerd_process', 'dockerd_start', 'load_start', 'restore_start', 'load_complete', 'initialization_complete', 'api_listen'];
  let previous = -1;
  for (const kind of required) {
    const index = restoration.events.findIndex((event, at) => at > previous && event.kind === kind);
    if (index < 0) throw new RecoveryJournalError('evidence', 'Restoration evidence omits or reorders a required startup boundary.');
    previous = index;
  }
}
export function parseSdkDecision(text: string): SdkDecision {
  const parsed = sdkDecisionSchema.safeParse(jsonValue(text));
  if (!parsed.success) throw new RecoveryJournalError('evidence', 'SDK decision does not match its closed schema.', { cause: parsed.error });
  requireByteBound(wireSdkDecision(parsed.data), SDK_DECISION_MAX_PAYLOAD_BYTES, 'SDK decision');
  validateDecision(parsed.data);
  return immutable(parsed.data);
}
export function wireSdkDecision(decision: SdkDecision): unknown {
  return decision.kind === 'member_terminal' ? { ...decision, memberProof: jsonValue(encodeCoordinatorSnapshot(decision.memberProof)) } : decision;
}
export function encodeSdkDecision(decision: SdkDecision): string {
  return JSON.stringify(wireSdkDecision(parseSdkDecision(JSON.stringify(wireSdkDecision(decision)))));
}
export function sdkDecisionScope(decision: SdkDecision): TypedReceiptScope {
  if (decision.kind === 'barrier_acceptance') return { kind: decision.kind, scope: decision.attempt };
  if (decision.kind === 'member_terminal') return { kind: decision.kind, scope: decision.memberId };
  return { kind: decision.kind, scope: 'generation' };
}
export function sdkDecisionDigest(decision: SdkDecision): string {
  return coordinatorDigest('agenai.docker-desktop-recovery.sdk-decision.v1', encodeSdkDecision(decision));
}

export function sdkDecisionReceipt(decision: SdkDecision): ReceiptRef {
  const text = encodeSdkDecision(decision);
  const payload = Buffer.from(text, 'utf8');
  const scope = sdkDecisionScope(decision);
  const headerText = `AGENAI-RECOVERY-1\n${decision.binding.engineKey.slice(7)}\n${decision.binding.recoveryKey.slice(7)}\n${scope.kind}\n${scope.scope}\n${payload.length}\n${rawDigest(text).slice(7)}\n`;
  if (Buffer.byteLength(headerText) > 512) throw new RecoveryJournalError('capacity', 'SDK evidence framing exceeds its fixed header.');
  const header = Buffer.alloc(512); header.write(headerText);
  const frame = Buffer.concat([header, payload]);
  const digest = `sha256:${createHash('sha256').update(frame).digest('hex')}`;
  if (decision.kind === 'barrier_acceptance') return { scope: 'decision', attempt: decision.attempt, slot: decision.kind, digest, bytes: frame.length };
  if (decision.kind === 'member_terminal') return { scope: 'member', memberId: decision.memberId, slot: decision.kind, digest, bytes: frame.length };
  return { scope: 'transaction', slot: decision.kind, digest, bytes: frame.length };
}
