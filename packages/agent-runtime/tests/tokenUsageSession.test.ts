// ------------------------------------------------------------------------------------------------
//                tokenUsageSession.test.ts - Turn-path usage placement, capability and cleanup
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCapabilities } from "@agen-ai/agent-protocol";

import { AgentProviderContractError, type AgentProviderOutput } from "../src/index.js";
import {
  atLeast, counters, delta, DETAIL_VIEW, MODEL_X, SESSION_SCOPE, SESSION_VIEW, snapshot, tokens, UNKNOWN,
} from "./fixtures/tokenUsage.js";
import { collectOutputs, openUsageSession, turn, usageCapabilities, type UsageEmitter } from "./fixtures/tokenUsageSession.js";

const hasCode = (code: string) => (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
const sessionSnapshot = (id: string, revision: number, input: number, output: number, finality = "open") =>
  snapshot(id, revision, tokens(input, output), { view: SESSION_VIEW, scope: SESSION_SCOPE, finality });
const turnDetail = (id: string, turnId: string, values = tokens(10, 1)) =>
  delta(id, values, { view: DETAIL_VIEW, scope: { scopeId: `usage-scope:${turnId}`, kind: "turn", turnId }, attribution: UNKNOWN, finality: "final" });

async function* usageTurn(emit: UsageEmitter, ...payloads: readonly unknown[]) {
  yield emit.started();
  for (const payload of payloads) yield emit.usage(payload);
  yield emit.completed();
}

// ------------------------------------------------------------------------------------------------
//                Delivery Placement
// ------------------------------------------------------------------------------------------------

test("usage rides the sole turn reader; the delivery turn is independent of the accounting scope", async (t) => {
  const plans: Record<string, readonly unknown[]> = {
    "turn-a": [sessionSnapshot("s-0", 0, 1110, 1), turnDetail("detail-a", "turn-a")],
    "turn-b": [sessionSnapshot("s-0", 0, 1110, 1), sessionSnapshot("s-1", 1, 3330, 3)],
  };
  const fixture = await openUsageSession({ script: (emit, input) => usageTurn(emit, ...plans[input.turnId]!) });
  t.after(() => fixture.dispose());

  const first = await collectOutputs(fixture.session.startTurn(turn("turn-a")).outputs);
  const second = await collectOutputs(fixture.session.startTurn(turn("turn-b")).outputs);
  const usage = [...first, ...second].flatMap((output) =>
    output.kind === "event" && output.event.type === "usage.observed" ? [output.event] : []);
  assert.deepEqual(usage.map((event) => [event.turnId, event.payload.observationId, event.payload.scope.kind]), [
    ["turn-a", "s-0", "session"], ["turn-a", "detail-a", "turn"], ["turn-b", "s-0", "session"], ["turn-b", "s-1", "session"],
  ]);
  assert.ok(usage.every((event) => Object.isFrozen(event) && Object.isFrozen(event.payload)));
});

test("usage is admitted after a final diff and before the terminal event, never after it", async (t) => {
  const accepted = await openUsageSession({ script: async function* (emit) {
    yield emit.started();
    yield emit.diff();
    yield emit.usage(sessionSnapshot("s-0", 0, 10, 1, "final"));
    yield emit.completed();
  } });
  t.after(() => accepted.dispose());
  const outputs = await collectOutputs(accepted.session.startTurn(turn("turn-diff")).outputs);
  assert.deepEqual(outputs.map((output) => output.kind === "event" ? output.event.type : output.kind),
    ["turn.started", "turn.diff.updated", "usage.observed", "turn.completed"]);

  const late = await openUsageSession({ script: async function* (emit) {
    yield emit.started();
    yield emit.completed();
    yield emit.usage(sessionSnapshot("s-0", 0, 10, 1));
  } });
  t.after(() => late.dispose());
  await assert.rejects(collectOutputs(late.session.startTurn(turn("turn-late")).outputs), hasCode("invalid_turn_sequence"));

  const early = await openUsageSession({ script: async function* (emit) {
    yield emit.usage(sessionSnapshot("s-0", 0, 10, 1));
  } });
  t.after(() => early.dispose());
  await assert.rejects(collectOutputs(early.session.startTurn(turn("turn-early")).outputs), hasCode("invalid_turn_sequence"));
});

test("valid unavailable telemetry preserves the native outcome", async (t) => {
  for (const outcome of ["completed", "failed"] as const) {
    const fixture = await openUsageSession({ script: async function* (emit) {
      yield emit.started();
      yield emit.usage({ ...turnDetail(`missing-${outcome}`, `turn-${outcome}`), measurement: { kind: "unavailable", reasons: ["native_result_incomplete"] } });
      yield emit.completed(outcome);
    } });
    t.after(() => fixture.dispose());
    const outputs = await collectOutputs(fixture.session.startTurn(turn(`turn-${outcome}`)).outputs);
    const terminal = outputs.at(-1);
    assert.ok(terminal?.kind === "event" && terminal.event.type === "turn.completed");
    assert.equal(terminal.event.payload.outcome, outcome);
  }
});

// ------------------------------------------------------------------------------------------------
//                Capability Matching
// ------------------------------------------------------------------------------------------------

test("observations must match a declared view, scope kind, reported counters and attribution kinds", async (t) => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["undeclared view", { ...sessionSnapshot("s", 0, 10, 1), view: { ...SESSION_VIEW, viewId: "other" } }, "output_capability_mismatch"],
    ["changed descriptor", { ...sessionSnapshot("s", 0, 10, 1), view: { ...SESSION_VIEW, population: { descendants: "unknown", auxiliary: "unknown" } } }, "output_capability_mismatch"],
    ["undeclared scope kind", { ...sessionSnapshot("s", 0, 10, 1), scope: { scopeId: "m", kind: "materialization" } }, "output_capability_mismatch"],
    ["listed counter unsupported", snapshot("s", 0, { inputTokens: 10 }, { view: SESSION_VIEW, scope: SESSION_SCOPE }), "output_capability_mismatch"],
    ["unlisted counter reported", snapshot("s", 0, tokens(10, 1, { cacheReadInputTokens: 0 }), { view: SESSION_VIEW, scope: SESSION_SCOPE }), "output_capability_mismatch"],
    ["undeclared attribution", delta("d", tokens(10, 1), {
      view: DETAIL_VIEW, scope: { scopeId: "usage-scope:turn-x", kind: "turn", turnId: "turn-x" }, attribution: MODEL_X,
    }), "output_capability_mismatch"],
  ];
  for (const [name, payload, code] of cases) {
    const fixture = await openUsageSession({ script: (emit) => usageTurn(emit, payload) });
    t.after(() => fixture.dispose());
    await assert.rejects(collectOutputs(fixture.session.startTurn(turn(name.replaceAll(" ", "-"))).outputs), hasCode(code), name);
  }

  const unsupported = await openUsageSession({
    capabilities: parseAgentCapabilities({ ...usageCapabilities, tokenUsage: { kind: "unsupported" } }),
    script: (emit) => usageTurn(emit, sessionSnapshot("s-0", 0, 10, 1)),
  });
  t.after(() => unsupported.dispose());
  await assert.rejects(collectOutputs(unsupported.session.startTurn(turn("turn-unsupported")).outputs), hasCode("output_capability_mismatch"));

  const unavailableOnly = await openUsageSession({ script: (emit) => usageTurn(emit, {
    ...sessionSnapshot("s-0", 0, 10, 1), measurement: { kind: "unavailable", reasons: ["not_reported"] },
  }) });
  t.after(() => unavailableOnly.dispose());
  await collectOutputs(unavailableOnly.session.startTurn(turn("turn-unavailable")).outputs);
});

