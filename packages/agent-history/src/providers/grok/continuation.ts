import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const position = z.strictObject({ version: z.literal(1), offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100),
  revision: digest, total: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100),
  previous: z.strictObject({ offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100), fingerprint: digest }).optional(),
}).refine((value) => value.offset <= value.total && (value.offset === 0 || value.previous?.offset === value.offset - 1));
export type GrokTranscriptPosition = z.infer<typeof position>;

export function grokTranscriptPosition(value: string | undefined, revision: string): GrokTranscriptPosition | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = position.parse(JSON.parse(value));
    if (parsed.revision !== revision) throw new Error('Changed state');
    return parsed;
  } catch { throw new AgentHistoryError('invalid_cursor', 'The saved Grok session changed or its continuation is invalid.'); }
}
export function encodeGrokPosition(value: GrokTranscriptPosition): string { return JSON.stringify(value); }
