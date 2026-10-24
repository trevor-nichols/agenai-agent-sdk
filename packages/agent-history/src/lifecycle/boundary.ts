import type { AgentHistoryConversationRef, AgentHistoryConversationSummary, AgentHistoryOperationOptions, AgentHistorySourceIdentity, AgentHistoryUnsupportedReason } from '../contracts/index.js';
import { parseAgentHistoryUnsupportedReason } from '../validation/parse.js';
import { AgentHistoryError, OperationFailure } from './errors.js';

export function operationOptions(input: AgentHistoryOperationOptions = {}): AgentHistoryOperationOptions {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => key !== 'signal' && key !== 'deadlineMs')
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
    throw new AgentHistoryError('invalid_input', 'Invalid history operation options.');
  }
  return { signal: input.signal, deadlineMs: input.deadlineMs };
}

export function assertSource(ref: AgentHistoryConversationRef, source: AgentHistorySourceIdentity): void {
  if (ref.source.providerKey !== source.providerKey || ref.source.sourceId !== source.sourceId || ref.source.generation !== source.generation) {
    throw new AgentHistoryError('wrong_source', 'The conversation belongs to a different history source or generation.');
  }
}

export function assertSummarySource(summary: AgentHistoryConversationSummary, source: AgentHistorySourceIdentity): void {
  assertSource(summary.ref, source);
  if (summary.parent) assertSource(summary.parent, source);
}

export function unsupported(reason: AgentHistoryUnsupportedReason): Readonly<{ status: 'unsupported'; reason: AgentHistoryUnsupportedReason }> {
  return Object.freeze({ status: 'unsupported', reason: parseAgentHistoryUnsupportedReason(reason) });
}

export function method(value: unknown): void {
  if (typeof value !== 'function') throw new AgentHistoryError('invalid_input', 'A supported history port must provide its method.');
}

export async function readResult<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw error instanceof OperationFailure ? error.error : error; }
}
