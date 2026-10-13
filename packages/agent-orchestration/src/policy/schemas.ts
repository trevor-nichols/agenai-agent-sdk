// ------------------------------------------------------------------------------------------------
//                schemas.ts - Bounded exclusions and normalized selection defaults
// ------------------------------------------------------------------------------------------------

import { AgentProviderKeySchema } from "@agen-ai/agent-protocol/zod";
import { z } from "zod/v4";
import { TargetOptionSchema } from "../catalog/schemas.js";
import { DELEGATION_ENTRIES } from "../shared/bounds.js";
import { CanonicalIdSchema, ExecutionModeSchema, ReasoningSchema, RevisionSchema, requireUniqueValues } from "../shared/schemas.js";
import type { DelegationPolicySnapshot, DelegationTargetIdentity } from "./types.js";

export function targetIdentityKey(identity: DelegationTargetIdentity): string {
  return JSON.stringify([identity.catalogId, identity.targetId]);
}

const exclusion = z.strictObject({
  exclusionId: CanonicalIdSchema,
  providerKey: AgentProviderKeySchema.optional(),
  modelId: CanonicalIdSchema.optional(),
  targetId: CanonicalIdSchema.optional(),
  catalogId: CanonicalIdSchema.optional(),
  reasoning: ReasoningSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  options: z.array(TargetOptionSchema).min(1).max(100).optional(),
}).superRefine((value, context) => {
  if ([value.providerKey, value.modelId, value.targetId, value.catalogId, value.reasoning, value.executionMode, value.options].every((criterion) => criterion === undefined)) {
    context.addIssue({ code: "custom", path: [], message: "A developer exclusion requires at least one criterion." });
  }
  if ((value.modelId !== undefined || value.options !== undefined) && value.providerKey === undefined) {
    context.addIssue({ code: "custom", path: ["providerKey"], message: "Model and native option exclusions require a provider identity." });
  }
  if ((value.targetId === undefined) !== (value.catalogId === undefined)) {
    context.addIssue({ code: "custom", path: ["targetId"], message: "Exact target exclusions require both catalog and target identities." });
  }
  if (value.options) requireUniqueValues(value.options.map((option) => option.key), context, ["options"]);
});

const developer = z.strictObject({
  enabled: z.boolean().default(true),
  exclusions: z.array(exclusion).max(DELEGATION_ENTRIES).default([]),
}).superRefine((value, context) => {
  requireUniqueValues(value.exclusions.map((entry) => entry.exclusionId), context, ["exclusions"]);
});
const identity = z.strictObject({ catalogId: CanonicalIdSchema, targetId: CanonicalIdSchema });
const identities = z.array(identity).max(DELEGATION_ENTRIES).superRefine((value, context) => {
  requireUniqueValues(value.map(targetIdentityKey), context, []);
});
const selection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all_available"), includeFast: z.boolean(), unknownModeTargets: identities }),
  z.strictObject({ kind: z.literal("explicit"), targets: identities }),
]);
const user = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    selection: selection.default({ kind: "all_available", includeFast: false, unknownModeTargets: [] }),
  }),
]);

export const PolicySnapshotSchema: z.ZodType<DelegationPolicySnapshot> = z.strictObject({
  revision: RevisionSchema,
  developer: developer.default({ enabled: true, exclusions: [] }),
  user: user.default({ enabled: false }),
});
