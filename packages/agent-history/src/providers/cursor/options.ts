import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from '../../lifecycle/limits.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';
import type { CreateCursorHistoryOptions } from './contracts.js';

const path = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'));
const options = z.strictObject({
  sourceId: z.string().min(1).max(128), generation: z.string().min(1).max(128),
  store: z.strictObject({ kind: z.enum(['jsonl', 'sqlite']), path }),
  scope: z.strictObject({ kind: z.literal('project'), projectPath: path, worktrees: z.literal('excluded') }),
  resources: z.strictObject({ kind: z.literal('linux-prlimit'), executable: path, temporaryRoot: path }),
  limits: z.unknown().optional(), management: HistoryManagementSelectionSchema.default([]),
});

export interface ResolvedCursorHistoryOptions extends Omit<CreateCursorHistoryOptions, 'limits' | 'management'> {
  readonly limits: AgentHistoryLimits;
  readonly management: readonly AgentHistoryMutationOperation[];
}

export function parseCursorHistoryOptions(input: unknown): ResolvedCursorHistoryOptions {
  try {
    const parsed = options.safeParse(captureHistoryData(input));
    if (!parsed.success || process.platform !== 'linux') throw new Error('Unsupported local source');
    const limits = parseAgentHistoryLimits(parsed.data.limits);
    return { ...parsed.data, limits: { ...limits, pageBytes: Math.min(limits.pageBytes, 196_608) } };
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('invalid_input', 'Cursor local history requires explicit project/store paths and the qualified Linux resource policy.');
  }
}
