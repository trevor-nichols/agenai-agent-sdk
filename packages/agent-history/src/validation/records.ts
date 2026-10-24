import { z } from 'zod/v4';
import {
  AgentIsoDateTimeSchema, AgentJsonValueSchema, AgentProviderConversationIdSchema,
  AgentProviderHistoryAnchorSchema, AgentProviderItemRefSchema, AgentProviderKeySchema, AgentProviderTurnRefSchema,
} from '@agen-ai/agent-protocol/zod';
import type {
  AgentHistoryAttachmentReference, AgentHistoryCatalogPage, AgentHistoryContent,
  AgentHistoryConversationRef, AgentHistoryConversationSummary, AgentHistoryCoverage,
  AgentHistoryNativeReferences, AgentHistoryPage, AgentHistoryRecord, AgentHistoryScope,
  AgentHistoryNamedTranscriptView, AgentHistoryViewSummary, AgentHistoryViewPage,
  AgentHistorySearchHit, AgentHistorySearchPage, AgentHistorySource,
  AgentHistorySourceIdentity, AgentHistoryStorageEffects, AgentHistoryTranscriptPage, AgentHistoryTranscriptView,
} from '../contracts/records.js';
import { AGENT_HISTORY_MAX_CONTENT_BLOCKS, AGENT_HISTORY_MAX_CURSOR_BYTES, AGENT_HISTORY_MAX_PAGE_BYTES, AGENT_HISTORY_MAX_PAGE_RECORDS, AGENT_HISTORY_MAX_SOURCE_ID_LENGTH } from './bounds.js';

const encoder = new TextEncoder();
const canonical = /^(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u;
export const HistoryIdSchema = z.string().min(1).max(AGENT_HISTORY_MAX_SOURCE_ID_LENGTH).regex(canonical);
export const HistoryKindSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/u);
export const HistoryPathSchema = z.string().min(1).max(4096).regex(canonical);
export const HistoryReasonSchema = z.string().min(1).max(2000);
export const HistoryNativeIdSchema = z.string().min(1).max(512).regex(canonical);
export const HistoryCursorSchema = z.string().min(1).max(AGENT_HISTORY_MAX_CURSOR_BYTES)
  .refine((value) => encoder.encode(value).byteLength <= AGENT_HISTORY_MAX_CURSOR_BYTES, 'History cursor exceeds 64 KiB of UTF-8.');

export function uniqueHistoryValues(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'History collections must not contain duplicates.' });
}

