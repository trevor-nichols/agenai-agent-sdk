import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentSessionDecisionChoiceIdSchema,
  AgentSessionDecisionRequestSchema,
  AgentSessionDecisionResponseSchema,
} from '../zod/sessionInteractions.js';
import type {
  AgentSessionDecisionChoiceId,
  AgentSessionDecisionRequest,
  AgentSessionDecisionResponse,
} from './types.js';

export function parseAgentSessionDecisionChoiceId(input: unknown): AgentSessionDecisionChoiceId {
  return parseWithSchema(AgentSessionDecisionChoiceIdSchema, input);
}

export function safeParseAgentSessionDecisionChoiceId(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionChoiceId> {
  return safeParseWithSchema(AgentSessionDecisionChoiceIdSchema, input);
}

export function parseAgentSessionDecisionRequest(input: unknown): AgentSessionDecisionRequest {
  return parseWithSchema(AgentSessionDecisionRequestSchema, input);
}

export function safeParseAgentSessionDecisionRequest(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionRequest> {
  return safeParseWithSchema(AgentSessionDecisionRequestSchema, input);
}

export function parseAgentSessionDecisionResponse(input: unknown): AgentSessionDecisionResponse {
  return parseWithSchema(AgentSessionDecisionResponseSchema, input);
}

export function safeParseAgentSessionDecisionResponse(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionResponse> {
  return safeParseWithSchema(AgentSessionDecisionResponseSchema, input);
}

export function parseAgentSessionDecisionResponseFor(
  request: AgentSessionDecisionRequest,
  input: unknown,
): AgentSessionDecisionResponse {
  const parsedRequest = parseAgentSessionDecisionRequest(request);
  const response = parseAgentSessionDecisionResponse(input);
  if (!parsedRequest.choices.some((choice) => choice.choiceId === response.choiceId)) {
    throw new AgentProtocolValidationError([{
      code: 'custom',
      path: ['choiceId'],
      message: 'The response must select a choice offered by this session decision.',
    }]);
  }
  return response;
}
