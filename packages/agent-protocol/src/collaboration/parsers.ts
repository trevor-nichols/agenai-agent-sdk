// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain collaboration parsers - Dependencies: collaboration schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentCollaborationControlInputSchema,
  AgentCollaborationNodeSchema,
  AgentCollaborationSpawnInputSchema,
} from '../zod/collaboration.js';
import type {
  AgentCollaborationControlInput,
  AgentCollaborationNode,
  AgentCollaborationSpawnInput,
} from './types.js';

export function parseAgentCollaborationNode(input: unknown): AgentCollaborationNode {
  return parseWithSchema(AgentCollaborationNodeSchema, input);
}

export function safeParseAgentCollaborationNode(
  input: unknown,
): AgentProtocolParseResult<AgentCollaborationNode> {
  return safeParseWithSchema(AgentCollaborationNodeSchema, input);
}

export function parseAgentCollaborationSpawnInput(
  input: unknown,
): AgentCollaborationSpawnInput {
  return parseWithSchema(AgentCollaborationSpawnInputSchema, input);
}

export function safeParseAgentCollaborationSpawnInput(
  input: unknown,
): AgentProtocolParseResult<AgentCollaborationSpawnInput> {
  return safeParseWithSchema(AgentCollaborationSpawnInputSchema, input);
}

export function parseAgentCollaborationControlInput(
  input: unknown,
): AgentCollaborationControlInput {
  return parseWithSchema(AgentCollaborationControlInputSchema, input);
}

export function safeParseAgentCollaborationControlInput(
  input: unknown,
): AgentProtocolParseResult<AgentCollaborationControlInput> {
  return safeParseWithSchema(AgentCollaborationControlInputSchema, input);
}
