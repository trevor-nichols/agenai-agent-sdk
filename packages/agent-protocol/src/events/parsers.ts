// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain event parsers - Dependencies: event schema
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentEventSchema } from '../zod/events.js';
import type { AgentEvent } from './types.js';

export function parseAgentEvent(input: unknown): AgentEvent {
  return parseWithSchema(AgentEventSchema, input);
}

export function safeParseAgentEvent(
  input: unknown,
): AgentProtocolParseResult<AgentEvent> {
  return safeParseWithSchema(AgentEventSchema, input);
}

export function createAgentEvent(input: AgentEvent): AgentEvent {
  return parseAgentEvent(input);
}
