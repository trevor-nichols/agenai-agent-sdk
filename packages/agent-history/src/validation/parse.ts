import type { ZodType } from 'zod/v4';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import type * as Contracts from '../contracts/index.js';
import * as Records from './records.js';
import * as Operations from './operations.js';
import { captureHistoryData, freezeHistoryData } from './bounds.js';
import { AgentHistoryValidationError } from './errors.js';

function parse<Value>(schema: ZodType<Value>, input: unknown): Value {
  const captured = captureHistoryData(input);
  const result = schema.safeParse(captured);
  if (!result.success) throw new AgentHistoryValidationError(normalizeZodValidationError(schema, result.error, captured));
  return freezeHistoryData(result.data);
}

export function parseAgentHistorySourceIdentity(input: unknown): Contracts.AgentHistorySourceIdentity { return parse(Records.AgentHistorySourceIdentitySchema, input); }
export function parseAgentHistorySource(input: unknown): Contracts.AgentHistorySource { return parse(Records.AgentHistorySourceSchema, input); }
export function parseAgentHistoryConversationRef(input: unknown): Contracts.AgentHistoryConversationRef { return parse(Records.AgentHistoryConversationRefSchema, input); }
export function parseAgentHistoryConversationSummary(input: unknown): Contracts.AgentHistoryConversationSummary { return parse(Records.AgentHistoryConversationSummarySchema, input); }
export function parseAgentHistoryRecord(input: unknown): Contracts.AgentHistoryRecord { return parse(Records.AgentHistoryRecordSchema, input); }
export function parseAgentHistoryCatalogPage(input: unknown): Contracts.AgentHistoryCatalogPage { return parse(Records.AgentHistoryCatalogPageSchema, input); }
export function parseAgentHistoryTranscriptPage(input: unknown): Contracts.AgentHistoryTranscriptPage { return parse(Records.AgentHistoryTranscriptPageSchema, input); }
export function parseAgentHistorySearchPage(input: unknown): Contracts.AgentHistorySearchPage { return parse(Records.AgentHistorySearchPageSchema, input); }
export function parseAgentHistoryTranscriptView(input: unknown): Contracts.AgentHistoryTranscriptView { return parse(Records.AgentHistoryTranscriptViewSchema, input); }
export function parseAgentHistoryListInput(input: unknown): Contracts.AgentHistoryListInput { return parse(Operations.AgentHistoryListInputSchema, input); }
export function parseAgentHistoryLookupInput(input: unknown): Contracts.AgentHistoryLookupInput { return parse(Operations.AgentHistoryLookupInputSchema, input); }
export function parseAgentHistoryReadInput(input: unknown): Contracts.AgentHistoryReadInput { return parse(Operations.AgentHistoryReadInputSchema, input); }
export function parseAgentHistorySearchInput(input: unknown): Contracts.AgentHistorySearchInput { return parse(Operations.AgentHistorySearchInputSchema, input); }
export function parseAgentHistoryMutationInput(input: unknown): Contracts.AgentHistoryMutationInput { return parse(Operations.AgentHistoryMutationInputSchema, input); }
export function parseAgentHistoryRenameInput(input: unknown): Contracts.AgentHistoryRenameInput { return parse(Operations.AgentHistoryRenameInputSchema, input); }
export function parseAgentHistoryMutationResult(input: unknown): Contracts.AgentHistoryMutationResult { return parse(Operations.AgentHistoryMutationResultSchema, input); }
export function parseAgentHistoryCatalogDescriptor(input: unknown): Contracts.AgentHistoryCatalogDescriptor { return parse(Operations.AgentHistoryCatalogDescriptorSchema, input); }
export function parseAgentHistoryLookupDescriptor(input: unknown): Contracts.AgentHistoryLookupDescriptor { return parse(Operations.AgentHistoryLookupDescriptorSchema, input); }
export function parseAgentHistoryTranscriptDescriptor(input: unknown): Contracts.AgentHistoryTranscriptDescriptor { return parse(Operations.AgentHistoryTranscriptDescriptorSchema, input); }
export function parseAgentHistorySearchDescriptor(input: unknown): Contracts.AgentHistorySearchDescriptor { return parse(Operations.AgentHistorySearchDescriptorSchema, input); }
export function parseAgentHistoryMutationDescriptor(input: unknown): Contracts.AgentHistoryMutationDescriptor { return parse(Operations.AgentHistoryMutationDescriptorSchema, input); }
export function parseAgentHistoryUnsupportedReason(input: unknown): Contracts.AgentHistoryUnsupportedReason { return parse(Operations.AgentHistoryUnsupportedReasonSchema, input); }
export function parseAgentHistoryNamedTranscriptView(input: unknown): Contracts.AgentHistoryNamedTranscriptView { return parse(Records.AgentHistoryNamedTranscriptViewSchema, input); }
export function parseAgentHistoryViewSummary(input: unknown): Contracts.AgentHistoryViewSummary { return parse(Records.AgentHistoryViewSummarySchema, input); }
export function parseAgentHistoryViewPage(input: unknown): Contracts.AgentHistoryViewPage { return parse(Records.AgentHistoryViewPageSchema, input); }
export function parseAgentHistoryViewListInput(input: unknown): Contracts.AgentHistoryViewListInput { return parse(Operations.AgentHistoryViewListInputSchema, input); }
export function parseAgentHistoryViewDescriptor(input: unknown): Contracts.AgentHistoryViewDescriptor { return parse(Operations.AgentHistoryViewDescriptorSchema, input); }
