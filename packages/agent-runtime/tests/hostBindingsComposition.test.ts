// ------------------------------------------------------------------------------------------------
//                hostBindingsComposition.test.ts - Revalidation and cleanup owner isolation
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCapabilities, parseAgentSessionDecisionRequest, parseAgentSessionId, parseAgentConfigurationRevisionId, parseAgentProviderConversationId, parseAgentProviderHistoryAnchor, parseAgentTurnId } from "@agen-ai/agent-protocol";

import {
  AgentProviderHostBindingCleanupError,
  validateAgentProviderAdapter,
  type AgentProviderSession, type AgentCreateSessionInput,
  type AgentSessionInteractionTerminal,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";
import {
  createHarness,
  deferred,
  hasContractCode,
  invoke,
  makeBinding,
  type OpeningKind,
} from "./fixtures/hostBindings/harness.js";

test("registry composition with a prevalidated adapter preserves one binding owner on every opening path", async (t) => {
  for (const kind of ["create", "resume", "branch"] satisfies OpeningKind[]) {
    await t.test(kind, async () => {
      const harness = await createHarness();
      const composed = validateAgentProviderAdapter(harness.fake.capabilities, harness.adapter);
      const host = makeBinding();
      const input: AgentCreateSessionInput = { sessionId: parseAgentSessionId(`composed-${kind}`), workingDirectory: "/host/workspace",
        configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("composition"), catalogRevision: 1, selections: [] },
        hostBinding: host.binding, onBindingCreated() {} };
      const sourceBinding = { conversationId: parseAgentProviderConversationId("composition-source"), historyAnchor: parseAgentProviderHistoryAnchor("source-history") };
      let session: AgentProviderSession;
      if (kind === "create") session = await composed.createSession(input);
      else if (kind === "resume") {
        if (composed.resumption.kind !== "supported") throw new Error("Expected resumption fixture.");
        session = await composed.resumption.resumeSession({ ...input, binding: sourceBinding });
      } else {
        if (composed.branching.kind !== "through_turn") throw new Error("Expected branching fixture.");
        session = await composed.branching.branchSession({ ...input, source: { sessionId: parseAgentSessionId("source"), binding: sourceBinding,
          throughTurn: { turnId: parseAgentTurnId("source-turn"), historyAnchor: sourceBinding.historyAnchor } } });
      }
      await invoke(harness.facade());
      assert.equal(host.invocations.length, 1);
      await assert.doesNotReject(async () => session.close({ reason: "idle" }),
        "Composed validation must close through the original host owner.");
      await session.close({ reason: "idle" });
      assert.equal(host.releaseCount(), 1);
      assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
      await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
      await harness.registry.dispose();
    });
  }
});

