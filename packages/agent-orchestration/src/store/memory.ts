// ------------------------------------------------------------------------------------------------
//                memory.ts - Explicit volatile delegation store
// ------------------------------------------------------------------------------------------------

import { createDelegationId, delegationDataBytes, delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { parseDelegationLimits, type DelegationLimits } from "../shared/limits.js";
import { failDelegation } from "../shared/operational-errors.js";
import { delegationSchemaError, invalidDelegationData } from "../shared/errors.js";
import { captureDelegationRecord, copyBoundedDelegationData } from "../shared/bounds.js";
import { parseDelegationOwnerToken } from "../tasks/parse.js";
import { StoreIdSchema } from "../tasks/schemas.js";
import type {
  DelegationNotificationRecord, DelegationOwnerToken, DelegationParentScope, DelegationPolicyCeiling,
  DelegationRunRecord, DelegationTaskObservation, DelegationTaskRecord,
} from "../tasks/types.js";
import { planDelegationStoreCommit } from "../store-adapter/plan.js";
import { criticalKinds } from "../store-adapter/context.js";
import { parseDelegationStoreCommand, parseDelegationStoreReadInput, parseDelegationStoreScanInput } from "./parse.js";
import { pageDelegationRows, summarizeDelegationRun } from "./pages.js";
import type {
  DelegationOperationRecord, DelegationStore, DelegationStoreCapacity, DelegationStoreCommand,
  DelegationStoreReadInput, DelegationStoreReadPage, DelegationStoreScanInput, DelegationStoreScanPage,
} from "./types.js";

function operationKey(parent: DelegationParentScope, operationId: string): string {
  return JSON.stringify([parent.parentId, parent.scopeId, operationId]);
}
function observationKey(runId: string, index: number): string { return `${runId}:${index}`; }
function runKey(run: DelegationRunRecord): string { return `${run.createdAt}:${run.runId}`; }

export function createInMemoryDelegationStore(options: {
  readonly limits?: Partial<DelegationLimits>;
  readonly storeId?: string;
} = {}): DelegationStore {
  const capturedOptions = captureDelegationRecord(options);
  if (Object.keys(capturedOptions).some((key) => key !== "limits" && key !== "storeId")) {
    invalidDelegationData("invalid_data", [], "Volatile store options contain an unknown property.");
  }
  const limits = parseDelegationLimits(capturedOptions.limits ?? {});
  const capturedStoreId = copyBoundedDelegationData(capturedOptions.storeId ?? createDelegationId());
  const parsedStoreId = StoreIdSchema.safeParse(capturedStoreId);
  if (!parsedStoreId.success) return delegationSchemaError(parsedStoreId.error, capturedStoreId);
  const storeId = parsedStoreId.data;
  let owner: DelegationOwnerToken | undefined;
  let epoch = 0;
  let capacity: DelegationStoreCapacity = Object.freeze({ tasks: 0, runs: 0, activeRuns: 0, queuedRuns: 0,
    retainedInputBytes: 0, observationBytes: 0, ordinaryOperations: 0, reservedBytes: 0, criticalSlots: 0 });
  const tasks = new Map<string, DelegationTaskRecord>();
  const runs = new Map<string, DelegationRunRecord>();
  const operations = new Map<string, DelegationOperationRecord>();
  const observations = new Map<string, DelegationTaskObservation>();
  const notifications = new Map<string, DelegationNotificationRecord>();
  const ceilings = new Map<string, DelegationPolicyCeiling>();
  const runOperations = (runId: string) => [...operations.values()].filter((operation) => operation.runId === runId);
  const runObservations = (runId: string) => [...observations.values()].filter((observation) => observation.runId === runId);
  const page = <Value>(query: unknown, rows: readonly Value[], key: (value: Value) => string,
    input: { readonly cursor?: string; readonly limit?: number }, envelopeBytes = 0) =>
    pageDelegationRows({ storeId, query, rows, key, limits, ...input, envelopeBytes });

  return Object.freeze({
    contractVersion: 4 as const, persistence: "volatile" as const, storeId, limits,
    async acquireOwner() {
      if (owner) failDelegation("owner_lost", "This volatile store already has an active owner.");
      owner = parseDelegationOwnerToken({ storeId, epoch: ++epoch, nonce: createDelegationId() });
      return owner;
    },
    async releaseOwner(input: DelegationOwnerToken) {
      if (!owner || input.storeId !== storeId || input.epoch !== owner.epoch || input.nonce !== owner.nonce) {
        failDelegation("owner_lost", "The store owner fence is no longer current.");
      }
      owner = undefined;
    },
    async commit(input: DelegationStoreCommand) {
      const command = parseDelegationStoreCommand(input);
      const task = tasks.get(command.taskId);
      const parent = command.kind === "admit" ? command.admission.parent : task?.parent;
      const runId = command.kind === "admit" ? command.admission.runId : command.runId;
      const notificationId = command.kind === "delivery_claim" || command.kind === "delivery_receipt" ? command.notificationId
        : runId ? delegationSubordinateId(runId, "notification") : undefined;
      const taskRuns = [...runs.values()].filter((run) => run.taskId === command.taskId);
      const selectedOperations = runId ? runOperations(runId) : [];
      const selectedObservations = command.kind === "observe" ? runObservations(command.observation.runId) : [];
      const plan = planDelegationStoreCommit({ command, current: {
        storeId, owner, limits, capacity, task, runs: taskRuns,
        operation: parent ? operations.get(operationKey(parent, command.operationId)) : undefined,
        criticalOperations: selectedOperations.filter((operation) => criticalKinds.has(operation.kind)),
        notification: notificationId ? notifications.get(notificationId) : undefined,
        ceiling: command.kind === "admit" ? ceilings.get(command.admission.policyCeiling.ceilingId) : undefined,
        observation: command.kind === "observe" ? observations.get(observationKey(command.observation.runId, command.observation.index)) : undefined,
        omissionObservation: selectedObservations.find((observation) => observation.kind === "omitted"),
        runIdExists: command.kind === "admit" && runs.has(command.admission.runId),
      } });
      for (const mutation of plan.mutations) {
        switch (mutation.kind) {
          case "task": tasks.set(mutation.value.taskId, mutation.value); break;
          case "run": runs.set(mutation.value.runId, mutation.value); break;
          case "operation": operations.set(operationKey(mutation.value.parent, mutation.value.operationId), mutation.value); break;
          case "observation": observations.set(observationKey(mutation.value.runId, mutation.value.index), mutation.value); break;
          case "notification": notifications.set(mutation.value.envelope.notificationId, mutation.value); break;
          case "ceiling": ceilings.set(mutation.value.ceilingId, mutation.value); break;
          case "capacity": capacity = mutation.value; break;
        }
      }
      return plan.receipt;
    },
    async read(input: DelegationStoreReadInput): Promise<DelegationStoreReadPage> {
      const query = parseDelegationStoreReadInput(input);
      let result: DelegationStoreReadPage;
      switch (query.kind) {
        case "capacity": result = { kind: query.kind, capacity }; break;
        case "task": {
          const task = tasks.get(query.taskId);
          result = { kind: query.kind, ...(task ? { view: { task, runs: page({ kind: query.kind, taskId: query.taskId },
            [...runs.values()].filter((run) => run.taskId === task.taskId).map(summarizeDelegationRun),
            (run) => `${String(run.ordinal).padStart(16, "0")}:${run.runId}`, query, delegationDataBytes(task)) } } : {}) }; break;
        }
        case "run": {
          const run = runs.get(query.runId);
          result = { kind: query.kind, ...(run?.taskId === query.taskId ? { run } : {}) }; break;
        }
        case "operation": {
          const operation = operations.get(operationKey(query.parent, query.operationId));
          result = { kind: query.kind, ...(operation ? { operation } : {}) }; break;
        }
        case "operations": result = { kind: query.kind, page: page({ kind: query.kind, taskId: query.taskId, runId: query.runId },
          runs.get(query.runId)?.taskId === query.taskId ? runOperations(query.runId) : [], (operation) => operation.operationId, query) }; break;
        case "observations": {
          const run = runs.get(query.runId);
          const found = run?.taskId === query.taskId;
          result = { kind: query.kind, page: page({ kind: query.kind, taskId: query.taskId, runId: query.runId },
            found ? runObservations(query.runId) : [], (observation) => String(observation.index).padStart(16, "0"), query),
          latestIndex: found ? run.observationIndex : 0, gap: found ? run.omittedObservations > 0 : false }; break;
        }
        case "notification": {
          const notification = notifications.get(query.notificationId);
          result = { kind: query.kind, ...(notification ? { notification } : {}) }; break;
        }
        case "ceiling": {
          const ceiling = ceilings.get(query.ceilingId);
          result = { kind: query.kind, ceilingId: query.ceilingId, ...(ceiling ? { origin: ceiling.origin } : {}),
            page: page({ kind: query.kind, ceilingId: query.ceilingId }, ceiling?.targets ?? [],
              delegationInputDigest, query, 512) }; break;
        }
      }
      return freezeDelegationData(result);
    },
    async scan(input: DelegationStoreScanInput): Promise<DelegationStoreScanPage> {
      const query = parseDelegationStoreScanInput(input);
      if (query.kind === "eligible_notifications") return freezeDelegationData({ kind: query.kind,
        page: page({ kind: query.kind }, [...notifications.values()].filter((notification) => notification.state === "pending"
          || (notification.state === "claimed" && notification.claim?.ownerEpoch !== owner?.epoch)),
        (notification) => notification.envelope.notificationId, query) });
      const selected = [...runs.values()].filter((run) => query.kind === "queued" ? run.phase === "queued"
        : run.phase !== "settled" && run.ownerEpoch !== owner?.epoch);
      return freezeDelegationData({ kind: query.kind, page: page({ kind: query.kind }, selected, runKey, query) });
    },
  });
}
