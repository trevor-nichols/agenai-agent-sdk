import { z } from 'zod/v4';
import type { AgentHistoryDriverContext } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { AgentHistoryValidationError } from '../../validation/errors.js';
import type { CodexHistoryConnection, CodexHistoryRequest } from './contracts.js';

export const CODEX_RESPONSE_BYTES = 2_097_152;
export const CODEX_MAX_NATIVE_CALLS = 8;
export const codexId = z.string().min(1).max(512).refine((value) => value.trim() === value && !/[\u0000-\u001F\u007F-\u009F]/u.test(value));
export const codexCursor = z.string().min(1).max(4096).refine((value) => Buffer.byteLength(value) <= 4096);
export const codexItemSchema = z.looseObject({ type: z.string().min(1).max(120), id: codexId });
export type CodexNativeItem = z.infer<typeof codexItemSchema>;

const epochSeconds = z.number().finite().min(0).max(8_640_000_000_000);
export const codexThreadSchema = z.object({
  id: codexId, historyMode: z.enum(['legacy', 'paginated']), cwd: z.string().min(1).max(4096),
  preview: z.string(), name: z.string().nullable().optional(), model: z.string().nullable().optional(),
  createdAt: epochSeconds, updatedAt: epochSeconds, parentThreadId: codexId.nullable().optional(),
  source: z.unknown().optional(),
  status: z.object({ type: z.string().min(1).max(100) }).optional(),
});
export type CodexNativeThread = z.infer<typeof codexThreadSchema>;

const sourceVariant = z.object({ subAgent: z.unknown().optional() });
const subAgentVariant = z.object({ thread_spawn: z.unknown().optional() });
const threadSpawnParent = z.object({ parent_thread_id: codexId });

export function codexThreadParentId(thread: CodexNativeThread): string | undefined {
  if (thread.parentThreadId != null) return thread.parentThreadId;
  const source = sourceVariant.safeParse(thread.source);
  if (!source.success) return undefined;
  const subAgent = subAgentVariant.safeParse(source.data.subAgent);
  if (!subAgent.success || !Object.hasOwn(subAgent.data, 'thread_spawn')) return undefined;
  return parseCodexNative(threadSpawnParent, subAgent.data.thread_spawn).parent_thread_id;
}

const envelopeSchema = z.object({
  id: z.union([z.int(), z.string().min(1).max(128)]),
  method: z.never().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string().max(16_384) }).optional(),
}).refine((value) => Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'));

export function parseCodexNative<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentHistoryError('native_failure', 'Codex returned invalid native history data.');
  return result.data;
}

export function captureCodexNative(value: unknown): unknown {
  try { return captureHistoryData(value); }
  catch (error) {
    if (error instanceof AgentHistoryValidationError && error.issues.some((issue) => /_limit$/u.test(issue.code))) {
      throw new AgentHistoryError('limit_exhausted', 'Codex native history exceeds the supported structural bounds.');
    }
    throw new AgentHistoryError('native_failure', 'Codex returned invalid native history data.');
  }
}

function nativeError(code: number, message: string): AgentHistoryError {
  if ((code === -32600 || code === -32602) && /invalid cursor|anchor.*no longer present/iu.test(message)) {
    return new AgentHistoryError('invalid_cursor', 'Codex history continuation is invalid or no longer identifies retained history.');
  }
  if (code === -32600 && /^(?:thread not loaded:|thread not found:|no rollout found for thread id )/u.test(message)) {
    return new AgentHistoryError('not_found', 'Codex saved thread is missing or unavailable.');
  }
  if (code === -32601) return new AgentHistoryError('unsupported_scope', 'This Codex history operation is unavailable for the native store.');
  if (code === -32602 || (code === -32600 && /^invalid thread id:/u.test(message))) {
    return new AgentHistoryError('invalid_input', 'Codex rejected the native history request.');
  }
  return new AgentHistoryError('native_failure', 'Codex could not complete the native history operation.');
}

export interface CodexRequester {
  call(request: CodexHistoryRequest, receive?: (result: unknown) => void): Promise<unknown>;
}

export function codexRequester(connection: CodexHistoryConnection, context: AgentHistoryDriverContext): CodexRequester {
  let calls = 0;
  return { async call(request, receive) {
    if (calls >= CODEX_MAX_NATIVE_CALLS) throw new AgentHistoryError('limit_exhausted', 'Codex history native request capacity is exhausted.');
    context.signal.throwIfAborted();
    calls += 1;
    context.markDispatched();
    const bytes = await connection.request(request, { signal: context.signal, maxResponseBytes: CODEX_RESPONSE_BYTES });
    if (receive === undefined) context.signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new AgentHistoryError('native_failure', 'Codex history returned an invalid response frame.');
    if (bytes.byteLength > CODEX_RESPONSE_BYTES) throw new AgentHistoryError('limit_exhausted', 'Codex history response exceeds its raw byte bound.');
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AgentHistoryError('native_failure', 'Codex history returned invalid UTF-8 JSON.'); }
    const envelope = parseCodexNative(envelopeSchema, captureCodexNative(raw));
    if (envelope.error !== undefined) throw nativeError(envelope.error.code, envelope.error.message);
    receive?.(envelope.result);
    return envelope.result;
  } };
}
