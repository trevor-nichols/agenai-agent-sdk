// ------------------------------------------------------------------------------------------------
//                create.ts - Owned session-local delegation callbacks without child lifetime coupling
// ------------------------------------------------------------------------------------------------

import {
  validateAgentHostToolInvocation, validateAgentHostToolResult, validateAgentSessionHostBinding,
  type AgentHostToolInvocation, type AgentHostToolResult, type AgentSessionHostBinding,
} from "@agen-ai/agent-runtime";
import { createDelegationId } from "../shared/identity.js";
import { delegationToolError, sanitizeDelegationToolError } from "./errors.js";
import { delegationGuidance, validateNativeToolNames } from "./guidance.js";
import { handleDelegationTool } from "./handlers.js";
import { delegationToolDefinitions } from "./schemas.js";
import type { CreateDelegationHostBindingOptions } from "./types.js";

export async function createDelegationHostBinding(options: CreateDelegationHostBindingOptions): Promise<AgentSessionHostBinding | undefined> {
  const client = options.client;
  const snapshot = await client.bindingSnapshot();
  if (!snapshot.enabled) return undefined;
  const nativeTools = validateNativeToolNames(options.nativeToolNames);
  const lifetime = new AbortController();
  const active = new Map<string, Promise<AgentHostToolResult>>();
  let releasePromise: Promise<void> | undefined;

  const invoke = (raw: AgentHostToolInvocation): Promise<AgentHostToolResult> => {
    if (lifetime.signal.aborted) return Promise.resolve(delegationToolError("tool_unavailable", "This managed tool binding has been released."));
    let invocation: AgentHostToolInvocation;
    try { invocation = validateAgentHostToolInvocation({ binding, invocation: raw }); }
    catch { return Promise.resolve(delegationToolError("invalid_tool_input", "The managed tool invocation or arguments are invalid.")); }
    if (invocation.signal?.aborted) return Promise.resolve(delegationToolError("operation_aborted", "The tool invocation was canceled before dispatch."));
    if (active.has(invocation.invocationId)) return Promise.resolve(delegationToolError("invalid_tool_input", "This tool invocation ID is already active."));
    if (active.size >= 16) return Promise.resolve(delegationToolError("capacity_exceeded", "This managed binding has reached its callback limit."));
    const signal = invocation.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, invocation.signal]);
    const work = Promise.resolve().then(async (): Promise<AgentHostToolResult> => {
      let value: unknown;
      try {
        value = await handleDelegationTool(client, snapshot, { ...invocation, signal });
      } catch (error) {
        if (signal.aborted && error === signal.reason) {
          return delegationToolError("operation_aborted", "The tool invocation was canceled. Any admitted child work remains independent.");
        }
        return sanitizeDelegationToolError(error);
      }
      try { return validateAgentHostToolResult({ kind: "success", value }); }
      catch { return delegationToolError("internal_error", "The managed action did not produce a portable result. Inspect retained state before retrying."); }
    }).finally(() => { active.delete(invocation.invocationId); });
    active.set(invocation.invocationId, work);
    return work;
  };

  const binding = validateAgentSessionHostBinding({ binding: {
    bindingId: options.bindingId ?? createDelegationId(), tools: delegationToolDefinitions(snapshot),
    instructions: { placement: options.instructionPlacement ?? "tool_context", text: delegationGuidance(snapshot, nativeTools) },
    invoke,
    release() {
      if (!releasePromise) {
        lifetime.abort(new DOMException("The managed tool binding was released.", "AbortError"));
        releasePromise = Promise.allSettled(active.values()).then(() => undefined);
      }
      return releasePromise;
    },
  }, support: { kind: "supported", toolTransport: "callback", instructionPlacements: ["system", "developer", "tool_context"] } });
  return binding;
}
