import { posix } from 'node:path';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryIdSchema, HistoryNativeIdSchema, HistoryPathSchema } from '../../validation/records.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';
import type { CreateOpenCodeHistoryOptions } from './contracts.js';

const directory = HistoryPathSchema.refine((value) => posix.isAbsolute(value)
  && posix.normalize(value) === value && !value.includes('\0'));
const messageType = z.enum(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic',
  'system', 'skill', 'shell', 'assistant', 'compaction', 'idle']);
const schema = z.strictObject({
  sourceId: HistoryIdSchema, generation: HistoryIdSchema,
  scope: z.strictObject({ kind: z.literal('project'), projectPath: directory, worktrees: z.literal('excluded') }),
  projectID: HistoryNativeIdSchema.optional(),
  server: z.strictObject({ baseUrl: z.string().min(1).max(8192), runtimeVersion: z.literal('2.1.2'),
    headers: z.record(z.string().min(1).max(256), z.string().max(8192)).optional() }),
  resources: z.strictObject({ kind: z.literal('caller_owned') }),
  messageType: messageType.optional(), limits: z.unknown().optional(),
  management: HistoryManagementSelectionSchema.default([]),
});

export interface ResolvedOpenCodeHistoryOptions extends Omit<CreateOpenCodeHistoryOptions, 'limits'> {
  readonly limits: AgentHistoryLimits;
}

export function parseOpenCodeOptions(value: unknown): ResolvedOpenCodeHistoryOptions {
  const result = schema.safeParse(captureHistoryData(value));
  if (!result.success) throw new AgentHistoryError('invalid_input', 'Invalid OpenCode history configuration.');
  const input = result.data;
  let url: URL;
  try { url = new URL(input.server.baseUrl); }
  catch { throw new AgentHistoryError('invalid_input', 'OpenCode history requires an explicit HTTP server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AgentHistoryError('invalid_input', 'OpenCode server URLs must use HTTP without embedded credentials, query or fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const entries = Object.entries(input.server.headers ?? {});
  if (entries.length > 32 || entries.reduce((bytes, [key, header]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(header), 0) > 16_384) {
    throw new AgentHistoryError('limit_exhausted', 'OpenCode server headers exceed their input budget.');
  }
  const headers: Record<string, string> = {};
  try {
    for (const [key, header] of new Headers(input.server.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) throw new Error('Unsupported transport header');
      headers[key] = header;
    }
  } catch { throw new AgentHistoryError('invalid_input', 'OpenCode server headers are invalid.'); }
  if (input.limits !== undefined && (typeof input.limits !== 'object' || input.limits === null || Array.isArray(input.limits))) {
    throw new AgentHistoryError('invalid_input', 'Invalid OpenCode history limits.');
  }
  const limits = parseAgentHistoryLimits({ pageBytes: 196_608, maximumDeadlineMs: 30_000, ...input.limits });
  if (limits.pageBytes > 196_608 || limits.maximumDeadlineMs > 30_000) {
    throw new AgentHistoryError('invalid_input', 'OpenCode history limits exceed the qualified client policy.');
  }
  return Object.freeze({ ...input, scope: Object.freeze(input.scope), limits,
    server: Object.freeze({ ...input.server, baseUrl: url.href, headers: Object.freeze(headers) }) });
}
