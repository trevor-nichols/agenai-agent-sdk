// ------------------------------------------------------------------------------------------------
//                validation.ts - Host binding metadata and result validation
// ------------------------------------------------------------------------------------------------

import { agentProtocolSerializedJsonBytes, parseAgentError, parseAgentJsonValue, type AgentJsonValue } from "@agen-ai/agent-protocol";
import { parseAgentBoundedText, parseAgentProviderTechnicalId } from "../foundation.js";
import { dataArray, dataRecord, exactKeys, matchesAgentHostToolSchema, parseAgentHostToolInputSchema } from "./schema.js";
import type { AgentHostInstructionPlacement, AgentHostToolInvocation, AgentHostToolResult, AgentSessionHostBinding, AgentSessionHostBindingSupport } from "./types.js";

const placements: readonly AgentHostInstructionPlacement[] = ["system", "developer", "tool_context"];

export function validateAgentSessionHostBindingSupport(value: unknown): AgentSessionHostBindingSupport {
  if (value === undefined) return Object.freeze({ kind: "unsupported" });
  const source = dataRecord(value);
  if (source.kind === "unsupported") {
    exactKeys(source, ["kind"]);
    return Object.freeze({ kind: "unsupported" });
  }
  exactKeys(source, ["kind", "toolTransport", "instructionPlacements"], ["kind", "toolTransport", "instructionPlacements"]);
  const instructions = dataArray(source.instructionPlacements, 3);
  if (source.kind !== "supported" || !["callback", "mcp"].includes(source.toolTransport as string)
    || new Set(instructions).size !== instructions.length
    || instructions.some((placement) => !placements.includes(placement as AgentHostInstructionPlacement))) {
    throw new TypeError("Host binding support has an invalid declaration.");
  }
  return Object.freeze({ kind: "supported", toolTransport: source.toolTransport as "callback" | "mcp",
    instructionPlacements: Object.freeze([...instructions]) as readonly AgentHostInstructionPlacement[] });
}

export function hostBindingEnvelope(value: unknown): AgentSessionHostBinding {
  const source = dataRecord(value);
  parseAgentProviderTechnicalId(source.bindingId, "host binding ID");
  if (typeof source.invoke !== "function" || typeof source.release !== "function") {
    throw new TypeError("Host bindings require invocation and release callbacks.");
  }
  return value as AgentSessionHostBinding;
}

export function validateAgentSessionHostBinding(input: Readonly<{
  binding: AgentSessionHostBinding;
  support: AgentSessionHostBindingSupport;
}>): AgentSessionHostBinding {
  const binding = hostBindingEnvelope(input.binding);
  const source = dataRecord(binding);
  exactKeys(source, ["bindingId", "tools", "instructions", "invoke", "release"], ["bindingId", "tools", "invoke", "release"]);
  const support = validateAgentSessionHostBindingSupport(input.support);
  if (support.kind === "unsupported") throw new TypeError("Session host bindings are unsupported.");
  const names = new Set<string>();
  const tools = dataArray(source.tools, 32).map((value) => {
    const tool = dataRecord(value);
    exactKeys(tool, ["name", "description", "inputSchema"], ["name", "description", "inputSchema"]);
    if (typeof tool.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(tool.name) || names.has(tool.name)) {
      throw new TypeError("Tool names must be unique canonical identifiers.");
    }
    names.add(tool.name);
    return Object.freeze({ name: tool.name,
      description: parseAgentBoundedText(tool.description, "tool description", 2_000),
      inputSchema: parseAgentHostToolInputSchema(tool.inputSchema) });
  });
  if (tools.length === 0) throw new TypeError("Host bindings require at least one tool.");
  let instructions: AgentSessionHostBinding["instructions"];
  if (source.instructions !== undefined) {
    const instruction = dataRecord(source.instructions);
    exactKeys(instruction, ["placement", "text"], ["placement", "text"]);
    if (!support.instructionPlacements.includes(instruction.placement as AgentHostInstructionPlacement)) {
      throw new TypeError("Host instruction placement is unsupported.");
    }
    const text = parseAgentBoundedText(instruction.text, "host instructions", 16_000);
    if (new TextEncoder().encode(text).byteLength > 16_384) throw new TypeError("Host instructions exceed 16 KiB.");
    instructions = Object.freeze({ placement: instruction.placement as AgentHostInstructionPlacement, text });
  }
  const metadata = { bindingId: binding.bindingId, tools: Object.freeze(tools),
    ...(instructions === undefined ? {} : { instructions }) };
  if (agentProtocolSerializedJsonBytes(metadata) > 65_536) {
    throw new TypeError("Host binding metadata exceeds 64 KiB.");
  }
  return Object.freeze({ ...metadata, invoke: binding.invoke.bind(binding), release: binding.release.bind(binding) });
}

/** Validate transport data against an already validated binding without claiming its lifetime. */
export function validateAgentHostToolInvocation(input: Readonly<{
  binding: Pick<AgentSessionHostBinding, "tools">;
  invocation: AgentHostToolInvocation;
}>): AgentHostToolInvocation {
  const call = dataRecord(input.invocation);
  exactKeys(call, ["invocationId", "toolName", "arguments", "signal"], ["invocationId", "toolName", "arguments"]);
  if (call.signal !== undefined && !(call.signal instanceof AbortSignal)) throw new TypeError("Tool cancellation requires an AbortSignal.");
  const invocationId = parseAgentProviderTechnicalId(call.invocationId, "host tool invocation ID");
  const tool = input.binding.tools.find((entry) => entry.name === call.toolName);
  const args = parseAgentJsonValue(call.arguments);
  if (!tool || !matchesAgentHostToolSchema(tool.inputSchema, args)) throw new TypeError("Tool arguments do not match its schema.");
  return Object.freeze({ invocationId, toolName: tool.name,
    arguments: args as Readonly<Record<string, AgentJsonValue>>,
    ...(call.signal === undefined ? {} : { signal: call.signal }) });
}

export function validateAgentHostToolResult(value: unknown): AgentHostToolResult {
  const parsed = parseAgentJsonValue(value);
  const source = dataRecord(parsed);
  if (source.kind === "success") {
    exactKeys(source, ["kind", "value"], ["kind", "value"]);
    return Object.freeze({ kind: "success", value: source.value as AgentJsonValue });
  }
  if (source.kind === "error") {
    exactKeys(source, ["kind", "error"], ["kind", "error"]);
    return Object.freeze({ kind: "error", error: parseAgentError(source.error) });
  }
  throw new TypeError("Host tool results require success or error disposition.");
}
