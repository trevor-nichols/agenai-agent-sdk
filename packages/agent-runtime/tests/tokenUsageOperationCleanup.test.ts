import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentOperationId, parseAgentOperationInvocationId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, AgentProviderDelegatedOperationError, type AgentProviderOutput } from "../src/index.js";
import { SESSION_SCOPE, SESSION_VIEW, snapshot, tokens } from "./fixtures/tokenUsage.js";
import { emitter, openUsageSession, turn, usageCapabilities } from "./fixtures/tokenUsageSession.js";

const operationInput = {
  invocation: { invocationId: parseAgentOperationInvocationId("operation:capacity"),
    operationId: parseAgentOperationId("fake.session.reset"), expectedRevision: 1, values: [] },
  observationTurnId: parseAgentTurnId("operation:observation"),
};
const overBound = snapshot("epoch-overflow", 0, tokens(10, 1), {
  view: SESSION_VIEW, scope: SESSION_SCOPE, epoch: 16, origin: { kind: "fresh_zero", cause: "native_reset" },
});
const hasCode = (code: string) => (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
const delegatedCause = (cause: unknown) => (error: unknown) => error instanceof AgentProviderDelegatedOperationError
  && error.operation === "invoke_operation" && error.providerExecution === "started" && error.cause === cause;

for (const source of ["observation", "producer"] as const) {
  test(`${source} capacity starts native quiescence before joining entered output callbacks`, async (t) => {
    const accepted = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<unknown>();
    const delivered: AgentProviderOutput[] = [];
    let operationSettled = false;
    const fixture = await openUsageSession({ session: (session, context) => {
      assert.equal(session.operations.kind, "supported");
      if (session.operations.kind !== "supported") throw new Error("Missing operations.");
      return { operations: { ...session.operations, async invokeOperation(input) {
        input.onProviderExecutionStarted?.();
        const emit = emitter(context.sessionId, input.observationTurnId);
        // A previous valid callback is still being accepted when accounting exceeds its bound.
        void input.onOutput?.(emit.usage(snapshot("first", 0, tokens(1, 1), { view: SESSION_VIEW, scope: SESSION_SCOPE })));
        try {
          if (source === "producer") throw new AgentProviderContractError(usageCapabilities.providerKey, "usage_capacity_exceeded", "Native usage retention is full.");
          await input.onOutput?.(emit.raw(overBound));
        }
        catch (cause) { rejected.resolve(cause); throw cause; }
        return { invocationId: input.invocation.invocationId, status: "completed" as const };
      } } };
    } });
    t.after(async () => { accepted.resolve(); await fixture.dispose(); });
    assert.equal(fixture.session.operations.kind, "supported");
    if (fixture.session.operations.kind !== "supported") return;
    const pending = fixture.session.operations.invokeOperation({ ...operationInput, async onOutput(output) {
      delivered.push(output);
      await accepted.promise;
    } });
    void Promise.resolve(pending).then(() => { operationSettled = true; }, () => { operationSettled = true; });
    const original = await rejected.promise;
    assert.ok(hasCode("usage_capacity_exceeded")(original));
    await setImmediate();
    assert.equal(fixture.nativeCloses(), 1, "Native producers must quiesce before the pending callback joins.");
    assert.equal(operationSettled, false, "The entered callback must remain owned.");
    assert.equal(delivered.length, 1, "The rejected usage must never reach the consumer.");
    accepted.resolve();
    await assert.rejects(Promise.resolve(pending), delegatedCause(original));
    await fixture.session.close({ reason: "error" });
    assert.equal(fixture.nativeCloses(), 1, "Explicit close must join the existing close owner.");
    assert.throws(() => fixture.session.startTurn(turn("after-capacity")), hasCode("session_closed"));
  });
}

for (const wrapped of [false, true]) {
  test(`capacity cleanup failure remains explicitly retryable with ${wrapped ? "wrapped" : "original"} provider failure`, async (t) => {
    const providerFailure = new Error("Provider could not finish its operation.");
    let original: unknown;
    let nativeCloses = 0;
    const fixture = await openUsageSession({ session: (session, context) => {
      assert.equal(session.operations.kind, "supported");
      if (session.operations.kind !== "supported") throw new Error("Missing operations.");
      return {
        async close(input) {
          nativeCloses += 1;
          if (nativeCloses === 1) throw new Error("Native cleanup has not settled.");
          await session.close(input);
        },
        operations: { ...session.operations, async invokeOperation(input) {
          input.onProviderExecutionStarted?.();
          try { await input.onOutput?.(emitter(context.sessionId, input.observationTurnId).raw(overBound)); }
          catch (cause) {
            original = cause;
            // Let the first close fail before the delegated operation rejects.
            await setImmediate();
            throw wrapped ? providerFailure : cause;
          }
          return { invocationId: input.invocation.invocationId, status: "completed" as const };
        } },
      };
    } });
    t.after(() => fixture.dispose());
    assert.equal(fixture.session.operations.kind, "supported");
    if (fixture.session.operations.kind !== "supported") return;
    await assert.rejects(Promise.resolve(fixture.session.operations.invokeOperation(operationInput)), (error: unknown) => {
      assert.ok(hasCode("usage_capacity_exceeded")(original));
      return delegatedCause(wrapped ? providerFailure : original)(error);
    });
    await setImmediate();
    assert.equal(nativeCloses, 1, "A failed automatic close must not retry itself or replace the operation error.");
    assert.throws(() => fixture.session.startTurn(turn("after-cleanup-failure")), hasCode("session_unusable"));
    await fixture.session.close({ reason: "error" });
    await fixture.session.close({ reason: "idle" });
    assert.equal(nativeCloses, 2, "One explicit retry settles cleanup; later close is idempotent.");
  });
}

for (const code of ["usage_capacity_exceeded", "usage_invalid"] as const) {
  test(`provider-thrown ${code} preserves its cause and ${code === "usage_capacity_exceeded" ? "closes" : "only fences"} the session`, async (t) => {
    const original = new AgentProviderContractError(usageCapabilities.providerKey, code, "Native usage could not be retained.");
    const fixture = await openUsageSession({ session: (session) => {
      assert.equal(session.operations.kind, "supported");
      if (session.operations.kind !== "supported") throw new Error("Missing operations.");
      return { operations: { ...session.operations, async invokeOperation(input) {
        input.onProviderExecutionStarted?.();
        throw original;
      } } };
    } });
    t.after(() => fixture.dispose());
    assert.equal(fixture.session.operations.kind, "supported");
    if (fixture.session.operations.kind !== "supported") return;
    await assert.rejects(Promise.resolve(fixture.session.operations.invokeOperation(operationInput)), delegatedCause(original));
    await setImmediate();
    assert.equal(fixture.nativeCloses(), code === "usage_capacity_exceeded" ? 1 : 0);
    assert.throws(() => fixture.session.startTurn(turn("after-failure")),
      hasCode(code === "usage_capacity_exceeded" ? "session_closed" : "session_unusable"));
  });
}
