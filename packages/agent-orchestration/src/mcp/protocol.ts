// ------------------------------------------------------------------------------------------------
//                protocol.ts - Shared runtime tools through bounded MCP results
// ------------------------------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { parseAgentJsonValue, type AgentJsonValue } from "@agen-ai/agent-protocol";
import {
  validateAgentHostToolInvocation, validateAgentHostToolResult,
  type AgentHostToolResult, type AgentSessionHostBinding,
} from "@agen-ai/agent-runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_MAX_INVOCATIONS, MCP_RESPONSE_BYTES } from "./limits.js";

export interface McpProtocolContext {
  readonly binding: AgentSessionHostBinding;
  readonly signal: AbortSignal;
  readonly calls: Set<Promise<AgentHostToolResult>>;
  assertAccepting(): void;
  cancelRequest(requestId: string | number): void;
}

function failure(code: string, message: string): AgentHostToolResult {
  return { kind: "error", error: { code, message, category: "unknown", recovery: { kind: "unknown" } } };
}

function encodeResult(result: AgentHostToolResult): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result }, isError: result.kind === "error" };
}

export function mcpTools(binding: AgentSessionHostBinding): Tool[] {
  const tools: Tool[] = binding.tools.map((tool) => {
    const { required, ...schema } = tool.inputSchema;
    return { name: tool.name, description: tool.description, inputSchema: { ...schema,
      properties: { ...schema.properties }, ...(required ? { required: [...required] } : {}) } };
  });
  const envelope = { jsonrpc: "2.0", id: "preflight", result: { tools } };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MCP_RESPONSE_BYTES) {
    throw new TypeError("The complete MCP tool list exceeds its HTTP response bound.");
  }
  return tools;
}

export function createMcpProtocol(context: McpProtocolContext, tools: Tool[]) {
  const protocol = new Server({ name: "agenai_delegation", version: "0.4.0" }, {
    capabilities: { tools: {} },
    ...(context.binding.instructions ? { instructions: context.binding.instructions.text } : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  protocol.setNotificationHandler(CancelledNotificationSchema, (notification) => {
    if (notification.params.requestId !== undefined) context.cancelRequest(notification.params.requestId);
  });
  protocol.setRequestHandler(ListToolsRequestSchema, () => {
    context.assertAccepting();
    return { tools };
  });
  protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let call: ReturnType<typeof validateAgentHostToolInvocation>;
    try {
      context.assertAccepting();
      const signal = AbortSignal.any([context.signal, extra.signal]);
      signal.throwIfAborted();
      call = validateAgentHostToolInvocation({ binding: context.binding, invocation: {
        invocationId: randomUUID(), toolName: request.params.name,
        arguments: parseAgentJsonValue(request.params.arguments ?? {}) as Record<string, AgentJsonValue>, signal,
      } });
    } catch {
      return encodeResult(failure("invalid_tool_input", "The tool invocation is invalid or unavailable."));
    }
    if (context.calls.size >= MCP_MAX_INVOCATIONS) {
      return encodeResult(failure("host_tool_capacity_exhausted", "The MCP binding has reached its invocation limit."));
    }
    const pending = Promise.resolve().then(async (): Promise<AgentHostToolResult> => {
      try {
        call.signal?.throwIfAborted();
        return validateAgentHostToolResult(await context.binding.invoke(call));
      } catch {
        return failure("host_tool_failed", "The host tool did not return a valid result.");
      }
    }).finally(() => { context.calls.delete(pending); });
    context.calls.add(pending);
    return encodeResult(await pending);
  });
  return { protocol, transport };
}
