// The version-one decoder is closed over frozen scalar, input, record and byte semantics.
import { z } from 'zod/v4';
import { delegationCanonicalJson, delegationInputDigest } from './data.js';
import {
  AtSchema, CountSchema, DigestSchema, NotificationSchema, ObservationSchema, ParentScopeSchema,
  PolicyCeilingSchema, RunRecordSchema, StoreIdSchema, TaskRecordSchema,
} from './schemas.js';

const revision = CountSchema.refine((value) => value > 0);
export const ReceiptSchema = z.strictObject({
  duplicate: z.boolean(), status: z.enum(['queued', 'preparing', 'running', 'waiting', 'settled', 'recorded', 'omitted', 'retired']),
  taskId: StoreIdSchema, taskRevision: revision, runId: StoreIdSchema.optional(), runRevision: revision.optional(),
  operationId: StoreIdSchema.optional(), notificationId: StoreIdSchema.optional(),
});
export const OperationSchema = z.strictObject({
  operationId: StoreIdSchema, parent: ParentScopeSchema, taskId: StoreIdSchema, runId: StoreIdSchema,
  kind: z.enum(['admit', 'prepare', 'configure', 'turn', 'steer', 'request_resolution', 'cancel', 'interrupt', 'session_close', 'binding_cleanup']),
  inputDigest: DigestSchema, ownerEpoch: revision,
  disposition: z.enum(['intent', 'delegated', 'delivered', 'rejected', 'interruption_requested', 'uncertain', 'completed']),
  attempts: revision, at: AtSchema, message: z.string().max(1_000).optional(), receipt: ReceiptSchema,
});
export const CapacitySchema = z.strictObject({
  tasks: CountSchema, runs: CountSchema, activeRuns: CountSchema, queuedRuns: CountSchema,
  retainedInputBytes: CountSchema, observationBytes: CountSchema, ordinaryOperations: CountSchema,
  reservedBytes: CountSchema, criticalSlots: CountSchema,
});
export const StateSchema = z.strictObject({
  singleton: z.literal(1), store_id: StoreIdSchema, owner_epoch: CountSchema, owner_nonce: StoreIdSchema.nullable(),
  limits_json: z.string(), capacity_json: z.string(),
});
export const FinalSlotSchema = z.strictObject({
  run: z.unknown(), task: TaskRecordSchema.optional(), notification: NotificationSchema.optional(), omission: ObservationSchema.optional(),
});
export function parseLegacyRun(summary: unknown, input: unknown) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary) || Object.hasOwn(summary, 'input')) {
    throw new Error('The legacy run summary is invalid.');
  }
  return RunRecordSchema.parse({ ...summary, input });
}
export function parseLegacyCeiling(input: unknown) {
  const value = PolicyCeilingSchema.parse(input);
  const keys = value.targets.map(delegationCanonicalJson);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)
    || value.ceilingId !== delegationInputDigest({ origin: value.origin, targets: value.targets })) {
    throw new Error('The legacy policy ceiling has an invalid digest or target order.');
  }
  return value;
}