// ------------------------------------------------------------------------------------------------
//                Contract Failures and Cleanup
// ------------------------------------------------------------------------------------------------

test("malformed, conflicting and regressing usage fails the turn with its usage contract code", async (t) => {
  const partialRows = { kind: "partial", reasons: ["not_reported"] };
  const cases: readonly (readonly [string, (emit: UsageEmitter) => readonly AgentProviderOutput[], string])[] = [
    ["malformed", (emit) => [emit.raw({ ...sessionSnapshot("s-0", 0, 10, 1), raw: {} })], "usage_invalid"],
    ["exact under partial coverage", (emit) => [emit.raw(snapshot("s-0", 0, tokens(10, 1), {
      view: SESSION_VIEW, scope: SESSION_SCOPE, coverage: partialRows,
    }))], "usage_invalid"],
    ["identity conflict", (emit) => [emit.usage(sessionSnapshot("s-0", 0, 10, 1)), emit.usage(sessionSnapshot("s-0", 1, 20, 2))], "usage_identity_conflict"],
    ["regression", (emit) => [emit.usage(sessionSnapshot("s-0", 0, 10, 1)), emit.usage(sessionSnapshot("s-1", 1, 9, 1))], "usage_counter_regression"],
    ["stale revision", (emit) => [emit.usage(sessionSnapshot("s-0", 3, 10, 1)), emit.usage(sessionSnapshot("s-1", 2, 20, 2))], "usage_sequence_invalid"],
  ];
  for (const [name, outputs, code] of cases) {
    const fixture = await openUsageSession({ script: async function* (emit) {
      yield emit.started();
      yield* outputs(emit);
      yield emit.completed();
    } });
    t.after(() => fixture.dispose());
    await assert.rejects(collectOutputs(fixture.session.startTurn(turn(`turn-${name.replaceAll(" ", "-")}`)).outputs), hasCode(code), name);
    assert.throws(() => fixture.session.startTurn(turn("turn-after")), (error) => error instanceof AgentProviderContractError, name);
  }
});

