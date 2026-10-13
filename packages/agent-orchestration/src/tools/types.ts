// ------------------------------------------------------------------------------------------------
//                types.ts - Explicit scoped delegation host binding construction
// ------------------------------------------------------------------------------------------------

import type { AgentHostInstructionPlacement } from "@agen-ai/agent-runtime";
import type { DelegationClient } from "../coordinator/types.js";
import type { DelegationTarget } from "../catalog/types.js";
import type { DelegationHistoricalRequest, DelegationPage, DelegationRunSummary, DelegationTaskRecord } from "../tasks/types.js";

export interface CreateDelegationHostBindingOptions {
  readonly client: DelegationClient;
  readonly bindingId?: string;
  readonly instructionPlacement?: AgentHostInstructionPlacement;
  /** The host certifies that these native tools exist in this exact session. */
  readonly nativeToolNames?: readonly string[];
}

export type DelegationToolTarget = Pick<DelegationTarget,
  "reference" | "providerKey" | "modelId" | "label" | "options" | "reasoning" | "executionMode" | "limitations">;

export interface DelegationToolTargetPage {
  readonly policyRevision: number;
  readonly targets: readonly DelegationToolTarget[];
  readonly cursor?: string;
  readonly emptyReason?: "delegation_disabled" | "no_permitted_targets";
}

export type DelegationToolRunSummary = Pick<DelegationRunSummary,
  "runId" | "ordinal" | "previousRunId" | "continuationMode" | "phase" | "revision" | "dispatch"
  | "cancelRequested" | "outcome" | "createdAt" | "deadlineAt" | "settledAt"> & Readonly<{
    target: DelegationTarget["reference"];
    pendingRequest?: Omit<DelegationHistoricalRequest, "requestId">;
  }>;

export interface DelegationToolTaskStatus {
  readonly task: Pick<DelegationTaskRecord,
    "storeId" | "taskId" | "state" | "revision" | "latestRunId" | "runCount" | "completionPolicy">;
  readonly runs: DelegationPage<DelegationToolRunSummary>;
  readonly waitStatus?: "settled" | "timeout";
}
