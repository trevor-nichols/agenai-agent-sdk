import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { codexCursor, codexId } from './native.js';

const catalog = z.strictObject({ version: z.literal(1), kind: z.literal('catalog'), cursor: codexCursor });
const position = { cursor: codexCursor.optional(), recordPart: z.int().min(0).max(1000) };
const transcript = z.discriminatedUnion('mode', [
  z.strictObject({ version: z.literal(1), mode: z.literal('legacy'), ...position,
    turnId: codexId.optional(), itemIndex: z.int().min(0).max(1000), itemId: codexId.optional() }),
  z.strictObject({ version: z.literal(1), mode: z.literal('paginated'), ...position,
    turnId: codexId.optional(), itemId: codexId.optional() }),
]).refine((value) => (value.turnId === undefined) === (value.itemId === undefined)
  && (value.recordPart === 0 || value.itemId !== undefined)
  && (value.mode !== 'legacy' || value.itemIndex === 0 || value.itemId !== undefined));
export type CodexTranscriptContinuation = z.infer<typeof transcript>;

function decode(value: string): unknown {
  if (Buffer.byteLength(value) > 8192) throw new AgentHistoryError('invalid_cursor', 'Codex continuation exceeds its bound.');
  try { return JSON.parse(value); }
  catch { throw new AgentHistoryError('invalid_cursor', 'Invalid Codex history continuation.'); }
}

function encode(value: unknown): string {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 8192) throw new AgentHistoryError('limit_exhausted', 'Codex continuation exceeds its bound.');
  return result;
}

export function parseCodexCatalogContinuation(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = catalog.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid Codex catalog continuation.');
  return parsed.data.cursor;
}

export function codexCatalogContinuation(cursor: string): string {
  return encode(catalog.parse({ version: 1, kind: 'catalog', cursor }));
}

export function parseCodexTranscriptContinuation(value: string | undefined): CodexTranscriptContinuation | undefined {
  if (value === undefined) return undefined;
  const parsed = transcript.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid Codex transcript continuation.');
  return parsed.data;
}

export function codexTranscriptContinuation(value: CodexTranscriptContinuation): string {
  return encode(transcript.parse(value));
}
