// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain session parsers - Dependencies: session schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentSessionBindingSchema,
  AgentSessionConfigurationSchema,
  AgentSessionOpenInputSchema,
} from '../zod/sessions.js';
import type {
  AgentSessionBinding,
  AgentSessionConfiguration,
  AgentSessionOpenInput,
} from './types.js';

export function parseAgentSessionBinding(input: unknown): AgentSessionBinding {
  return parseWithSchema(AgentSessionBindingSchema, input);
}

export function safeParseAgentSessionBinding(
  input: unknown,
): AgentProtocolParseResult<AgentSessionBinding> {
  return safeParseWithSchema(AgentSessionBindingSchema, input);
}

export function parseAgentSessionConfiguration(
  input: unknown,
): AgentSessionConfiguration {
  return parseWithSchema(AgentSessionConfigurationSchema, input);
}

export function safeParseAgentSessionConfiguration(
  input: unknown,
): AgentProtocolParseResult<AgentSessionConfiguration> {
  return safeParseWithSchema(AgentSessionConfigurationSchema, input);
}

export function parseAgentSessionOpenInput(
  input: unknown,
): AgentSessionOpenInput {
  return parseWithSchema(AgentSessionOpenInputSchema, input);
}

export function safeParseAgentSessionOpenInput(
  input: unknown,
): AgentProtocolParseResult<AgentSessionOpenInput> {
  return safeParseWithSchema(AgentSessionOpenInputSchema, input);
}

export function matchesAgentSessionBinding(
  actual: unknown,
  expected: unknown,
): boolean {
  const parsedActual = safeParseAgentSessionBinding(actual);
  const parsedExpected = safeParseAgentSessionBinding(expected);
  return parsedActual.success
    && parsedExpected.success
    && parsedActual.data.conversationId === parsedExpected.data.conversationId
    && parsedActual.data.historyAnchor === parsedExpected.data.historyAnchor;
}
