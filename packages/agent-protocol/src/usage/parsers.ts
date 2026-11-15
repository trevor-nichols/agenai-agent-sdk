// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain token-usage parsers - Dependencies: usage and event schemas
// ------------------------------------------------------------------------------------------------

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/index.js';
import type { AgentUsageObservedEvent } from '../events/types.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentEventSchema } from '../zod/events.js';
import {
  AgentTokenCountSchema,
  AgentTokenUsageCapabilitySchema,
  AgentTokenUsageObservationSchema,
} from '../zod/usage.js';
import type {
  AgentTokenCount,
  AgentTokenUsageCapability,
  AgentTokenUsageObservation,
} from './types.js';

export function parseAgentTokenCount(input: unknown): AgentTokenCount {
  return parseWithSchema(AgentTokenCountSchema, input);
}

export function safeParseAgentTokenCount(input: unknown): AgentProtocolParseResult<AgentTokenCount> {
  return safeParseWithSchema(AgentTokenCountSchema, input);
}

export function parseAgentTokenUsageObservation(input: unknown): AgentTokenUsageObservation {
  return parseWithSchema(AgentTokenUsageObservationSchema, input);
}

export function safeParseAgentTokenUsageObservation(
  input: unknown,
): AgentProtocolParseResult<AgentTokenUsageObservation> {
  return safeParseWithSchema(AgentTokenUsageObservationSchema, input);
}

export function parseAgentTokenUsageCapability(input: unknown): AgentTokenUsageCapability {
  return parseWithSchema(AgentTokenUsageCapabilitySchema, input);
}

export function safeParseAgentTokenUsageCapability(
  input: unknown,
): AgentProtocolParseResult<AgentTokenUsageCapability> {
  return safeParseWithSchema(AgentTokenUsageCapabilitySchema, input);
}

export function safeParseAgentUsageObservedEvent(
  input: unknown,
): AgentProtocolParseResult<AgentUsageObservedEvent> {
  const parsed = safeParseWithSchema(AgentEventSchema, input);
  if (!parsed.success) return parsed;
  if (parsed.data.type === 'usage.observed') return { success: true, data: parsed.data };
  return {
    success: false,
    issues: [{
      code: 'invalid_value',
      path: ['type'],
      message: 'Expected a usage.observed event.',
    }],
  };
}

export function parseAgentUsageObservedEvent(input: unknown): AgentUsageObservedEvent {
  const parsed = safeParseAgentUsageObservedEvent(input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
