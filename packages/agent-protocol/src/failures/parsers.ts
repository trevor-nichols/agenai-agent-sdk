// ------------------------------------------------------------------------------------------------
//                parsers.ts - Validator-neutral operational failure parsers
// ------------------------------------------------------------------------------------------------

import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentErrorSchema } from '../zod/failures.js';
import type { AgentProtocolParseResult } from '../foundation/validation.js';
import type { AgentError } from './types.js';

export function parseAgentError(input: unknown): AgentError {
  return parseWithSchema(AgentErrorSchema, input);
}

export function safeParseAgentError(
  input: unknown,
): AgentProtocolParseResult<AgentError> {
  return safeParseWithSchema(AgentErrorSchema, input);
}
