// ------------------------------------------------------------------------------------------------
//                sessions.ts - Session schemas - Dependencies: foundation schemas, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import { AGENT_CONFIGURATION_FIELDS_MAX_LENGTH } from '../configuration/types.js';
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
  AgentCanonicalIdValueSchema,
  AgentProviderConversationIdSchema,
  AgentProviderHistoryAnchorSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
} from './foundation.js';
import { AgentConfigurationValueSchema } from './configuration.js';

// ------------------------------------------------------------------------------------------------
//                Binding and Configuration
// ------------------------------------------------------------------------------------------------

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const AgentSessionBindingSchema: z.ZodType<AgentSessionBinding> = z
  .object({
    conversationId: AgentProviderConversationIdSchema,
    historyAnchor: AgentProviderHistoryAnchorSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentSessionConfigurationPortableSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('managed'),
        revision: AgentConfigurationRevisionIdSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        kind: z.literal('selected'),
        revision: AgentConfigurationRevisionIdSchema,
        catalogRevision: PositiveSafeIntegerSchema,
        selections: z
          .array(
            z
              .object({
                key: AgentCanonicalIdValueSchema,
                fieldRevision: PositiveSafeIntegerSchema,
                value: AgentConfigurationValueSchema,
              })
              .strict()
              .readonly(),
          )
          .max(AGENT_CONFIGURATION_FIELDS_MAX_LENGTH)
          .readonly(),
      })
      .strict()
      .readonly(),
  ],
);

export const AgentSessionConfigurationSchema: z.ZodType<AgentSessionConfiguration> =
  AgentSessionConfigurationPortableSchema.superRefine((configuration, context) => {
    if (configuration.kind === 'selected') {
      const keys = new Set<string>();
      let previousKey = '';
      configuration.selections.forEach((selection, selectionIndex) => {
        if (keys.has(selection.key)) {
          context.addIssue({
            code: 'custom',
            path: ['selections', selectionIndex, 'key'],
            message: 'Session configuration keys must be unique.',
          });
        }
        if (
          selectionIndex > 0
          && compareStringsByUnicodeCodePoint(previousKey, selection.key) >= 0
        ) {
          context.addIssue({
            code: 'custom',
            path: ['selections', selectionIndex, 'key'],
            message: 'Session configuration selections must be ordered by key.',
          });
        }
        keys.add(selection.key);
        previousKey = selection.key;
      });
    }
    if (
      agentProtocolSerializedJsonBytes(configuration)
      > AGENT_PROTOCOL_JSON_BYTES_LIMIT
    ) {
      context.addIssue({
        code: 'custom',
        path: [],
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
  AgentSessionCreateInputPortableSchema.superRefine(validateSessionOpenInput);
export const AgentSessionResumeInputSchema: z.ZodType<AgentSessionResumeInput> =
  AgentSessionResumeInputPortableSchema.superRefine(validateSessionOpenInput);
export const AgentSessionBranchInputSchema: z.ZodType<AgentSessionBranchInput> =
  AgentSessionBranchInputPortableSchema.superRefine(validateSessionOpenInput);
export const AgentSessionOpenInputSchema: z.ZodType<AgentSessionOpenInput> =
  AgentSessionOpenInputPortableSchema.superRefine(validateSessionOpenInput);

export { AgentSessionOpenInputPortableSchema };
