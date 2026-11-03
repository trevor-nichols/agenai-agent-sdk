import { z } from 'zod/v4';
import { digestSchema, positiveSequenceSchema, uuidSchema } from './scalars.js';

export const RECOVERY_EVIDENCE_LIMITS = Object.freeze({ receiptBytes: 262_144, archiveBytes: 1_048_576,
  attemptSlots: 8, activeProtocolSlots: 6, attemptBytes: 2_097_152 });
export const nativeAttemptSlotSchema = z.enum(['admission', 'armed', 'stopped', 'finished', 'outcome']);
const receiptFields = { digest: digestSchema, bytes: z.number().int().positive().max(RECOVERY_EVIDENCE_LIMITS.receiptBytes) };
export const nativeAttemptRefSchema = z.strictObject({ scope: z.literal('attempt'), attempt: positiveSequenceSchema,
  slot: nativeAttemptSlotSchema, ...receiptFields }).readonly();
export const nativeOutcomeRefSchema = z.strictObject({ scope: z.literal('attempt'), attempt: positiveSequenceSchema,
  slot: z.literal('outcome'), ...receiptFields }).readonly();
export const barrierDecisionRefSchema = z.strictObject({ scope: z.literal('decision'), attempt: positiveSequenceSchema,
  slot: z.literal('barrier_acceptance'), ...receiptFields }).readonly();
export const attemptTerminalRefSchema = z.union([nativeOutcomeRefSchema, barrierDecisionRefSchema]);
export const memberTerminalRefSchema = z.strictObject({ scope: z.literal('member'), memberId: uuidSchema,
  slot: z.literal('member_terminal'), ...receiptFields }).readonly();
export const originArchiveRefSchema = z.strictObject({ scope: z.literal('transaction'), slot: z.literal('origin_archive'),
  digest: digestSchema, bytes: z.number().int().positive().max(RECOVERY_EVIDENCE_LIMITS.archiveBytes) }).readonly();
export const terminalArchiveRefSchema = z.strictObject({ scope: z.literal('transaction'), slot: z.literal('terminal_archive'),
  digest: digestSchema, bytes: z.number().int().positive().max(RECOVERY_EVIDENCE_LIMITS.archiveBytes) }).readonly();
export const finalInventoryRefSchema = z.strictObject({ scope: z.literal('transaction'), slot: z.literal('final_inventory'), ...receiptFields }).readonly();
export const generationTerminalRefSchema = z.strictObject({ scope: z.literal('transaction'), slot: z.literal('generation_terminal'), ...receiptFields }).readonly();
export const receiptRefSchema = z.union([nativeAttemptRefSchema, barrierDecisionRefSchema, memberTerminalRefSchema,
  originArchiveRefSchema, terminalArchiveRefSchema, finalInventoryRefSchema, generationTerminalRefSchema]);
export type NativeAttemptSlot = z.infer<typeof nativeAttemptSlotSchema>;
export type NativeAttemptRef = z.infer<typeof nativeAttemptRefSchema>;
export type NativeOutcomeRef = z.infer<typeof nativeOutcomeRefSchema>;
export type AcceptedBarrierDecisionRef = z.infer<typeof barrierDecisionRefSchema>;
export type AttemptTerminalRef = z.infer<typeof attemptTerminalRefSchema>;
export type MemberTerminalRef = z.infer<typeof memberTerminalRefSchema>;
export type OriginArchiveRef = z.infer<typeof originArchiveRefSchema>;
export type TerminalArchiveRef = z.infer<typeof terminalArchiveRefSchema>;
export type FinalInventoryDecisionRef = z.infer<typeof finalInventoryRefSchema>;
export type GenerationTerminalRef = z.infer<typeof generationTerminalRefSchema>;
export type ReceiptRef = z.infer<typeof receiptRefSchema>;
export type TypedReceiptScope = Readonly<{ kind: NativeAttemptSlot | 'barrier_acceptance'; scope: number }>
  | Readonly<{ kind: 'member_terminal'; scope: string }>
  | Readonly<{ kind: 'origin_archive' | 'terminal_archive' | 'final_inventory' | 'generation_terminal'; scope: 'generation' }>;
export function receiptScope(ref: ReceiptRef): TypedReceiptScope {
  if (ref.scope === 'attempt' || ref.scope === 'decision') return { kind: ref.slot, scope: ref.attempt };
  if (ref.scope === 'member') return { kind: ref.slot, scope: ref.memberId };
  return { kind: ref.slot, scope: 'generation' };
}
export function sameReceipt(left: ReceiptRef, right: ReceiptRef): boolean {
  if (left.scope !== right.scope || left.slot !== right.slot || left.digest !== right.digest || left.bytes !== right.bytes) return false;
  if ('attempt' in left) return 'attempt' in right && left.attempt === right.attempt;
  if ('memberId' in left) return 'memberId' in right && left.memberId === right.memberId;
  return true;
}
