// ------------------------------------------------------------------------------------------------
//                handlers.ts - Shared scoped delegation actions for callback and MCP transports
// ------------------------------------------------------------------------------------------------

import { AGENT_PROTOCOL_TEXT_MAX_LENGTH, type AgentTurnInputContent } from "@agen-ai/agent-protocol";
import type { AgentHostToolInvocation } from "@agen-ai/agent-runtime";
import type { DelegationTargetReference } from "../catalog/types.js";
import type { DelegationBindingSnapshot, DelegationClient } from "../coordinator/types.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationCompletionPolicy } from "../tasks/types.js";
import { projectTargetPage, projectTaskPage } from "./projection.js";

interface PageInput { readonly cursor?: string; readonly limit?: number }
interface TaskInput { readonly taskId: string; readonly runsCursor?: string; readonly limit?: number; readonly waitMs?: number }
interface OperationInput { readonly operationId: string; readonly target: DelegationTargetReference; readonly expectedPolicyRevision: number; readonly context?: string }
interface SpawnInput extends OperationInput { readonly prompt: string; readonly completionPolicy?: DelegationCompletionPolicy; readonly timeoutMs?: number }
interface SendInput extends OperationInput { readonly taskId: string; readonly mode: "steer" | "next_turn" | "follow_up"; readonly message: string }
interface CancelInput { readonly operationId: string; readonly taskId: string }

function taskContent(text: string, context: string | undefined): AgentTurnInputContent {
  for (const field of [text, ...(context === undefined ? [] : [context])]) {
    if (new TextEncoder().encode(field).byteLength > 16_384) {
      failDelegation("capacity_exceeded", "A task text field exceeds its UTF-8 byte limit.");
    }
  }
  const contents = context === undefined ? text : `${text}\n\nContext:\n${context}`;
  const parts: { type: "text"; text: string }[] = [];
  let position = 0;
  while (position < contents.length) {
    let end = Math.min(position + AGENT_PROTOCOL_TEXT_MAX_LENGTH, contents.length);
    if (end < contents.length && /[\uD800-\uDBFF]/u.test(contents[end - 1]!)) end--;
    parts.push({ type: "text", text: contents.slice(position, end) });
    position = end;
  }
  return { parts };
}

export async function handleDelegationTool(client: DelegationClient, snapshot: DelegationBindingSnapshot,
  invocation: AgentHostToolInvocation): Promise<unknown> {
  const args = invocation.arguments;
  invocation.signal?.throwIfAborted();
  switch (invocation.toolName) {
    case "delegation_targets": {
      const input = args as unknown as PageInput;
      return projectTargetPage(client, { ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit ?? Math.min(20, snapshot.limits.maxPageRecords) });
    }
    case "delegate_task": {
      const input = args as unknown as SpawnInput;
      return client.spawn({ operationId: input.operationId, target: input.target,
        expectedPolicyRevision: input.expectedPolicyRevision, input: taskContent(input.prompt, input.context),
        ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    }
    case "task_status": {
      const input = args as unknown as TaskInput;
      let waitStatus: "settled" | "timeout" | undefined;
      if (input.waitMs !== undefined && input.waitMs > 0) {
        waitStatus = (await client.wait({ taskId: input.taskId, timeoutMs: input.waitMs,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) })).status;
        invocation.signal?.throwIfAborted();
      }
      return projectTaskPage(client, { taskId: input.taskId,
        ...(input.runsCursor === undefined ? {} : { runsCursor: input.runsCursor }),
        limit: input.limit ?? Math.min(20, snapshot.limits.maxPageRecords) }, waitStatus);
    }
    case "task_send": {
      const input = args as unknown as SendInput;
      return client.send({ operationId: input.operationId, taskId: input.taskId, mode: input.mode,
        target: input.target, expectedPolicyRevision: input.expectedPolicyRevision, input: taskContent(input.message, input.context) });
    }
    case "task_cancel": {
      const input = args as unknown as CancelInput;
      return client.cancel({ operationId: input.operationId, taskId: input.taskId });
    }
    default: return failDelegation("unsupported_operation", "The managed tool is unavailable.");
  }
}
