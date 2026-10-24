import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryIdSchema } from '../../validation/records.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';
import { GROK_PAGE_BYTES, GrokDirectorySchema } from './native.js';
import { assertGrokInitialization, GROK_RAW_BYTES } from './native.js';
import type { GrokHistoryConnection } from './contracts.js';

const common = z.strictObject({ sourceId: HistoryIdSchema, generation: HistoryIdSchema,
  scope: z.strictObject({ kind: z.literal('project'), projectPath: GrokDirectorySchema, worktrees: z.literal('excluded') }),
  limits: z.unknown().optional(), management: HistoryManagementSelectionSchema.default([]) });
const processSchema = common.extend({ executable: GrokDirectorySchema, nativeHome: GrokDirectorySchema,
  localManagement: z.strictObject({ kind: z.literal('caller_quiescent') }).optional(),
  resources: z.strictObject({ kind: z.literal('linux-prlimit-bubblewrap'), resourceLauncher: GrokDirectorySchema,
    sandboxLauncher: GrokDirectorySchema, temporaryRoot: GrokDirectorySchema }) });

function limits(input: unknown) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw new AgentHistoryError('invalid_input', 'Invalid Grok history limits.');
  const parsed = parseAgentHistoryLimits({ pageBytes: GROK_PAGE_BYTES, concurrentReads: 1,
    deadlineMs: 20_000, maximumDeadlineMs: 20_000, ...input });
  if (parsed.pageBytes > GROK_PAGE_BYTES || parsed.concurrentReads !== 1 || parsed.maximumDeadlineMs > 20_000) {
    throw new AgentHistoryError('invalid_input', 'Grok history limits exceed the qualified operation policy.');
  }
  return parsed;
}
export function parseGrokOptions(input: unknown) {
  const result = common.safeParse(captureHistoryData(input));
  if (!result.success) throw new AgentHistoryError('invalid_input', 'Invalid Grok history source configuration.');
  return Object.freeze({ ...result.data, limits: limits(result.data.limits) });
}
export function parseGrokProcessOptions(input: unknown) {
  const result = processSchema.safeParse(captureHistoryData(input));
  if (!result.success) throw new AgentHistoryError('invalid_input', 'Grok history requires explicit native home and Linux resource launchers.');
  if (result.data.management.some((operation) => operation === 'rename' || operation === 'delete') && result.data.localManagement === undefined) {
    throw new AgentHistoryError('invalid_input', 'Owned Grok management requires the caller to keep the selected native store quiescent.');
  }
  return Object.freeze({ ...result.data, limits: limits(result.data.limits) });
}
export type ResolvedGrokProcessOptions = ReturnType<typeof parseGrokProcessOptions>;

const connectionData = z.strictObject({ protocolProfile: z.literal('schema-v1.23.0'), runtimeVersion: z.literal('1.0.62'),
  initialization: z.unknown(), resources: z.strictObject({ kind: z.literal('caller_owned'),
    maxInboundFrameBytes: z.int().min(1024).max(GROK_RAW_BYTES) }) });

export function parseBorrowedGrokOptions(input: unknown) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
    const { connection: connectionDescriptor, ...data } = Object.getOwnPropertyDescriptors(input);
    if (!connectionDescriptor || !('value' in connectionDescriptor)) throw new Error('Invalid connection');
    const raw: unknown = connectionDescriptor.value;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid connection');
    const { listSessions, sessionState, sessionUpdates, sessionSearch, ...descriptors } = Object.getOwnPropertyDescriptors(raw);
    const method = (descriptor: PropertyDescriptor | undefined) => {
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('Invalid connection method');
      return descriptor.value;
    };
    const list = method(listSessions), state = method(sessionState), updates = method(sessionUpdates);
    const search = sessionSearch === undefined || ('value' in sessionSearch && sessionSearch.value === undefined) ? undefined : method(sessionSearch);
    const metadata = connectionData.parse(captureHistoryData(Object.defineProperties({}, descriptors)));
    assertGrokInitialization(metadata.initialization);
    const connection: GrokHistoryConnection = Object.freeze({ ...metadata,
      listSessions: async (params, options) => Reflect.apply(list, raw, [params, options]),
      sessionState: async (params, options) => Reflect.apply(state, raw, [params, options]),
      sessionUpdates: async (params, options) => Reflect.apply(updates, raw, [params, options]),
      ...(search === undefined ? {} : { sessionSearch: async (params: Parameters<NonNullable<GrokHistoryConnection['sessionSearch']>>[0],
        options: Parameters<NonNullable<GrokHistoryConnection['sessionSearch']>>[1]) => Reflect.apply(search, raw, [params, options]) }),
    });
    return { options: parseGrokOptions(Object.defineProperties({}, data)), connection };
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('invalid_input', 'Grok history requires exact initialization, named read methods and caller-owned transport bounds.');
  }
}
