// ------------------------------------------------------------------------------------------------
//                store.ts - Public store commands and revision-aware test setup
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createDelegationPolicyCeiling,
  createInMemoryDelegationStore,
  DelegationOperationError,
  type DelegationLimits,
  type DelegationMutationFence,
  type DelegationOperationDisposition,
  type DelegationParentScope,
  type DelegationRunRecord,
  type DelegationStoreCommand,
} from "../../../src/index.js";
import { makeTarget } from "../../fixtures.js";

export const at = "2026-10-10T12:00:00.000Z";
export const parent: DelegationParentScope = { parentId: "parent", scopeId: "scope", revision: 1 };
export const target = makeTarget("standard").reference;
export const input = { parts: [{ type: "text" as const, text: "Perform the delegated task." }] };
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const hasCode = (code: string) => (error: unknown) => error instanceof DelegationOperationError && error.code === code;

export async function createStoreFixture(limits: Partial<DelegationLimits> = {}, runId: string = randomUUID()) {
  const store = createInMemoryDelegationStore({ limits });
  const owner = await store.acquireOwner();
  const taskId = randomUUID();
  const admission: DelegationStoreCommand = {
    kind: "admit", owner, operationId: randomUUID(), inputDigest: digest("first admission"),
    taskId, expectedTaskRevision: 0,
    admission: {
      parent, depth: 1, policyCeiling: createDelegationPolicyCeiling({ origin: parent, targets: [target] }),
      completionPolicy: "collect", runId, target, policyRevision: 1, originPolicyRevision: 1, input, createdAt: at,
      deadlineAt: "2026-10-10T12:30:00.000Z", queuedStartDeadlineAt: "2026-10-10T12:05:00.000Z",
    },
  };
  const admit = () => store.commit(admission);
  async function run(selectedRunId = runId): Promise<DelegationRunRecord> {
    const result = await store.read({ kind: "run", taskId, runId: selectedRunId });
    assert.equal(result.kind, "run");
    assert.ok(result.run);
    return result.run;
  }
  async function fence(operationId: string = randomUUID(), inputDigest = digest(operationId), selectedRunId = runId): Promise<DelegationMutationFence> {
    const result = await store.read({ kind: "task", taskId });
    assert.equal(result.kind, "task");
    assert.ok(result.view);
    return { owner, operationId, inputDigest, taskId, runId: selectedRunId,
      expectedTaskRevision: result.view.task.revision, expectedRunRevision: (await run(selectedRunId)).revision };
  }
  async function intent(kind: "prepare" | "turn" | "steer" | "interrupt" | "session_close" | "binding_cleanup", selectedRunId = runId) {
    const operation = await fence(undefined, undefined, selectedRunId);
    await store.commit({ ...operation, kind: "dispatch_intent", operationKind: kind, at,
      ...(kind === "turn" ? { appliedTarget: target } : {}) });
    return operation;
  }
  async function receipt(operation: DelegationMutationFence, disposition: Exclude<DelegationOperationDisposition, "intent"> = "completed") {
    return store.commit({ ...await fence(operation.operationId, operation.inputDigest, operation.runId), kind: "operation_receipt", disposition, at });
  }
  async function running() {
    await admit();
    await receipt(await intent("prepare"));
    await receipt(await intent("turn"), "delegated");
  }
  return { store, owner, taskId, runId, admission, admit, run, fence, intent, receipt, running };
}
