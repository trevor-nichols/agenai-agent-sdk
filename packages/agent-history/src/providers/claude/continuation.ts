import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const offset = z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100);
const catalogCursor = z.strictObject({ version: z.literal(1), offset });
const transcriptCursor = z.strictObject({
  version: z.literal(1), offset, part: z.int().min(0).max(1000),
  uuid: z.string().min(1).max(512).optional(),
}).refine((value) => value.part === 0 || value.uuid !== undefined);

export interface ClaudeTranscriptContinuation {
  readonly version: 1;
  readonly offset: number;
  readonly part: number;
  readonly uuid?: string;
}

function decode(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > 512) throw new AgentHistoryError('invalid_cursor', 'Claude history continuation exceeds its bound.');
  try { return JSON.parse(value); }
  catch { throw new AgentHistoryError('invalid_cursor', 'Invalid Claude history continuation.'); }
}

export function parseClaudeCatalogContinuation(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = catalogCursor.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid Claude catalog continuation.');
  return parsed.data.offset;
}

export function claudeCatalogContinuation(value: number): string {
  return JSON.stringify(catalogCursor.parse({ version: 1, offset: value }));
}

export function parseClaudeTranscriptContinuation(value: string | undefined): ClaudeTranscriptContinuation {
  if (value === undefined) return { version: 1, offset: 0, part: 0 };
  const parsed = transcriptCursor.safeParse(decode(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_cursor', 'Invalid Claude transcript continuation.');
  return parsed.data;
}

export function claudeTranscriptContinuation(value: ClaudeTranscriptContinuation): string {
  const encoded = JSON.stringify(transcriptCursor.parse(value));
  if (Buffer.byteLength(encoded, 'utf8') > 512) throw new AgentHistoryError('limit_exhausted', 'Claude history continuation exceeds its bound.');
  return encoded;
}
