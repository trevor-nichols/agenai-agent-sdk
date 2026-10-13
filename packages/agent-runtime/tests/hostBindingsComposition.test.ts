// ------------------------------------------------------------------------------------------------
//                hostBindingsComposition.test.ts - Revalidation and cleanup owner isolation
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCapabilities } from "@agen-ai/agent-protocol";

import {
  AgentProviderHostBindingCleanupError,
  AgentProviderRegistryError,
  createAgentProviderRegistry,
  validateAgentProviderAdapter,
  type AgentProviderDriver,
  type AgentProviderSession,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";
import {
  createHarness,
  hasContractCode,
  invoke,
  makeBinding,
  type OpeningKind,
} from "./fixtures/hostBindings/harness.js";

test("registry composition with a prevalidated adapter preserves one binding owner on every opening path", async (t) => {
  for (const kind of ["create", "resume", "branch"] satisfies OpeningKind[]) {
    await t.test(kind, async () => {
      const harness = await createHarness({
        transformAdapter: (adapter, capabilities) => validateAgentProviderAdapter(capabilities, adapter),
      });
      const host = makeBinding();
      const session = await harness.open(kind, host.binding);
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

test("registry revalidation applies current capabilities to a previously validated adapter", async () => {
  const fake = createFakeAgentProvider();
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      return {
        ...instance,
        adapter: validateAgentProviderAdapter(instance.capabilities, instance.adapter),
        capabilities: parseAgentCapabilities({
          ...instance.capabilities,
          sessions: { ...instance.capabilities.sessions, resume: false },
        }),
      };
    },
  };
  await assert.rejects(createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] }), (error: unknown) => {
    assert.ok(error instanceof AgentProviderRegistryError);
    assert.equal(error.code, "instance_contract_mismatch");
    assert.ok(hasContractCode("capability_port_mismatch")(error.cause));
    return true;
  });
  assert.equal(fake.snapshot().createdSessionIds.length, 0);
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
