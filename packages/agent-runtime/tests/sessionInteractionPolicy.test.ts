// ------------------------------------------------------------------------------------------------
//                sessionInteractionPolicy.test.ts - Typed direct requests and human wait boundaries
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  AgentProtocolValidationError, parseAgentSessionFormRequest, parseAgentSessionPlanReviewRequest,
  parseAgentSessionResponse, parseAgentSessionFormChoiceId, parseAgentSessionPlanRevision,
} from "@agen-ai/agent-protocol";
import type {
  AgentProviderSessionContext, AgentRequestResolutionResult, AgentSessionInteraction,
  AgentSessionInteractionContext, AgentSessionInteractionSupport,
} from "../src/index.js";
import { createHarness, deferred, hasContractCode, makeBinding, type OpeningKind } from "./fixtures/hostBindings/harness.js";
import { decline, grant, refusal, scenario } from "./fixtures/sessionInteractions.js";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const directSupport: AgentSessionInteractionSupport = {
  kind: "supported", producerOwnership: "exclusive", humanWait: ["bounded", "until_withdrawn_or_closed"],
  mappings: [
    { openingOperation: "create", requestKind: "decision" },
    { openingOperation: "create", requestKind: "form" },
    { openingOperation: "create", requestKind: "plan_review" },
  ],
};

function form(context: AgentProviderSessionContext) {
  return parseAgentSessionFormRequest({ kind: "form", sessionId: context.sessionId, requestId: "outside-turn-form",
    title: "Delivery details", fields: [{ kind: "text", fieldId: "address", label: "Address", required: true,
      sensitivity: "sensitive", multiline: false, maxLength: 100 }],
    choices: [{ action: "submit", choiceId: "send", label: "Send details" }, { action: "cancel", choiceId: "cancel", label: "Cancel" }],
  });
}

function review(context: AgentProviderSessionContext) {
  return parseAgentSessionPlanReviewRequest({ kind: "plan_review", sessionId: context.sessionId, requestId: "outside-turn-review",
    title: "Review the migration", plan: { planId: "migration-plan", revision: "revision-2", title: "Migration plan",
      content: { kind: "text", format: "markdown", text: "1. Back up the data.\n2. Apply the reviewed migration." } },
    choices: [{ action: "approve", choiceId: "approve", label: "Approve" },
      { action: "revise", choiceId: "revise", label: "Revise" }, { action: "abandon", choiceId: "abandon", label: "Abandon" }],
  });
}

test("direct session forms and plan reviews deliver exact offered actions without starting a turn", { timeout: 10_000 }, async (t) => {
  const cases = [
    { response: { kind: "form", action: "submit", choiceId: "send", answers: [{ kind: "text", fieldId: "address", value: "Private address" }] },
      accepted: { kind: "form", action: "submit", choiceId: "send" } },
    { response: { kind: "form", action: "cancel", choiceId: "cancel" }, accepted: { kind: "form", action: "cancel", choiceId: "cancel" } },
    { response: { kind: "plan_review", action: "approve", choiceId: "approve", planId: "migration-plan", revision: "revision-2" },
      accepted: { kind: "plan_review", action: "approve", choiceId: "approve", planId: "migration-plan", revision: "revision-2" } },
    { response: { kind: "plan_review", action: "revise", choiceId: "revise", planId: "migration-plan", revision: "revision-2", feedback: "Keep the rollback step." },
      accepted: { kind: "plan_review", action: "revise", choiceId: "revise", planId: "migration-plan", revision: "revision-2" } },
    { response: { kind: "plan_review", action: "abandon", choiceId: "abandon", planId: "migration-plan", revision: "revision-2" },
      accepted: { kind: "plan_review", action: "abandon", choiceId: "abandon", planId: "migration-plan", revision: "revision-2" } },
  ] as const;
  for (const entry of cases) await t.test(`${entry.response.kind}/${entry.response.action}`, async () => {
    let starts = 0;
    const fixture = await scenario({ support: directSupport, openingOffer: false, transformSession(session) {
      return { ...session, startTurn(input) { starts += 1; return session.startTurn(input); } };
    } });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
    const candidate = fixture.offer(fixture.contexts[0]!, { request: entry.response.kind === "form" ? form : review });
    assert.ok(handle);
    const response = parseAgentSessionResponse(entry.response);
    if (response.kind === "form" && response.action === "cancel") {
      await assert.rejects(handle.respond({ ...response, choiceId: parseAgentSessionFormChoiceId("send") }),
        (error: unknown) => error instanceof AgentProtocolValidationError);
    }
    if (response.kind === "plan_review" && response.action === "revise") {
      await assert.rejects(handle.respond({ ...response, revision: parseAgentSessionPlanRevision("revision-1") }),
        (error: unknown) => error instanceof AgentProtocolValidationError);
    }
    assert.deepEqual(candidate.responses, []);
    assert.deepEqual(await handle.respond(response), { status: "delivered" });
    assert.deepEqual(candidate.responses, [entry.response]);
    assert.deepEqual(await handle.terminal, { kind: "answered", response: entry.accepted });
    assert.equal(starts, 0);
    await session.close({ reason: "idle" });
    assert.deepEqual([fixture.closes(), candidate.answers], [1, [entry.response.choiceId]]);
  });
});

