// ------------------------------------------------------------------------------------------------
//                mcp.ts - Real SDK client connections and neutral result decoding
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import type { AgentHostToolResult, AgentSessionHostBinding } from "@agen-ai/agent-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startDelegationMcpBridge, type DelegationMcpServerDefinition, type StartDelegationMcpBridgeOptions } from "../../../src/mcp/index.js";

export function mcpResult(result: Pick<CallToolResult, "content" | "structuredContent" | "isError">): AgentHostToolResult {
  assert.equal(result.content.length, 1);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  if (text?.type !== "text") throw new Error("Expected a neutral JSON text envelope.");
  const envelope = JSON.parse(text.text) as AgentHostToolResult;
  assert.deepEqual(result.structuredContent, envelope);
  assert.equal(result.isError, envelope.kind === "error");
  assert.ok(Buffer.byteLength(text.text) < 32 * 1_024);
  return envelope;
}

export async function connectMcpClient(server: DelegationMcpServerDefinition) {
  const client = new Client({ name: "delegation-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  try { await client.connect(transport); }
  catch (error) { await client.close(); throw error; }
  return { client, transport,
    async call(name: string, args: Record<string, unknown>) { return mcpResult(CallToolResultSchema.parse(await client.callTool({ name, arguments: args }))); },
    close: () => client.close(),
  };
}

export async function connectMcp(binding: AgentSessionHostBinding, options: Omit<StartDelegationMcpBridgeOptions, "binding"> = {}) {
  const bridge = await startDelegationMcpBridge({ ...options, binding });
  try {
    const connection = await connectMcpClient(bridge.server);
    return { ...connection, bridge, async close() { await connection.close(); await bridge.release(); } };
  } catch (error) { await bridge.release(); throw error; }
}
