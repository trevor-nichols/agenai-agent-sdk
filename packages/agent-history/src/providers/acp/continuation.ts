import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const continuation = z.strictObject({ version: z.literal(1), cursor: z.string().min(1).max(8192).optional(),
  offset: z.int().min(0).max(1000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).refine((value) => value.offset === 0 || value.fingerprint !== undefined);
export type AcpHistoryPosition = z.infer<typeof continuation>;

export function acpHistoryPosition(value: string | undefined): AcpHistoryPosition {
  if (value === undefined) return { version: 1, offset: 0 };
  try { return continuation.parse(JSON.parse(value)); }
  catch { throw new AgentHistoryError('invalid_cursor', 'The ACP catalog continuation is invalid.'); }
}

export function encodeAcpHistoryPosition(value: AcpHistoryPosition): string {
  return JSON.stringify(value);
}
