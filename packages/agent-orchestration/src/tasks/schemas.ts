// ------------------------------------------------------------------------------------------------
//                schemas.ts - Internal bounded delegation record validation
// ------------------------------------------------------------------------------------------------

import { AgentFailureCategorySchema, AgentRecoveryHintSchema, AgentTurnInputContentSchema } from "@agen-ai/agent-protocol/zod";
import { z } from "zod/v4";
import { delegationDataBytes } from "../shared/identity.js";
import { DELEGATION_FAILURE_BYTES } from "../shared/limits.js";
import { CanonicalIdSchema, RevisionSchema } from "../shared/schemas.js";
import type {
  DelegationCompletionEnvelope, DelegationHistoricalRequest, DelegationNotificationRecord,
  DelegationOwnerToken, DelegationParentScope, DelegationPolicyCeiling,
  DelegationPublicFailure,
  DelegationRunOutcome, DelegationRunRecord, DelegationTaskObservation, DelegationTaskRecord,
} from "./types.js";

export const StoreIdSchema = z.uuid();
export const OpaqueIdSchema = CanonicalIdSchema.max(128).refine((value) => new TextEncoder().encode(value).byteLength <= 128);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const AtSchema = z.iso.datetime();
export const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CompletionPolicySchema = z.enum(["collect", "next_turn", "automatic"]);
export const RunPhaseSchema = z.enum(["queued", "preparing", "running", "waiting", "settled"]);
export const ParentScopeSchema: z.ZodType<DelegationParentScope> = z.strictObject({
  parentId: OpaqueIdSchema, scopeId: OpaqueIdSchema, revision: RevisionSchema,
});
export const OwnerTokenSchema: z.ZodType<DelegationOwnerToken> = z.strictObject({
  storeId: StoreIdSchema, epoch: RevisionSchema, nonce: StoreIdSchema,
});
export const TargetReferenceSchema = z.strictObject({
  catalogId: CanonicalIdSchema, catalogRevision: RevisionSchema,
  targetId: CanonicalIdSchema, targetRevision: RevisionSchema,
  sourceId: CanonicalIdSchema, sourceRevision: RevisionSchema,
});
export const PolicyCeilingSchema: z.ZodType<DelegationPolicyCeiling> = z.strictObject({
  ceilingId: DigestSchema, origin: ParentScopeSchema, targets: z.array(TargetReferenceSchema).max(1_000),
});
export const HistoricalRequestSchema: z.ZodType<DelegationHistoricalRequest> = z.strictObject({
  requestId: CanonicalIdSchema, requestKind: z.enum(["approval", "elicitation"]), openedAt: AtSchema,
  expiresAt: AtSchema.optional(), state: z.enum(["waiting", "resolution_intended", "resolved", "unavailable"]),
});
export const ResultReferenceSchema = z.strictObject({ id: CanonicalIdSchema, kind: z.enum(["artifact", "host_result"]), digest: DigestSchema.optional() })
  .refine((value) => delegationDataBytes(value) <= 256, "Result reference exceeds 256 bytes.");
