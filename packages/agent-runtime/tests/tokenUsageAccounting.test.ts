// ------------------------------------------------------------------------------------------------
//                tokenUsageAccounting.test.ts - Reducer quantities, identity and snapshot sequencing
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentProviderKey } from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  admitTokenUsageEvent,
  createTokenUsageLedger,
  sumDisjointTokenCounts,
} from "../src/index.js";
import {
  admitAll, atLeast, CALL_VIEW, delta, event, exact, fresh, HISTORICAL, MODEL_Y, newWork, pick, rejectionCode, rows,
  SESSION, SESSION_VIEW, snapshot, tokens, total, turnScope, UNKNOWN, unavailable, UNSUPPORTED,
} from "./fixtures/tokenUsage.js";

const PROVIDER = parseAgentProviderKey("claude");
type Count = Parameters<typeof sumDisjointTokenCounts>[1];
const count = (value: unknown) => value as Count;

// ------------------------------------------------------------------------------------------------
//                Canonical Quantities
// ------------------------------------------------------------------------------------------------

test("exclusive native buckets compose into inclusive totals whose subsets are never re-added", () => {
  assert.deepEqual(sumDisjointTokenCounts(PROVIDER, count(exact(100)), count(exact(800)), count(exact(100))), exact(1000));
  assert.deepEqual(
    sumDisjointTokenCounts(PROVIDER, count(exact(100)), count(exact(800)), count(unavailable("not_reported"))),
    atLeast(900, "not_reported"),
  );
  assert.deepEqual(sumDisjointTokenCounts(PROVIDER, count(unavailable("not_reported"))), unavailable("not_reported"));
  const usageInvalid = { name: "AgentProviderContractError", providerKey: PROVIDER, code: "usage_invalid" };
  assert.throws(() => sumDisjointTokenCounts(PROVIDER, count(exact(Number.MAX_SAFE_INTEGER)), count(exact(1))), usageInvalid);
  assert.throws(() => sumDisjointTokenCounts(PROVIDER, count(exact(10)), count(UNSUPPORTED)), usageInvalid);
  assert.throws(() => sumDisjointTokenCounts(PROVIDER, count(exact(-1))), (error) => error instanceof AgentProviderContractError);

  const ledger = fresh(delta("call-1", tokens(1000, 27, { cacheReadInputTokens: 800, cacheCreationInputTokens: 100, reasoningOutputTokens: 7 })));
  assert.deepEqual(pick(total(ledger).counters, "inputTokens", "cacheReadInputTokens", "outputTokens", "reasoningOutputTokens"), {
    inputTokens: exact(1000), cacheReadInputTokens: exact(800), outputTokens: exact(27), reasoningOutputTokens: exact(7),
  });
});

test("known zero, unsupported, not reported and partial subsets keep distinct meanings", () => {
  const ledger = fresh(
    delta("call-1", tokens(10, 100, { cacheReadInputTokens: 0, reasoningOutputTokens: atLeast(7, "history_incomplete") })),
    delta("call-2", tokens(unavailable("not_reported"), 50, { cacheReadInputTokens: 0, reasoningOutputTokens: 5 })),
  );
  assert.deepEqual(total(ledger).counters, {
    inputTokens: atLeast(10, "not_reported"),
    cacheReadInputTokens: exact(0),
    cacheCreationInputTokens: UNSUPPORTED,
    cacheCreationFiveMinuteInputTokens: UNSUPPORTED,
    cacheCreationOneHourInputTokens: UNSUPPORTED,
    outputTokens: exact(150),
    reasoningOutputTokens: atLeast(12, "history_incomplete"),
    modelCalls: UNSUPPORTED,
    turns: UNSUPPORTED,
  });
});

test("composed reasons stay admissible at the observation boundary", () => {
  const six = sumDisjointTokenCounts(PROVIDER,
    count(atLeast(1, "not_reported", "history_incomplete", "origin_unknown")),
    count(atLeast(2, "native_result_incomplete", "coverage_unknown", "observation_interrupted")));
  assert.deepEqual(six, atLeast(3, "not_reported", "native_result_incomplete", "history_incomplete", "origin_unknown",
    "coverage_unknown", "observation_interrupted"));
  const seven = sumDisjointTokenCounts(PROVIDER, six, count(atLeast(1, "counter_discontinuity")));
  const ledger = fresh(delta("composed", tokens(seven, 0)));
  assert.deepEqual(total(ledger).counters.inputTokens, atLeast(4, "not_reported", "native_result_incomplete", "history_incomplete",
    "origin_unknown", "coverage_unknown", "observation_interrupted", "counter_discontinuity"));
});