test("the default finite human deadline expires without an answer and joins retained presentation before release", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const releaseCallback = deferred<void>();
  const host = makeBinding();
  const fixture = await scenario({ cleanup: () => releaseCallback.resolve() });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", host.binding, { interactions: { async onRequest(value) {
    handle = value;
    await releaseCallback.promise;
  } } });
  assert.ok(handle);
  assert.equal(Object.hasOwn(handle.request, "expiresAt"), false);
  assert.deepEqual(handle.deadline, { kind: "deadline", expiresAt: "2026-10-16T12:05:00.000Z", source: "host_policy" });
  t.mock.timers.tick(299_999);
  await setImmediate();
  assert.deepEqual([handle.signal.aborted, fixture.closes(), host.releaseCount()], [false, 0, 0]);
  t.mock.timers.tick(1);
  assert.deepEqual(await handle.terminal, { kind: "expired", source: "host_policy" });
  await fixture.nativeCloseEntered;
  assert.deepEqual([fixture.offers[0]!.answers, host.releaseCount()], [[], 0]);
  releaseCallback.resolve();
  await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
  await session.close({ reason: "idle" });
  assert.deepEqual([fixture.closes(), host.releaseCount()], [1, 1]);
});

test("explicit unbounded human waiting survives beyond the former ceiling without inventing producer expiry", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const fixture = await scenario();
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: {
    humanWait: { kind: "until_withdrawn_or_closed" }, onRequest(value) { handle = value; },
  } });
  assert.ok(handle);
  const producer = fixture.contexts[0]!.interactions;
  assert.ok(producer);
  assert.deepEqual(producer.humanWait, { kind: "until_withdrawn_or_closed" });
  assert.equal(Object.hasOwn(producer.limits ?? {}, "requestTimeoutMs"), false);
  assert.deepEqual(handle.deadline, { kind: "no_deadline" });
  assert.equal(Object.hasOwn(handle.request, "expiresAt"), false);
  t.mock.timers.tick(1_800_001);
  await setImmediate();
  assert.deepEqual([handle.signal.aborted, fixture.closes(), fixture.offers[0]!.answers], [false, 0, []]);
  assert.deepEqual(await handle.respond({ kind: "decision", choiceId: decline }), { status: "delivered" });
  assert.deepEqual(await handle.terminal, { kind: "answered", response: { kind: "decision", choiceId: decline } });
  assert.deepEqual(fixture.offers[0]!.answers, ["leave-gated"]);
  await session.close({ reason: "idle" });
});

test("conflicting and malformed human policy is rejected before candidate opening and releases the host binding", { timeout: 10_000 }, async (t) => {
  for (const kind of ["create", "resume", "branch"] satisfies OpeningKind[]) await t.test(kind, async () => {
    let entries = 0;
    const harness = await createHarness({ beforeOpen() { entries += 1; }, transformAdapter(adapter) {
      return { ...adapter, sessionInteractions: { kind: "supported", producerOwnership: "exclusive",
        mappings: [{ openingOperation: "create", requestKind: "decision" }, { openingOperation: "resume", requestKind: "decision" },
          { openingOperation: "branch", requestKind: "decision" }], humanWait: ["bounded", "until_withdrawn_or_closed"] } };
    } });
    t.after(() => harness.registry.dispose());
    for (const human of [
      { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { requestTimeoutMs: 300_000 } },
      { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { requestTimeoutMs: undefined } },
      { humanWait: { kind: "unlimited" } },
      { humanWait: { kind: "bounded", duration: 10 } },
    ]) {
      const host = makeBinding();
      const interactions = { ...human, onRequest() {} } as unknown as AgentSessionInteractionContext;
      await assert.rejects(async () => harness.open(kind, host.binding, { interactions }), hasContractCode("invalid_session_interaction"));
      assert.deepEqual([entries, harness.contexts.length, host.releaseCount()], [0, 0, 1]);
    }
  });
});

