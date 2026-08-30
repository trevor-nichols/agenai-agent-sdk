// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain protocol primitive parsers - Dependencies: protocol schemas
// ------------------------------------------------------------------------------------------------

import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentArtifactIdSchema,
  AgentApprovalOptionIdSchema,
  AgentConfigurationRevisionIdSchema,
  AgentErrorSchema,
  AgentInstanceIdSchema,
  AgentIsoDateTimeSchema,
  AgentItemIdSchema,
  AgentJsonValueSchema,
  AgentProviderConversationIdSchema,
  AgentProviderHistoryAnchorSchema,
  AgentProviderItemRefSchema,
  AgentProviderKeySchema,
  AgentProviderRefsSchema,
  AgentProviderRequestRefSchema,
  AgentProviderTurnRefSchema,
  AgentRequestFieldIdSchema,
  AgentRequestIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
} from '../zod/foundation.js';
import type {
  AgentArtifactId,
  AgentApprovalOptionId,
  AgentConfigurationRevisionId,
  AgentError,
  AgentInstanceId,
  AgentIsoDateTime,
  AgentItemId,
  AgentJsonValue,
  AgentProviderConversationId,
  AgentProviderHistoryAnchor,
  AgentProviderItemRef,
  AgentProviderKey,
  AgentProviderRefs,
  AgentProviderRequestRef,
  AgentProviderTurnRef,
  AgentRequestFieldId,
  AgentRequestId,
  AgentSessionId,
  AgentTurnId,
} from './types.js';
import type { AgentProtocolParseResult } from './validation.js';

// ------------------------------------------------------------------------------------------------
//                ID Parsers
// ------------------------------------------------------------------------------------------------

function idParser<T>(schema: Parameters<typeof parseWithSchema<T>>[0]) {
  return {
    parse: (input: unknown): T => parseWithSchema(schema, input),
    safeParse: (input: unknown): AgentProtocolParseResult<T> =>
      safeParseWithSchema(schema, input),
  };
}

const instanceIdParser = idParser<AgentInstanceId>(AgentInstanceIdSchema);
const sessionIdParser = idParser<AgentSessionId>(AgentSessionIdSchema);
const turnIdParser = idParser<AgentTurnId>(AgentTurnIdSchema);
const itemIdParser = idParser<AgentItemId>(AgentItemIdSchema);
const requestIdParser = idParser<AgentRequestId>(AgentRequestIdSchema);
const approvalOptionIdParser = idParser<AgentApprovalOptionId>(
  AgentApprovalOptionIdSchema,
);
const requestFieldIdParser = idParser<AgentRequestFieldId>(
  AgentRequestFieldIdSchema,
);
const artifactIdParser = idParser<AgentArtifactId>(AgentArtifactIdSchema);
const revisionIdParser = idParser<AgentConfigurationRevisionId>(
  AgentConfigurationRevisionIdSchema,
);
const conversationIdParser = idParser<AgentProviderConversationId>(
  AgentProviderConversationIdSchema,
);
const historyAnchorParser = idParser<AgentProviderHistoryAnchor>(
  AgentProviderHistoryAnchorSchema,
);
const providerTurnRefParser = idParser<AgentProviderTurnRef>(
  AgentProviderTurnRefSchema,
);
const providerItemRefParser = idParser<AgentProviderItemRef>(
  AgentProviderItemRefSchema,
);
const providerRequestRefParser = idParser<AgentProviderRequestRef>(
  AgentProviderRequestRefSchema,
);

export const parseAgentInstanceId = instanceIdParser.parse;
export const safeParseAgentInstanceId = instanceIdParser.safeParse;
export const parseAgentSessionId = sessionIdParser.parse;
export const safeParseAgentSessionId = sessionIdParser.safeParse;
export const parseAgentTurnId = turnIdParser.parse;
export const safeParseAgentTurnId = turnIdParser.safeParse;
export const parseAgentItemId = itemIdParser.parse;
export const safeParseAgentItemId = itemIdParser.safeParse;
export const parseAgentRequestId = requestIdParser.parse;
export const safeParseAgentRequestId = requestIdParser.safeParse;
export const parseAgentApprovalOptionId = approvalOptionIdParser.parse;
export const safeParseAgentApprovalOptionId = approvalOptionIdParser.safeParse;
export const parseAgentRequestFieldId = requestFieldIdParser.parse;
export const safeParseAgentRequestFieldId = requestFieldIdParser.safeParse;
export const parseAgentArtifactId = artifactIdParser.parse;
export const safeParseAgentArtifactId = artifactIdParser.safeParse;
export const parseAgentConfigurationRevisionId = revisionIdParser.parse;
export const safeParseAgentConfigurationRevisionId = revisionIdParser.safeParse;
export const parseAgentProviderConversationId = conversationIdParser.parse;
export const safeParseAgentProviderConversationId = conversationIdParser.safeParse;
export const parseAgentProviderHistoryAnchor = historyAnchorParser.parse;
export const safeParseAgentProviderHistoryAnchor = historyAnchorParser.safeParse;
export const parseAgentProviderTurnRef = providerTurnRefParser.parse;
export const safeParseAgentProviderTurnRef = providerTurnRefParser.safeParse;
export const parseAgentProviderItemRef = providerItemRefParser.parse;
export const safeParseAgentProviderItemRef = providerItemRefParser.safeParse;
export const parseAgentProviderRequestRef = providerRequestRefParser.parse;
export const safeParseAgentProviderRequestRef = providerRequestRefParser.safeParse;

// ------------------------------------------------------------------------------------------------
//                Foundation Parsers
// ------------------------------------------------------------------------------------------------

export function parseAgentProviderKey(input: unknown): AgentProviderKey {
  return parseWithSchema(AgentProviderKeySchema, input);
}

export function safeParseAgentProviderKey(
  input: unknown,
): AgentProtocolParseResult<AgentProviderKey> {
  return safeParseWithSchema(AgentProviderKeySchema, input);
}

export function parseAgentIsoDateTime(input: unknown): AgentIsoDateTime {
  return parseWithSchema(AgentIsoDateTimeSchema, input);
}

export function safeParseAgentIsoDateTime(
  input: unknown,
): AgentProtocolParseResult<AgentIsoDateTime> {
  return safeParseWithSchema(AgentIsoDateTimeSchema, input);
}

export function parseAgentJsonValue(input: unknown): AgentJsonValue {
  return parseWithSchema(AgentJsonValueSchema, input);
}

export function safeParseAgentJsonValue(
  input: unknown,
): AgentProtocolParseResult<AgentJsonValue> {
  return safeParseWithSchema(AgentJsonValueSchema, input);
}

export function parseAgentProviderRefs(input: unknown): AgentProviderRefs {
  return parseWithSchema(AgentProviderRefsSchema, input);
}

export function safeParseAgentProviderRefs(
  input: unknown,
): AgentProtocolParseResult<AgentProviderRefs> {
  return safeParseWithSchema(AgentProviderRefsSchema, input);
}

export function parseAgentError(input: unknown): AgentError {
  return parseWithSchema(AgentErrorSchema, input);
}

export function safeParseAgentError(
  input: unknown,
): AgentProtocolParseResult<AgentError> {
  return safeParseWithSchema(AgentErrorSchema, input);
}
