// ------------------------------------------------------------------------------------------------
//                types.ts - Session-local tool and instruction binding contracts
// ------------------------------------------------------------------------------------------------

import type { AgentError, AgentJsonValue } from "@agen-ai/agent-protocol";
import type { MaybePromise } from "../foundation.js";

export type AgentHostInstructionPlacement = "system" | "developer" | "tool_context";

export type AgentSessionHostBindingSupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      toolTransport: "callback" | "mcp";
      instructionPlacements: readonly AgentHostInstructionPlacement[];
    }>;

interface AgentHostToolSchemaDescription {
  readonly description?: string;
}

export interface AgentHostToolObjectSchema extends AgentHostToolSchemaDescription {
  readonly type: "object";
  readonly properties: Readonly<Record<string, AgentHostToolSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface AgentHostToolInputSchema extends AgentHostToolObjectSchema {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
}

export type AgentHostToolSchema = AgentHostToolSchemaDescription & (
  | AgentHostToolObjectSchema
  | Readonly<{ type: "array"; items: AgentHostToolSchema; minItems?: number; maxItems: number }>
  | Readonly<{ type: "string"; enum?: readonly string[]; minLength?: number; maxLength: number }>
  | Readonly<{ type: "integer" | "number"; minimum?: number; maximum?: number }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{ type: "null" }>
);

export interface AgentHostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentHostToolInputSchema;
}

export type AgentHostToolResult =
  | Readonly<{ kind: "success"; value: AgentJsonValue }>
  | Readonly<{ kind: "error"; error: AgentError }>;

export interface AgentHostToolInvocation {
  readonly invocationId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, AgentJsonValue>>;
  readonly signal?: AbortSignal;
}

export interface AgentSessionHostBinding {
  readonly bindingId: string;
  readonly tools: readonly AgentHostToolDefinition[];
  readonly instructions?: Readonly<{ placement: AgentHostInstructionPlacement; text: string }>;
  readonly invoke: (input: AgentHostToolInvocation) => MaybePromise<AgentHostToolResult>;
  readonly release: () => MaybePromise<void>;
}