test("genuine provider expiry wins exact ties and remains finite under unbounded human waiting", { timeout: 10_000 }, async (t) => {
  for (const policy of ["bounded-tie", "unbounded"] as const) await t.test(policy, { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
    const expiresAt = new Date(now + 1_000).toISOString();
    const fixture = await scenario({ openingOfferOptions: { expiresAt } });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const interactions: AgentSessionInteractionContext = policy === "bounded-tie"
      ? { limits: { requestTimeoutMs: 1_000 }, onRequest(value) { handle = value; } }
      : { humanWait: { kind: "until_withdrawn_or_closed" }, onRequest(value) { handle = value; } };
    const session = await fixture.open("create", undefined, { interactions });
    assert.ok(handle);
    assert.equal(handle.request.expiresAt, expiresAt);
    assert.deepEqual(handle.deadline, { kind: "deadline", expiresAt, source: "provider" });
    t.mock.timers.tick(1_000);
    assert.deepEqual(await handle.terminal, { kind: "expired", source: "provider" });
    await fixture.nativeCloseEntered;
    assert.deepEqual(fixture.offers[0]!.answers, []);
    await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
    await session.close({ reason: "idle" });
    assert.equal(fixture.closes(), 1);
  });
});

test("far-future provider expiry stays live across timer limits and expires at its actual deadline", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const lifetimeMs = 30 * 24 * 60 * 60 * 1_000;
  const expiresAt = new Date(now + lifetimeMs).toISOString();
  const fixture = await scenario({ openingOfferOptions: { expiresAt } });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: {
    humanWait: { kind: "until_withdrawn_or_closed" }, onRequest(value) { handle = value; },
  } });
  assert.ok(handle);
  assert.equal(handle.request.expiresAt, expiresAt);
  assert.deepEqual(handle.deadline, { kind: "deadline", expiresAt, source: "provider" });
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual([handle.signal.aborted, fixture.closes(), fixture.offers[0]!.answers], [false, 0, []]);
  t.mock.timers.tick(2_147_483_646);
  await setImmediate();
  assert.deepEqual([handle.signal.aborted, fixture.closes()], [false, 0]);
  t.mock.timers.tick(lifetimeMs - 2_147_483_647 - 1);
  await setImmediate();
  assert.deepEqual([handle.signal.aborted, fixture.closes()], [false, 0]);
  t.mock.timers.tick(1);
  assert.deepEqual(await handle.terminal, { kind: "expired", source: "provider" });
  await fixture.nativeCloseEntered;
  assert.deepEqual(fixture.offers[0]!.answers, []);
  await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
  await session.close({ reason: "idle" });
  assert.equal(fixture.closes(), 1);
});

test("already expired provider requests fail the public opening without presenting answer authority", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const expiresAt = new Date(now - 1).toISOString();
  const fixture = await scenario({ openingOfferOptions: { expiresAt }, async beforeOpen(context) {
    if (context.signal?.aborted) await fixture.offers[0]!.stop();
  } });
  t.after(async () => { await Promise.all(fixture.offers.map((candidate) => candidate.stop())); await fixture.dispose(); });
  let presentations = 0;
  await assert.rejects(async () => fixture.open("create", undefined, { interactions: {
    humanWait: { kind: "until_withdrawn_or_closed" }, onRequest() { presentations += 1; },
  } }), hasContractCode("invalid_session_interaction"));
  assert.deepEqual([presentations, fixture.contexts.length, fixture.candidates.length, fixture.closes()], [0, 1, 0, 0]);
  assert.equal(fixture.offers[0]!.handle.request.expiresAt, expiresAt);
  assert.deepEqual(fixture.offers[0]!.answers, []);
});

test("withdrawal during entered delivery preserves its exact receipt without restoring answer authority", { timeout: 10_000 }, async (t) => {
  for (const result of [
    { status: "delivered" },
    { status: "rejected", requestState: "pending", error: refusal },
  ] satisfies AgentRequestResolutionResult[]) await t.test(result.status, async () => {
    const acknowledgment = deferred<AgentRequestResolutionResult>();
    const fixture = await scenario({ openingOfferOptions: { respond: () => acknowledgment.promise },
      cleanup: () => acknowledgment.resolve(result) });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
    assert.ok(handle);
    const candidate = fixture.offers[0]!;
    const answer = handle.respond({ kind: "decision", choiceId: grant });
    await candidate.entered;
    candidate.withdraw();
    assert.deepEqual(await handle.terminal, { kind: "withdrawn" });
    const late = await handle.respond({ kind: "decision", choiceId: decline });
    assert.equal(late.status, "rejected");
    if (late.status !== "rejected") throw new Error("Expected withdrawn response authority.");
    assert.deepEqual([late.requestState, late.error.code], ["unavailable", "session_interaction_unavailable"]);
    acknowledgment.resolve(result);
    assert.deepEqual(await answer, result);
    assert.deepEqual(await handle.terminal, { kind: "withdrawn" });
    assert.deepEqual(candidate.responses, [{ kind: "decision", choiceId: "trust-workspace" }]);
    assert.equal(fixture.closes(), 0);
    await session.close({ reason: "idle" });
  });
});