test("qualified model-request and SDK-turn counts keep their units and declared basis", () => {
  const view = { ...CALL_VIEW, countBasis: { modelCalls: "provider_reported", turns: "observed" } };
  const first = delta("counted-a", tokens(100, 10, { modelCalls: 3, turns: 1 }), { view, finality: "final" });
  const second = delta("counted-b", tokens(200, 20, { modelCalls: 2, turns: 1 }), { view, scope: turnScope("turn-b"), finality: "final" });
  const ledger = fresh(first, second);
  assert.deepEqual(pick(total(ledger).counters, "modelCalls", "turns"), { modelCalls: exact(5), turns: exact(2) });
  assert.equal(admitTokenUsageEvent(ledger, event(first)).status, "duplicate");
  assert.equal(rejectionCode(createTokenUsageLedger({ sessionId: SESSION }), delta("unqualified", tokens(1, 1, { modelCalls: 1 }))), "usage_invalid");
  assert.equal(rejectionCode(ledger, delta("basis-drift", tokens(1, 1, { modelCalls: 1, turns: 0 }), {
    view: { ...view, countBasis: { modelCalls: "observed", turns: "observed" } },
  })), "usage_scope_mismatch");
});

test("a turn scope admits several model calls but one entered SDK turn, including across epochs", () => {
  const view = { ...CALL_VIEW, countBasis: { modelCalls: "observed", turns: "observed" } };
  const first = fresh(delta("first", { modelCalls: 1, turns: 1 }, { view }));
  assert.equal(rejectionCode(first, delta("second-entry", { modelCalls: 1, turns: 1 }, { view })), "usage_scope_mismatch");
  const second = admitAll(first, delta("second-call", { modelCalls: 1, turns: 0 }, { view }));
  assert.deepEqual(pick(total(second).counters, "modelCalls", "turns"), { modelCalls: exact(2), turns: exact(1) });
  const snapshotView = { ...view, accounting: "snapshot" };
  const started = fresh(snapshot("epoch0", 0, { modelCalls: 1, turns: 1 }, { view: snapshotView, scope: turnScope("turn-a") }));
  assert.equal(rejectionCode(started, snapshot("epoch1", 0, { modelCalls: 1, turns: 1 }, {
    view: snapshotView, scope: turnScope("turn-a"), epoch: 1, origin: { kind: "fresh_zero", cause: "native_reset" },
  })), "usage_scope_mismatch");
});

// ------------------------------------------------------------------------------------------------
//                Identity and Replay
// ------------------------------------------------------------------------------------------------

test("distinct equal increments count twice, a replay is idempotent and a changed identity is rejected", () => {
  const first = delta("call-1", tokens(200, 20));
  const ledger = fresh(first, delta("call-2", tokens(200, 20)));
  assert.deepEqual(pick(total(ledger).counters, "inputTokens", "outputTokens"), { inputTokens: exact(400), outputTokens: exact(40) });

  const reordered = { finality: first.finality, measurement: first.measurement, scope: first.scope, view: first.view, observationId: first.observationId };
  const replay = admitTokenUsageEvent(ledger, event(reordered, { turnId: "turn-b", occurredAt: "2026-11-14T00:00:00.000Z" }));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.status === "duplicate" && replay.ledger, ledger);

  assert.equal(rejectionCode(ledger, delta("call-1", tokens(200, 21))), "usage_identity_conflict");
  const after = admitAll(ledger, delta("call-3", tokens(200, 20)));
  assert.deepEqual(pick(total(after).counters, "inputTokens", "outputTokens"), { inputTokens: exact(600), outputTokens: exact(60) });
  assert.deepEqual(pick(total(ledger).counters, "inputTokens"), { inputTokens: exact(400) });
});

