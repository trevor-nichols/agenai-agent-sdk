import { z } from 'zod/v4';
import type {
  AgentHistoryMutationInput, AgentHistoryMutationResult, AgentHistoryRenameInput,
  AgentHistoryCatalogPage, AgentHistoryConversationRef, AgentHistoryConversationSummary, AgentHistoryListInput,
  AgentHistoryLookupInput, AgentHistoryReadInput, AgentHistorySource, AgentHistoryTranscriptPage,
} from '../../../contracts/index.js';
import { AgentHistoryError, type AgentHistoryErrorCode } from '../../../lifecycle/errors.js';
import {
  parseAgentHistoryMutationInput, parseAgentHistoryMutationResult, parseAgentHistoryRenameInput,
  parseAgentHistoryCatalogPage, parseAgentHistoryConversationSummary, parseAgentHistoryListInput,
  parseAgentHistoryLookupInput, parseAgentHistoryReadInput, parseAgentHistorySource,
  parseAgentHistoryTranscriptPage,
} from '../../../validation/parse.js';
import { captureHistoryData } from '../../../validation/bounds.js';

export const CLAUDE_WORKER_INPUT_BYTES = 32_768;
export const CLAUDE_WORKER_OUTPUT_BYTES = 262_144;
export const CLAUDE_PAGE_BYTES = 196_608;
export const CLAUDE_CURSOR_RESERVE_BYTES = 2_048;

export interface ClaudeWorkerRequest {
  readonly version: 1;
  readonly source: AgentHistorySource;
  readonly configHome: string;
  readonly includeProgrammatic: boolean;
  readonly pageBytes: number;
  readonly operation:
    | Readonly<{ kind: 'catalog'; input: AgentHistoryListInput }>
    | Readonly<{ kind: 'lookup'; input: AgentHistoryLookupInput }>
    | Readonly<{ kind: 'transcript'; input: AgentHistoryReadInput }>
    | Readonly<{ kind: 'rename'; input: AgentHistoryRenameInput }>
    | Readonly<{ kind: 'delete'; input: AgentHistoryMutationInput }>;
}

export type ClaudeWorkerResponse =
  | Readonly<{ version: 1; kind: 'catalog'; page: AgentHistoryCatalogPage }>
  | Readonly<{ version: 1; kind: 'lookup'; summary: AgentHistoryConversationSummary }>
  | Readonly<{ version: 1; kind: 'transcript'; page: AgentHistoryTranscriptPage }>
  | Readonly<{ version: 1; kind: 'mutation'; result: AgentHistoryMutationResult }>
  | Readonly<{ version: 1; kind: 'error'; code: AgentHistoryErrorCode; message: string }>;

const requestSchema = z.strictObject({
  version: z.literal(1), source: z.unknown(),
  configHome: z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !value.includes('\0')),
  includeProgrammatic: z.boolean(), pageBytes: z.int().min(1).max(CLAUDE_PAGE_BYTES),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('catalog'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('lookup'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('transcript'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('rename'), input: z.unknown() }),
    z.strictObject({ kind: z.literal('delete'), input: z.unknown() }),
  ]),
});
const errorCode = z.enum([
  'invalid_input', 'invalid_cursor', 'wrong_source', 'not_found', 'access_denied', 'unsupported_scope', 'closed',
  'cancelled', 'deadline_exceeded', 'busy', 'limit_exhausted', 'native_failure', 'cleanup_failed',
]);
const conversationId = z.uuid();
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('catalog'), page: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('lookup'), summary: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('transcript'), page: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('mutation'), result: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal('error'), code: errorCode, message: z.string().min(1).max(1024) }),
]);

