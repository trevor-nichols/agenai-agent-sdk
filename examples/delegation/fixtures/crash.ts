// ------------------------------------------------------------------------------------------------
//                crash.ts - Coordinator crash barriers through public store and provider ports
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentRequestResolution } from "@agen-ai/agent-protocol";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import {
  createDelegationCoordinator,
  type DelegationSpawnTaskInput,
} from "@agen-ai/agent-orchestration";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { completedOutputs, createReferenceHost, eventBase, input, parent } from "./host.js";
import { barrier, invocationCount, persistJson, readJson, recordInvocation } from "./journal.js";
import { hasCode, withCommit } from "./store.js";

export interface CrashIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly spawn: DelegationSpawnTaskInput;
  readonly notificationId?: string;
  readonly cancellation?: { readonly operationId: string; readonly queuedRunId: string };
}

export async function crashAt(root: string, stage: string) {
  let markRunning!: () => void;
  const running = new Promise<void>((resolve) => { markRunning = resolve; });
  const opened = await openSqliteDelegationStore({ root: join(root, "database"), ...(stage === "saturated" ? { limits: {
    maxRunObservations: 1, maxRetainedObservationBytes: 8_192, maxOrdinaryOperationsPerRun: 3, maxOrdinaryOperations: 3,
  } } : {}) });
  const reference = await createReferenceHost({ root,
    async onInvoke() {
      recordInvocation(root, "child");
      if (stage === "effect") await barrier("crash", { stage });
    },
    ...(stage === "waiting" ? {
      execution: (session, _context, turn) => session.startTurn(turn),
      onRequest: async ({ request }) => {
        if (request.requestKind !== "approval") throw new Error("Expected the fake approval request.");
        persistJson(root, "lost-resolution.json", { requestKind: "approval", requestId: request.requestId,
          disposition: "selected", optionId: request.options[0]!.optionId });
        await barrier("crash", { stage });
      },
    } : {}),
    ...(stage === "saturated" ? { outputs: (_session, context, turn) => completedOutputs(context, turn.turnId, Array.from({ length: 5 }, () => "界".repeat(3_000))) } : {}),
    ...(stage === "cancellation" ? { allowContinuation: true, async *outputs(_session, context, turn) {
      yield createAgentEventOutput({ ...eventBase(context, turn.turnId), type: "turn.started", payload: {} });
      markRunning();
      await new Promise<void>(() => {});
    } } : {}),
  });
  const spawn: DelegationSpawnTaskInput = { operationId: randomUUID(), target: reference.target.reference, expectedPolicyRevision: 1, input };
  let identity: CrashIdentity;
  const store = withCommit(opened.store, async (command) => {
    if (command.kind === "admit" && command.expectedTaskRevision === 0) {
      identity = { taskId: command.taskId, runId: command.admission.runId, spawn };
      persistJson(root, "identity.json", identity);
      if (stage === "before_admission") await barrier("crash", { stage });
    }
    if (command.kind === "settle" && stage === "terminal") await barrier("crash", { stage });
    const receipt = await opened.store.commit(command);
    if (command.kind === "settle") {
      identity = { ...identity, notificationId: receipt.notificationId! };
      persistJson(root, "identity.json", identity);
    }
    if ((command.kind === "admit" && stage === "admitted")
      || (command.kind === "dispatch_intent" && command.operationKind === "prepare" && stage === "preparation")
      || (command.kind === "dispatch_intent" && command.operationKind === "turn" && stage === "dispatch")
      || (command.kind === "cancel" && stage === "cancellation")
      || (command.kind === "settle" && (stage === "settled" || stage === "saturated"))) await barrier("crash", { stage });
    return receipt;
  });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store, limits: store.limits });
  const client = await coordinator.bindParent({ scope: parent });
  const admitted = await client.spawn(spawn);
  if (stage === "cancellation") {
    await running;
    const queued = await client.send({ operationId: randomUUID(), taskId: admitted.taskId, mode: "next_turn", input,
      target: reference.target.reference, expectedPolicyRevision: 1 });
    assert.equal(queued.status, "queued");
    if (queued.status !== "queued") throw new Error("Expected an admitted continuation.");
    const operationId = randomUUID();
    persistJson(root, "identity.json", { ...readJson<CrashIdentity>(root, "identity.json"),
      cancellation: { operationId, queuedRunId: queued.admission.runId } });
    await client.cancel({ operationId, taskId: admitted.taskId });
  }
  await new Promise<void>(() => {});
}