test("ledgers and summaries are immutable values", () => {
  const ledger = fresh(delta("call-1", tokens(10, 1)));
  const summary = total(ledger);
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.counters) && Object.isFrozen(summary.counters.inputTokens));
  assert.equal(total(ledger), summary);
  assert.ok(Object.isFrozen(ledger));
  assert.deepEqual(Object.keys(ledger), []);
  assert.throws(() => admitTokenUsageEvent({} as typeof ledger, event(delta("x", tokens(1, 1)))), TypeError);
});

test("a settled checkpoint leaves the series open until a final observation settles it", () => {
  const checkpoints = [snapshot("s-0", 0, tokens(1110, 1)), snapshot("s-1", 1, tokens(3330, 3))];
  const open = checkpoints.reduce((ledger, payload, index) => {
    const result = admitTokenUsageEvent(ledger, event(payload, { turnId: index === 0 ? "turn-a" : "turn-b" }));
    assert.equal(result.status, "recorded");
    return result.status === "recorded" ? result.ledger : ledger;
  }, createTokenUsageLedger({ sessionId: SESSION }));
  const settled = admitAll(open, snapshot("s-2", 2, tokens(3330, 3), { finality: "final" }));
  assert.equal(rejectionCode(settled, snapshot("s-3", 3, tokens(4000, 4))), "usage_sequence_invalid");
  assert.equal(admitTokenUsageEvent(settled, event(checkpoints[1])).status, "duplicate");

  const turn = fresh(delta("call-1", tokens(10, 1), { finality: "final" }));
  assert.equal(rejectionCode(turn, delta("call-2", tokens(10, 1))), "usage_sequence_invalid");
});

// ------------------------------------------------------------------------------------------------
//                Snapshots
// ------------------------------------------------------------------------------------------------

test("comparable exact historical snapshots establish new work; a lower bound followed by an exact total does not", () => {
  const history = fresh(snapshot("s-0", 0, tokens(400, 40), { origin: HISTORICAL }), snapshot("s-1", 1, tokens(600, 60), { origin: HISTORICAL }));
  assert.deepEqual(pick(total(history, SESSION_VIEW.viewId).counters, "inputTokens", "outputTokens"), { inputTokens: exact(600), outputTokens: exact(60) });
  assert.deepEqual(pick(newWork(history).counters, "inputTokens", "outputTokens"), { inputTokens: exact(200), outputTokens: exact(20) });
  assert.equal(rejectionCode(history, snapshot("s-1-again", 1, tokens(600, 60), { origin: HISTORICAL })), "usage_identity_conflict");

  const backfilled = fresh(
    snapshot("s-0", 0, tokens(atLeast(400, "history_incomplete"), atLeast(40, "history_incomplete")), {
      origin: HISTORICAL, coverage: { kind: "partial", reasons: ["history_incomplete"] },
    }),
    snapshot("s-1", 1, tokens(1000, 100), { origin: HISTORICAL }),
  );
  assert.deepEqual(pick(newWork(backfilled).counters, "inputTokens", "outputTokens"), {
    inputTokens: unavailable("history_incomplete"), outputTokens: unavailable("history_incomplete"),
  });
});

test("unknown origins never subtract and changed populations disable subtraction permanently", () => {
  const origin = { kind: "unknown", cause: "initial" };
  const unknownOrigin = fresh(snapshot("u-0", 0, tokens(400, 40), { origin }), snapshot("u-1", 1, tokens(600, 60), { origin }));
  assert.deepEqual(total(unknownOrigin, SESSION_VIEW.viewId).counters.inputTokens, exact(600));
  assert.deepEqual(newWork(unknownOrigin).counters.inputTokens, unavailable("origin_unknown"));

  const initial = fresh(snapshot("baseline", 0, { inputTokens: 400, outputTokens: 100, reasoningOutputTokens: 0 }, { origin: HISTORICAL }));
  const changed = { inputTokens: { kind: "stable", populationId: "restored-input" }, reasoningOutputTokens: UNKNOWN };
  const updated = admitAll(initial, snapshot("backfill", 1, { inputTokens: 1000, outputTokens: 100, reasoningOutputTokens: 50 }, {
    origin: HISTORICAL, comparison: changed,
  }));
  assert.deepEqual(pick(newWork(updated).counters, "inputTokens", "outputTokens", "reasoningOutputTokens"), {
    inputTokens: unavailable("history_incomplete"), outputTokens: exact(0), reasoningOutputTokens: unavailable("history_incomplete"),
  });
  const reverted = admitAll(updated, snapshot("old-id", 2, { inputTokens: 1100, outputTokens: 110, reasoningOutputTokens: 51 }, { origin: HISTORICAL }));
  assert.deepEqual(newWork(reverted).counters.inputTokens, unavailable("history_incomplete"));
});

