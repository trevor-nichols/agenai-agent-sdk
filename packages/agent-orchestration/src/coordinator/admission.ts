// ------------------------------------------------------------------------------------------------
//                admission.ts - Scoped idempotent admission and explicit send modes
// ------------------------------------------------------------------------------------------------

import { admittedTarget, effectiveChoices, readCeiling, sameTarget } from "../execution/authority.js";
import { assertCompletionPolicy } from "../delivery/setup.js";
import { steerRun } from "../execution/control.js";
import { assertAccepting, schedule } from "../execution/scheduler.js";
import { sameScopeIdentity, type CoordinatorState, type ParentBinding } from "../execution/state.js";
import { createDelegationId, delegationInputDigest } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationOperationRecord } from "../store/types.js";
import { parseSendTaskInput, parseSpawnTaskInput } from "./parse.js";
import type { DelegationAdmissionReceipt, DelegationSendReceipt, DelegationSendTaskInput, DelegationSpawnTaskInput } from "./types.js";

async function priorOperation(state: CoordinatorState, binding: ParentBinding, operationId: string, digest: string, kind: "admit" | "steer") {
  const read = await state.options.store.read({ kind: "operation", parent: binding.scope, operationId });
  if (read.kind !== "operation" || !read.operation) return undefined;
  if (read.operation.inputDigest !== digest || read.operation.kind !== kind) failDelegation("operation_conflict", "The operation identity already has different retained input.");
  const { task } = await state.task(read.operation.taskId);
  state.options.host.assertResultAccess({ scope: binding.scope, task });
  return read.operation;
}

async function admissionReceipt(state: CoordinatorState, operation: DelegationOperationRecord, duplicate: boolean): Promise<DelegationAdmissionReceipt> {
  const run = await state.run(operation.taskId, operation.runId);
  return { storeId: state.options.store.storeId, operationId: operation.operationId, taskId: operation.taskId,
    runId: operation.runId, target: run.admittedTarget, revision: operation.receipt.taskRevision,
    status: "queued", duplicate };
}

