// ------------------------------------------------------------------------------------------------
//                parse.ts - Validator-neutral delegation data parsers
// ------------------------------------------------------------------------------------------------

import { z } from "zod/v4";
import type { DelegationTargetReference } from "../catalog/types.js";
import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError, invalidDelegationData } from "../shared/errors.js";
import { delegationCanonicalJson, delegationInputDigest } from "../shared/identity.js";
import { freezeDelegationData } from "../shared/immutable.js";
import {
  CompletionEnvelopeSchema, HistoricalRequestSchema, NotificationSchema, ObservationSchema,
  OwnerTokenSchema, ParentScopeSchema, PolicyCeilingSchema, ResultReferenceSchema, RunOutcomeSchema, RunRecordSchema, TargetReferenceSchema, TaskRecordSchema,
} from "./schemas.js";
import type {
  DelegationCompletionEnvelope, DelegationHistoricalRequest, DelegationNotificationRecord,
  DelegationOwnerToken, DelegationParentScope, DelegationPolicyCeiling, DelegationResultReference, DelegationRunOutcome,
  DelegationRunRecord, DelegationTaskObservation, DelegationTaskRecord,
} from "./types.js";

function parse<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const captured = copyBoundedDelegationData(input);
  const parsed = schema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return freezeDelegationData(parsed.data);
}

export const parseDelegationParentScope = (input: unknown): DelegationParentScope => parse(ParentScopeSchema, input);
export const parseDelegationOwnerToken = (input: unknown): DelegationOwnerToken => parse(OwnerTokenSchema, input);
export const parseDelegationTaskRecord = (input: unknown): DelegationTaskRecord => parse(TaskRecordSchema, input);
export const parseDelegationRunRecord = (input: unknown): DelegationRunRecord => parse(RunRecordSchema, input);
export const parseDelegationRunOutcome = (input: unknown): DelegationRunOutcome => parse(RunOutcomeSchema, input);
export const parseDelegationResultReference = (input: unknown): DelegationResultReference => parse(ResultReferenceSchema, input);
export const parseDelegationTaskObservation = (input: unknown): DelegationTaskObservation => parse(ObservationSchema, input);
export const parseDelegationHistoricalRequest = (input: unknown): DelegationHistoricalRequest => parse(HistoricalRequestSchema, input);
export const parseDelegationCompletionEnvelope = (input: unknown): DelegationCompletionEnvelope => parse(CompletionEnvelopeSchema, input);
export const parseDelegationNotificationRecord = (input: unknown): DelegationNotificationRecord => parse(NotificationSchema, input);

export function parseDelegationPolicyCeiling(input: unknown): DelegationPolicyCeiling {
  const value = parse(PolicyCeilingSchema, input);
  const keys = value.targets.map(delegationCanonicalJson);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)
    || value.ceilingId !== delegationInputDigest({ origin: value.origin, targets: value.targets })) {
    return invalidDelegationData("invalid_ceiling", [], "Policy ceilings require sorted unique exact references and their canonical digest.");
  }
  return value;
}

export function createDelegationPolicyCeiling(input: {
  readonly origin: DelegationParentScope;
  readonly targets: readonly DelegationTargetReference[];
}): DelegationPolicyCeiling {
  const captured = parse(z.strictObject({ origin: ParentScopeSchema, targets: z.array(TargetReferenceSchema).max(1_000) }), input);
  const origin = captured.origin;
  const targets = [...captured.targets].sort((left, right) => {
    const a = delegationCanonicalJson(left), b = delegationCanonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return parseDelegationPolicyCeiling({ origin, targets, ceilingId: delegationInputDigest({ origin, targets }) });
}
