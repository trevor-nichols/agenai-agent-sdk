import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { parseAgentHistorySourceIdentity } from '../../validation/parse.js';
import { HistoryIdSchema } from '../../validation/records.js';
import type { AcpHistoryConnection, CreateAcpHistoryOptions } from './contracts.js';
import { AcpHistoryDirectorySchema, ACP_HISTORY_NATIVE_BYTES, ACP_HISTORY_PAGE_BYTES, acpHistoryNegotiatedList } from './native.js';

const options = z.strictObject({ providerKey: z.string().min(1).max(100), sourceId: HistoryIdSchema, generation: HistoryIdSchema,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectPath: AcpHistoryDirectorySchema, worktrees: z.literal('excluded') }),
    z.strictObject({ kind: z.literal('all_projects') }),
  ]), limits: z.unknown().optional(),
});
const connectionData = z.strictObject({ protocolProfile: z.literal('schema-v1.23.0'), initialization: z.unknown(),
  resources: z.strictObject({ kind: z.literal('caller_owned'), maxInboundFrameBytes: z.int().min(1024).max(ACP_HISTORY_NATIVE_BYTES) }),
});

export interface ResolvedAcpHistoryOptions extends Omit<CreateAcpHistoryOptions, 'limits'> {
  readonly limits: AgentHistoryLimits;
  readonly listSupported: boolean;
}

export function parseAcpHistoryOptions(value: unknown): ResolvedAcpHistoryOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AgentHistoryError('invalid_input', 'Invalid ACP history configuration.');
  const { connection: descriptor, ...data } = Object.getOwnPropertyDescriptors(value);
  if (!descriptor || !('value' in descriptor)) throw new AgentHistoryError('invalid_input', 'An initialized ACP history connection is required.');
  const raw: unknown = descriptor.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentHistoryError('invalid_input', 'Invalid ACP history connection.');
  const { listSessions: _methodDescriptor, ...connectionDescriptors } = Object.getOwnPropertyDescriptors(raw);
  const method: unknown = Reflect.get(raw, 'listSessions');
  if (typeof method !== 'function') throw new AgentHistoryError('invalid_input', 'An ACP list session port is required.');
  const parsed = options.safeParse(captureHistoryData(Object.defineProperties({}, data)));
  const native = connectionData.safeParse(captureHistoryData(Object.defineProperties({}, connectionDescriptors)));
  if (!parsed.success || !native.success) throw new AgentHistoryError('invalid_input', 'ACP history requires explicit scope, initialization and caller-owned ingress bounds.');
  const identity = parseAgentHistorySourceIdentity({ providerKey: parsed.data.providerKey,
    sourceId: parsed.data.sourceId, generation: parsed.data.generation });
  const input = parsed.data.limits;
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw new AgentHistoryError('invalid_input', 'Invalid ACP history limits.');
  const limits = parseAgentHistoryLimits({ pageBytes: ACP_HISTORY_PAGE_BYTES, concurrentReads: 1, maximumDeadlineMs: 30_000, ...input });
  if (limits.pageBytes > ACP_HISTORY_PAGE_BYTES || limits.maximumDeadlineMs > 30_000) throw new AgentHistoryError('invalid_input', 'ACP history limits exceed the supported operation policy.');
  const listSupported = acpHistoryNegotiatedList(native.data.initialization);
  const connection: AcpHistoryConnection = Object.freeze({ ...native.data,
    listSessions: async (params, context) => Reflect.apply(method, raw, [params, context]),
  });
  return Object.freeze({ ...parsed.data, ...identity, connection, limits, listSupported });
}