export const PublicFailureSchema: z.ZodType<DelegationPublicFailure> = z.strictObject({
  category: AgentFailureCategorySchema,
  code: z.string().min(1).max(128).regex(/^(?:\S|\S[\s\S]*\S)$/u),
  message: z.string().max(DELEGATION_FAILURE_BYTES),
  recovery: AgentRecoveryHintSchema.refine((hint) => hint.kind !== "wait_for_quota" || hint.quota === undefined,
    "Parent-visible recovery cannot contain child quota identity."),
}).refine((value) => delegationDataBytes(value) <= DELEGATION_FAILURE_BYTES, "Failure exceeds 2 KiB of canonical JSON.");
export const RunOutcomeSchema: z.ZodType<DelegationRunOutcome> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("succeeded"), result: z.strictObject({
    text: z.string().max(8_192).refine((value) => new TextEncoder().encode(value).byteLength <= 8_192),
    truncated: z.boolean(), references: z.array(ResultReferenceSchema).max(8),
  }).refine((value) => delegationDataBytes(value) <= 8_192, "Result summary exceeds 8 KiB of canonical JSON.") }),
  z.strictObject({ kind: z.literal("failed"), error: PublicFailureSchema }),
  z.strictObject({ kind: z.literal("canceled"), confirmation: z.enum(["not_dispatched", "provider_terminal"]) }),
  z.strictObject({ kind: z.literal("recovery_required"), reason: z.enum([
    "executor_lost", "dispatch_uncertain", "request_executor_lost", "steering_uncertain", "cancellation_uncertain", "storage_failed",
  ]) }),
]);
export const TaskRecordSchema: z.ZodType<DelegationTaskRecord> = z.strictObject({
  storeId: StoreIdSchema, taskId: StoreIdSchema, parent: ParentScopeSchema, ancestorTaskId: StoreIdSchema.optional(),
  depth: RevisionSchema, policyCeilingRef: DigestSchema, completionPolicy: CompletionPolicySchema,
  state: z.enum(["active", "settled", "recovery_required", "retired"]), revision: RevisionSchema,
  latestRunId: StoreIdSchema, runCount: RevisionSchema, createdAt: AtSchema, retiredAt: AtSchema.optional(),
  retirement: z.strictObject({ operationId: StoreIdSchema, inputDigest: DigestSchema, reason: z.string().max(1_000) }).optional(),
});
export const RunRecordSchema: z.ZodType<DelegationRunRecord> = z.strictObject({
  taskId: StoreIdSchema, runId: StoreIdSchema, ordinal: RevisionSchema,
  previousRunId: StoreIdSchema.optional(), continuationMode: z.enum(["next_turn", "follow_up"]).optional(), admissionOperationId: StoreIdSchema,
  admittedTarget: TargetReferenceSchema, appliedTarget: TargetReferenceSchema.optional(), admittedPolicyRevision: RevisionSchema,
  admittedOriginPolicyRevision: RevisionSchema,
  input: AgentTurnInputContentSchema, ownerEpoch: RevisionSchema, phase: RunPhaseSchema, revision: RevisionSchema,
  createdAt: AtSchema, deadlineAt: AtSchema, queuedStartDeadlineAt: AtSchema,
  dispatch: z.enum(["none", "intended", "delegated"]), preparation: z.enum(["none", "intended", "completed", "uncertain"]),
  cancelRequested: z.boolean(), pendingRequest: HistoricalRequestSchema.optional(),
  outcome: RunOutcomeSchema.optional(), settledAt: AtSchema.optional(), observationIndex: CountSchema,
  observationCount: CountSchema, observationBytes: CountSchema, omittedObservations: CountSchema, ordinaryOperationCount: CountSchema,
  lastObservationDigest: DigestSchema.optional(),
  recoveryReason: z.enum(["executor_lost", "dispatch_uncertain", "request_executor_lost", "steering_uncertain", "cancellation_uncertain", "storage_failed"]).optional(),
  finalization: z.strictObject({ operationId: StoreIdSchema, inputDigest: DigestSchema,
    taskRevision: CountSchema, runRevision: CountSchema }).optional(),
}).superRefine((value, context) => {
  if ((value.previousRunId !== undefined) !== (value.continuationMode !== undefined)) {
    context.addIssue({ code: "custom", path: ["continuationMode"], message: "A continuation mode requires exactly one previous run reference." });
  }
  if ((value.phase === "settled") !== (value.outcome !== undefined)
    || (value.phase === "settled") !== (value.settledAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["phase"], message: "A settled run requires exactly one final outcome and timestamp." });
  }
  if (delegationDataBytes(value) > 65_536 || delegationDataBytes(value.input) > 24_576
    || value.input.parts.reduce((count, part) => count + (part.type === "text" ? part.text.length : 0), 0) > 16_000) {
    context.addIssue({ code: "custom", path: ["input"], message: "Internal run records require a bounded complete row and admitted input." });
  }
});
export const ObservationSchema: z.ZodType<DelegationTaskObservation> = z.strictObject({
  storeId: StoreIdSchema, taskId: StoreIdSchema, runId: StoreIdSchema, index: RevisionSchema, at: AtSchema,
  kind: z.enum(["state", "text", "request", "omitted"]), phase: RunPhaseSchema.optional(),
  text: z.string().max(8_192).optional(), request: HistoricalRequestSchema.optional(), omitted: RevisionSchema.optional(),
}).refine((value) => delegationDataBytes(value) <= 8_192, "Canonical observation exceeds 8 KiB.");
export const CompletionEnvelopeSchema: z.ZodType<DelegationCompletionEnvelope> = z.strictObject({
  storeId: StoreIdSchema, notificationId: StoreIdSchema, taskId: StoreIdSchema, runId: StoreIdSchema,
  parent: ParentScopeSchema, policy: CompletionPolicySchema, settledAt: AtSchema, expiresAt: AtSchema, outcome: RunOutcomeSchema,
}).refine((value) => delegationDataBytes(value) <= 12_288, "Completion envelope exceeds 12 KiB.");
const deliveryCommit = z.strictObject({
  operationId: StoreIdSchema, inputDigest: DigestSchema, commandDigest: DigestSchema,
  attemptId: StoreIdSchema, attempt: RevisionSchema, ownerEpoch: RevisionSchema,
  receipt: z.strictObject({ duplicate: z.boolean(), status: z.enum(["queued", "preparing", "running", "waiting", "settled", "recorded", "omitted", "retired"]),
    taskId: StoreIdSchema, taskRevision: RevisionSchema, runId: StoreIdSchema.optional(), runRevision: RevisionSchema.optional(),
    operationId: StoreIdSchema.optional(), notificationId: StoreIdSchema.optional() }),
}).refine((value) => delegationDataBytes(value) <= 2_048, "Delivery bookkeeping exceeds its reserved slot.");
export const NotificationSchema: z.ZodType<DelegationNotificationRecord> = z.strictObject({
  envelope: CompletionEnvelopeSchema, revision: RevisionSchema,
  state: z.enum(["collectible", "pending", "claimed", "accepted", "rejected", "expired", "dismissed"]),
  claim: z.strictObject({ ownerEpoch: RevisionSchema, attemptId: StoreIdSchema }).optional(), attempts: CountSchema,
  retryAt: AtSchema.optional(), inboxId: OpaqueIdSchema.optional(), acceptedAt: AtSchema.optional(), reason: z.string().max(1_000).optional(),
  delivery: z.strictObject({ claim: deliveryCommit.optional(), receipt: deliveryCommit.optional() }).optional(),
}).superRefine((value, context) => {
  if ((value.state === "claimed") !== (value.claim !== undefined)) {
    context.addIssue({ code: "custom", path: ["claim"], message: "Only a claimed notification retains an active owner claim." });
  }
  if (delegationDataBytes({ outcome: value.envelope.outcome, notification: value }) > 32_768) {
    context.addIssue({ code: "custom", path: [], message: "Notification and outcome exceed their final reservation." });
  }
});
