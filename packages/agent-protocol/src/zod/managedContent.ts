// ------------------------------------------------------------------------------------------------
//                managedContent.ts - Managed content schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { AGENT_ARTIFACT_BYTE_SIZE_MAX } from '../artifacts/types.js';
import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_MANAGED_CONTENT_CATALOG_MAX_LENGTH,
  AGENT_MANAGED_CONTENT_KINDS,
  AGENT_MANAGED_CONTENT_NAME_MAX_LENGTH,
  AGENT_MANAGED_CONTENT_PROMPT_MAX_LENGTH,
  AGENT_MANAGED_CONTENT_SOURCES,
  AGENT_MANAGED_CONTENT_STATUSES,
  AGENT_MANAGED_CONTENT_SUMMARY_MAX_LENGTH,
  type AgentManagedContentCatalog,
  type AgentManagedContentDescriptor,
} from '../managedContent/types.js';
import {
  AgentManagedContentIdSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const AgentManagedContentDescriptorSchema: z.ZodType<AgentManagedContentDescriptor> = z
  .object({
    contentId: AgentManagedContentIdSchema,
    revision: PositiveSafeIntegerSchema,
    kind: z.enum(AGENT_MANAGED_CONTENT_KINDS),
    source: z.enum(AGENT_MANAGED_CONTENT_SOURCES),
    status: z.enum(AGENT_MANAGED_CONTENT_STATUSES),
    name: createAgentCanonicalNonBlankStringSchema(AGENT_MANAGED_CONTENT_NAME_MAX_LENGTH),
    summary: createAgentCanonicalNonBlankStringSchema(AGENT_MANAGED_CONTENT_SUMMARY_MAX_LENGTH).optional(),
    byteSize: z.number().int().positive().max(AGENT_ARTIFACT_BYTE_SIZE_MAX),
    digest: z.object({ algorithm: z.literal('sha256'), value: Sha256Schema }).strict().readonly(),
    invocation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('provider_materialization') }).strict().readonly(),
      z.object({
        kind: z.literal('prompt_recipe'),
        prompt: createAgentCanonicalNonBlankStringSchema(
          AGENT_MANAGED_CONTENT_PROMPT_MAX_LENGTH,
        ),
        confirmation: z.enum(['none', 'required']),
      }).strict().readonly(),
    ]).readonly(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      (descriptor.kind === 'prompt')
      !== (descriptor.invocation.kind === 'prompt_recipe')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['invocation', 'kind'],
        message: 'Prompt content must be a prompt recipe and only prompt content may be one.',
      });
    }
  })
  .readonly();

export const AgentManagedContentCatalogPortableSchema = z
  .object({
    revision: PositiveSafeIntegerSchema,
    entries: z.array(AgentManagedContentDescriptorSchema)
      .max(AGENT_MANAGED_CONTENT_CATALOG_MAX_LENGTH)
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentManagedContentCatalogSchema: z.ZodType<AgentManagedContentCatalog> =
  AgentManagedContentCatalogPortableSchema.superRefine((catalog, context) => {
    let previous = '';
    const ids = new Set<string>();
    catalog.entries.forEach((entry, entryIndex) => {
      if (ids.has(entry.contentId)) {
        context.addIssue({ code: 'custom', path: ['entries', entryIndex, 'contentId'], message: 'Managed content IDs must be unique.' });
      }
      if (
        entryIndex > 0
        && compareStringsByUnicodeCodePoint(previous, entry.contentId) >= 0
      ) {
        context.addIssue({ code: 'custom', path: ['entries', entryIndex, 'contentId'], message: 'Managed content must be ordered by contentId.' });
      }
      ids.add(entry.contentId);
      previous = entry.contentId;
    });
  });