export async function recoverCrash(root: string, stage: string) {
  const identity = readJson<CrashIdentity>(root, "identity.json");
  const opened = await openSqliteDelegationStore({ root: join(root, "database") });
  const errors: unknown[] = [];
  const store = withCommit(opened.store, async (command) => {
    try { return await opened.store.commit(command); }
    catch (error) { errors.push({ kind: command.kind, message: error instanceof Error ? error.message : String(error) }); throw error; }
  });
  const requests: unknown[] = [];
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, "child"), onRequest: (request) => { requests.push(request); } });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store, limits: store.limits });
  const client = await coordinator.bindParent({ scope: parent });
  if (stage === "cancellation") {
    assert.ok(identity.cancellation);
    const cancellation = await client.cancel({ operationId: identity.cancellation.operationId, taskId: identity.taskId });
    assert.equal(cancellation.duplicate, true);
    assert.equal(cancellation.status, "recovery_required");
    const queued = await store.read({ kind: "run", taskId: identity.taskId, runId: identity.cancellation.queuedRunId });
    assert.equal(queued.kind, "run");
    const operations = await store.read({ kind: "operations", taskId: identity.taskId, runId: identity.cancellation.queuedRunId });
    assert.equal(operations.kind, "operations");
    assert.equal(operations.page.items.filter((operation) => operation.kind === "cancel").length, 1,
      "Retry must finish the original cancellation after process loss, preserving any settled recovery outcome.");
    assert.notEqual(queued.run?.outcome?.kind, "succeeded");
  }
  const initial = await opened.store.read({ kind: "task", taskId: identity.taskId });
  assert.equal(initial.kind, "task");
  if (stage === "before_admission") {
    assert.equal(initial.view, undefined);
    assert.equal(invocationCount(root, "child"), 0);
  } else {
    const duplicate = await client.spawn(identity.spawn);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.taskId, identity.taskId);
    assert.equal(duplicate.runId, identity.runId);
    const settled = await client.wait({ taskId: identity.taskId, timeoutMs: 2_000 });
    assert.equal(settled.status, "settled");
    const run = settled.task.runs.items[0]!;
    if (stage === "admitted" || stage === "settled" || stage === "saturated") assert.equal(run.outcome?.kind, "succeeded");
    else assert.equal(run.outcome?.kind, "recovery_required");
    if (stage === "waiting") {
      assert.equal(run.pendingRequest?.state, "unavailable");
      assert.equal(requests.length, 0);
      await assert.rejects(coordinator.resolveRequest({ handle: {} as never, operationId: randomUUID(), resolution: readJson<AgentRequestResolution>(root, "lost-resolution.json") }), hasCode("request_unavailable"));
    }
    if (stage === "settled" || stage === "saturated") {
      if (stage === "settled") assert.deepEqual(run.outcome, { kind: "succeeded", result: { text: "Durable result.", truncated: false, references: [] } });
      else {
        assert.equal(run.outcome?.kind, "succeeded");
        if (run.outcome?.kind !== "succeeded") throw new Error("Expected bounded success after durable saturation.");
        assert.equal(run.outcome.result.truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(run.outcome.result)) <= 8_192);
        const observations = await opened.store.read({ kind: "observations", taskId: identity.taskId, runId: identity.runId });
        assert.equal(observations.kind, "observations");
        assert.equal(observations.gap, true);
        assert.equal(observations.page.items.filter((observation) => observation.kind === "omitted").length, 1);
      }
      const notification = await opened.store.read({ kind: "notification", notificationId: identity.notificationId! });
      assert.equal(notification.kind, "notification");
      assert.deepEqual(notification.notification?.envelope.outcome, run.outcome);
      assert.equal(notification.notification?.state, "collectible");
    }
  }
  const expectedInvocations = ["admitted", "effect", "waiting", "terminal", "settled", "saturated", "cancellation"].includes(stage) ? 1 : 0;
  assert.equal(invocationCount(root, "child"), expectedInvocations);
  const started = Date.now();
  const shutdown = await coordinator.dispose({ mode: "drain", timeoutMs: 1_000 });
  const operations = shutdown.status === "closed" || stage === "before_admission" ? undefined : await store.read({ kind: "operations", taskId: identity.taskId, runId: identity.runId });
  assert.equal(shutdown.status, "closed", JSON.stringify({ shutdown, elapsedMs: Date.now() - started, errors,
    operations: operations?.kind === "operations" ? operations.page.items.map(({ kind, disposition, attempts }) => ({ kind, disposition, attempts })) : undefined,
    closeCounts: reference.fake.snapshot().closeCounts }));
  await reference.registry.dispose();
  return { stage, invocations: invocationCount(root, "child"), storeId: opened.store.storeId };
}
