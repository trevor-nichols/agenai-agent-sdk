import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';

export type ClaudeHistoryScope =
  | Readonly<{ kind: 'project'; projectPath: string; worktrees: 'included' | 'excluded' }>
  | Readonly<{ kind: 'all_projects' }>;

export interface ClaudeHistoryResourcePolicy {
  readonly kind: 'linux-prlimit';
  readonly executable: string;
  readonly temporaryRoot: string;
}

export interface CreateClaudeHistoryOptions {
  readonly sourceId: string;
  readonly generation: string;
  readonly configHome: string;
  readonly scope: ClaudeHistoryScope;
  readonly includeProgrammatic?: boolean;
  readonly resources: ClaudeHistoryResourcePolicy;
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}

export interface ResolvedClaudeHistoryOptions extends Omit<CreateClaudeHistoryOptions, 'includeProgrammatic' | 'limits' | 'management'> {
  readonly includeProgrammatic: boolean;
  readonly management: readonly AgentHistoryMutationOperation[];
  readonly limits: AgentHistoryLimits;
}

const absolutePath = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'));
const optionsSchema = z.strictObject({
  sourceId: z.string().min(1).max(128), generation: z.string().min(1).max(128), configHome: absolutePath,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectPath: absolutePath, worktrees: z.enum(['included', 'excluded']) }),
    z.strictObject({ kind: z.literal('all_projects') }),
  ]),
  includeProgrammatic: z.boolean().default(true),
  resources: z.strictObject({ kind: z.literal('linux-prlimit'), executable: absolutePath, temporaryRoot: absolutePath }),
  limits: z.unknown().optional(), management: HistoryManagementSelectionSchema.default([]),
});

export function parseClaudeHistoryOptions(value: unknown): ResolvedClaudeHistoryOptions {
  const parsed = optionsSchema.safeParse(captureHistoryData(value));
  if (!parsed.success) throw new AgentHistoryError('invalid_input', 'Invalid Claude history configuration.');
  if (process.platform !== 'linux') throw new AgentHistoryError('unsupported_scope', 'Claude history requires the qualified Linux resource policy.');
  const input = parsed.data;
  const selected = input.limits === undefined ? {} : input.limits;
  if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new AgentHistoryError('invalid_input', 'Invalid Claude history limits.');
  }
  const limits = parseAgentHistoryLimits({ pageBytes: 196_608, deadlineMs: 20_000, maximumDeadlineMs: 20_000, ...selected });
  if (limits.pageBytes > 196_608 || limits.maximumDeadlineMs > 20_000) {
    throw new AgentHistoryError('invalid_input', 'Claude history limits exceed the qualified worker policy.');
  }
  return Object.freeze({ ...input, limits });
}