export const AgentHistorySourceIdentitySchema: z.ZodType<AgentHistorySourceIdentity> = z.strictObject({
  providerKey: AgentProviderKeySchema, sourceId: HistoryIdSchema, generation: HistoryIdSchema,
});
export const AgentHistoryScopeSchema: z.ZodType<AgentHistoryScope> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectPath: HistoryPathSchema, worktrees: z.enum(['included', 'excluded']) }),
  z.strictObject({ kind: z.literal('all_projects') }),
  z.strictObject({ kind: z.literal('account'), label: z.string().min(1).max(200).optional() }),
  z.strictObject({ kind: z.literal('provider_defined'), description: HistoryReasonSchema }),
]);
const storageEffect = z.enum(['initializes_store', 'migrates_store', 'updates_index', 'updates_auxiliary_files']);
export const AgentHistoryStorageEffectsSchema: z.ZodType<AgentHistoryStorageEffects> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('possible'), effects: z.tuple([storageEffect]).rest(storageEffect).refine((values) => values.length <= 4 && new Set(values).size === values.length, 'Storage effects must be unique and bounded.') }),
  z.strictObject({ kind: z.literal('unknown'), reason: HistoryReasonSchema }),
]);
export const AgentHistorySourceSchema: z.ZodType<AgentHistorySource> = z.strictObject({
  providerKey: AgentProviderKeySchema, sourceId: HistoryIdSchema, generation: HistoryIdSchema,
  kind: HistoryKindSchema, scope: AgentHistoryScopeSchema, storageEffects: AgentHistoryStorageEffectsSchema,
  resourceOwnership: z.enum(['owned', 'borrowed']),
});
export const AgentHistoryConversationRefSchema: z.ZodType<AgentHistoryConversationRef> = z.strictObject({
  source: AgentHistorySourceIdentitySchema, conversationId: AgentProviderConversationIdSchema,
});
export const AgentHistoryConversationSummarySchema: z.ZodType<AgentHistoryConversationSummary> = z.strictObject({
  ref: AgentHistoryConversationRefSchema, title: z.string().max(2000).optional(),
  createdAt: AgentIsoDateTimeSchema.optional(), updatedAt: AgentIsoDateTimeSchema.optional(),
  projectPath: HistoryPathSchema.optional(), model: z.string().min(1).max(512).optional(),
  parent: AgentHistoryConversationRefSchema.optional(), archiveState: z.enum(['archived', 'not_archived', 'unknown']),
}).superRefine((value, context) => {
  const source = value.ref.source, parent = value.parent?.source;
  if (parent && (source.providerKey !== parent.providerKey || source.sourceId !== parent.sourceId || source.generation !== parent.generation)) {
    context.addIssue({ code: 'custom', path: ['parent', 'source'], message: 'Parent conversation must belong to the same source generation.' });
  }
});
export const AgentHistoryNativeReferencesSchema: z.ZodType<AgentHistoryNativeReferences> = z.strictObject({
  turnId: AgentProviderTurnRefSchema.optional(), itemId: AgentProviderItemRefSchema.optional(), historyAnchor: AgentProviderHistoryAnchorSchema.optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), 'Native references require an observed native identity.');
