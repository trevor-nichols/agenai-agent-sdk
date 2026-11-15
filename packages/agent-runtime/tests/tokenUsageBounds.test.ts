// ------------------------------------------------------------------------------------------------
//                tokenUsageBounds.test.ts - Reducer views, missingness, rejection and capacity bounds
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_LIMITS,
  parseAgentProviderKey,
  type AgentUsageViewId,
} from "@agen-ai/agent-protocol";

import {
  AGENT_TOKEN_USAGE_LEDGER_LIMITS,
  admitTokenUsageEvent,
  createTokenUsageLedger,
  sumDisjointTokenCounts,
  summarizeTokenUsageView,
} from "../src/index.js";
import {
  admitAll, atLeast, CALL_VIEW, counters, delta, DETAIL_VIEW, event, exact, fresh, missing, MODEL_X, MODEL_Y, newWork, pick,
  rejectionCode, rows, SESSION, SESSION_SCOPE, SESSION_VIEW, snapshot, tokens, total, TURN_A, turnScope, UNKNOWN, unavailable,
  UNSUPPORTED, WHOLE_TREE,
} from "./fixtures/tokenUsage.js";

// ------------------------------------------------------------------------------------------------
//                Views and Attribution
// ------------------------------------------------------------------------------------------------

test("overlapping views never add: a parent total keeps its value beside contained child detail", () => {
  const child = { scopeId: "child", kind: "turn", turnId: "turn-a", containedIn: "session" };
  const ledger = fresh(snapshot("parent", 0, tokens(1000, 100)), delta("child", tokens(300, 30), { view: DETAIL_VIEW, scope: child }));
  assert.deepEqual(pick(total(ledger, SESSION_VIEW.viewId).counters, "inputTokens"), { inputTokens: exact(1000) });
  assert.deepEqual(pick(total(ledger, DETAIL_VIEW.viewId).counters, "inputTokens"), { inputTokens: exact(300) });

  const grandchild = { scopeId: "grandchild", kind: "turn", turnId: "turn-a", containedIn: "child" };
  assert.equal(rejectionCode(ledger, delta("grandchild", tokens(1, 1), { view: DETAIL_VIEW, scope: grandchild })), "usage_scope_mismatch");
  assert.equal(rejectionCode(ledger, delta("other", tokens(1, 1), { scope: turnScope("turn-b") })), "usage_scope_mismatch");
});

test("Claude attempt-4 per-turn results and cumulative model usage are overlapping views of one session", () => {
  const provider = parseAgentProviderKey("claude");
  const retention = (read: number, creation: number, fiveMinute: number, oneHour: number) => ({
    cacheReadInputTokens: read, cacheCreationInputTokens: creation, cacheCreationFiveMinuteInputTokens: fiveMinute,
    cacheCreationOneHourInputTokens: oneHour, reasoningOutputTokens: 0,
  });
  const model = { kind: "model", model: { modelId: "claude-scripted" } };
  const query = { scopeId: "m-7f3a:query", kind: "materialization" };
  const cumulative = (index: number, values: Record<string, unknown>) =>
    snapshot(`m-7f3a:result-${index}:model-usage`, index, values, { scope: query, attribution: model });
  const result = (index: number, turnId: string, values: Record<string, unknown>) => delta(`m-7f3a:result-${index}:usage`, values, {
    view: DETAIL_VIEW, scope: { scopeId: `m-7f3a:result-${index}`, kind: "turn", turnId, containedIn: query.scopeId },
    attribution: UNKNOWN, finality: "final",
  });
  const inclusive = sumDisjointTokenCounts(provider, { kind: "exact", value: 10 }, { kind: "exact", value: 100 }, { kind: "exact", value: 1000 });
  const ledger = fresh(
    cumulative(0, tokens(inclusive, 1, retention(100, 1000, 1000, 0))),
    result(0, "turn-1", tokens(1110, 1, retention(100, 1000, 1000, 0))),
    cumulative(1, tokens(3330, 3, retention(300, 3000, 1000, 2000))),
    result(1, "turn-2", tokens(2220, 2, retention(200, 2000, 0, 2000))),
  );
  const expected = {
    inputTokens: exact(3330), cacheReadInputTokens: exact(300), cacheCreationInputTokens: exact(3000),
    cacheCreationFiveMinuteInputTokens: exact(1000), cacheCreationOneHourInputTokens: exact(2000),
    outputTokens: exact(3), reasoningOutputTokens: exact(0), modelCalls: UNSUPPORTED, turns: UNSUPPORTED,
  };
  assert.deepEqual(total(ledger, SESSION_VIEW.viewId), { counters: expected, attribution: model });
  assert.deepEqual(total(ledger, DETAIL_VIEW.viewId), { counters: expected, attribution: UNKNOWN });
  assert.deepEqual(newWork(ledger).counters, expected);
  const summary = summarizeTokenUsageView(ledger, DETAIL_VIEW.viewId as AgentUsageViewId);
  assert.deepEqual(summary && { authority: summary.authority, scopeKind: summary.scopeKind, scopeCount: summary.scopeCount },
    { authority: "detail", scopeKind: "turn", scopeCount: 2 });
});

