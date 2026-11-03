import { z } from 'zod/v4';
import { parseCoordinatorSnapshot, encodeCoordinatorSnapshot, coordinatorDigest } from '../journal/schema.js';
import type { CoordinatorSnapshot } from '../journal/schema.js';
import { attemptTerminalRefSchema, barrierDecisionRefSchema, finalInventoryRefSchema, memberTerminalRefSchema,
  nativeAttemptRefSchema, originArchiveRefSchema } from './receipts.js';
import { claimSchema, digestSchema, endpointSchema, immutable, jsonValue, originalHelperSchema, positiveSequenceSchema,
  recoveryHelperSchema, RecoveryJournalError, sequenceSchema, transportAdmissionSchema, uuidSchema } from './scalars.js';
import { validateRecoveryEnvelope } from './validation.js';
import { FIRST_SUCCESSOR_PROFILE, PREVIOUS_RECOVERY_PROFILE } from './helperSuccession.js';

export const RECOVERY_JOURNAL_LIMITS = Object.freeze({ framedBytes: 1_048_576, nativeHeaderBytes: 148,
  originalBytes: 262_144, originalBase64Bytes: 349_528, projectionBytes: 589_824, noIdRows: 36,
  noIdRowBytes: 768, controlBytes: 49_152, sequenceAdmissionReserve: 4096, cleanupSequenceReserve: 512,
  attemptSequenceReserve: 64, roleGrowthBytes: 4096, memberGrowthBytes: 512, rootGrowthBytes: 4096 });
const snapshotSchema: z.ZodType<CoordinatorSnapshot> = z.unknown().transform((value, context) => {
  try { return parseCoordinatorSnapshot(JSON.stringify(value)); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid original coordinator snapshot projection' }); return z.NEVER; }
});
export interface RecoveryCleanupProjection {
  readonly format: 'agenai.desktop-recovery.cleanup-projection.v1';
  readonly snapshot: CoordinatorSnapshot;
}
const projectionSchema: z.ZodType<RecoveryCleanupProjection> = z.strictObject({
  format: z.literal('agenai.desktop-recovery.cleanup-projection.v1'), snapshot: snapshotSchema });
const armedRefSchema = z.unknown().transform((value, context) => {
  const parsed = nativeAttemptRefSchema.safeParse(value);
  if (parsed.success && parsed.data.slot === 'armed') return parsed.data;
  context.addIssue({ code: 'custom', message: 'Expected native armed reference' }); return z.NEVER;
});
const stoppedRefSchema = z.unknown().transform((value, context) => {
  const parsed = nativeAttemptRefSchema.safeParse(value);
  if (parsed.success && parsed.data.slot === 'stopped') return parsed.data;
  context.addIssue({ code: 'custom', message: 'Expected native stopped reference' }); return z.NEVER;
});
export const noIdAbsenceSchema = z.strictObject({ memberId: uuidSchema,
  role: z.enum(['compute', 'export', 'egress_broker', 'egress_relay', 'filesystem', 'route_observer']),
  createEffect: positiveSequenceSchema, checkpointDigestAtInspection: digestSchema, barrier: barrierDecisionRefSchema,
  inspectionDigest: digestSchema, settledAtSequence: sequenceSchema }).readonly();
export const memberTerminalSchema = z.strictObject({ memberId: uuidSchema, memberSequence: positiveSequenceSchema,
  checkpointDigest: digestSchema, receipt: memberTerminalRefSchema }).readonly();
export const recoveryPhaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared') }),
  z.strictObject({ kind: z.literal('attempt_prepared'), ordinal: positiveSequenceSchema }),
  z.strictObject({ kind: z.literal('armed'), ordinal: positiveSequenceSchema,
    preparedRawDigest: digestSchema, armed: armedRefSchema }),
  z.strictObject({ kind: z.literal('stopped'), ordinal: positiveSequenceSchema,
    preparedRawDigest: digestSchema, armed: armedRefSchema, stopped: stoppedRefSchema }),
  z.strictObject({ kind: z.literal('attempt_closed'), ordinal: positiveSequenceSchema, terminal: attemptTerminalRefSchema }),
  z.strictObject({ kind: z.literal('cleanup'), barrier: barrierDecisionRefSchema, acceptedAtSequence: sequenceSchema }),
  z.strictObject({ kind: z.literal('terminal_ready'), finalInventory: finalInventoryRefSchema }),
]);
const envelopeFields = {
  recoveryKey: digestSchema, authorityId: uuidSchema, engineKey: digestSchema,
  daemonId: z.string().min(1).refine((value) => value.isWellFormed() && Buffer.byteLength(value) <= 256),
  sequence: sequenceSchema, predecessor: z.strictObject({ format: z.enum(['coordinator-v1', 'recovery-v1']), digest: digestSchema }),
  origin: z.strictObject({ payloadBase64: z.string().max(RECOVERY_JOURNAL_LIMITS.originalBase64Bytes),
    payloadBytes: z.number().int().positive().max(RECOVERY_JOURNAL_LIMITS.originalBytes), rawDigest: digestSchema,
    snapshotDigest: digestSchema, framedDigest: digestSchema, sequence: sequenceSchema,
    generationId: uuidSchema, generationOrdinal: positiveSequenceSchema, claim: claimSchema, archive: originArchiveRefSchema }),
  preparation: z.strictObject({ configuredEndpoint: endpointSchema, sharedDigest: digestSchema,
    originalHelper: originalHelperSchema, recoveryHelper: recoveryHelperSchema }),
  transport: transportAdmissionSchema,
  projection: projectionSchema,
  noIdAbsences: z.array(noIdAbsenceSchema).max(RECOVERY_JOURNAL_LIMITS.noIdRows),
  memberTerminals: z.array(memberTerminalSchema).max(4), nextAttempt: positiveSequenceSchema,
  historyHead: attemptTerminalRefSchema.nullable(), phase: recoveryPhaseSchema,
  release: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('requested'), atSequence: sequenceSchema })]),
};
export const recoveryEnvelopeV1Schema = z.strictObject({ format: z.literal('agenai.docker-desktop-recovery.v1'), ...envelopeFields });
export const recoveryEnvelopeV2Schema = z.strictObject({ format: z.literal('agenai.docker-desktop-recovery.v2'), ...envelopeFields,
  predecessor: z.strictObject({ format: z.enum(['recovery-v1', 'recovery-v2']), digest: digestSchema }),
  activeHelper: recoveryHelperSchema, activeProfileDigest: digestSchema,
  previousIssuer: z.strictObject({ throughAttempt: positiveSequenceSchema, profileDigest: z.literal(PREVIOUS_RECOVERY_PROFILE) }),
});
export const recoveryEnvelopeV3Schema = z.strictObject({ format: z.literal('agenai.docker-desktop-recovery.v3'), ...envelopeFields,
  predecessor: z.strictObject({ format: z.enum(['recovery-v2', 'recovery-v3']), digest: digestSchema }),
  activeHelper: recoveryHelperSchema, activeProfileDigest: digestSchema,
  previousIssuers: z.tuple([
    z.strictObject({ kind: z.literal('original'), throughAttempt: positiveSequenceSchema, profileDigest: z.literal(PREVIOUS_RECOVERY_PROFILE) }),
    z.strictObject({ kind: z.literal('first_successor'), throughAttempt: positiveSequenceSchema,
      helper: recoveryHelperSchema, profileDigest: z.literal(FIRST_SUCCESSOR_PROFILE) }),
  ]),
});
export const recoveryEnvelopeSchema = z.discriminatedUnion('format', [recoveryEnvelopeV1Schema, recoveryEnvelopeV2Schema, recoveryEnvelopeV3Schema]);
export type RecoveryEnvelope = z.infer<typeof recoveryEnvelopeSchema>;
export type NoIdAbsence = z.infer<typeof noIdAbsenceSchema>;
export type MemberTerminal = z.infer<typeof memberTerminalSchema>;
export type RecoveryPhase = z.infer<typeof recoveryPhaseSchema>;

