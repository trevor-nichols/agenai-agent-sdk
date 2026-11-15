import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCapabilities, parseAgentOperationId, parseAgentOperationInvocationId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, type AgentProviderOutput } from "../src/index.js";
import { delta, DETAIL_VIEW, HISTORICAL, SESSION_SCOPE, SESSION_VIEW, snapshot, tokens, UNKNOWN } from "./fixtures/tokenUsage.js";
import { collectOutputs, emitter, openUsageSession, turn, usageCapabilities } from "./fixtures/tokenUsageSession.js";

const hasCode = (code: string) => (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
const countedView = { ...SESSION_VIEW, countBasis: { modelCalls: "unsupported", turns: "observed" } };
const countedCapabilities = parseAgentCapabilities({ ...usageCapabilities, tokenUsage: { kind: "supported", views: [
  { view: countedView, scopeKind: "session", reportedCounters: ["inputTokens", "outputTokens", "turns"], attribution: ["unknown"] },
] } });
const total = (id: string, revision: number, turns: number, historical = false) => snapshot(id, revision, tokens(10 + revision, 1, { turns }), {
  view: countedView, scope: SESSION_SCOPE, attribution: UNKNOWN, ...(historical ? { origin: HISTORICAL } : {}),
});

test("usage rejects foreign turn scopes, including optional model-call correlation", async (t) => {
  for (const kind of ["turn", "model_call"] as const) {
    const capabilities = parseAgentCapabilities({ ...usageCapabilities, tokenUsage: { kind: "supported", views: [
      { view: DETAIL_VIEW, scopeKind: kind, reportedCounters: ["inputTokens", "outputTokens"], attribution: ["unknown"] },
    ] } });
    const fixture = await openUsageSession({ capabilities, script: async function* (emit) {
      yield emit.started();
      yield emit.usage(delta("foreign", tokens(10, 1), { view: DETAIL_VIEW,
        scope: { scopeId: "foreign", kind, turnId: "never-entered" }, attribution: UNKNOWN }));
      yield emit.completed();
    } });
    t.after(() => fixture.dispose());
    await assert.rejects(collectOutputs(fixture.session.startTurn(turn("actual")).outputs), hasCode("usage_scope_mismatch"));
  }
});

test("known new-work turn counts cannot exceed entered execution, while historical totals remain valid", async (t) => {
  for (const historical of [false, true]) {
    const fixture = await openUsageSession({ capabilities: countedCapabilities, script: async function* (emit, input) {
      yield emit.started();
      if (historical) yield emit.usage(total("baseline", 0, 1000, true));
      yield emit.usage(historical ? total("current", 1, input.turnId === "valid" ? 1001 : 2000, true)
        : total("current", 0, input.turnId === "valid" ? 1 : 1000));
      yield emit.completed();
    } });
    t.after(() => fixture.dispose());
    await assert.rejects(collectOutputs(fixture.session.startTurn(turn("invalid")).outputs), hasCode("usage_scope_mismatch"));

    const valid = await openUsageSession({ capabilities: countedCapabilities, script: async function* (emit) {
      yield emit.started();
      if (historical) yield emit.usage(total("baseline", 0, 1000, true));
      yield emit.usage(total("current", historical ? 1 : 0, historical ? 1001 : 1, historical));
      yield emit.completed();
    } });
    t.after(() => valid.dispose());
    assert.equal((await collectOutputs(valid.session.startTurn(turn("valid")).outputs)).at(-1)?.kind, "event");
  }
});

test("a later turn may deliver an earlier entered turn's usage", async (t) => {
  const fixture = await openUsageSession({ script: async function* (emit, input) {
    yield emit.started();
    if (input.turnId === "later") yield emit.usage(delta("delayed", tokens(10, 1), { view: DETAIL_VIEW,
      scope: { scopeId: "earlier-usage", kind: "turn", turnId: "earlier" }, attribution: UNKNOWN }));
    yield emit.completed();
  } });
  t.after(() => fixture.dispose());
  await collectOutputs(fixture.session.startTurn(turn("earlier")).outputs);
  const outputs = await collectOutputs(fixture.session.startTurn(turn("later")).outputs);
  const usage = outputs.find((output) => output.kind === "event" && output.event.type === "usage.observed");
  assert.ok(usage?.kind === "event" && usage.event.type === "usage.observed");
  assert.equal(usage.event.turnId, "later");
  assert.deepEqual(usage.event.payload.scope, { scopeId: "earlier-usage", kind: "turn", turnId: "earlier" });
});

test("turn census refusal happens before announcing provider entry", async (t) => {
  let entries = 0;
  const fixture = await openUsageSession({ script: async function* (emit) {
    entries += 1;
    yield emit.started();
    yield emit.completed();
  } });
  t.after(() => fixture.dispose());
  await collectOutputs(fixture.session.startTurn(turn("same-id")).outputs);
  let announced = 0;
  await assert.rejects(collectOutputs(fixture.session.startTurn({ ...turn("same-id"),
    onProviderExecutionStarted() { announced += 1; },
  }).outputs), hasCode("usage_scope_mismatch"));
  assert.equal(announced, 0);
  assert.equal(entries, 1);
});

test("operation settlement and close retire callbacks and join already entered consumers", async (t) => {
  let saved: ((output: AgentProviderOutput) => Promise<void>) | undefined;
  let usage: AgentProviderOutput | undefined;
  const consuming = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await openUsageSession({ session: (session, context) => ({
    operations: session.operations.kind !== "supported" ? session.operations : { ...session.operations,
      async invokeOperation(input) {
        input.onProviderExecutionStarted?.();
        saved = async (output) => { await input.onOutput?.(output); };
        usage = emitter(context.sessionId, input.observationTurnId).usage(snapshot("s", 0, tokens(10, 1), { view: SESSION_VIEW, scope: SESSION_SCOPE }));
        void saved(usage);
        return { invocationId: input.invocation.invocationId, status: "completed" as const };
      },
    },
  }) });
  t.after(() => fixture.dispose());
  assert.equal(fixture.session.operations.kind, "supported");
  if (fixture.session.operations.kind !== "supported") return;
  let delivered = 0;
  let settled = false;
  const operation = Promise.resolve(fixture.session.operations.invokeOperation({
    invocation: { invocationId: parseAgentOperationInvocationId("owned"), operationId: parseAgentOperationId("fake.session.reset"), expectedRevision: 1, values: [] },
    observationTurnId: parseAgentTurnId("operation"),
    async onOutput() { delivered += 1; consuming.resolve(); await release.promise; },
  })).then(() => { settled = true; });
  await consuming.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeConsumer = settled;
  release.resolve();
  await operation;
  assert.equal(settledBeforeConsumer, false, "operation must retain its entered output callback");
  assert.ok(saved && usage);
  await assert.rejects(saved(usage), hasCode("invalid_operation_result"));
  await fixture.session.close({ reason: "idle" });
  await assert.rejects(saved(usage), hasCode("invalid_operation_result"));
  assert.equal(delivered, 1);
  assert.equal(fixture.nativeCloses(), 1);
});
