import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryPathSchema } from '../../validation/records.js';

export const ACP_HISTORY_NATIVE_BYTES = 1_048_576;
export const ACP_HISTORY_PAGE_BYTES = 196_608;
export const AcpHistoryDirectorySchema = HistoryPathSchema.refine((value) =>
  (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) && !value.includes('\0'));
const capability = z.object({}).nullable().optional();
const initialization = z.object({ protocolVersion: z.literal(1),
  agentCapabilities: z.object({ sessionCapabilities: z.object({ list: capability }).optional() }).optional(),
});
export const AcpHistorySessionSchema = z.object({ sessionId: z.string().min(1).max(16_384), cwd: AcpHistoryDirectorySchema,
  additionalDirectories: z.array(AcpHistoryDirectorySchema).max(1000).optional(),
  title: z.string().max(2000).nullable().optional(), updatedAt: z.string().max(128).nullable().optional(),
});
export const AcpHistoryListSchema = z.object({ sessions: z.array(AcpHistorySessionSchema).max(1000), nextCursor: z.string().min(1).max(8192).nullable().optional() });

export function acpHistoryNegotiatedList(value: unknown): boolean {
  try {
    const parsed = initialization.safeParse(captureHistoryData(value));
    if (!parsed.success) throw new Error('Invalid initialization');
    return parsed.data.agentCapabilities?.sessionCapabilities?.list != null;
  } catch { throw new AgentHistoryError('invalid_input', 'ACP history requires the observed protocol version 1 initialization response.'); }
}

export function parseAcpHistoryList(value: unknown): z.infer<typeof AcpHistoryListSchema> {
  try {
    const parsed = AcpHistoryListSchema.safeParse(captureHistoryData(value));
    if (!parsed.success) throw new Error('Invalid native catalog');
    return parsed.data;
  } catch { throw new AgentHistoryError('native_failure', 'The ACP peer returned an invalid or oversized session catalog.'); }
}
