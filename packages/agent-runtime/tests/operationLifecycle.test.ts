import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentOperationId, parseAgentOperationInvocationId, parseAgentTurnId,
  type AgentOperationTiming } from "@agen-ai/agent-protocol";
import { createAgentEventOutput, type AgentProviderInvokeOperationInput,
  type AgentSessionInteraction } from "../src/index.js";
import { createHarness, deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";
import { turnInput } from "./fixtures/sessionInteractions.js";
import { approve, continuationFixture } from "./fixtures/nativeContinuations.js";

const invocation = { invocationId: parseAgentOperationInvocationId("operation:one"),
  operationId: parseAgentOperationId("fake.session.reset"), expectedRevision: 1, values: [] };
const operationInput = { invocation, observationTurnId: parseAgentTurnId("operation:observation") };

async function fixture(options: { timing?: AgentOperationTiming; output?: boolean | 'retry'; catalog?: Promise<void> } = {}) {
  const entered = deferred<void>();
  const release = deferred<void>();
  let dispatches = 0;
  let nativeClosed = false;
  let signal: AbortSignal | undefined;
  const harness = await createHarness({ transformSession(session, context) {
    assert.equal(session.operations.kind, "supported");
    if (session.operations.kind !== "supported") throw new Error("Missing operations.");
    const operations = session.operations;
    return { ...session, async close(input) { nativeClosed = true; await session.close(input); }, operations: {
      ...operations,
      async listOperations(input) {
        await options.catalog;
        const catalog = await operations.listOperations(input);
        return { ...catalog, operations: catalog.operations.map((descriptor) => ({ ...descriptor,
          timing: options.timing ?? descriptor.timing })) };
      },
      async invokeOperation(input: AgentProviderInvokeOperationInput) {
        input.onProviderExecutionStarted?.();
        signal = input.signal;
        dispatches += 1;
        entered.resolve();
        if (options.output) await input.onOutput?.(createAgentEventOutput({ protocolVersion: 13,
          sessionId: context.sessionId, turnId: input.observationTurnId, occurredAt: "2026-10-19T00:00:00.000Z",
          ...(options.output === 'retry'
            ? { type: 'runtime.retrying', payload: { owner: 'provider', attempt: 1, maxAttempts: 3, delayMs: 1250,
                error: { category: 'overloaded', code: 'busy', message: 'Provider busy.', recovery: { kind: 'retry' } } } }
            : { type: "runtime.warning", payload: { code: "operation_observation", message: "Await acceptance." } }) }));
        else await release.promise;
        return { invocationId: input.invocation.invocationId, status: "completed" as const };
      },
    } };
  } });
  const session = await harness.open("create");
  assert.equal(session.operations.kind, "supported");
  if (session.operations.kind !== "supported") throw new Error("Missing operations.");
  return { session, operations: session.operations, entered: entered.promise, release: () => release.resolve(),
    dispatches: () => dispatches, nativeClosed: () => nativeClosed, signal: () => signal,
    async dispose() { release.resolve(); await session.close({ reason: "idle" }); await harness.registry.dispose(); } };
}

test("an idle operation excludes caller turns and other operations until completion, then replays once", async () => {
  const f = await fixture();
  try {
    const pending = f.operations.invokeOperation(operationInput);
    await f.entered;
    assert.throws(() => f.session.startTurn(turnInput), hasContractCode("concurrent_turn"));
    await assert.rejects(Promise.resolve(f.operations.invokeOperation({ ...operationInput,
      invocation: { ...invocation, invocationId: parseAgentOperationInvocationId("operation:two") } })), hasContractCode("concurrent_turn"));
    f.release();
    const result = await pending;
    const turn = f.session.startTurn(turnInput);
    assert.deepEqual(await f.operations.invokeOperation(operationInput), result, "Settled replay must not reserve new execution.");
    assert.equal(f.dispatches(), 1);
    await assert.rejects(Promise.resolve(f.operations.invokeOperation({ ...operationInput,
      invocation: { ...invocation, expectedRevision: 2 } })), hasContractCode("input_operation_mismatch"));
    assert.equal(turn.turnId, turnInput.turnId);
  } finally { await f.dispose(); }
});

test("a reserved caller turn excludes idle operations before native dispatch", async () => {
  const f = await fixture();
  try {
    f.session.startTurn(turnInput);
    const pending = Promise.resolve(f.operations.invokeOperation(operationInput));
    f.release();
    await assert.rejects(pending, hasContractCode("concurrent_turn"));
    assert.equal(f.dispatches(), 0);
  } finally { await f.dispose(); }
});

test("active-turn operations retain their existing timing behavior", async () => {
  const f = await fixture({ timing: "active_turn" });
  try {
    f.session.startTurn(turnInput);
    f.release();
    assert.equal((await f.operations.invokeOperation(operationInput)).status, "completed");
    assert.equal(f.dispatches(), 1);
  } finally { await f.dispose(); }
});

test('session operation retries preserve provider ownership and await output acceptance', async () => {
  const f = await fixture({ output: 'retry' });
  const accepted = deferred<void>();
  const observed = deferred<void>();
  let settled = false;
  try {
    const pending = Promise.resolve(f.operations.invokeOperation({ ...operationInput, async onOutput(output) {
      assert.ok(output.kind === 'event' && output.event.type === 'runtime.retrying');
      assert.equal(output.event.turnId, operationInput.observationTurnId);
      assert.equal(output.event.payload.owner, 'provider');
      assert.equal(output.event.payload.attempt, 1);
      observed.resolve(); await accepted.promise;
    } })).then((result) => { settled = true; return result; });
    await observed.promise;
    assert.equal(settled, false);
    assert.equal(f.dispatches(), 1);
    accepted.resolve();
    assert.equal((await pending).status, 'completed');
  } finally { accepted.resolve(); await f.dispose(); }
});

for (const output of [false, true]) test(`close quiesces native producers before joining ${output ? "output acceptance" : "the operation"}`, async () => {
  const f = await fixture({ output });
  const accept = deferred<void>();
  let closed = false;
  try {
    const pending = f.operations.invokeOperation({ ...operationInput, onOutput: () => accept.promise });
    await f.entered;
    const closing = Promise.resolve(f.session.close({ reason: "idle" })).then(() => { closed = true; });
    await setImmediate();
    assert.equal(f.nativeClosed(), true, "Quiescence must begin before the operation join.");
    assert.equal(closed, false, "Close must retain the entered operation and callback.");
    assert.equal(f.signal()?.aborted, true);
    accept.resolve(); f.release();
    await pending; await closing;
    assert.equal(closed, true);
  } finally { accept.resolve(); await f.dispose(); }
});

test("close during catalog lookup joins preparation and prevents later delegation", async () => {
  const catalog = deferred<void>();
  const f = await fixture({ catalog: catalog.promise });
  try {
    const pending = Promise.resolve(f.operations.invokeOperation(operationInput));
    void pending.catch(() => {});
    let closed = false;
    const closing = Promise.resolve(f.session.close({ reason: "idle" })).then(() => { closed = true; });
    await setImmediate();
    assert.equal(closed, false, "Close must join operation preparation.");
    catalog.resolve(); f.release();
    await assert.rejects(pending);
    await closing;
    assert.equal(f.dispatches(), 0);
  } finally { catalog.resolve(); await f.dispose(); }
});

test("native continuation execution excludes idle operations", async () => {
  const release = deferred<void>();
  const f = await continuationFixture({ afterStarted: release.promise });
  const offered = deferred<AgentSessionInteraction>();
  const started = deferred<void>();
  let reading: Promise<void> | undefined;
  const session = await f.adapter.createSession({ ...f.input,
    interactions: { onRequest(value) { offered.resolve(value); } },
    nativeContinuations: { onExecution({ execution }) {
      reading = (async () => { for await (const output of execution.outputs) {
        if (output.kind === "event" && output.event.type === "turn.started") started.resolve();
      } })();
    } },
  });
  try {
    await (await offered.promise).respond(approve(f.request()));
    await started.promise;
    assert.equal(session.operations.kind, "supported");
    if (session.operations.kind !== "supported") throw new Error("Missing operations.");
    await assert.rejects(Promise.resolve(session.operations.invokeOperation(operationInput)), hasContractCode("concurrent_turn"));
    assert.equal(f.counts().dispatches, 1);
  } finally { release.resolve(); await reading; await session.close({ reason: "idle" }); await f.dispose(); }
});

test("an entered idle operation prevents native continuation dispatch", async () => {
  const release = deferred<void>(); const entered = deferred<void>();
  const f = await continuationFixture({ transformSession(session) {
    assert.equal(session.operations.kind, "supported");
    if (session.operations.kind !== "supported") throw new Error("Missing operations.");
    return { ...session, operations: { ...session.operations, async invokeOperation(input) {
      input.onProviderExecutionStarted?.(); entered.resolve(); await release.promise;
      return { invocationId: input.invocation.invocationId, status: "completed" };
    } } };
  } });
  const offered = deferred<AgentSessionInteraction>();
  const session = await f.adapter.createSession({ ...f.input,
    interactions: { onRequest(value) { offered.resolve(value); } },
    nativeContinuations: { async onExecution({ execution }) { for await (const output of execution.outputs) assert.ok(output); } },
  });
  try {
    assert.equal(session.operations.kind, "supported");
    if (session.operations.kind !== "supported") throw new Error("Missing operations.");
    const pending = session.operations.invokeOperation(operationInput);
    await entered.promise;
    await assert.rejects((await offered.promise).respond(approve(f.request())), hasContractCode("concurrent_turn"));
    assert.equal(f.counts().dispatches, 0);
    release.resolve();
    assert.equal((await pending).status, "completed");
  } finally { release.resolve(); await session.close({ reason: "idle" }); await f.dispose(); }
});
