// ------------------------------------------------------------------------------------------------
//                parse.ts - Validator-neutral delegation data parsers
// ------------------------------------------------------------------------------------------------

import { AgentTurnInputContentSchema } from "@agen-ai/agent-protocol/zod";
import { z } from "zod/v4";
import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError } from "../shared/errors.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { parseDelegationPolicyCeiling } from "../tasks/parse.js";
import {
  AtSchema, CompletionPolicySchema, CountSchema, DigestSchema, HistoricalRequestSchema,
  ObservationSchema, OpaqueIdSchema, OwnerTokenSchema, ParentScopeSchema, PolicyCeilingSchema,
  RunOutcomeSchema, StoreIdSchema, TargetReferenceSchema,
} from "../tasks/schemas.js";
import type { DelegationStoreCommand, DelegationStoreReadInput, DelegationStoreScanInput } from "./types.js";

const fence = {
  owner: OwnerTokenSchema, operationId: StoreIdSchema, inputDigest: DigestSchema, taskId: StoreIdSchema,
  expectedTaskRevision: CountSchema, runId: StoreIdSchema.optional(), expectedRunRevision: CountSchema.optional(),
};
const admission = z.strictObject({
  parent: ParentScopeSchema, ancestorTaskId: StoreIdSchema.optional(), depth: z.number().int().positive(),
  policyCeiling: PolicyCeilingSchema, completionPolicy: CompletionPolicySchema,
  runId: StoreIdSchema, previousRunId: StoreIdSchema.optional(), continuationMode: z.enum(["next_turn", "follow_up"]).optional(), target: TargetReferenceSchema,
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  originPolicyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), input: AgentTurnInputContentSchema,
  createdAt: AtSchema, deadlineAt: AtSchema, queuedStartDeadlineAt: AtSchema,
}).refine((value) => (value.previousRunId !== undefined) === (value.continuationMode !== undefined), {
  path: ["continuationMode"], message: "A continuation mode requires exactly one previous run reference.",
});
const deliveryResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted"), inboxId: OpaqueIdSchema, acceptedAt: AtSchema }),
  z.strictObject({ status: z.literal("blocked"), reason: z.enum(["busy", "authority_unavailable", "capacity"]), retryAt: AtSchema }),
  z.strictObject({ status: z.literal("uncertain"), retryAt: AtSchema }),
  z.strictObject({ status: z.enum(["rejected", "expired", "dismissed"]), reason: z.string().max(1_000) }),
]);
const commandSchema: z.ZodType<DelegationStoreCommand> = z.discriminatedUnion("kind", [
  z.strictObject({ ...fence, kind: z.literal("admit"), admission }),
  z.strictObject({ ...fence, kind: z.literal("dispatch_intent"),
    operationKind: z.enum(["prepare", "configure", "turn", "steer", "request_resolution", "interrupt", "session_close", "binding_cleanup"]),
    at: AtSchema, appliedTarget: TargetReferenceSchema.optional(), attempt: z.union([z.literal(1), z.literal(2)]).optional() }),
  z.strictObject({ ...fence, kind: z.literal("operation_receipt"),
    disposition: z.enum(["delegated", "delivered", "rejected", "interruption_requested", "uncertain", "completed"]),
    at: AtSchema, message: z.string().max(1_000).optional(), requestState: z.enum(["pending", "unavailable"]).optional() }),
  z.strictObject({ ...fence, kind: z.literal("observe"), observation: ObservationSchema }),
  z.strictObject({ ...fence, kind: z.literal("request_state"), state: z.enum(["opened", "resolution_intended", "resolved", "unavailable"]),
    request: HistoricalRequestSchema, at: AtSchema }),
  z.strictObject({ ...fence, kind: z.literal("cancel"), at: AtSchema, reason: z.string().min(1).max(1_000) }),
  z.strictObject({ ...fence, kind: z.literal("settle"), outcome: RunOutcomeSchema, at: AtSchema }),
  z.strictObject({ ...fence, kind: z.literal("delivery_claim"), notificationId: StoreIdSchema,
    expectedNotificationRevision: CountSchema, attemptId: StoreIdSchema, at: AtSchema }),
  z.strictObject({ ...fence, kind: z.literal("delivery_receipt"), notificationId: StoreIdSchema,
    expectedNotificationRevision: CountSchema, attemptId: StoreIdSchema, result: deliveryResult, at: AtSchema }),
  z.strictObject({ ...fence, kind: z.literal("retire_recovery"), reason: z.string().min(1).max(1_000), at: AtSchema }),
]);
const page = { cursor: z.string().max(256).optional(), limit: z.number().int().positive().max(100).optional() };
const readSchema: z.ZodType<DelegationStoreReadInput> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), taskId: StoreIdSchema, ...page }),
  z.strictObject({ kind: z.literal("run"), taskId: StoreIdSchema, runId: StoreIdSchema }),
  z.strictObject({ kind: z.literal("operation"), parent: ParentScopeSchema, operationId: StoreIdSchema }),
  z.strictObject({ kind: z.literal("operations"), taskId: StoreIdSchema, runId: StoreIdSchema, ...page }),
  z.strictObject({ kind: z.literal("observations"), taskId: StoreIdSchema, runId: StoreIdSchema, ...page }),
  z.strictObject({ kind: z.literal("notification"), notificationId: StoreIdSchema }),
  z.strictObject({ kind: z.literal("ceiling"), ceilingId: DigestSchema, ...page }),
  z.strictObject({ kind: z.literal("capacity") }),
]);
const scanSchema: z.ZodType<DelegationStoreScanInput> = z.strictObject({
  kind: z.enum(["queued", "recoverable_runs", "eligible_notifications"]), at: AtSchema, ...page,
});

function parse<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const captured = copyBoundedDelegationData(input);
  const parsed = schema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return freezeDelegationData(parsed.data);
}

export function parseDelegationStoreCommand(input: unknown): DelegationStoreCommand {
  const value = parse(commandSchema, input);
  if (value.kind === "admit") parseDelegationPolicyCeiling(value.admission.policyCeiling);
  return value;
}
export const parseDelegationStoreReadInput = (input: unknown): DelegationStoreReadInput => parse(readSchema, input);
export const parseDelegationStoreScanInput = (input: unknown): DelegationStoreScanInput => parse(scanSchema, input);