export const AgentHistoryAttachmentReferenceSchema: z.ZodType<AgentHistoryAttachmentReference> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native'), id: HistoryNativeIdSchema }),
  z.strictObject({ kind: z.literal('uri'), uri: z.string().url().max(8192).refine((value) => {
    if (!URL.canParse(value)) return false;
    const uri = new URL(value);
    return uri.username === '' && uri.password === '';
  }, 'Attachment references cannot contain URL user credentials.') }),
]);
export const AgentHistoryOmissionSchema = z.enum(['compacted', 'deleted', 'unsupported_record_kind', 'unsupported_content', 'subagents_excluded', 'native_retention', 'resource_limit', 'provider_omission']);
const text = z.string().max(AGENT_HISTORY_MAX_PAGE_BYTES);
export const AgentHistoryContentSchema: z.ZodType<AgentHistoryContent> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text }),
  z.strictObject({ kind: z.literal('thinking'), text }),
  z.strictObject({ kind: z.literal('attachment'), attachmentKind: z.enum(['image', 'file', 'document', 'unknown']), reference: AgentHistoryAttachmentReferenceSchema, name: z.string().max(512).optional(), mediaType: z.string().min(1).max(128).optional() }),
  z.strictObject({ kind: z.literal('omission'), reason: AgentHistoryOmissionSchema, detail: HistoryReasonSchema }),
]);
const recordBase = { native: AgentHistoryNativeReferencesSchema.optional(), timestamp: AgentIsoDateTimeSchema.optional() };
const content = z.array(AgentHistoryContentSchema).max(AGENT_HISTORY_MAX_CONTENT_BLOCKS);
export const AgentHistoryRecordSchema: z.ZodType<AgentHistoryRecord> = z.discriminatedUnion('kind', [
  z.strictObject({ ...recordBase, kind: z.literal('message'), role: z.enum(['user', 'assistant', 'system', 'developer']), content }),
  z.strictObject({ ...recordBase, kind: z.literal('tool_call'), callId: HistoryNativeIdSchema.optional(), name: z.string().min(1).max(256), arguments: AgentJsonValueSchema.optional() }),
  z.strictObject({ ...recordBase, kind: z.literal('tool_result'), callId: HistoryNativeIdSchema.optional(), outcome: z.enum(['succeeded', 'failed', 'unknown']), content }),
  z.strictObject({ ...recordBase, kind: z.literal('notice'), code: z.string().min(1).max(120).regex(canonical), message: z.string().min(1).max(4000) }),
  z.strictObject({ ...recordBase, kind: z.literal('compaction'), summary: text.optional() }),
]);
export const AgentHistoryCoverageSchema: z.ZodType<AgentHistoryCoverage> = z.strictObject({
  view: z.enum(['catalog', 'retained_chain', 'current_checkpoint', 'stored_updates', 'retained_archive']),
  children: z.enum(['included', 'excluded', 'unknown']), omissions: z.array(AgentHistoryOmissionSchema).max(8).superRefine(uniqueHistoryValues),
});
function pageFields<Item>(item: z.ZodType<Item>) {
  return { items: z.array(item).max(AGENT_HISTORY_MAX_PAGE_RECORDS), nextCursor: HistoryCursorSchema.optional(),
    observedAt: AgentIsoDateTimeSchema, consistency: z.enum(['live', 'snapshot']), coverage: AgentHistoryCoverageSchema,
  };
}
function pageFits(value: unknown): boolean {
  return encoder.encode(JSON.stringify(value)).byteLength <= AGENT_HISTORY_MAX_PAGE_BYTES;
}
function page<Item>(item: z.ZodType<Item>): z.ZodType<AgentHistoryPage<Item>> {
  return z.strictObject(pageFields(item)).refine(pageFits, 'History page exceeds 1 MiB of serialized UTF-8 JSON.');
}
export const AgentHistoryCatalogPageSchema: z.ZodType<AgentHistoryCatalogPage> = page(AgentHistoryConversationSummarySchema);
export const AgentHistoryTranscriptPageSchema: z.ZodType<AgentHistoryTranscriptPage> = page(AgentHistoryRecordSchema);
export const AgentHistorySearchHitSchema: z.ZodType<AgentHistorySearchHit> = z.strictObject({
  conversation: AgentHistoryConversationSummarySchema, snippet: z.string().max(8192).optional(), native: AgentHistoryNativeReferencesSchema.optional(),
  score: z.number().finite().optional(), matchedFields: z.array(z.enum(['title', 'transcript', 'conversation_id'])).min(1).max(3).superRefine(uniqueHistoryValues).optional(),
});
export const AgentHistorySearchPageSchema: z.ZodType<AgentHistorySearchPage> = z.strictObject({
  ...pageFields(AgentHistorySearchHitSchema), totalEstimate: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).refine(pageFits, 'History page exceeds 1 MiB of serialized UTF-8 JSON.');
export const AgentHistoryTranscriptViewSchema: z.ZodType<AgentHistoryTranscriptView> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main') }), z.strictObject({ kind: z.literal('subagent'), id: HistoryNativeIdSchema }), z.strictObject({ kind: z.literal('run'), id: HistoryNativeIdSchema }),
]);

export const AgentHistoryNamedTranscriptViewSchema: z.ZodType<AgentHistoryNamedTranscriptView> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('subagent'), id: HistoryNativeIdSchema }),
  z.strictObject({ kind: z.literal('run'), id: HistoryNativeIdSchema }),
]);
export const AgentHistoryViewSummarySchema: z.ZodType<AgentHistoryViewSummary> = z.strictObject({
  view: AgentHistoryNamedTranscriptViewSchema, title: z.string().max(2000).optional(),
  createdAt: AgentIsoDateTimeSchema.optional(), updatedAt: AgentIsoDateTimeSchema.optional(),
});
export const AgentHistoryViewPageSchema: z.ZodType<AgentHistoryViewPage> = page(AgentHistoryViewSummarySchema);
