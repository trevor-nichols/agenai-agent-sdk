// ------------------------------------------------------------------------------------------------
//                create.ts - Explicit managed coordinator ownership and scoped clients
// ------------------------------------------------------------------------------------------------

import { bindingCeiling } from "../execution/authority.js";
import { assertRetainedDeliverySetup, validateDeliverySetup } from "../delivery/setup.js";
import { installDeliveryScheduler } from "../delivery/scheduler.js";
import { recoverNotificationClaims } from "../delivery/recovery.js";
import { cancelLive, resolveLiveRequest } from "../execution/control.js";
import { CoordinatorState, now, type ParentBinding } from "../execution/state.js";
import { schedule } from "../execution/scheduler.js";
import { delegationInputDigest } from "../shared/identity.js";
import { parseDelegationLimits } from "../shared/limits.js";
import { failDelegation } from "../shared/operational-errors.js";
import { parseDelegationParentScope } from "../tasks/parse.js";
import { createAdmissionClient } from "./admission.js";
import { createCancelClient } from "./cancel.js";
import { parseOperationId, parseTaskId } from "./parse.js";
import { createReadClient } from "./read.js";
import { recoverRuns } from "./recovery.js";
import { shutdown } from "./shutdown.js";
import type { CreateDelegationCoordinatorOptions, DelegationCoordinator } from "./types.js";

export async function createDelegationCoordinator(options: CreateDelegationCoordinatorOptions): Promise<DelegationCoordinator> {
  const limits = parseDelegationLimits(options.limits);
  if (options.store.contractVersion !== 4 || delegationInputDigest(limits) !== delegationInputDigest(options.store.limits)) {
    failDelegation("store_failed", "The coordinator requires the exact store contract and limits.");
  }
  validateDeliverySetup(options);
  const owner = await options.store.acquireOwner();
  const state = new CoordinatorState({ ...options, limits }, owner);
  state.onFailure = () => { for (const live of state.live.values()) {
    live.uncertain = "storage_failed";
    live.lifetime.abort(new DOMException("Managed storage ownership failed.", "AbortError"));
    void cancelLive(state, live, "storage_failed").catch(() => undefined);
  } };
  try {
    await assertRetainedDeliverySetup(state);
    let cursor: string | undefined; do { cursor = (await recoverRuns(state, limits.maxPageRecords, cursor, false)).cursor; } while (cursor);
    await recoverNotificationClaims(state);
  }
  catch (error) { await options.store.releaseOwner(owner); throw error; }
  schedule(state);
  installDeliveryScheduler(state);
  state.wakeDelivery?.();
  return Object.freeze({
    async bindParent(input) {
      const scope = parseDelegationParentScope(input.scope);
      options.host.assertResultAccess({ scope });
      const initial: ParentBinding = { scope, ...(input.ancestor ? { ancestor: { taskId: parseTaskId(input.ancestor.taskId), runId: parseTaskId(input.ancestor.runId) } } : {}) };
      const ceiling = await bindingCeiling(state, initial);
      const depth = initial.ancestor ? (await state.task(initial.ancestor.taskId)).task.depth + 1 : 1;
      const binding: ParentBinding = { ...initial, ...(ceiling ? { ceiling } : {}), depth };
      return Object.freeze({ ...createReadClient(state, binding), ...createAdmissionClient(state, binding), cancel: createCancelClient(state, binding) });
    },
    resolveRequest: (input) => resolveLiveRequest(state, input),
    recover: (input) => recoverRuns(state, input.limit, input.cursor),
    async retireRecoveryTask(input) {
      const operationId = parseOperationId(input.operationId);
      const taskId = parseTaskId(input.taskId);
      if (typeof input.reason !== "string" || input.reason.length < 1 || input.reason.length > 512) failDelegation("capacity_exceeded", "Recovery retirement requires a bounded reason.");
      const { task } = await state.task(taskId);
      options.host.assertResultAccess({ scope: task.parent, task });
      options.host.assertControl({ scope: task.parent, task });
      if ([...state.live.values()].some((live) => live.taskId === taskId)) failDelegation("recovery_required", "Retained execution resources must quiesce before retirement.");
      await state.gate(async () => {
        const current = await state.task(taskId);
        await state.commit({ owner, operationId, inputDigest: delegationInputDigest({ kind: "retire_recovery", taskId, reason: input.reason }),
          taskId, expectedTaskRevision: current.task.revision, kind: "retire_recovery", reason: input.reason, at: now() });
      });
      return state.task(taskId);
    },
    dispose: (input) => shutdown(state, input),
  } satisfies DelegationCoordinator);
}