test("rejected session cleanup joins the real interaction callback before releasing its host binding", async () => {
  const callback = deferred<void>();
  const terminal = deferred<AgentSessionInteractionTerminal>();
  const nativeClosed = deferred<void>();
  const events: string[] = [];
  const harness = await createHarness({
    transformAdapter: (adapter) => ({ ...adapter, createSession: (input) => adapter.createSession(input), sessionInteractions: {
      kind: "supported", mappings: [{ openingOperation: "create", requestKind: "decision" }], producerOwnership: "exclusive", humanWait: ["bounded"],
    } }),
    beforeOpen(context) {
      assert.ok(context.interactions);
      const completion = context.interactions.onRequest({
        kind: "direct", request: parseAgentSessionDecisionRequest({ kind: "decision", requestId: "rejected-session-decision", sessionId: context.sessionId,
          title: "Workspace configuration", target: { kind: "workspace", path: "/host/workspace" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(), choices: [{ choiceId: "leave-gated", label: "Leave gated",
            description: "Keep workspace configuration gated.", consequence: { kind: "decline", configuration: "remains_gated" } }] }),
        signal: new AbortController().signal, terminal: terminal.promise,
        async respond() { throw new Error("The rejected opening must never receive a decision."); },
      });
      void Promise.resolve(completion).catch(() => {});
    },
    transformSession(session) {
      return Object.assign({ ...session, async close(input: Parameters<AgentProviderSession["close"]>[0]) {
        await session.close(input);
        terminal.resolve({ kind: "session_closed" });
        events.push("native_closed");
        nativeClosed.resolve();
      } }, { invalidExtraPort: true });
    },
  });
  const host = makeBinding({ events });
  const opening = harness.open("create", host.binding, { interactions: { onRequest: () => callback.promise } });
  const rejected = assert.rejects(Promise.resolve(opening), hasContractCode("invalid_session"));
  await nativeClosed.promise;
  assert.equal(host.releaseCount(), 0);
  assert.deepEqual(events, ["native_closed"]);
  callback.resolve();
  await rejected;
  assert.deepEqual(events, ["native_closed", "host_release"]);
  await harness.registry.dispose();
});

test("revalidation checks current capabilities against the captured original candidate", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const validated = validateAgentProviderAdapter(instance.capabilities, instance.adapter);
  const changed = parseAgentCapabilities({ ...instance.capabilities, sessions: { ...instance.capabilities.sessions, resume: false } });
  assert.throws(() => validateAgentProviderAdapter(changed, validated), hasContractCode("capability_port_mismatch"));
  assert.equal(fake.snapshot().createdSessionIds.length, 0);
  await instance.dispose();
  assert.equal(fake.snapshot().instanceDisposeCount, 1);
});

test("a foreign retained cleanup error cannot transfer ownership of the current opening's host binding", async (t) => {
  for (const currentReleaseFails of [false, true]) {
    await t.test(currentReleaseFails ? "current release retains its own retry and the foreign handle" : "current release succeeds before returning the foreign handle", async () => {
      let priorCloseCalls = 0;
      const priorCloseFailure = new Error("Prior native cleanup failed.");
      const currentReleaseFailure = new Error("Current host release failed.");
      const harness = await createHarness({ transformSession(session) {
        const candidate: AgentProviderSession = { ...session, async close(input) {
          assert.equal(this, candidate);
          priorCloseCalls += 1;
          if (priorCloseCalls === 1) throw priorCloseFailure;
          await session.close(input);
        } };
        return Object.assign(candidate, { invalidExtraPort: true });
      } });
      const prior = makeBinding();
      let priorCleanup: AgentProviderHostBindingCleanupError | undefined;
      await assert.rejects(async () => harness.open("create", prior.binding), (error: unknown) => {
        assert.ok(error instanceof AgentProviderHostBindingCleanupError);
        priorCleanup = error;
        return true;
      });
      assert.equal(prior.releaseCount(), 0);
      const current = makeBinding({ release() {
        if (currentReleaseFails && current.releaseCount() === 1) throw currentReleaseFailure;
      } });
      const failure = await Promise.resolve(harness.open("create", current.binding, {
        onBindingCreated() { throw priorCleanup!; },
      })).catch((error: unknown) => error);
      assert.equal(current.releaseCount(), 1, "A foreign cleanup error cannot bypass this opening's lease cleanup.");
      await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
      assert.equal(current.invocations.length, 0);
      assert.equal(prior.releaseCount(), 0, "The current opening cannot release the prior retained owner.");
      if (currentReleaseFails) {
        assert.ok(failure instanceof AgentProviderHostBindingCleanupError);
        assert.notEqual(failure, priorCleanup);
        assert.ok(failure.errors.includes(priorCleanup));
        assert.ok(failure.errors.includes(currentReleaseFailure));
        await failure.retryCleanup();
        assert.equal(current.releaseCount(), 2);
        assert.equal(prior.releaseCount(), 0);
      } else {
        assert.equal(failure, priorCleanup);
      }
      await priorCleanup!.retryCleanup();
      assert.equal(priorCloseCalls, 2);
      assert.equal(prior.releaseCount(), 1);
      await harness.registry.dispose();
    });
  }
});