test("attribution is preserved rather than upgraded, borrowed or proportionally split", () => {
  const perCall = { view: DETAIL_VIEW, scope: { scopeId: "call", kind: "model_call", containedIn: "session" } };
  const thread = fresh(snapshot("thread", 0, tokens(5000, 50), { attribution: UNKNOWN }), delta("call", tokens(200, 2), perCall));
  assert.deepEqual(total(thread, SESSION_VIEW.viewId).attribution, UNKNOWN);
  assert.deepEqual(total(thread, DETAIL_VIEW.viewId).attribution, MODEL_X);

  const twoModels = fresh(delta("a", tokens(1, 1)), delta("b", tokens(1, 1), { scope: turnScope("turn-b"), attribution: MODEL_Y }));
  assert.deepEqual(total(twoModels).attribution, { kind: "mixed" });
  const withUnknown = admitAll(twoModels, delta("c", tokens(1, 1), { scope: turnScope("turn-c"), attribution: UNKNOWN }));
  assert.deepEqual(total(withUnknown).attribution, { kind: "mixed" });
  const oneAndUnknown = fresh(delta("a", tokens(1, 1)), delta("c", tokens(1, 1), { scope: turnScope("turn-c"), attribution: UNKNOWN }));
  assert.deepEqual(total(oneAndUnknown).attribution, UNKNOWN);
  assert.deepEqual(total(fresh(delta("m", tokens(100, 2), { attribution: rows(70, 30) }))).attribution, { kind: "mixed" });
  assert.equal(rejectionCode(createTokenUsageLedger({ sessionId: SESSION }), delta("m", tokens(100, 2), { attribution: rows(70, 20) })), "usage_invalid");
});

// ------------------------------------------------------------------------------------------------
//                Missingness and Rejection
// ------------------------------------------------------------------------------------------------

test("missing measurements stay missing rather than becoming zero or a complete total", () => {
  const lost = missing("lost", ["observation_interrupted"], { view: SESSION_VIEW, scope: SESSION_SCOPE });
  const interrupted = fresh(snapshot("s-0", 0, tokens(1000, 10)), lost);
  assert.deepEqual(total(interrupted, SESSION_VIEW.viewId).counters.inputTokens, atLeast(1000, "observation_interrupted"));
  assert.deepEqual(total(admitAll(interrupted, snapshot("s-1", 1, tokens(1200, 12))), SESSION_VIEW.viewId).counters.inputTokens, exact(1200));
  assert.deepEqual(total(fresh(delta("call-1", tokens(200, 20)), missing("call-2", ["not_reported"]))).counters.outputTokens,
    atLeast(20, "not_reported"));

  const zeroedErrorResult = fresh(missing("result", ["native_result_incomplete"], { finality: "final" }));
  const allMissing = Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name, unavailable("native_result_incomplete")]));
  assert.deepEqual(total(zeroedErrorResult), { counters: counters(allMissing), attribution: UNKNOWN });
  assert.equal(summarizeTokenUsageView(zeroedErrorResult, SESSION_VIEW.viewId as AgentUsageViewId), undefined);
});

