import { z } from 'zod/v4';
import type {
  AgentHistoryMutationInput, AgentHistoryMutationResult,
  AgentHistoryCatalogPage, AgentHistoryConversationRef, AgentHistoryConversationSummary, AgentHistoryListInput,
  AgentHistoryLookupInput, AgentHistoryReadInput, AgentHistorySource, AgentHistoryTranscriptPage,
  AgentHistoryViewListInput, AgentHistoryViewPage,
} from '../../../contracts/index.js';
import { AgentHistoryError, type AgentHistoryErrorCode } from '../../../lifecycle/errors.js';
import { captureHistoryData } from '../../../validation/bounds.js';
import {
  parseAgentHistoryMutationInput, parseAgentHistoryMutationResult,
  parseAgentHistoryCatalogPage, parseAgentHistoryConversationSummary, parseAgentHistoryListInput,
  parseAgentHistoryLookupInput, parseAgentHistoryReadInput, parseAgentHistorySource,
  parseAgentHistoryTranscriptPage, parseAgentHistoryViewListInput, parseAgentHistoryViewPage,
} from '../../../validation/parse.js';
import type { CursorHistoryStore } from '../contracts.js';

export const CURSOR_WORKER_INPUT_BYTES = 32_768;
export const CURSOR_WORKER_OUTPUT_BYTES = 262_144;
export const CURSOR_PAGE_BYTES = 196_608;
export const CURSOR_PAGE_RESERVE_BYTES = 2048;

export interface CursorWorkerRequest {
  readonly version: 1;
  readonly source: AgentHistorySource;
  readonly store: CursorHistoryStore;
  readonly pageBytes: number;
  readonly operation:
    | Readonly<{ kind: 'catalog'; input: AgentHistoryListInput }>
    | Readonly<{ kind: 'lookup'; input: AgentHistoryLookupInput }>
    | Readonly<{ kind: 'views'; input: AgentHistoryViewListInput }>
    | Readonly<{ kind: 'transcript'; input: AgentHistoryReadInput }>
    | Readonly<{ kind: 'archive'; input: AgentHistoryMutationInput }>
    | Readonly<{ kind: 'restore'; input: AgentHistoryMutationInput }>
    | Readonly<{ kind: 'delete'; input: AgentHistoryMutationInput }>;
}

export type CursorWorkerResponse =
  | Readonly<{ version: 1; kind: 'catalog'; page: AgentHistoryCatalogPage }>
  | Readonly<{ version: 1; kind: 'lookup'; summary: AgentHistoryConversationSummary }>
  | Readonly<{ version: 1; kind: 'views'; page: AgentHistoryViewPage }>
  | Readonly<{ version: 1; kind: 'transcript'; page: AgentHistoryTranscriptPage }>
  | Readonly<{ version: 1; kind: 'mutation'; result: AgentHistoryMutationResult }>
  | Readonly<{ version: 1; kind: 'error'; code: AgentHistoryErrorCode; message: string }>;

const absolutePath = z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !value.includes('\0'));
const requestSchema = z.strictObject({
  version: z.literal(1), source: z.unknown(),
  store: z.strictObject({ kind: z.enum(['jsonl', 'sqlite']), path: absolutePath }),
  pageBytes: z.int().min(1).max(CURSOR_PAGE_BYTES),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('catalog'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('lookup'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('views'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('transcript'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('archive'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('restore'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('delete'), input: z.unknown() }),
  ]),
});
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('catalog'), page: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('lookup'), summary: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('views'), page: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('transcript'), page: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('mutation'), result: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('error'),
    code: z.enum(['invalid_input', 'invalid_cursor', 'wrong_source', 'not_found', 'access_denied', 'unsupported_scope', 'closed',
      'cancelled', 'deadline_exceeded', 'busy', 'limit_exhausted', 'native_failure', 'cleanup_failed']),
    message: z.string().min(1).max(1024) }),
]);
export const cursorNativeId = z.string().min(1).max(16_384).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);

