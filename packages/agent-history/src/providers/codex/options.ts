import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';
import type { CodexHistoryConnection, CodexHistoryOptions, CodexHistoryRequest, CodexHistoryRequestContext, CodexHistorySourceKind, CreateCodexHistoryProcessOptions } from './contracts.js';

const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'] as const;
const absolutePath = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'));
const common = {
  sourceId: z.string().min(1).max(128), generation: z.string().min(1).max(128),
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectPath: absolutePath, worktrees: z.literal('excluded') }),
    z.strictObject({ kind: z.literal('all_projects') }),
  ]),
  catalogPolicy: z.enum(['scan_and_repair', 'state_db_only']),
  sourceKinds: z.array(z.enum(sourceKinds)).min(1).max(sourceKinds.length)
    .refine((kinds) => new Set(kinds).size === kinds.length).default([...sourceKinds]),
  limits: z.unknown().optional(),
  management: HistoryManagementSelectionSchema.default([]),
};
const borrowedSchema = z.strictObject({ ...common, resources: z.strictObject({ kind: z.literal('caller_owned') }) });
const processSchema = z.strictObject({ ...common, executable: absolutePath, configHome: absolutePath,
  resources: z.strictObject({ kind: z.literal('linux-prlimit-bubblewrap'), resourceLauncher: absolutePath,
    sandboxLauncher: absolutePath, temporaryRoot: absolutePath }),
});

export interface ResolvedCodexHistoryOptions extends Omit<CodexHistoryOptions, 'sourceKinds' | 'limits'> {
  readonly sourceKinds: readonly CodexHistorySourceKind[];
  readonly limits: AgentHistoryLimits;
}
export interface ResolvedCodexHistoryProcessOptions extends ResolvedCodexHistoryOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly resources: CreateCodexHistoryProcessOptions['resources'];
}

function limits(input: unknown): AgentHistoryLimits {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new AgentHistoryError('invalid_input', 'Invalid Codex history limits.');
  }
  const parsed = parseAgentHistoryLimits({ pageBytes: 196_608, concurrentReads: 1,
    deadlineMs: 30_000, maximumDeadlineMs: 30_000, ...input });
  if (parsed.pageBytes > 196_608 || parsed.maximumDeadlineMs > 30_000) {
    throw new AgentHistoryError('invalid_input', 'Codex history limits exceed its qualified operation policy.');
  }
  return parsed;
}

export function parseBorrowedCodexOptions(value: unknown): Readonly<{
  options: ResolvedCodexHistoryOptions; connection: CodexHistoryConnection;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentHistoryError('invalid_input', 'Invalid Codex history configuration.');
  }
  const { connection: descriptor, ...data } = Object.getOwnPropertyDescriptors(value);
  if (!descriptor || !('value' in descriptor)) throw new AgentHistoryError('invalid_input', 'An initialized Codex history connection is required.');
  const connection: unknown = descriptor.value;
  const parsed = borrowedSchema.safeParse(captureHistoryData(Object.defineProperties({}, data)));
  if (!parsed.success || connection === null || typeof connection !== 'object'
    || !('runtimeVersion' in connection) || connection.runtimeVersion !== '0.163.0'
    || !('request' in connection) || typeof connection.request !== 'function') {
    throw new AgentHistoryError('invalid_input', 'Codex history requires the qualified initialized local connection and explicit resource ownership.');
  }
  const request = connection.request;
  const captured: CodexHistoryConnection = Object.freeze({ runtimeVersion: '0.163.0',
    request: async (input: CodexHistoryRequest, context: CodexHistoryRequestContext) => {
      const response: unknown = await Reflect.apply(request, connection, [input, context]);
      if (!(response instanceof Uint8Array)) throw new AgentHistoryError('native_failure', 'Codex history requires a bounded UTF-8 response envelope.');
      return response;
    },
  });
  return { options: Object.freeze({ ...parsed.data, limits: limits(parsed.data.limits) }), connection: captured };
}

export function parseCodexProcessOptions(value: unknown): ResolvedCodexHistoryProcessOptions {
  const parsed = processSchema.safeParse(captureHistoryData(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_input', 'Invalid Codex history process configuration.');
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new AgentHistoryError('unsupported_scope', 'The owned Codex history process requires the qualified Linux x86_64 tuple.');
  }
  return Object.freeze({ ...parsed.data, limits: limits(parsed.data.limits) });
}