test("malformed, unsafe, contradictory and foreign observations reject while the prior ledger keeps accounting", () => {
  const ledger = fresh(delta("base", tokens(200, 20)));
  const bad = (values: Record<string, unknown>, options?: Parameters<typeof delta>[2]) => delta("bad", values, options);
  const cases: readonly (readonly [unknown, string])[] = [
    [bad(tokens(-1, 1)), "usage_invalid"],
    [bad(tokens(1.5, 1)), "usage_invalid"],
    [bad(tokens(2 ** 53, 1)), "usage_invalid"],
    [{ ...bad(tokens(1, 1)), raw: { usage: {} } }, "usage_invalid"],
    [bad(tokens(100, 1, { cacheReadInputTokens: 60, cacheCreationInputTokens: 41 })), "usage_invalid"],
    [bad(tokens(100, 1, { cacheCreationInputTokens: 10, cacheCreationFiveMinuteInputTokens: 6, cacheCreationOneHourInputTokens: 5 })), "usage_invalid"],
    [bad(tokens(100, 7, { reasoningOutputTokens: 8 })), "usage_invalid"],
    [bad(tokens(100, 7), { coverage: { kind: "partial", reasons: ["not_reported"] } }), "usage_invalid"],
    [bad(tokens(unavailable("unsupported", "not_reported"), 7)), "usage_invalid"],
    [snapshot("bad", 0, tokens(1, 1), { view: CALL_VIEW, scope: TURN_A }), "usage_invalid"],
    [snapshot("bad", 0, tokens(1, 1), { epoch: -1, origin: { kind: "unknown", cause: "native_new_origin" } }), "usage_invalid"],
    [bad(tokens(Number.MAX_SAFE_INTEGER, 1)), "usage_invalid"],
    [bad(tokens(Number.MAX_SAFE_INTEGER, 1), { scope: turnScope("turn-z") }), "usage_invalid"],
    [bad(tokens(1, 1), { scope: { ...TURN_A, turnId: "turn-b" } }), "usage_scope_mismatch"],
    [bad(tokens(1, 1), { view: { ...CALL_VIEW, population: WHOLE_TREE } }), "usage_scope_mismatch"],
  ];
  for (const [payload, code] of cases) assert.equal(rejectionCode(ledger, payload), code, JSON.stringify(payload));
  assert.equal(rejectionCode(ledger, delta("foreign", tokens(1, 1)), { sessionId: "session-2" }), "usage_scope_mismatch");
  assert.equal(rejectionCode(ledger, delta("envelope", tokens(1, 1)), { protocolVersion: 13 }), "usage_invalid");
  assert.equal(rejectionCode(ledger, delta("envelope", tokens(1, 1)), { type: "context.usage.updated" }), "usage_invalid");
  assert.equal(rejectionCode(ledger, delta("envelope", tokens(1, 1)), { extra: true }), "usage_invalid");
  assert.deepEqual(pick(total(admitAll(ledger, delta("next", tokens(100, 10)))).counters, "inputTokens"), { inputTokens: exact(300) });
});

// ------------------------------------------------------------------------------------------------
//                Capacity and Byte Budgets
// ------------------------------------------------------------------------------------------------

test("capacity exhaustion rejects new identities without evicting retained ones", () => {
  let ledger = createTokenUsageLedger({ sessionId: SESSION });
  for (let index = 0; index < AGENT_TOKEN_USAGE_LEDGER_LIMITS.scopes; index += 1) {
    ledger = admitAll(ledger, delta(`call-${index}`, tokens(1, 1), { scope: turnScope(`turn-${index}`) }));
  }
  assert.equal(rejectionCode(ledger, delta("call-extra", tokens(1, 1), { scope: turnScope("turn-extra") })), "usage_capacity_exceeded");
  for (let index = AGENT_TOKEN_USAGE_LEDGER_LIMITS.scopes; index < AGENT_TOKEN_USAGE_LEDGER_LIMITS.retainedObservations; index += 1) {
    ledger = admitAll(ledger, missing(`call-${index}`, ["not_reported"], { scope: turnScope("turn-0") }));
  }
  assert.equal(rejectionCode(ledger, delta("call-next", tokens(1, 1), { scope: turnScope("turn-0") })), "usage_capacity_exceeded");
  assert.equal(admitTokenUsageEvent(ledger, event(delta("call-1", tokens(1, 1), { scope: turnScope("turn-1") }))).status, "duplicate");
  assert.deepEqual(total(ledger).counters.inputTokens, atLeast(AGENT_TOKEN_USAGE_LEDGER_LIMITS.scopes, "not_reported"));
});

