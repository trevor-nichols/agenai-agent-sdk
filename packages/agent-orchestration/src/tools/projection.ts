// ------------------------------------------------------------------------------------------------
//                projection.ts - Bounded model-facing target and task pages without authority data
// ------------------------------------------------------------------------------------------------

import { agentProtocolSerializedJsonBytes } from "@agen-ai/agent-protocol";
import type { DelegationTarget } from "../catalog/types.js";
import type { DelegationClient } from "../coordinator/types.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationRunSummary, DelegationTaskView } from "../tasks/types.js";
import type { DelegationToolRunSummary, DelegationToolTarget, DelegationToolTargetPage, DelegationToolTaskStatus } from "./types.js";

export const DELEGATION_TOOL_PAGE_BYTES = 24_576;

function targetProjection(target: DelegationTarget): DelegationToolTarget {
  const { reference, providerKey, modelId, label, options, reasoning, executionMode, limitations } = target;
  return { reference, providerKey, modelId, label, options, reasoning, executionMode, limitations };
}

function runProjection(run: DelegationRunSummary): DelegationToolRunSummary {
  const { runId, ordinal, phase, revision, dispatch, cancelRequested, createdAt, deadlineAt } = run;
  const pending = run.pendingRequest;
  return { runId, ordinal, phase, revision, dispatch, cancelRequested, createdAt, deadlineAt, target: run.admittedTarget,
    ...(run.previousRunId === undefined ? {} : { previousRunId: run.previousRunId }),
    ...(run.continuationMode === undefined ? {} : { continuationMode: run.continuationMode }),
    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
    ...(pending === undefined ? {} : { pendingRequest: {
      requestKind: pending.requestKind, state: pending.state, openedAt: pending.openedAt,
      ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
    } }),
  };
}

function taskProjection(view: DelegationTaskView, waitStatus?: "settled" | "timeout"): DelegationToolTaskStatus {
  const { storeId, taskId, state, revision, latestRunId, runCount, completionPolicy } = view.task;
  return { task: { storeId, taskId, state, revision, latestRunId, runCount, completionPolicy },
    runs: { items: view.runs.items.map(runProjection), ...(view.runs.cursor === undefined ? {} : { cursor: view.runs.cursor }) },
    ...(waitStatus === undefined ? {} : { waitStatus }) };
}

async function boundedPage<Value>(limit: number, read: (limit: number) => Promise<Value>): Promise<Value> {
  let requested = limit;
  for (;;) {
    const page = await read(requested);
    if (agentProtocolSerializedJsonBytes(page) <= DELEGATION_TOOL_PAGE_BYTES) return page;
    if (requested === 1) return failDelegation("capacity_exceeded", "One projected record exceeds the tool result limit.");
    requested = Math.max(1, Math.floor(requested / 2));
  }
}

export function projectTargetPage(client: DelegationClient, input: Readonly<{ cursor?: string; limit: number }>): Promise<DelegationToolTargetPage> {
  return boundedPage(input.limit, async (limit) => {
    const page = await client.targets({ ...(input.cursor === undefined ? {} : { cursor: input.cursor }), limit });
    return { policyRevision: page.policyRevision, targets: page.targets.map(targetProjection),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(page.emptyReason === undefined ? {} : { emptyReason: page.emptyReason }) };
  });
}

export function projectTaskPage(client: DelegationClient,
  input: Readonly<{ taskId: string; runsCursor?: string; limit: number }>, waitStatus?: "settled" | "timeout"): Promise<DelegationToolTaskStatus> {
  return boundedPage(input.limit, async (limit) => taskProjection(await client.inspect({ taskId: input.taskId,
    ...(input.runsCursor === undefined ? {} : { runsCursor: input.runsCursor }), limit }), waitStatus));
}
