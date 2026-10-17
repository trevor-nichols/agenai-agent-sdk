// ------------------------------------------------------------------------------------------------
//                sessionCleanupOwnership.test.ts - Failed opening cleanup without a host binding
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentConfigurationRevisionId, parseAgentProviderConversationId, parseAgentProviderHistoryAnchor, parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import {
  AgentProviderSessionCleanupError,
  isAgentProviderSessionCleanupErrorFor,
  type AgentCreateSessionInput,
  type AgentProviderSession,
} from "../src/index.js";
import { createHarness, deferred, makeBinding } from "./fixtures/hostBindings/harness.js";

test("failed candidate cleanup retains its exact opening owner with and without a host binding", async (t) => {
  for (const kind of ["create", "resume", "branch"] as const) for (const withBinding of [false, true]) for (const withInteractions of [false, true]) {
    await t.test(`${kind} ${withBinding ? "with binding" : "without binding"} ${withInteractions ? "with interactions" : "without interactions"}`, async () => {
      let closes = 0;
      const finish = deferred<void>();
      const harness = await createHarness({
        transformAdapter: (adapter) => ({ ...adapter, createSession: (input) => adapter.createSession(input), sessionInteractions: { kind: "supported",
          mappings: [{ openingOperation: "create", requestKind: "decision" }, { openingOperation: "resume", requestKind: "decision" }, { openingOperation: "branch", requestKind: "decision" }], producerOwnership: "exclusive", humanWait: ["bounded"] } }),
        transformSession(session) {
        return Object.assign({ ...session, async close(input: Parameters<AgentProviderSession["close"]>[0]) {
          closes += 1;
          if (closes === 1) throw new Error("Native cleanup did not complete.");
          await finish.promise;
          await session.close(input);
        } }, { invalidExtraPort: true });
      } });
      const context: AgentCreateSessionInput = {
        sessionId: parseAgentSessionId(`cleanup:${kind}`), workingDirectory: "/host/workspace",
        configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("cleanup-contract"), catalogRevision: 1, selections: [] }, onBindingCreated() {},
        ...(withBinding ? { hostBinding: makeBinding().binding } : {}),
        ...(withInteractions ? { interactions: { onRequest() {} } } : {}),
      };
      const binding = { conversationId: parseAgentProviderConversationId("cleanup-conversation"),
        historyAnchor: parseAgentProviderHistoryAnchor("cleanup-history") };
      let opening: object = context;
      let open = () => harness.adapter.createSession(context);
      if (kind === "resume") {
        const port = harness.adapter.resumption;
        assert.equal(port.kind, "supported");
        if (port.kind !== "supported") throw new Error("Expected resume fixture.");
        const input = { ...context, binding };
        opening = input;
        open = () => port.resumeSession(input);
      } else if (kind === "branch") {
        const port = harness.adapter.branching;
        assert.equal(port.kind, "through_turn");
        if (port.kind !== "through_turn") throw new Error("Expected branch fixture.");
        const input = { ...context, source: { sessionId: parseAgentSessionId("source"), binding,
          throughTurn: { turnId: parseAgentTurnId("source-turn"), historyAnchor: binding.historyAnchor } } };
        opening = input;
        open = () => port.branchSession(input);
      }
      const error = await Promise.resolve().then(open).catch((failure: unknown) => failure);
      assert.ok(error instanceof AgentProviderSessionCleanupError);
      assert.equal(isAgentProviderSessionCleanupErrorFor(error, opening), true);
      assert.equal(isAgentProviderSessionCleanupErrorFor(error, { ...opening }), false);
      assert.equal(isAgentProviderSessionCleanupErrorFor(new AgentProviderSessionCleanupError({
        providerKey: harness.fake.definition.providerKey, errors: [], retryCleanup() {},
      }), opening), false);
      assert.equal(closes, 1);
      const first = error.retryCleanup();
      assert.equal(error.retryCleanup(), first);
      finish.resolve();
      await first;
      await error.retryCleanup();
      assert.equal(closes, 2);
      await harness.registry.dispose();
    });
  }
});

test("a returned candidate without close remains retained until its exact candidate can quiesce", async () => {
  let restore!: () => void;
  const harness = await createHarness({ transformSession(session) {
    const candidate = { ...session, close: undefined } as unknown as AgentProviderSession;
    restore = () => { Object.assign(candidate, { close: session.close }); };
    return candidate;
  } });
  const input: AgentCreateSessionInput = { sessionId: parseAgentSessionId("missing-close"),
    workingDirectory: "/host/workspace", configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("cleanup-contract"), catalogRevision: 1, selections: [] }, onBindingCreated() {} };
  const error = await Promise.resolve().then(() => harness.adapter.createSession(input)).catch((failure: unknown) => failure);
  assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
  await assert.rejects(error.retryCleanup());
  assert.equal(Object.values(harness.fake.snapshot().closeCounts).length, 0);
  restore();
  await error.retryCleanup();
  assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
  await harness.registry.dispose();
});

test("propagating another opening's retained error does not change its owner", async () => {
  let first = true;
  const harness = await createHarness({ beforeOpen() { if (!first) throw prior; }, transformSession(session) {
    return Object.assign({ ...session, async close(input: Parameters<AgentProviderSession["close"]>[0]) {
      if (first) throw new Error("Retained native close.");
      await session.close(input);
    } }, { invalidExtraPort: true });
  } });
  const input: AgentCreateSessionInput = { sessionId: parseAgentSessionId("first-opening"),
    workingDirectory: "/host/workspace", configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("cleanup-contract"), catalogRevision: 1, selections: [] }, onBindingCreated() {} };
  const error = await Promise.resolve().then(() => harness.adapter.createSession(input)).catch((failure: unknown) => failure);
  assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
  const prior = error;
  first = false;
  const next = { ...input, sessionId: parseAgentSessionId("next-opening") };
  await assert.rejects(async () => harness.adapter.createSession(next), (failure: unknown) => failure === prior);
  assert.equal(isAgentProviderSessionCleanupErrorFor(prior, next), false);
  assert.equal(isAgentProviderSessionCleanupErrorFor(prior, input), true);
  await prior.retryCleanup();
  await harness.registry.dispose();
});
