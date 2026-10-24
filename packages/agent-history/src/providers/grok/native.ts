import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { AgentHistoryValidationError } from '../../validation/errors.js';
import { HistoryNativeIdSchema, HistoryPathSchema } from '../../validation/records.js';
import { AcpHistorySessionSchema, acpHistoryNegotiatedList } from '../acp/native.js';

export const GROK_RAW_BYTES = 1_048_576;
export const GROK_PAGE_BYTES = 196_608;
export const GrokDirectorySchema = HistoryPathSchema.refine((value) => value.startsWith('/') && !value.includes('\0'));
export const GrokSessionIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu);
const time = z.string().min(1).max(128).refine((value) => Number.isFinite(Date.parse(value)));
export const GrokSummarySchema = z.object({
  info: z.object({ id: GrokSessionIdSchema, cwd: GrokDirectorySchema }),
  generated_title: z.string().max(2000).nullable().optional(), session_summary: z.string().max(2000).nullable().optional(),
  created_at: time.optional(), updated_at: time.optional(), current_model_id: z.string().max(512).nullable().optional(),
  parent_session_id: GrokSessionIdSchema.nullable().optional(), session_kind: z.string().max(128).optional(),
}).passthrough();
export const GrokStateSchema = z.object({ summary: GrokSummarySchema });
export const GrokStateParamsSchema = z.strictObject({ sessionId: GrokSessionIdSchema, cwd: GrokDirectorySchema });
export const GrokUpdatesParamsSchema = GrokStateParamsSchema.extend({ offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100), limit: z.literal(1) });
export const GrokUpdatesSchema = z.object({ updates: z.array(z.unknown()).max(1), totalCount: z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100),
  hasMore: z.boolean(), promptStarts: z.array(z.int().min(0).max(Number.MAX_SAFE_INTEGER - 100)).max(100_000).optional() });
export const GrokSearchParamsSchema = z.strictObject({ query: z.string().min(1).max(2000), cwd: GrokDirectorySchema,
  limit: z.int().min(1).max(100), offset: z.int().min(0).max(1000), includeContent: z.literal(true), headless: z.literal('exclude') });
export const GrokSearchSchema = z.object({ results: z.array(z.object({ sessionId: GrokSessionIdSchema, cwd: GrokDirectorySchema,
  summary: z.string().max(2000), updatedAt: time, score: z.number(),
  matchedFields: z.array(z.enum(['title', 'content', 'session_id'])).max(3), snippet: z.string().max(8192).optional() })).max(100),
  nextOffset: z.int().min(0).max(1100).nullable(), totalEstimate: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), bootstrapping: z.boolean() });
export const GrokSearchResponseSchema = z.union([z.object({ result: GrokSearchSchema, error: z.never().optional() }), z.object({ error: z.string().max(8192) })]);
export const GrokRenameParamsSchema = GrokStateParamsSchema.extend({ title: z.string().min(1).refine((value) => [...value].length <= 100
  && Buffer.byteLength(value) <= 464 && value.trim() === value && !/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value)), kind: z.literal('build') });
export const GrokDeleteParamsSchema = GrokStateParamsSchema.extend({ kind: z.literal('build') });
export const GrokMutationReceiptSchema = z.object({ success: z.literal(true) });
const session = AcpHistorySessionSchema.extend({ sessionId: GrokSessionIdSchema,
  _meta: z.object({ 'x.ai/session': z.object({ kind: z.literal('build') }) }) });
export const GrokListSchema = z.object({ sessions: z.array(session).max(1000), nextCursor: z.string().min(1).max(8192).nullable().optional() });
const initialization = z.object({ _meta: z.object({ grokShell: z.literal(true), agentVersion: z.literal('1.0.62') }) });
export const GrokUpdateParamsSchema = z.object({ sessionId: GrokSessionIdSchema,
  update: z.object({ sessionUpdate: z.string().min(1).max(256) }).passthrough(),
  _meta: z.object({ eventId: HistoryNativeIdSchema.optional() }).optional() });
export const GrokEnvelopeSchema = z.object({
  timestamp: z.union([time, z.int().min(0).max(8_640_000_000_000)]).optional(),
  method: z.string().min(1).max(256).optional(), params: z.unknown().optional(),
}).passthrough();

export function parseGrokNative<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  try {
    const captured = captureHistoryData(input);
    if (Buffer.byteLength(JSON.stringify(captured)) > GROK_RAW_BYTES) throw new AgentHistoryError('limit_exhausted', 'The Grok native response exceeds 1 MiB.');
    const parsed = schema.safeParse(captured);
    if (!parsed.success) throw new Error('Invalid native response');
    return parsed.data;
  } catch (error) {
    if (error instanceof AgentHistoryError && error.code === 'limit_exhausted') throw error;
    if (error instanceof AgentHistoryValidationError && error.issues.some((issue) => ['byte_limit', 'entry_limit', 'value_limit', 'depth_limit'].includes(issue.code))) {
      throw new AgentHistoryError('limit_exhausted', 'The Grok history response exceeds its data budget.');
    }
    throw new AgentHistoryError('native_failure', 'Grok returned an invalid history response.');
  }
}

export function assertGrokInitialization(value: unknown): void {
  if (!acpHistoryNegotiatedList(value) || !initialization.safeParse(captureHistoryData(value)).success) {
    throw new AgentHistoryError('unsupported_scope', 'Grok history requires the observed Grok Build 1.0.62 initialization and negotiated session listing.');
  }
}
