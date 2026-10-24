import { z } from 'zod/v4';
import type {
  AgentHistoryCatalogDescriptor, AgentHistoryListInput, AgentHistoryLookupDescriptor, AgentHistoryLookupInput,
  AgentHistoryMutationDescriptor, AgentHistoryMutationEffects, AgentHistoryMutationInput, AgentHistoryMutationResult,
  AgentHistoryReadInput, AgentHistoryRenameInput, AgentHistorySearchDescriptor, AgentHistorySearchInput,
  AgentHistoryTranscriptDescriptor, AgentHistoryUnsupportedReason, AgentHistoryViewListInput, AgentHistoryViewDescriptor,
} from '../contracts/operations.js';
import { AGENT_HISTORY_MAX_PAGE_RECORDS } from './bounds.js';
import {
  AgentHistoryConversationRefSchema, AgentHistoryTranscriptViewSchema,
  HistoryCursorSchema, HistoryPathSchema, HistoryReasonSchema, uniqueHistoryValues,
} from './records.js';

export const AgentHistoryCatalogFilterSchema = z.enum(['projectPath', 'archived', 'parent', 'sourceKinds']);
export const AgentHistoryOrderSchema = z.enum(['native', 'updated_asc', 'updated_desc', 'created_asc', 'created_desc']);
export const HistoryManagementSelectionSchema = z.array(z.enum(['rename', 'archive', 'restore', 'delete'])).max(4).superRefine(uniqueHistoryValues);
const filters = z.array(AgentHistoryCatalogFilterSchema).max(4).superRefine(uniqueHistoryValues);
const orders = z.array(AgentHistoryOrderSchema).min(1).max(5).superRefine(uniqueHistoryValues);
const pagination = z.enum(['offset', 'cursor', 'none']);
const nativeSourceKind = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const listFields = {
  cursor: HistoryCursorSchema.optional(), limit: z.number().int().min(1).max(AGENT_HISTORY_MAX_PAGE_RECORDS).optional(),
  projectPath: HistoryPathSchema.optional(), archived: z.enum(['exclude', 'include', 'only']).optional(),
  order: AgentHistoryOrderSchema.optional(), parent: AgentHistoryConversationRefSchema.optional(),
  sourceKinds: z.array(nativeSourceKind).min(1).max(100).superRefine(uniqueHistoryValues).optional(),
};
export const AgentHistoryListInputSchema: z.ZodType<AgentHistoryListInput> = z.strictObject(listFields);
export const AgentHistoryLookupInputSchema: z.ZodType<AgentHistoryLookupInput> = z.strictObject({ conversation: AgentHistoryConversationRefSchema });
export const AgentHistoryReadInputSchema: z.ZodType<AgentHistoryReadInput> = z.strictObject({
  conversation: AgentHistoryConversationRefSchema, cursor: listFields.cursor, limit: listFields.limit, view: AgentHistoryTranscriptViewSchema.optional(),
});
export const AgentHistorySearchInputSchema: z.ZodType<AgentHistorySearchInput> = z.strictObject({ ...listFields, query: z.string().min(1).max(2000) });
export const AgentHistoryCatalogDescriptorSchema: z.ZodType<AgentHistoryCatalogDescriptor> = z.strictObject({ filters, orders, pagination });
export const AgentHistoryLookupDescriptorSchema: z.ZodType<AgentHistoryLookupDescriptor> = z.strictObject({ semantics: z.literal('native_lookup') });
export const AgentHistoryTranscriptDescriptorSchema: z.ZodType<AgentHistoryTranscriptDescriptor> = z.strictObject({
  views: z.array(z.enum(['main', 'subagent', 'run'])).min(1).max(3).superRefine(uniqueHistoryValues), pagination,
});
export const AgentHistorySearchDescriptorSchema: z.ZodType<AgentHistorySearchDescriptor> = z.strictObject({
  syntax: z.enum(['literal', 'sql_like', 'fts', 'provider_defined']), caseSensitivity: z.enum(['sensitive', 'insensitive', 'provider_defined']),
  ranking: z.enum(['none', 'native', 'chronological']), scope: z.enum(['title', 'metadata', 'transcript']), filters, orders,
});
export const AgentHistoryMutationEffectsSchema: z.ZodType<AgentHistoryMutationEffects> = z.strictObject({
  scope: z.enum(['local', 'remote', 'local_and_remote', 'provider_managed']),
  descendants: z.enum(['none', 'subagents', 'descendants', 'unknown']),
  active: z.enum(['native_rejects', 'requires_quiescent', 'unknown']), atomicity: z.enum(['atomic', 'non_atomic', 'unknown']),
});
export const AgentHistoryMutationDescriptorSchema: z.ZodType<AgentHistoryMutationDescriptor> = z.strictObject({ effects: AgentHistoryMutationEffectsSchema });
const mutationFields = { conversation: AgentHistoryConversationRefSchema, acceptEffects: AgentHistoryMutationEffectsSchema };
export const AgentHistoryMutationInputSchema: z.ZodType<AgentHistoryMutationInput> = z.strictObject(mutationFields);
export const AgentHistoryRenameInputSchema: z.ZodType<AgentHistoryRenameInput> = z.strictObject({
  ...mutationFields, title: z.string().min(1).max(2000).refine((value) => value.trim() === value && /\S/u.test(value) && !/[\u0000-\u001F\u007F-\u009F]/u.test(value), 'Rename title must be canonical nonblank text.'),
});
const mutationReason = z.strictObject({ code: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/u), message: HistoryReasonSchema });
export const AgentHistoryMutationResultSchema: z.ZodType<AgentHistoryMutationResult> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), ref: AgentHistoryConversationRefSchema }),
  z.strictObject({ status: z.literal('not_applied'), ref: AgentHistoryConversationRefSchema, reason: mutationReason }),
  z.strictObject({ status: z.literal('outcome_unknown'), ref: AgentHistoryConversationRefSchema, reason: mutationReason }),
]);
export const AgentHistoryUnsupportedReasonSchema: z.ZodType<AgentHistoryUnsupportedReason> = z.strictObject({
  code: z.enum(['native_unavailable', 'unqualified', 'scope_excluded', 'management_disabled', 'resource_policy_required']), message: HistoryReasonSchema,
});

export const AgentHistoryViewListInputSchema: z.ZodType<AgentHistoryViewListInput> = z.strictObject({
  conversation: AgentHistoryConversationRefSchema, kind: z.enum(['run', 'subagent']),
  cursor: listFields.cursor, limit: listFields.limit,
});
export const AgentHistoryViewDescriptorSchema: z.ZodType<AgentHistoryViewDescriptor> = z.strictObject({
  kinds: z.array(z.enum(['run', 'subagent'])).min(1).max(2).superRefine(uniqueHistoryValues), pagination,
});
