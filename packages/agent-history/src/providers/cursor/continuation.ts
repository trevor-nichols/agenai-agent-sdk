import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const catalog = z.strictObject({ version: z.literal(1), kind: z.enum(['catalog', 'views']), cursor: z.string().min(1).max(8192) });
const transcript = z.strictObject({
  version: z.literal(1), kind: z.literal('transcript'),
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100), part: z.int().min(0).max(100_000),
  revision: z.string().min(1).max(256), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
export type CursorTranscriptPosition = z.infer<typeof transcript>;

export function nativeCatalogCursor(value: string | undefined, kind: 'catalog' | 'views'): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = catalog.safeParse(JSON.parse(value));
    if (!parsed.success || parsed.data.kind !== kind) throw new Error('Wrong cursor');
    return parsed.data.cursor;
  } catch { throw new AgentHistoryError('invalid_cursor', 'Invalid Cursor local catalog continuation.'); }
}

export function encodeCursorCatalog(cursor: string | undefined, kind: 'catalog' | 'views'): string | undefined {
  return cursor === undefined ? undefined : JSON.stringify({ version: 1, kind, cursor });
}

export function nativeTranscriptCursor(value: string | undefined, revision: string): CursorTranscriptPosition {
  if (value === undefined) return { version: 1, kind: 'transcript', offset: 0, part: 0, revision };
  try {
    const parsed = transcript.safeParse(JSON.parse(value));
    if (!parsed.success || parsed.data.revision !== revision || (parsed.data.part > 0 && parsed.data.fingerprint === undefined)) throw new Error('Changed checkpoint');
    return parsed.data;
  } catch { throw new AgentHistoryError('invalid_cursor', 'Cursor history changed or its transcript continuation is invalid.'); }
}

export function encodeCursorTranscript(position: CursorTranscriptPosition): string {
  return JSON.stringify(position);
}
