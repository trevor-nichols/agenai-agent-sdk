// ------------------------------------------------------------------------------------------------
//                sessions.ts - Session schemas - Dependencies: foundation schemas, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import type {
  AgentSessionBinding,
  AgentSessionBranchSource,
  AgentSessionBranchInput,
  AgentSessionConfiguration,
  AgentSessionCreateInput,
  AgentSessionOpenInput,
  AgentSessionResumeInput,
} from '../sessions/types.js';
import {
  AgentConfigurationRevisionIdSchema,
  AgentJsonObjectKeySchema,
  AgentJsonValuePortableSchema,
  AgentProviderConversationIdSchema,
  AgentProviderHistoryAnchorSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

// ------------------------------------------------------------------------------------------------
//                Binding and Configuration
// ------------------------------------------------------------------------------------------------

const SESSION_CONFIGURATION_JSON_DEPTH_OFFSET = 2;
const SESSION_OPEN_JSON_DEPTH_OFFSET = 3;

export const AgentSessionBindingSchema: z.ZodType<AgentSessionBinding> = z
  .object({
    conversationId: AgentProviderConversationIdSchema,
    historyAnchor: AgentProviderHistoryAnchorSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentSessionConfigurationPortableSchema = z
  .object({
    revision: AgentConfigurationRevisionIdSchema,
    values: z.record(
      AgentJsonObjectKeySchema,
      AgentJsonValuePortableSchema,
    ).readonly(),
  })
  .strict()
  .readonly();

export const AgentSessionConfigurationSchema: z.ZodType<AgentSessionConfiguration> =
  withAcyclicProtocolInput(AgentSessionConfigurationPortableSchema, {
    maxDepth:
      AGENT_PROTOCOL_JSON_DEPTH_LIMIT + SESSION_CONFIGURATION_JSON_DEPTH_OFFSET,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine((configuration, context) => {
    if (Object.keys(configuration.values).length > AGENT_PROTOCOL_COLLECTION_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        path: ['values'],
        message: `Session configuration cannot exceed ${AGENT_PROTOCOL_COLLECTION_MAX_LENGTH} entries.`,
      });
    }
    if (
      agentProtocolSerializedJsonBytes(configuration.values)
      > AGENT_PROTOCOL_JSON_BYTES_LIMIT
    ) {
      context.addIssue({
        code: 'custom',
        path: ['values'],
        message: `Session configuration cannot exceed ${AGENT_PROTOCOL_JSON_BYTES_LIMIT} serialized bytes.`,
      });
    }
  });

// ------------------------------------------------------------------------------------------------
//                Open Operation Schemas
// ------------------------------------------------------------------------------------------------

export const AgentSessionCreateInputPortableSchema = z
  .object({
    operation: z.literal('create'),
    sessionId: AgentSessionIdSchema,
    configuration: AgentSessionConfigurationPortableSchema,
  })
  .strict()
  .readonly();

export const AgentSessionResumeInputPortableSchema = z
  .object({
    operation: z.literal('resume'),
    sessionId: AgentSessionIdSchema,
    binding: AgentSessionBindingSchema,
    configuration: AgentSessionConfigurationPortableSchema,
  })
  .strict()
  .readonly();

export const AgentSessionBranchSourceSchema: z.ZodType<AgentSessionBranchSource> = z
  .object({
    sessionId: AgentSessionIdSchema,
    binding: AgentSessionBindingSchema,
    throughTurn: z
      .object({
        turnId: AgentTurnIdSchema,
        historyAnchor: AgentProviderHistoryAnchorSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentSessionBranchInputPortableSchema = z
  .object({
    operation: z.literal('branch'),
    sessionId: AgentSessionIdSchema,
    source: AgentSessionBranchSourceSchema,
    configuration: AgentSessionConfigurationPortableSchema,
  })
  .strict()
  .readonly();

const AgentSessionOpenInputPortableSchema = z.discriminatedUnion('operation', [
  AgentSessionCreateInputPortableSchema,
  AgentSessionResumeInputPortableSchema,
  AgentSessionBranchInputPortableSchema,
]);

function validateSessionOpenInput(
  input: AgentSessionOpenInput,
  context: z.RefinementCtx,
): void {
  const parsed = AgentSessionConfigurationSchema.safeParse(input.configuration);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['configuration', ...issue.path] });
    }
  }
  if (
    input.operation === 'branch'
    && input.sessionId === input.source.sessionId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: 'Branch target sessionId must differ from its source sessionId.',
    });
  }
}

export const AgentSessionCreateInputSchema: z.ZodType<AgentSessionCreateInput> =
  withAcyclicProtocolInput(AgentSessionCreateInputPortableSchema, {
    maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT + SESSION_OPEN_JSON_DEPTH_OFFSET,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(validateSessionOpenInput);
export const AgentSessionResumeInputSchema: z.ZodType<AgentSessionResumeInput> =
  withAcyclicProtocolInput(AgentSessionResumeInputPortableSchema, {
    maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT + SESSION_OPEN_JSON_DEPTH_OFFSET,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(validateSessionOpenInput);
export const AgentSessionBranchInputSchema: z.ZodType<AgentSessionBranchInput> =
  withAcyclicProtocolInput(AgentSessionBranchInputPortableSchema, {
    maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT + SESSION_OPEN_JSON_DEPTH_OFFSET,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(validateSessionOpenInput);
export const AgentSessionOpenInputSchema: z.ZodType<AgentSessionOpenInput> =
  withAcyclicProtocolInput(AgentSessionOpenInputPortableSchema, {
    maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT + SESSION_OPEN_JSON_DEPTH_OFFSET,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(validateSessionOpenInput);

export { AgentSessionOpenInputPortableSchema };
