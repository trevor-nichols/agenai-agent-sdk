import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { openCodeCursor, openCodeID } from './native.js';

const catalog = z.strictObject({ version: z.literal(1), kind: z.literal('catalog'), cursor: openCodeCursor });
const transcript = z.strictObject({ version: z.literal(1), kind: z.literal('transcript'), cursor: openCodeCursor.optional(),
  messageID: openCodeID.optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(), part: z.int().min(0).max(3000) })
  .refine((value) => value.part === 0 || (value.messageID !== undefined && value.fingerprint !== undefined));
export type OpenCodeTranscriptContinuation = z.infer<typeof transcript>;

function decode(value: string): unknown {
  if (Buffer.byteLength(value) > 8192) throw new AgentHistoryError('invalid_cursor', 'OpenCode continuation exceeds its bound.');
  try { return JSON.parse(value); }
  catch { throw new AgentHistoryError('invalid_cursor', 'Invalid OpenCode history continuation.'); }
}

function encode(value: unknown): string {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 8192) throw new AgentHistoryError('limit_exhausted', 'OpenCode continuation exceeds its bound.');
  return result;
}

export function parseOpenCodeCatalogContinuation(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = catalog.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid OpenCode catalog continuation.');
  return parsed.data.cursor;
}

export function openCodeCatalogContinuation(cursor: string): string {
  return encode(catalog.parse({ version: 1, kind: 'catalog', cursor }));
}

export function parseOpenCodeTranscriptContinuation(value?: string): OpenCodeTranscriptContinuation | undefined {
  if (value === undefined) return undefined;
  const parsed = transcript.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid OpenCode transcript continuation.');
  return parsed.data;
}

export function openCodeTranscriptContinuation(value: OpenCodeTranscriptContinuation): string {
  return encode(transcript.parse(value));
}
