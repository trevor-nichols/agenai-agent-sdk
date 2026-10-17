// ------------------------------------------------------------------------------------------------
//                state.ts - Owned live handles and authoritative store access
// ------------------------------------------------------------------------------------------------

import type { AgentProviderSession, AgentProviderSessionCleanupError, AgentProviderTurnExecution } from "@agen-ai/agent-runtime";
import type { AgentRequest, AgentSessionId, AgentTurnId } from "@agen-ai/agent-protocol";
import type { DelegationTarget } from "../catalog/types.js";
import type { CreateDelegationCoordinatorOptions } from "../coordinator/types.js";
import type { DelegationChildResources, DelegationContinuation, DelegationExecutionLease, DelegationHostRequestHandle } from "../host/types.js";
import { DelegationOperationError, failDelegation } from "../shared/operational-errors.js";
import type { DelegationCommitReceipt, DelegationMutationFence, DelegationStoreCommand } from "../store/types.js";
import type { DelegationHistoricalRequest, DelegationOwnerToken, DelegationParentScope, DelegationPolicyCeiling, DelegationResultReference, DelegationRunOutcome, DelegationRunRecord, DelegationTaskRecord, DelegationTaskView } from "../tasks/types.js";

export interface ParentBinding {
  readonly scope: DelegationParentScope;
  readonly ancestor?: Readonly<{ taskId: string; runId: string }>;
  readonly ceiling?: DelegationPolicyCeiling;
  readonly depth?: number;
}

export interface LiveRequest {
  readonly handle: DelegationHostRequestHandle;
  readonly live: LiveRun;
  readonly request: AgentRequest;
  readonly history: DelegationHistoricalRequest;
  readonly signal: AbortSignal;
  eligibility: "waiting" | "claimed" | "retired";
  resolution?: Promise<unknown>;
}

export interface RequestPresentation {
  readonly history: DelegationHistoricalRequest;
  readonly abort: AbortController;
}

export interface LiveRun {
  readonly taskId: string;
  readonly runId: string;
  readonly scope: DelegationParentScope;
  readonly target: DelegationTarget;
  readonly ceiling: DelegationPolicyCeiling;
  readonly lifetime: AbortController;
  readonly controlAbort: AbortController;
  readonly sessionId: AgentSessionId;
  readonly turnId: AgentTurnId;
  readonly controls: Set<Promise<unknown>>;
  readonly requestAttempts: Map<string, LiveRequest>;
  readonly requestPresentations: Map<AgentRequest["requestId"], RequestPresentation>;
  readonly pendingOperations: Map<string, Readonly<{ digest: string; promise: Promise<unknown> }>>;
  execution?: DelegationExecutionLease;
  resources?: DelegationChildResources;
  session?: AgentProviderSession;
  turn?: AgentProviderTurnExecution;
  rejectedOpening?: AgentProviderSessionCleanupError;
  stream?: Promise<void>;
  outputDrained?: Promise<void>;
  request?: LiveRequest;
  observedStart: boolean;
  recordedStart: boolean;
  controlTail: Promise<void>;
  uncertain?: Extract<DelegationRunOutcome, { kind: "recovery_required" }>["reason"];
  terminal?: DelegationRunOutcome;
  summary: string;
  truncated: boolean;
  references: DelegationResultReference[];
  runtimeCleanupAttempts: number;
  resourceReleaseAttempts: number;
  executionReleaseAttempts: number;
  runtimeClosed: boolean;
  resourcesReleased: boolean;
  executionReleased: boolean;
  cleanup?: Promise<boolean>;
  cancellation?: Promise<unknown>;
  finishing?: Promise<void>;
  ready?: Promise<void>;
  schedule?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  removeRevocation?: () => void;
}

export class CoordinatorState {
  readonly live = new Map<string, LiveRun>();
  readonly continuations = new Map<string, DelegationContinuation>();
  readonly requests = new WeakMap<DelegationHostRequestHandle, LiveRequest>();
  readonly waiters = new Set<() => void>();
  readonly producers = new Set<Promise<unknown>>();
  readonly deliveryCalls = new Map<string, Readonly<{ controller: AbortController; taskId: string; promise: Promise<unknown> }>>();
  closing = false;
  draining = false;
  failed = false;
  released = false;
  pump?: Promise<void>;
  queueTimer?: ReturnType<typeof setTimeout>;
  schedulePending = false;
  onFailure?: () => void;
  wakeDelivery?: () => void;
  stopDelivery?: (abort: boolean) => void;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly options: CreateDelegationCoordinatorOptions, readonly owner: DelegationOwnerToken) {}

  gate<Value>(action: () => Promise<Value>): Promise<Value> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  changed(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  fail(): void {
    const first = !this.failed;
    this.failed = true;
    this.closing = true;
    this.draining = false;
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = undefined; }
    this.stopDelivery?.(true);
    if (first) this.onFailure?.();
    this.changed();
  }

  track<Value>(promise: Promise<Value>, live?: LiveRun): Promise<Value> {
    this.producers.add(promise);
    live?.controls.add(promise);
    void promise.finally(() => { this.producers.delete(promise); live?.controls.delete(promise); this.changed(); }).catch(() => undefined);
    return promise;
  }

  async task(taskId: string): Promise<DelegationTaskView> {
    const result = await this.options.store.read({ kind: "task", taskId, limit: this.options.limits.maxPageRecords });
    if (result.kind !== "task" || !result.view) return failDelegation("request_unavailable", "The managed task is unavailable.");
    return result.view;
  }

  async run(taskId: string, runId: string): Promise<DelegationRunRecord> {
    const result = await this.options.store.read({ kind: "run", taskId, runId });
    if (result.kind !== "run" || !result.run) return failDelegation("request_unavailable", "The managed run is unavailable.");
    return result.run;
  }

  async commit(command: DelegationStoreCommand): Promise<DelegationCommitReceipt> {
    if (this.released) failDelegation("owner_lost", "The coordinator no longer owns this store.");
    try {
      const receipt = await this.options.store.commit(command);
      this.changed();
      if (command.kind === "settle" || command.kind === "cancel") this.wakeDelivery?.();
      return receipt;
    } catch (error) {
      if (error instanceof DelegationOperationError && error.code !== "store_failed" && error.code !== "owner_lost") throw error;
      this.fail();
      if (error instanceof DelegationOperationError) throw error;
      return failDelegation("store_failed", "The managed store could not commit this operation.");
    }
  }

  mutate(taskId: string, runId: string, operationId: string, inputDigest: string,
    command: (fence: DelegationMutationFence, task: DelegationTaskRecord, run: DelegationRunRecord) => DelegationStoreCommand | undefined): Promise<DelegationCommitReceipt | undefined> {
    return this.gate(async () => {
      const [{ task }, run] = await Promise.all([this.task(taskId), this.run(taskId, runId)]);
      const mutation = command({ owner: this.owner, operationId, inputDigest, taskId,
        expectedTaskRevision: task.revision, runId, expectedRunRevision: run.revision }, task, run);
      return mutation === undefined ? undefined : this.commit(mutation);
    });
  }
}

export function sameScopeIdentity(left: DelegationParentScope, right: DelegationParentScope): boolean {
  return left.parentId === right.parentId && left.scopeId === right.scopeId;
}

export function now(): string { return new Date().toISOString(); }

export function truncateUtf8(text: string, maximum: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of text) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > maximum) break;
    result += character;
  }
  return result;
}
