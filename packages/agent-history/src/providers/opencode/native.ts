import { z } from 'zod/v4';
import type { AgentHistoryDriverContext } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { AgentHistoryValidationError } from '../../validation/errors.js';
import { HistoryNativeIdSchema } from '../../validation/records.js';
import type { OpenCodeHistoryClient, OpenCodeMessageListInput, OpenCodeSessionListInput } from './contracts.js';

export const OPENCODE_RESPONSE_BYTES = 1_048_576;
export const openCodeID = HistoryNativeIdSchema;
export const openCodeCursor = z.string().min(1).max(4096).refine((value) => Buffer.byteLength(value) <= 4096);
export const openCodeTime = z.number().finite().min(0).max(8_640_000_000_000_000);
export const openCodeSession = z.object({
  id: openCodeID, parentID: openCodeID.optional(), projectID: openCodeID,
  title: z.string().optional(), location: z.object({ directory: z.string().min(1).max(4096) }),
  model: z.object({ id: z.string().min(1).max(512) }).optional(),
  time: z.object({ created: openCodeTime, updated: openCodeTime, archived: openCodeTime.optional() }),
});
export type OpenCodeSession = z.infer<typeof openCodeSession>;
export const openCodeMessage = z.looseObject({ id: openCodeID, type: z.string().min(1).max(120), time: z.object({ created: openCodeTime }) });
export type OpenCodeMessage = z.infer<typeof openCodeMessage>;
const endpointCursor = openCodeCursor.nullish().transform((value) => value ?? undefined);
export const openCodePagination = z.object({ next: endpointCursor, previous: endpointCursor });

export function parseOpenCodeNative<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentHistoryError('native_failure', 'OpenCode returned invalid native history data.');
  return parsed.data;
}

function capture(value: unknown): unknown {
  try { return captureHistoryData(value); }
  catch (error) {
    if (error instanceof AgentHistoryValidationError && error.issues.some((issue) => /_limit$/u.test(issue.code))) {
      throw new AgentHistoryError('limit_exhausted', 'OpenCode native history exceeds its structural bounds.');
    }
    throw new AgentHistoryError('native_failure', 'OpenCode returned invalid native history data.');
  }
}

export interface OpenCodeRequester {
  session(id: string): Promise<unknown>;
  sessions(input: OpenCodeSessionListInput): Promise<unknown>;
  messages(input: OpenCodeMessageListInput): Promise<unknown>;
  active(): Promise<unknown>;
}

export function openCodeRequester(client: OpenCodeHistoryClient, context: AgentHistoryDriverContext): OpenCodeRequester {
  let calls = 0;
  const call = async (operation: () => Promise<unknown>): Promise<unknown> => {
    if (calls >= 8) throw new AgentHistoryError('limit_exhausted', 'OpenCode history native request capacity is exhausted.');
    context.signal.throwIfAborted();
    calls += 1;
    context.markDispatched();
    const value = await operation();
    context.signal.throwIfAborted();
    return capture(value);
  };
  return { session: (id) => call(() => client.session(id, context.signal)),
    sessions: (input) => call(() => client.sessions(input, context.signal)),
    messages: (input) => call(() => client.messages(input, context.signal)),
    active: () => call(() => client.active(context.signal)) };
}
