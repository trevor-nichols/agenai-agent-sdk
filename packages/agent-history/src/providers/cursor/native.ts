import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { cursorNativeId } from './worker/protocol.js';

export interface CursorRunHandle {
  readonly runInfo: unknown;
  conversation(): Promise<unknown>;
}

export interface CursorHistorySdk {
  archiveAgent(id: string): Promise<unknown>;
  restoreAgent(id: string): Promise<unknown>;
  deleteAgent(id: string): Promise<unknown>;
  listAgents(input: Readonly<{ limit: number; cursor?: string }>): Promise<unknown>;
  getAgent(id: string): Promise<unknown>;
  listRuns(id: string, input: Readonly<{ limit: number; cursor?: string }>): Promise<unknown>;
  getRun(id: string): Promise<CursorRunHandle>;
  messages(id: string, input: Readonly<{ offset: number; limit: number }>): Promise<unknown>;
  agentDocument(id: string): Promise<unknown>;
  runDocument(agentId: string, runId: string): Promise<unknown>;
  dispose(): Promise<void>;
}

const timestamp = z.int().min(0).max(8_640_000_000_000_000);
const path = z.string().min(1).max(4096);
export const checkpointRef = z.object({ schemaVersion: z.literal(1), rootBlobId: z.string().regex(/^[a-f0-9]{64}$/u) });
export const agentDocument = z.object({
  agentId: cursorNativeId, cwd: path, name: z.string().max(4096).nullable().optional(),
  createdAt: timestamp, updatedAt: timestamp,
  status: z.enum(['idle', 'running', 'error', 'archived']),
  activeRunId: cursorNativeId.nullable().optional(),
  latestCheckpoint: checkpointRef.nullable().optional(),
});
export const agentInfo = z.object({
  agentId: cursorNativeId, name: z.string().max(4096), lastModified: timestamp,
  createdAt: timestamp.optional(), archived: z.boolean().optional(), runtime: z.literal('local'), cwd: path,
});
export const runInfo = z.object({
  id: cursorNativeId, agentId: cursorNativeId,
  status: z.enum(['running', 'finished', 'error', 'cancelled']), createdAt: timestamp.optional(),
});
export const runDocument = z.object({
  runId: cursorNativeId, agentId: cursorNativeId,
  status: z.enum(['queued', 'running', 'finished', 'error', 'cancelled', 'expired']),
  createdAt: timestamp, updatedAt: timestamp,
});
const nativePage = z.object({ items: z.array(z.unknown()).max(1), nextCursor: z.string().min(1).max(8192).optional() });

export function parseCursorNativePage(value: unknown): z.infer<typeof nativePage> {
  return parseCursorNative(nativePage, value);
}

export function parseCursorNative<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentHistoryError('native_failure', 'Cursor SDK returned invalid local history data.');
  return parsed.data;
}

export function cursorNativeJson(value: unknown): unknown {
  try {
    // SDK checkpoint records are protobuf objects; their own JSON projection is
    // converted only inside the worker's hard resource boundary.
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Missing native data');
    if (Buffer.byteLength(text) > 1_048_576) throw new AgentHistoryError('limit_exhausted', 'Cursor native record exceeds its normalization budget.');
    const result: unknown = JSON.parse(text);
    return result;
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('native_failure', 'Cursor SDK returned an unreadable history record.');
  }
}