export function isRecoveryEnvelopeFormat(format: unknown): format is RecoveryEnvelope['format'] {
  return format === 'agenai.docker-desktop-recovery.v1' || format === 'agenai.docker-desktop-recovery.v2' || format === 'agenai.docker-desktop-recovery.v3';
}
export function isRecoveryEnvelope(state: RecoveryEnvelope | CoordinatorSnapshot): state is RecoveryEnvelope {
  return isRecoveryEnvelopeFormat(state.format);
}

export function wireRecoveryEnvelope(envelope: RecoveryEnvelope): unknown {
  return { ...envelope, projection: { ...envelope.projection,
    snapshot: jsonValue(encodeCoordinatorSnapshot(envelope.projection.snapshot)) } };
}
export function parseRecoveryEnvelope(text: string): RecoveryEnvelope {
  if (!text.isWellFormed() || Buffer.byteLength(text) + RECOVERY_JOURNAL_LIMITS.nativeHeaderBytes > RECOVERY_JOURNAL_LIMITS.framedBytes) {
    throw new RecoveryJournalError('capacity', 'Recovery envelope exceeds the native framing capacity.');
  }
  const parsed = recoveryEnvelopeSchema.safeParse(jsonValue(text));
  if (!parsed.success) throw new RecoveryJournalError('invalid', 'Recovery envelope does not match its closed schema.', { cause: parsed.error });
  validateRecoveryEnvelope(parsed.data);
  return immutable(parsed.data);
}
export function encodeRecoveryEnvelope(envelope: RecoveryEnvelope): string {
  const parsed = parseRecoveryEnvelope(JSON.stringify(wireRecoveryEnvelope(envelope)));
  return JSON.stringify(wireRecoveryEnvelope(parsed));
}
const versions = {
  'agenai.docker-desktop-recovery.v1': { predecessor: 'recovery-v1', domain: 'agenai.docker-desktop-recovery.snapshot.v1' },
  'agenai.docker-desktop-recovery.v2': { predecessor: 'recovery-v2', domain: 'agenai.docker-desktop-recovery.snapshot.v2' },
  'agenai.docker-desktop-recovery.v3': { predecessor: 'recovery-v3', domain: 'agenai.docker-desktop-recovery.snapshot.v3' },
} satisfies Record<RecoveryEnvelope['format'], { predecessor: 'recovery-v1' | 'recovery-v2' | 'recovery-v3'; domain: string }>;
export function recoveryPredecessorFormat(envelope: RecoveryEnvelope) { return versions[envelope.format].predecessor; }
export function recoveryEnvelopeDigest(envelope: RecoveryEnvelope): string {
  return coordinatorDigest(versions[envelope.format].domain, encodeRecoveryEnvelope(envelope));
}
export function noIdAbsenceDigest(row: NoIdAbsence): string {
  return coordinatorDigest('agenai.docker-desktop-recovery.name-absence.v1', JSON.stringify(noIdAbsenceSchema.parse(row)));
}