test("views, model rows and epochs have finite capacity", () => {
  const views = ["v-1", "v-2", "v-3", "v-4"].map((viewId, index) => delta(viewId, tokens(1, 1), {
    view: { ...DETAIL_VIEW, viewId }, scope: { scopeId: `scope-${index}`, kind: "turn", turnId: "turn-a" },
  }));
  const fullViews = fresh(...views);
  assert.equal(rejectionCode(fullViews, delta("v-5", tokens(1, 1), {
    view: { ...DETAIL_VIEW, viewId: "v-5" }, scope: turnScope("turn-extra"),
  })), "usage_capacity_exceeded");

  const lower = atLeast(1, "not_reported");
  const nineModels = { kind: "mixed", rowCoverage: "partial", rows: Array.from({ length: AGENT_TOKEN_USAGE_LIMITS.modelRows + 1 }, (_, index) => ({
    model: { modelId: `model-${index}` }, counters: counters(tokens(lower, lower)),
  })) };
  const partial = { kind: "partial", reasons: ["not_reported"] };
  assert.equal(rejectionCode(fullViews, delta("rows", tokens(atLeast(9, "not_reported"), atLeast(9, "not_reported")), {
    coverage: partial, attribution: nineModels,
  })), "usage_capacity_exceeded");

  const reset = (epoch: number) => snapshot(`epoch-${epoch}`, 0, tokens(1, 1), {
    epoch, origin: epoch === 0 ? { kind: "fresh_zero", cause: "initial" } : { kind: "fresh_zero", cause: "native_reset" },
  });
  const allEpochs = fresh(...Array.from({ length: AGENT_TOKEN_USAGE_LIMITS.epochsPerScope }, (_, epoch) => reset(epoch)));
  assert.equal(rejectionCode(allEpochs, reset(AGENT_TOKEN_USAGE_LIMITS.epochsPerScope)), "usage_capacity_exceeded");
});

test("byte budgets admit a large ASCII observation and reject wide text and excess retention", () => {
  const reasons = ["native_result_incomplete", "observation_interrupted", "counter_discontinuity"];
  const largeObservation = (index: number, fill = "a", value = Number.MAX_SAFE_INTEGER) => {
    const id = (prefix: string, length: number = AGENT_TOKEN_USAGE_LIMITS.identifierLength) => prefix.padEnd(length, fill);
    const partial = counters(Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name,
      name === "modelCalls" || name === "turns" ? UNSUPPORTED : atLeast(value, ...reasons)])));
    return {
      observationId: id(`observation-${index}-`),
      view: { ...DETAIL_VIEW, viewId: id("view-") },
      scope: { scopeId: id("scope-"), kind: "turn", turnId: id("turn-", AGENT_PROTOCOL_ID_MAX_LENGTH), containedIn: id("parent-") },
      measurement: {
        kind: "delta",
        coverage: { kind: "partial", reasons },
        counters: partial,
        attribution: {
          kind: "mixed",
          rowCoverage: "partial",
          rows: Array.from({ length: AGENT_TOKEN_USAGE_LIMITS.modelRows }, (_, row) => ({
            model: { modelProvider: id(`p${row}-`, AGENT_TOKEN_USAGE_LIMITS.modelProviderLength), modelId: id(`m${row}-`) },
            counters: partial,
          })),
        },
      },
      finality: "open",
    };
  };
  const empty = createTokenUsageLedger({ sessionId: SESSION });
  assert.equal(admitTokenUsageEvent(empty, event(largeObservation(0))).status, "recorded");
  assert.equal(rejectionCode(empty, largeObservation(0, "界")), "usage_capacity_exceeded");

  let ledger = empty;
  let admitted = 0;
  for (;;) {
    const result = admitTokenUsageEvent(ledger, event(largeObservation(admitted, "a", 1_000_000_000)));
    if (result.status === "rejected") {
      assert.equal(result.code, "usage_capacity_exceeded");
      break;
    }
    assert.equal(result.status, "recorded");
    ledger = result.ledger;
    admitted += 1;
  }
  assert.ok(admitted > 0 && admitted < AGENT_TOKEN_USAGE_LEDGER_LIMITS.retainedObservations);
  assert.equal(admitTokenUsageEvent(ledger, event(largeObservation(0, "a", 1_000_000_000))).status, "duplicate");
});
