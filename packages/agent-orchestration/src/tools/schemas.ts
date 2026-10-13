// ------------------------------------------------------------------------------------------------
//                schemas.ts - Closed bounded schemas shared by callback and MCP delegation tools
// ------------------------------------------------------------------------------------------------

import type { AgentHostToolDefinition, AgentHostToolInputSchema, AgentHostToolSchema } from "@agen-ai/agent-runtime";
import type { DelegationBindingSnapshot } from "../coordinator/types.js";

export const DELEGATION_TOOL_NAMES = ["delegation_targets", "delegate_task", "task_status", "task_send", "task_cancel"] as const;
export type DelegationToolName = typeof DELEGATION_TOOL_NAMES[number];

const uuid: AgentHostToolSchema = { type: "string", minLength: 36, maxLength: 36,
  description: "A UUID. For operations, choose it once and reuse it only for the exact same action and arguments." };
const revision: AgentHostToolSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const identifier: AgentHostToolSchema = { type: "string", minLength: 1, maxLength: 256 };
const cursor: AgentHostToolSchema = { type: "string", minLength: 1, maxLength: 512 };
const target: AgentHostToolSchema = { type: "object", additionalProperties: false,
  properties: { catalogId: identifier, catalogRevision: revision, targetId: identifier,
    targetRevision: revision, sourceId: identifier, sourceRevision: revision },
  required: ["catalogId", "catalogRevision", "targetId", "targetRevision", "sourceId", "sourceRevision"] };

function schema(properties: Readonly<Record<string, AgentHostToolSchema>>, required: readonly string[] = []): AgentHostToolInputSchema {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required, additionalProperties: false };
}

export function delegationToolDefinitions(snapshot: DelegationBindingSnapshot): readonly AgentHostToolDefinition[] {
  const text: AgentHostToolSchema = { type: "string", minLength: 1, maxLength: snapshot.limits.maxInputTextCharacters,
    description: "Plain text, at most 16 KiB UTF-8 per field. Combined task content must fit the configured input byte and character limits." };
  const limit: AgentHostToolSchema = { type: "integer", minimum: 1, maximum: snapshot.limits.maxPageRecords };
  return [
    { name: "delegation_targets", description: "List currently permitted managed targets and the policy revision. An emptyReason distinguishes delegation_disabled from no_permitted_targets. Follow the returned cursor for more choices; preserve the exact target reference for admission.",
      inputSchema: schema({ cursor, limit }) },
    { name: "delegate_task", description: "Admit one managed child task using an exact listed target and current policy revision. A queued receipt is admission only. Supply a stable UUID operationId; identical retries never create another task.",
      inputSchema: schema({ operationId: uuid, target, expectedPolicyRevision: revision, prompt: text, context: text,
        completionPolicy: { type: "string", enum: snapshot.completionPolicies, maxLength: 9 },
        timeoutMs: { type: "integer", minimum: 1, maximum: snapshot.limits.runTimeoutMs } },
      ["operationId", "target", "expectedPolicyRevision", "prompt"]) },
    { name: "task_status", description: "Inspect bounded managed run history and results. Optionally wait for a bounded interval; a wait timeout does not cancel work. Follow runs.cursor without discarding earlier run outcomes. Waiting approval or elicitation belongs to the host.",
      inputSchema: schema({ taskId: uuid, runsCursor: cursor, limit,
        waitMs: { type: "integer", minimum: 0, maximum: snapshot.limits.maxWaitMs } }, ["taskId"]) },
    { name: "task_send", description: "Send explicit steer, next_turn, or follow_up input with a stable UUID operationId. Steer never falls back to a queue. next_turn reserves a later run; follow_up requires a safe settled continuation. delivery_uncertain requires inspection, not automatic replay.",
      inputSchema: schema({ operationId: uuid, taskId: uuid,
        mode: { type: "string", enum: ["steer", "next_turn", "follow_up"], maxLength: 9 },
        target, expectedPolicyRevision: revision, message: text, context: text },
      ["operationId", "taskId", "mode", "target", "expectedPolicyRevision", "message"]) },
    { name: "task_cancel", description: "Request cancellation using a stable UUID operationId. requested does not mean stopped; inspect until confirmed or recovery_required. Retry the canonical accepted operation ID. Cancellation remains available after managed delegation is disabled.",
      inputSchema: schema({ operationId: uuid, taskId: uuid }, ["operationId", "taskId"]) },
  ];
}
