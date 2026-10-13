// ------------------------------------------------------------------------------------------------
//                schemas.ts - Certified target structure and cross-reference validation
// ------------------------------------------------------------------------------------------------

import { AGENT_CONFIGURATION_FIELDS_MAX_LENGTH, agentProtocolSerializedJsonBytes } from "@agen-ai/agent-protocol";
import {
  AgentConfigurationSelectionInputSchema,
  AgentInstanceIdSchema,
  AgentProviderKeySchema,
  AgentSessionConfigurationSchema,
} from "@agen-ai/agent-protocol/zod";
import { z } from "zod/v4";
import { DELEGATION_ENTRIES, DELEGATION_TARGET_BYTES } from "../shared/bounds.js";
import { CanonicalIdSchema, ExecutionModeSchema, ReasoningSchema, ReasonTextSchema, RevisionSchema, requireUniqueValues } from "../shared/schemas.js";
import type { DelegationTargetCatalog } from "./types.js";

export const TargetOptionSchema = z.strictObject({ key: CanonicalIdSchema, optionId: CanonicalIdSchema });
const reference = z.strictObject({
  catalogId: CanonicalIdSchema, catalogRevision: RevisionSchema,
  targetId: CanonicalIdSchema, targetRevision: RevisionSchema,
  sourceId: CanonicalIdSchema, sourceRevision: RevisionSchema,
});
const target = z.strictObject({
  reference,
  instanceId: AgentInstanceIdSchema,
  providerKey: AgentProviderKeySchema,
  modelId: CanonicalIdSchema,
  label: CanonicalIdSchema.max(200),
  options: z.array(TargetOptionSchema).max(100),
  reasoning: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("certified"), value: ReasoningSchema }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  executionMode: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("certified"), value: ExecutionModeSchema }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  certification: z.strictObject({ mappingId: CanonicalIdSchema, mappingRevision: RevisionSchema }),
  availability: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("available") }),
    z.strictObject({ kind: z.literal("unavailable"), code: CanonicalIdSchema, reason: ReasonTextSchema }),
  ]),
  limitations: z.array(ReasonTextSchema).max(10),
  application: z.strictObject({
    configuration: AgentSessionConfigurationSchema,
    beforeFirstTurn: z.array(AgentConfigurationSelectionInputSchema).max(AGENT_CONFIGURATION_FIELDS_MAX_LENGTH),
  }),
}).superRefine((value, context) => {
  requireUniqueValues(value.options.map((option) => option.key), context, ["options"]);
  if (value.application.configuration.kind === "managed" && value.application.beforeFirstTurn.length > 0) {
    context.addIssue({ code: "custom", path: ["application", "beforeFirstTurn"], message: "Managed configurations cannot apply selectable session fields." });
  }
  if (value.executionMode.kind === "unknown" && value.limitations.length === 0) {
    context.addIssue({ code: "custom", path: ["limitations"], message: "Unknown execution mode requires an explicit limitation." });
  }
  if (agentProtocolSerializedJsonBytes(value) > DELEGATION_TARGET_BYTES) {
    context.addIssue({ code: "custom", path: [], message: "Delegation target exceeds 32 KiB of serialized JSON." });
  }
});

export const TargetCatalogSchema: z.ZodType<DelegationTargetCatalog> = z.strictObject({
  catalogId: CanonicalIdSchema,
  revision: RevisionSchema,
  targets: z.array(target).max(DELEGATION_ENTRIES),
}).superRefine((catalog, context) => {
  requireUniqueValues(catalog.targets.map((entry) => entry.reference.targetId), context, ["targets"]);
  const sources = new Map<string, number>();
  for (const [index, entry] of catalog.targets.entries()) {
    if (entry.reference.catalogId !== catalog.catalogId || entry.reference.catalogRevision !== catalog.revision) {
      context.addIssue({ code: "custom", path: ["targets", index, "reference"], message: "Target reference must identify this exact catalog revision." });
    }
    const prior = sources.get(entry.reference.sourceId);
    if (prior !== undefined && prior !== entry.reference.sourceRevision) {
      context.addIssue({ code: "custom", path: ["targets", index, "reference", "sourceRevision"], message: "Targets from the same source must share its current revision." });
    }
    sources.set(entry.reference.sourceId, entry.reference.sourceRevision);
  }
});
