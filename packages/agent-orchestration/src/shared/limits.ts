// ------------------------------------------------------------------------------------------------
//                limits.ts - Finite operational defaults and format ceilings
// ------------------------------------------------------------------------------------------------

import { z } from "zod/v4";
import { copyBoundedDelegationData } from "./bounds.js";
import { delegationSchemaError } from "./errors.js";
import { freezeDelegationData } from "./immutable.js";

export const DELEGATION_FINAL_RESERVATION_BYTES = 32_768;
export const DELEGATION_FAILURE_BYTES = 2_048;
export const DELEGATION_CRITICAL_SLOT_BYTES = 2_048;
export const DELEGATION_CRITICAL_SLOTS = 4;
export const DELEGATION_RUN_RESERVATION_BYTES = 40_960;

export interface DelegationLimits {
  readonly maxActiveRuns: number;
  readonly maxQueuedRuns: number;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxRuns: number;
  readonly maxRunsPerTask: number;
  readonly maxInputBytes: number;
  readonly maxInputTextCharacters: number;
  readonly maxRetainedInputBytes: number;
  readonly maxObservationBytes: number;
  readonly maxRunObservationBytes: number;
  readonly maxRunObservations: number;
  readonly maxRetainedObservationBytes: number;
  readonly maxOrdinaryOperationsPerRun: number;
  readonly maxOrdinaryOperations: number;
  readonly runTimeoutMs: number;
  readonly queuedStartTimeoutMs: number;
  readonly maxWaitMs: number;
  readonly controlTimeoutMs: number;
  readonly notificationTtlMs: number;
  readonly maxPageRecords: number;
  readonly maxPageBytes: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = Object.freeze({
  maxActiveRuns: 4, maxQueuedRuns: 32, maxDepth: 2, maxTasks: 256, maxRuns: 1_024, maxRunsPerTask: 8,
  maxInputBytes: 24_576, maxInputTextCharacters: 16_000, maxRetainedInputBytes: 16_777_216,
  maxObservationBytes: 8_192, maxRunObservationBytes: 1_048_576, maxRunObservations: 2_048,
  maxRetainedObservationBytes: 33_554_432, maxOrdinaryOperationsPerRun: 32, maxOrdinaryOperations: 8_192,
  runTimeoutMs: 1_800_000, queuedStartTimeoutMs: 300_000, maxWaitMs: 30_000, controlTimeoutMs: 10_000,
  notificationTtlMs: 86_400_000, maxPageRecords: 100, maxPageBytes: 65_536,
});

const finite = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.strictObject(Object.fromEntries(Object.entries(DEFAULT_DELEGATION_LIMITS)
  .map(([key, value]) => [key, finite.default(value)])) as Record<keyof DelegationLimits, z.ZodDefault<typeof finite>>)
  .superRefine((value, context) => {
    for (const [smaller, larger] of [
      ["maxActiveRuns", "maxRuns"], ["maxQueuedRuns", "maxRuns"], ["maxTasks", "maxRuns"],
      ["maxRunsPerTask", "maxRuns"], ["maxInputBytes", "maxRetainedInputBytes"],
    ] as const) {
      if (value[smaller] > value[larger]) context.addIssue({ code: "custom", path: [smaller], message: `${smaller} exceeds ${larger}.` });
    }
    if (value.maxPageRecords > 100 || value.maxPageBytes > 65_536
      || value.maxInputBytes > 24_576 || value.maxInputTextCharacters > 16_000 || value.maxObservationBytes > 8_192) {
      context.addIssue({ code: "custom", path: [], message: "Limits exceed the initial bounded record and page format." });
    }
    if (value.maxRuns > Math.floor(Number.MAX_SAFE_INTEGER / DELEGATION_RUN_RESERVATION_BYTES)
      || value.maxOrdinaryOperations > Math.floor(Number.MAX_SAFE_INTEGER / DELEGATION_CRITICAL_SLOT_BYTES)
      || value.maxRunObservations > Math.floor(Number.MAX_SAFE_INTEGER / value.maxObservationBytes)) {
      context.addIssue({ code: "custom", path: [], message: "Derived store reservations must remain safe integers." });
    }
    for (const key of ["runTimeoutMs", "queuedStartTimeoutMs", "maxWaitMs", "controlTimeoutMs", "notificationTtlMs"] as const) {
      if (value[key] > 2_147_483_647) context.addIssue({ code: "custom", path: [key], message: "Durations must fit a referenced Node timer." });
    }
  });

export function parseDelegationLimits(input: unknown = {}): DelegationLimits {
  const captured = copyBoundedDelegationData(input);
  const parsed = schema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return freezeDelegationData(parsed.data);
}