function request(value: unknown): ClaudeWorkerRequest {
  const captured = captureHistoryData(value);
  if (Buffer.byteLength(JSON.stringify(captured), 'utf8') > CLAUDE_WORKER_INPUT_BYTES) {
    throw new AgentHistoryError('limit_exhausted', 'Claude worker request exceeds 32 KiB.');
  }
  const result = requestSchema.safeParse(captured);
  if (!result.success) throw new AgentHistoryError('invalid_input', 'Invalid Claude history worker request.');
  const input = result.data;
  const source = parseAgentHistorySource(input.source);
  if (source.providerKey !== 'claude' || source.kind !== 'claude-native'
    || source.resourceOwnership !== 'owned' || !['project', 'all_projects'].includes(source.scope.kind)) {
    throw new AgentHistoryError('invalid_input', 'Unsupported Claude history source configuration.');
  }
  if (source.scope.kind === 'project' && !source.scope.projectPath.startsWith('/')) {
    throw new AgentHistoryError('invalid_input', 'Claude project scope requires an absolute path.');
  }
  const base = { version: input.version, source, configHome: input.configHome,
    includeProgrammatic: input.includeProgrammatic, pageBytes: input.pageBytes };
  switch (input.operation.kind) {
    case 'catalog': return { ...base, operation: { kind: 'catalog', input: parseAgentHistoryListInput(input.operation.input) } };
    case 'lookup': {
      const parsed = parseAgentHistoryLookupInput(input.operation.input);
      assertConversation(parsed.conversation, source);
      return { ...base, operation: { kind: 'lookup', input: parsed } };
    }
    case 'rename': {
      const parsed = parseAgentHistoryRenameInput(input.operation.input);
      assertConversation(parsed.conversation, source);
      return { ...base, operation: { kind: 'rename', input: parsed } };
    }
    case 'delete': {
      const parsed = parseAgentHistoryMutationInput(input.operation.input);
      assertConversation(parsed.conversation, source);
      return { ...base, operation: { kind: 'delete', input: parsed } };
    }
    case 'transcript': {
      const parsed = parseAgentHistoryReadInput(input.operation.input);
      assertConversation(parsed.conversation, source);
      return { ...base, operation: { kind: 'transcript', input: parsed } };
    }
  }
}

function assertConversation(ref: AgentHistoryConversationRef, expected: AgentHistorySource): void {
  if (!conversationId.safeParse(ref.conversationId).success) {
    throw new AgentHistoryError('invalid_input', 'Claude conversation IDs must be native session UUIDs.');
  }
  const actual = ref.source;
  if (actual.providerKey !== expected.providerKey || actual.sourceId !== expected.sourceId || actual.generation !== expected.generation) {
    throw new AgentHistoryError('wrong_source', 'Claude worker conversation belongs to another source generation.');
  }
}

export function parseClaudeWorkerRequest(value: unknown): ClaudeWorkerRequest {
  try { return request(value); }
  catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('invalid_input', 'Invalid Claude history worker request.');
  }
}

function response(value: unknown): ClaudeWorkerResponse {
  const captured = captureHistoryData(value);
  if (Buffer.byteLength(JSON.stringify(captured), 'utf8') > CLAUDE_WORKER_OUTPUT_BYTES) {
    throw new AgentHistoryError('native_failure', 'Claude worker response exceeds its envelope.');
  }
  const result = responseSchema.safeParse(captured);
  if (!result.success) throw new AgentHistoryError('native_failure', 'Invalid Claude history worker response.');
  const input = result.data;
  switch (input.kind) {
    case 'catalog': return { version: 1, kind: 'catalog', page: parseAgentHistoryCatalogPage(input.page) };
      case 'mutation': return { version: 1, kind: 'mutation', result: parseAgentHistoryMutationResult(input.result) };
    case 'lookup': return { version: 1, kind: 'lookup', summary: parseAgentHistoryConversationSummary(input.summary) };
    case 'transcript': return { version: 1, kind: 'transcript', page: parseAgentHistoryTranscriptPage(input.page) };
    case 'error': return input;
  }
}

export function parseClaudeWorkerResponse(value: unknown): ClaudeWorkerResponse {
  try { return response(value); }
  catch { throw new AgentHistoryError('native_failure', 'Invalid Claude history worker response.'); }
}