test("over-bound usage rejects as capacity and abandons the session through its close owner", async (t) => {
  const nineRows = {
    kind: "mixed",
    rowCoverage: "partial",
    rows: Array.from({ length: 9 }, (_, index) => ({ model: { modelId: `model-${index}` }, counters: counters(tokens(atLeast(1, "not_reported"), atLeast(1, "not_reported"))) })),
  };
  const overBound = snapshot("s-rows", 0, tokens(atLeast(9, "not_reported"), atLeast(9, "not_reported")), {
    view: SESSION_VIEW, scope: SESSION_SCOPE, coverage: { kind: "partial", reasons: ["not_reported"] }, attribution: nineRows,
  });
  const lateEpoch = snapshot("s-epoch", 0, tokens(10, 1), {
    view: SESSION_VIEW, scope: SESSION_SCOPE, epoch: 16, origin: { kind: "fresh_zero", cause: "native_reset" },
  });
  for (const payload of [overBound, lateEpoch]) {
    const fixture = await openUsageSession({ script: async function* (emit) {
      yield emit.started();
      yield emit.raw(payload);
      yield emit.completed();
    } });
    t.after(() => fixture.dispose());
    await assert.rejects(collectOutputs(fixture.session.startTurn(turn("turn-capacity")).outputs), hasCode("usage_capacity_exceeded"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.nativeCloses(), 1);
    assert.throws(() => fixture.session.startTurn(turn("turn-after")), hasCode("session_closed"));
  }
});

test("a foreign session envelope fails before accounting", async (t) => {
  const fixture = await openUsageSession({ script: async function* (emit) {
    yield emit.started();
    yield emit.raw(sessionSnapshot("s-0", 0, 10, 1), { sessionId: "another-session" });
  } });
  t.after(() => fixture.dispose());
  await assert.rejects(collectOutputs(fixture.session.startTurn(turn("turn-foreign")).outputs), hasCode("output_session_mismatch"));
});
