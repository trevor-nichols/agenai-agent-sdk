// ------------------------------------------------------------------------------------------------
//                providerOpeningCleanup.test.ts - Exact provider opening failures retain cleanup ownership
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentConfigurationRevisionId, parseAgentProviderKey, parseAgentSessionId } from "@agen-ai/agent-protocol";
import {
  AgentProviderSessionCleanupError, createAgentProviderSessionCleanupError,
  isAgentProviderSessionCleanupErrorFor, type AgentProviderCreateSessionInput, type AgentProviderSessionContext,
} from "../src/index.js";
import { createHarness, deferred, hasContractCode, invoke, makeBinding, type OpeningKind } from "./fixtures/hostBindings/harness.js";

test("provider opening cleanup retains the binding until explicit native retry and host release succeed", async (t) => {
  for (const kind of ["create", "resume", "branch"] satisfies OpeningKind[]) {
    await t.test(kind, async () => {
      const events: string[] = [];
      const nativeDone = deferred<void>();
      let retries = 0;
      let failNative = true;
      let failHost = true;
      const harness = await createHarness({ beforeOpen(context) {
        throw createAgentProviderSessionCleanupError({ providerKey: harness.fake.definition.providerKey,
          openingInput: context, errors: [new Error("Native cleanup remains pending.")],
          async retryCleanup() {
            retries += 1;
            if (failNative) throw new Error("Native cleanup still failed.");
            await nativeDone.promise;
            events.push("native_closed");
          },
        });
      } });
      const host = makeBinding({ events, release() { if (failHost) throw new Error("Host release failed."); } });
      t.after(async () => { failNative = false; failHost = false; nativeDone.resolve(); await harness.registry.dispose(); });
      const failure: unknown = await Promise.resolve(harness.open(kind, host.binding)).catch((error: unknown) => error);
      assert.ok(failure instanceof AgentProviderSessionCleanupError);
      assert.equal(host.releaseCount(), 0, "A failed provider opening must not release a still-owned binding.");
      assert.equal(retries, 0, "Propagation must not perform an extra native cleanup attempt.");
      await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
      await assert.rejects(failure.retryCleanup(), /Native cleanup still failed/u);
      assert.equal(host.releaseCount(), 0);
      failNative = false;
      const retry = failure.retryCleanup();
      assert.equal(failure.retryCleanup(), retry, "Concurrent cleanup retries share the exact pending operation.");
      nativeDone.resolve();
      await assert.rejects(retry, /Host release failed/u);
      assert.deepEqual(events, ["native_closed", "host_release"]);
      failHost = false;
      await failure.retryCleanup();
      await failure.retryCleanup();
      assert.equal(retries, 2, "Successful native cleanup is not repeated when only host release needs retry.");
      assert.deepEqual(events, ["native_closed", "host_release", "host_release"]);
    });
  }
});

test("a provider cleanup receipt without a host binding identifies the original caller input", async () => {
  let retries = 0;
  const harness = await createHarness({ beforeOpen(context) {
    throw createAgentProviderSessionCleanupError({ providerKey: harness.fake.definition.providerKey,
      openingInput: context, errors: [new Error("Opening failed before a session was returned.")],
      retryCleanup: () => { retries += 1; },
    });
  } });
  const input: AgentProviderCreateSessionInput = {
    sessionId: parseAgentSessionId("retained-opening"), workingDirectory: "/workspace",
    configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("config:1"), catalogRevision: 1, selections: [] },
    onBindingCreated() {},
  };
  const failure: unknown = await Promise.resolve(harness.adapter.createSession(input)).catch((error: unknown) => error);
  assert.ok(isAgentProviderSessionCleanupErrorFor(failure, input));
  assert.equal(isAgentProviderSessionCleanupErrorFor(failure, { ...input }), false);
  assert.equal(retries, 0);
  await failure.retryCleanup();
  await failure.retryCleanup();
  assert.equal(retries, 1);
  await harness.registry.dispose();
});

test("foreign, cloned and unassociated cleanup errors cannot retain the current opening", async (t) => {
  for (const ownership of ["foreign", "clone", "unassociated", "wrong_provider"] as const) {
    await t.test(ownership, async () => {
      let retries = 0;
      let thrown: AgentProviderSessionCleanupError | undefined;
      const harness = await createHarness({ beforeOpen(context) {
        const openingInput: AgentProviderSessionContext = ownership === "foreign"
          ? { ...context, workingDirectory: "/another/workspace" } : ownership === "clone" ? { ...context } : context;
        const input = { providerKey: ownership === "wrong_provider" ? parseAgentProviderKey("other-provider") : harness.fake.definition.providerKey,
          errors: [], retryCleanup: () => { retries += 1; } };
        thrown = ownership === "unassociated" ? new AgentProviderSessionCleanupError(input)
          : createAgentProviderSessionCleanupError({ ...input, openingInput });
        throw thrown;
      } });
      const host = makeBinding();
      const failure: unknown = await Promise.resolve(harness.open("create", host.binding)).catch((error: unknown) => error);
      assert.equal(failure, thrown);
      assert.equal(host.releaseCount(), 1);
      assert.equal(retries, 0);
      await harness.registry.dispose();
    });
  }
});
