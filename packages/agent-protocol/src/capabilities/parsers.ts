// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain capability parsers - Dependencies: capability schema
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentCapabilitiesSchema } from '../zod/capabilities.js';
import type { AgentCapabilities } from './types.js';

export function parseAgentCapabilities(input: unknown): AgentCapabilities {
  return parseWithSchema(AgentCapabilitiesSchema, input);
}

export function safeParseAgentCapabilities(
  input: unknown,
): AgentProtocolParseResult<AgentCapabilities> {
  return safeParseWithSchema(AgentCapabilitiesSchema, input);
}

export function matchesAgentCapabilities(
  actual: unknown,
  expected: unknown,
): boolean {
  const parsedActual = safeParseAgentCapabilities(actual);
  const parsedExpected = safeParseAgentCapabilities(expected);
  return parsedActual.success
    && parsedExpected.success
    && JSON.stringify(parsedActual.data) === JSON.stringify(parsedExpected.data);
}
