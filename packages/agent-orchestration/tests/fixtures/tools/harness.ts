// ------------------------------------------------------------------------------------------------
//                harness.ts - Managed tools invoked through a validated parent session facade
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseAgentSessionId, type AgentJsonValue } from "@agen-ai/agent-protocol";
import type { AgentHostToolResult, AgentProviderSession, AgentSessionHostBinding } from "@agen-ai/agent-runtime";
import { createExecutionHarness } from "../execution/harness.js";

export async function createToolHarness(options: Parameters<typeof createExecutionHarness>[0] = {}) {
  const harness = await createExecutionHarness({ ...options, provider: { ...options.provider,
    transformAdapter(adapter) {
      return { ...(options.provider?.transformAdapter?.(adapter) ?? adapter), hostBinding: {
        kind: "supported", toolTransport: "callback", instructionPlacements: ["system", "developer", "tool_context"],
      } };
    },
  } });
  const parents: AgentProviderSession[] = [];
  async function mount(binding?: AgentSessionHostBinding) {
    const sessionId = parseAgentSessionId(`tools:${randomUUID()}`);
    const adapter = harness.registry.requireInstance(harness.provider.definition.instanceId).adapter;
    const session = await adapter.createSession({ sessionId, workingDirectory: "/host/parent",
      configuration: harness.target.application.configuration, onBindingCreated() {},
      ...(binding === undefined ? {} : { hostBinding: binding }),
    });
    parents.push(session);
    const context = harness.provider.contexts.find((entry) => entry.sessionId === sessionId);
    assert.ok(context);
    return { session, binding: context.hostBinding,
      invoke(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
        assert.ok(context.hostBinding, "An enabled parent must receive a validated host binding.");
        return Promise.resolve().then(() => context.hostBinding!.invoke({ invocationId: randomUUID(), toolName: name,
          arguments: args as Record<string, AgentJsonValue>,
          ...(signal === undefined ? {} : { signal }),
        }));
      },
    };
  }
  return { ...harness, mount, async close() {
    for (const session of parents) await session.close({ reason: "shutdown" });
    return harness.close();
  } };
}

export function toolValue<Value>(result: AgentHostToolResult): Value {
  assert.equal(result.kind, "success", JSON.stringify(result));
  if (result.kind !== "success") throw new Error("Expected a successful tool result.");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1_024, "The entire tool result must fit its transport budget.");
  return result.value as Value;
}

export function assertToolError(result: AgentHostToolResult, code: string) {
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("Expected a structured tool error.");
  assert.equal(result.error.code, code);
  assert.equal(result.error.category, "unknown");
  assert.deepEqual(result.error.recovery, { kind: "unknown" });
}