export function createAdmissionClient(state: CoordinatorState, binding: ParentBinding) {
  return {
    async spawn(raw: DelegationSpawnTaskInput): Promise<DelegationAdmissionReceipt> {
      const input = parseSpawnTaskInput(raw, state.options.limits);
      state.options.host.assertResultAccess({ scope: binding.scope });
      const normalized = { kind: "spawn", target: input.target, expectedPolicyRevision: input.expectedPolicyRevision,
        input: input.input, completionPolicy: input.completionPolicy ?? "collect", timeoutMs: input.timeoutMs ?? state.options.limits.runTimeoutMs };
      const digest = delegationInputDigest(normalized);
      const receipt = await state.gate(async () => {
        const prior = await priorOperation(state, binding, input.operationId, digest, "admit");
        if (prior) return admissionReceipt(state, prior, true);
        assertAccepting(state);
        assertCompletionPolicy(state, normalized.completionPolicy);
        const choices = await effectiveChoices(state, binding);
        const target = admittedTarget(choices, input.target, input.expectedPolicyRevision);
        const depth = binding.depth ?? 1;
        if (depth > state.options.limits.maxDepth) failDelegation("capacity_exceeded", "The managed descendant depth is exhausted.");
        const created = Date.now();
        const taskId = createDelegationId();
        const runId = createDelegationId();
        const commit = await state.commit({ owner: state.owner, operationId: input.operationId, inputDigest: digest,
          taskId, expectedTaskRevision: 0, kind: "admit", admission: { parent: binding.scope,
            ...(binding.ancestor ? { ancestorTaskId: binding.ancestor.taskId } : {}), depth, policyCeiling: choices.ceiling,
            completionPolicy: normalized.completionPolicy, runId, target: target.reference, policyRevision: choices.resolved.policyRevision,
            originPolicyRevision: choices.originPolicyRevision, input: input.input, createdAt: new Date(created).toISOString(),
            deadlineAt: new Date(created + normalized.timeoutMs).toISOString(),
            queuedStartDeadlineAt: new Date(created + state.options.limits.queuedStartTimeoutMs).toISOString() } });
        return { storeId: state.options.store.storeId, operationId: input.operationId, taskId, runId, target: target.reference,
          revision: commit.taskRevision, status: "queued" as const, duplicate: false };
      });
      schedule(state);
      return receipt;
    },
    async send(raw: DelegationSendTaskInput): Promise<DelegationSendReceipt> {
      const input = parseSendTaskInput(raw, state.options.limits);
      const { task } = await state.task(input.taskId);
      if (!sameScopeIdentity(binding.scope, task.parent)) failDelegation("request_unavailable", "The managed task does not belong to this parent scope.");
      state.options.host.assertResultAccess({ scope: binding.scope, task });
      const { operationId: _operationId, ...semantic } = input;
      const digest = delegationInputDigest({ kind: "send", ...semantic });
      const prior = await priorOperation(state, binding, input.operationId, digest, input.mode === "steer" ? "steer" : "admit");
      if (prior) {
        if (prior.kind === "admit") return { status: "queued", admission: await admissionReceipt(state, prior, true), duplicate: true };
        const pending = state.live.get(prior.runId)?.pendingOperations.get(input.operationId);
        if (pending) return (pending.promise as Promise<DelegationSendReceipt>).then((receipt) => ({ ...receipt, duplicate: true }));
        return { status: prior.disposition === "delivered" ? "delivered" : prior.disposition === "rejected" ? "rejected" : "delivery_uncertain",
          taskId: prior.taskId, runId: prior.runId, operationId: input.operationId, duplicate: true };
      }
      assertAccepting(state);
      assertCompletionPolicy(state, task.completionPolicy);
      state.options.host.assertControl({ scope: binding.scope, task });
      if (task.state === "recovery_required" || task.state === "retired") failDelegation("recovery_required", "This managed task requires explicit recovery retirement.");
      const choices = await effectiveChoices(state, binding);
      const ceiling = await readCeiling(state, task.policyCeilingRef);
      const target = admittedTarget({ ...choices, targets: choices.targets.filter((entry) => ceiling.targets.some((ref) => sameTarget(ref, entry.reference))) }, input.target, input.expectedPolicyRevision);
      if (input.mode === "steer") {
        const live = [...state.live.values()].find((entry) => entry.taskId === task.taskId && entry.stream);
        if (!live) failDelegation("unsupported_operation", "This managed child has no active steerable turn.");
        return steerRun(state, live, input, digest, choices.originPolicyRevision);
      }
      const continuationMode = input.mode;
      const receipt = await state.gate(async () => {
        const retry = await priorOperation(state, binding, input.operationId, digest, "admit");
        if (retry) return admissionReceipt(state, retry, true);
        const current = await state.task(task.taskId);
        const previous = await state.run(task.taskId, current.task.latestRunId);
        if (current.runs.items.some((run) => run.phase === "queued")) failDelegation("capacity_exceeded", "This managed task already has its queued next turn.");
        const live = state.live.get(previous.runId);
        const continuation = state.continuations.get(task.taskId);
        if (input.mode === "next_turn") {
          if (previous.phase !== "running" || !live?.resources?.continuation || !live.session) failDelegation("unsupported_operation", "A queued next turn requires an active safely resumable conversation.");
          if (!sameTarget(live.target.reference, target.reference) && !live.resources.continuation.allowTargetChange) failDelegation("unsupported_operation", "This conversation does not authorize a target change.");
        } else if (previous.phase !== "settled" || !previous.outcome || previous.outcome.kind === "recovery_required" || !continuation) {
          failDelegation("unsupported_operation", "A follow-up requires a definitive settled conversation with exact resume authority.");
        }
        const previousTarget = live?.target ?? continuation?.target;
        if (!previousTarget || previousTarget.instanceId !== target.instanceId || previousTarget.providerKey !== target.providerKey) failDelegation("unsupported_operation", "A continuation must retain its exact provider instance.");
        const created = Date.now();
        const runId = createDelegationId();
        const commit = await state.commit({ owner: state.owner, operationId: input.operationId, inputDigest: digest, taskId: task.taskId,
          expectedTaskRevision: current.task.revision, runId: previous.runId, expectedRunRevision: previous.revision, kind: "admit", admission: {
            parent: task.parent, ...(task.ancestorTaskId ? { ancestorTaskId: task.ancestorTaskId } : {}), depth: task.depth,
            policyCeiling: ceiling, completionPolicy: task.completionPolicy, runId, previousRunId: previous.runId, continuationMode, target: target.reference,
            policyRevision: choices.resolved.policyRevision, originPolicyRevision: choices.originPolicyRevision, input: input.input,
            createdAt: new Date(created).toISOString(), deadlineAt: new Date(created + state.options.limits.runTimeoutMs).toISOString(),
            queuedStartDeadlineAt: new Date(created + state.options.limits.queuedStartTimeoutMs).toISOString() } });
        return { storeId: state.options.store.storeId, operationId: input.operationId, taskId: task.taskId, runId, target: target.reference,
          revision: commit.taskRevision, status: "queued" as const, duplicate: false };
      });
      schedule(state);
      return { status: "queued", admission: receipt, duplicate: receipt.duplicate };
    },
  };
}
