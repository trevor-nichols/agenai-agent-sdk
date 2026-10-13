// ------------------------------------------------------------------------------------------------
//                store.ts - Closed public commands for durable adapter conformance
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createDelegationPolicyCeiling,
  DelegationOperationError,
  type DelegationMutationFence,
  type DelegationOwnerToken,
  type DelegationStore,
  type DelegationStoreCommand,
  type DelegationTargetReference,
} from "@agen-ai/agent-orchestration";
import { input, parent } from "./host.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const hasCode = (code: string) => (error: unknown) => error instanceof DelegationOperationError && error.code === code;
export const target: DelegationTargetReference = { catalogId: "catalog", catalogRevision: 1, targetId: "standard", targetRevision: 1, sourceId: "source", sourceRevision: 1 };

export function withCommit(store: DelegationStore, commit: DelegationStore["commit"]): DelegationStore {
  return { contractVersion: store.contractVersion, persistence: store.persistence, storeId: store.storeId, limits: store.limits,
    acquireOwner: () => store.acquireOwner(), commit, read: (query) => store.read(query), scan: (query) => store.scan(query),
    releaseOwner: (owner) => store.releaseOwner(owner) };
}

export function admission(owner: DelegationOwnerToken, completionPolicy: "collect" | "next_turn" | "automatic" = "collect"): Extract<DelegationStoreCommand, { kind: "admit" }> {
  const at = new Date().toISOString();
  const operationId = randomUUID();
  return { kind: "admit", owner, operationId, inputDigest: digest(operationId), taskId: randomUUID(), expectedTaskRevision: 0,
    admission: { parent, depth: 1, policyCeiling: createDelegationPolicyCeiling({ origin: parent, targets: [target] }),
      completionPolicy, runId: randomUUID(), target, policyRevision: 1, originPolicyRevision: 1, input, createdAt: at,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), queuedStartDeadlineAt: new Date(Date.now() + 30_000).toISOString() } };
}

export async function fence(store: DelegationStore, owner: DelegationOwnerToken, taskId: string, runId: string, operationId: string = randomUUID()): Promise<DelegationMutationFence> {
  const [task, run] = await Promise.all([store.read({ kind: "task", taskId }), store.read({ kind: "run", taskId, runId })]);
  assert.equal(task.kind, "task");
  assert.equal(run.kind, "run");
  assert.ok(task.view);
  assert.ok(run.run);
  return { owner, operationId, inputDigest: digest(operationId), taskId, runId,
    expectedTaskRevision: task.view.task.revision, expectedRunRevision: run.run.revision };
}

export async function prepareAndDispatch(store: DelegationStore, owner: DelegationOwnerToken, taskId: string, runId: string) {
  for (const operationKind of ["prepare", "turn"] as const) {
    const operation = await fence(store, owner, taskId, runId);
    await store.commit({ ...operation, kind: "dispatch_intent", operationKind, at: new Date().toISOString(), ...(operationKind === "turn" ? { appliedTarget: target } : {}) });
    await store.commit({ ...await fence(store, owner, taskId, runId, operation.operationId), kind: "operation_receipt",
      disposition: operationKind === "prepare" ? "completed" : "delegated", at: new Date().toISOString() });
  }
}

export async function settleRun(store: DelegationStore, owner: DelegationOwnerToken, policy: "next_turn" | "automatic" = "automatic") {
  const admitted = admission(owner, policy);
  await store.commit(admitted);
  const taskId = admitted.taskId;
  const runId = admitted.admission.runId;
  await prepareAndDispatch(store, owner, taskId, runId);
  const receipt = await store.commit({ ...await fence(store, owner, taskId, runId), kind: "settle", at: new Date().toISOString(),
    outcome: { kind: "succeeded", result: { text: "Retained completion", truncated: false, references: [] } } });
  assert.ok(receipt.notificationId);
  const result = await store.read({ kind: "notification", notificationId: receipt.notificationId });
  assert.equal(result.kind, "notification");
  assert.ok(result.notification);
  return { taskId, runId, notificationId: receipt.notificationId, envelope: result.notification.envelope };
}