test("historical subtraction cannot create subset work outside its inclusive parent", () => {
  for (const [parent, child] of [["outputTokens", "reasoningOutputTokens"], ["inputTokens", "cacheReadInputTokens"]] as const) {
    const ledger = fresh(snapshot("base", 0, { [parent]: 100, [child]: 0 }, { origin: HISTORICAL }));
    assert.equal(rejectionCode(ledger, snapshot("reclassified", 1, { [parent]: 100, [child]: 50 }, { origin: HISTORICAL })), "usage_invalid");
    assert.deepEqual(pick(newWork(ledger).counters, parent, child), { [parent]: exact(0), [child]: exact(0) });
  }
});

test("a lower value is a regression unless an explicit native boundary opens the next epoch", () => {
  const ledger = fresh(snapshot("s-0", 5, tokens(1000, 10)));
  assert.equal(rejectionCode(ledger, snapshot("s-1", 6, tokens(900, 10))), "usage_counter_regression");
  assert.equal(rejectionCode(ledger, snapshot("s-1", 3, tokens(1200, 12))), "usage_sequence_invalid");
  assert.equal(rejectionCode(ledger, snapshot("s-1", 6, tokens(1200, 12), { origin: HISTORICAL })), "usage_scope_mismatch");
  assert.equal(rejectionCode(ledger, snapshot("s-1", 0, tokens(1, 1), { epoch: 2, origin: { kind: "fresh_zero", cause: "native_reset" } })), "usage_sequence_invalid");

  const reset = admitAll(ledger, snapshot("s-1", 0, tokens(100, 1), { epoch: 1, origin: { kind: "fresh_zero", cause: "native_reset" } }));
  assert.deepEqual(pick(total(reset, SESSION_VIEW.viewId).counters, "inputTokens", "outputTokens"), {
    inputTokens: atLeast(1100, "counter_discontinuity"), outputTokens: atLeast(11, "counter_discontinuity"),
  });
  const restored = admitAll(ledger, snapshot("s-1", 0, tokens(1200, 12), { epoch: 1, origin: { kind: "historical", cause: "native_new_origin" } }));
  assert.deepEqual(total(restored, SESSION_VIEW.viewId).counters.inputTokens, atLeast(1200, "origin_unknown", "counter_discontinuity"));
  assert.deepEqual(newWork(restored).counters.inputTokens, atLeast(1000, "counter_discontinuity"));
});

test("cumulative model evidence survives unknown snapshots and rejects reassignment or row regression", () => {
  const original = fresh(snapshot("model-a", 0, tokens(100, 1)));
  assert.equal(rejectionCode(original, snapshot("model-b", 1, tokens(200, 2), { attribution: MODEL_Y })), "usage_scope_mismatch");
  const gap = admitAll(original, snapshot("model-unknown", 1, tokens(150, 2), { attribution: UNKNOWN }));
  assert.equal(rejectionCode(gap, snapshot("model-b", 2, tokens(200, 2), { attribution: MODEL_Y })), "usage_scope_mismatch");
  const mixed = admitAll(gap, snapshot("both", 2, tokens(200, 2), { attribution: rows(100, 100) }));
  assert.deepEqual(total(mixed, SESSION_VIEW.viewId).attribution, { kind: "mixed" });
  assert.equal(rejectionCode(mixed, snapshot("regressed-row", 3, tokens(250, 2), { attribution: rows(50, 200) })), "usage_counter_regression");
  assert.equal(rejectionCode(mixed, snapshot("lost-row", 3, tokens(300, 3))), "usage_scope_mismatch");
  assert.deepEqual(total(mixed, SESSION_VIEW.viewId).counters.inputTokens, exact(200));
});
