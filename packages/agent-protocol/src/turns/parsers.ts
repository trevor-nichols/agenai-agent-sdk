// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain turn parsers - Dependencies: turn schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentItemSnapshotSchema,
  AgentContentReferenceInputPartSchema,
  AgentTurnInputContentSchema,
  AgentTurnInterruptionInputSchema,
  AgentTurnRunInputSchema,
} from '../zod/turns.js';
import type {
  AgentItemSnapshot,
  AgentContentReferenceInputPart,
  AgentTurnInputContent,
  AgentTurnInterruptionInput,
  AgentTurnRunInput,
} from './types.js';

export function parseAgentTurnInputContent(
  input: unknown,
): AgentTurnInputContent {
  return parseWithSchema(AgentTurnInputContentSchema, input);
}

export function safeParseAgentTurnInputContent(
  input: unknown,
): AgentProtocolParseResult<AgentTurnInputContent> {
  return safeParseWithSchema(AgentTurnInputContentSchema, input);
}

export function parseAgentTurnRunInput(input: unknown): AgentTurnRunInput {
  return parseWithSchema(AgentTurnRunInputSchema, input);
}

export function safeParseAgentTurnRunInput(
  input: unknown,
): AgentProtocolParseResult<AgentTurnRunInput> {
  return safeParseWithSchema(AgentTurnRunInputSchema, input);
}

export function parseAgentTurnInterruptionInput(
  input: unknown,
): AgentTurnInterruptionInput {
  return parseWithSchema(AgentTurnInterruptionInputSchema, input);
}

export function safeParseAgentTurnInterruptionInput(
  input: unknown,
): AgentProtocolParseResult<AgentTurnInterruptionInput> {
  return safeParseWithSchema(AgentTurnInterruptionInputSchema, input);
}

export function parseAgentItemSnapshot(input: unknown): AgentItemSnapshot {
  return parseWithSchema(AgentItemSnapshotSchema, input);
}

export function safeParseAgentItemSnapshot(
  input: unknown,
): AgentProtocolParseResult<AgentItemSnapshot> {
  return safeParseWithSchema(AgentItemSnapshotSchema, input);
}

export function parseAgentContentReferenceInputPart(input: unknown): AgentContentReferenceInputPart {
  return parseWithSchema(AgentContentReferenceInputPartSchema, input);
}

export function safeParseAgentContentReferenceInputPart(input: unknown): AgentProtocolParseResult<AgentContentReferenceInputPart> {
  return safeParseWithSchema(AgentContentReferenceInputPartSchema, input);
}
