import { z } from 'zod/v4';
import { AgentHistoryError } from './errors.js';

export interface AgentHistoryLimits {
  readonly pageSize: number;
  readonly pageBytes: number;
  readonly concurrentReads: number;
  readonly deadlineMs: number;
  readonly maximumDeadlineMs: number;
  readonly cleanupDeadlineMs: number;
}

export const DEFAULT_AGENT_HISTORY_LIMITS: AgentHistoryLimits = Object.freeze({
  pageSize: 100,
  pageBytes: 1_048_576,
  concurrentReads: 4,
  deadlineMs: 30_000,
  maximumDeadlineMs: 120_000,
  cleanupDeadlineMs: 10_000,
});

const limitsSchema = z.strictObject({
  pageSize: z.int().min(1).max(100).default(100),
  pageBytes: z.int().min(1).max(1_048_576).default(1_048_576),
  concurrentReads: z.int().min(1).max(4).default(4),
  deadlineMs: z.int().min(1).max(120_000).default(30_000),
  maximumDeadlineMs: z.int().min(1).max(120_000).default(120_000),
  cleanupDeadlineMs: z.int().min(1).max(30_000).default(10_000),
}).refine((limits) => limits.deadlineMs <= limits.maximumDeadlineMs);

export function parseAgentHistoryLimits(input: unknown = {}): AgentHistoryLimits {
  const parsed = limitsSchema.safeParse(input);
  if (!parsed.success) throw new AgentHistoryError('invalid_input', 'History limits are outside the supported bounds.');
  return Object.freeze(parsed.data);
}

export function enforcePageBytes(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) {
    throw new AgentHistoryError('limit_exhausted', 'The history result exceeds its output byte limit.');
  }
}