export function assertCursorConversation(ref: AgentHistoryConversationRef, source: AgentHistorySource): void {
  if (!cursorNativeId.safeParse(ref.conversationId).success || ref.conversationId.startsWith('bc-')) {
    throw new AgentHistoryError('invalid_input', 'Cursor local history requires a native local agent ID.');
  }
  if (ref.source.providerKey !== source.providerKey || ref.source.sourceId !== source.sourceId || ref.source.generation !== source.generation) {
    throw new AgentHistoryError('wrong_source', 'Cursor conversation belongs to another source generation.');
  }
}

export function parseCursorWorkerRequest(value: unknown): CursorWorkerRequest {
  try {
    const captured = captureHistoryData(value);
    if (Buffer.byteLength(JSON.stringify(captured)) > CURSOR_WORKER_INPUT_BYTES) throw new AgentHistoryError('limit_exhausted', 'Cursor worker request exceeds 32 KiB.');
    const result = requestSchema.safeParse(captured);
    if (!result.success) throw new Error('Invalid worker input');
    const input = result.data, source = parseAgentHistorySource(input.source);
    if (source.providerKey !== 'cursor' || source.kind !== 'cursor-local-sdk' || source.resourceOwnership !== 'owned'
      || source.scope.kind !== 'project' || source.scope.worktrees !== 'excluded' || !source.scope.projectPath.startsWith('/')) throw new Error('Invalid local source');
    const base = { version: input.version, source, store: input.store, pageBytes: input.pageBytes };
    switch (input.operation.kind) {
      case 'catalog': return { ...base, operation: { kind: 'catalog', input: parseAgentHistoryListInput(input.operation.input) } };
      case 'lookup': {
        const parsed = parseAgentHistoryLookupInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        return { ...base, operation: { kind: 'lookup', input: parsed } };
      }
      case 'views': {
        const parsed = parseAgentHistoryViewListInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        if (parsed.kind !== 'run') throw new AgentHistoryError('unsupported_scope', 'Cursor local history exposes named run views only.');
        return { ...base, operation: { kind: 'views', input: parsed } };
      }
      case 'archive': {
        const parsed = parseAgentHistoryMutationInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        return { ...base, operation: { kind: 'archive', input: parsed } };
      }
      case 'restore': {
        const parsed = parseAgentHistoryMutationInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        return { ...base, operation: { kind: 'restore', input: parsed } };
      }
      case 'delete': {
        const parsed = parseAgentHistoryMutationInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        return { ...base, operation: { kind: 'delete', input: parsed } };
      }
      case 'transcript': {
        const parsed = parseAgentHistoryReadInput(input.operation.input);
        assertCursorConversation(parsed.conversation, source);
        if (parsed.view?.kind === 'run' && !cursorNativeId.safeParse(parsed.view.id).success) throw new Error('Invalid native run ID');
        return { ...base, operation: { kind: 'transcript', input: parsed } };
      }
    }
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('invalid_input', 'Invalid Cursor history worker request.');
  }
}

export function parseCursorWorkerResponse(value: unknown): CursorWorkerResponse {
  try {
    const captured = captureHistoryData(value);
    if (Buffer.byteLength(JSON.stringify(captured)) > CURSOR_WORKER_OUTPUT_BYTES) throw new Error('Worker response exceeds its envelope');
    const result = responseSchema.safeParse(captured);
    if (!result.success) throw new Error('Invalid worker output');
    const input = result.data;
    switch (input.kind) {
      case 'catalog': return { version: 1, kind: 'catalog', page: parseAgentHistoryCatalogPage(input.page) };
      case 'mutation': return { version: 1, kind: 'mutation', result: parseAgentHistoryMutationResult(input.result) };
      case 'lookup': return { version: 1, kind: 'lookup', summary: parseAgentHistoryConversationSummary(input.summary) };
      case 'views': return { version: 1, kind: 'views', page: parseAgentHistoryViewPage(input.page) };
      case 'transcript': return { version: 1, kind: 'transcript', page: parseAgentHistoryTranscriptPage(input.page) };
      case 'error': return input;
    }
  } catch { throw new AgentHistoryError('native_failure', 'Cursor history worker returned an invalid response.'); }
}
