// ------------------------------------------------------------------------------------------------
//                hostBindingsLifecycle.test.ts - Registry opening and host lease cleanup
// ------------------------------------------------------------------------------------------------

import { fixtureTurn } from "./fixtures/turnExecution.js";

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  parseAgentCollaborationId,
  parseAgentIsoDateTime,
  parseAgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  AgentProviderHostBindingCleanupError,
  createAgentEventOutput,
  type AgentHostToolResult,
  type AgentProviderSession,
} from "../src/index.js";
import {
  createHarness,
  deferred,
  hasContractCode,
  invoke,
  makeBinding,
  type OpeningKind,
} from "./fixtures/hostBindings/harness.js";

const openingKinds: readonly OpeningKind[] = ["create", "resume", "branch"];

test("create, resume and branch each forward a fresh authorized binding independently of native continuity", async () => {
  const harness = await createHarness();
  const hosts = openingKinds.map(() => makeBinding());
  const sessions: AgentProviderSession[] = [];
  for (const [index, kind] of openingKinds.entries()) {
    const host = hosts[index]!;
    const session = await harness.open(kind, host.binding);
    sessions.push(session);
    const facade = harness.facade();
    assert.equal(facade.bindingId, host.binding.bindingId, "Correlation IDs may repeat on separately authorized objects.");
    assert.notEqual(facade, host.binding);
    assert.deepEqual(structuredClone(facade.tools), host.binding.tools);
    assert.deepEqual(facade.instructions, host.binding.instructions);
    assert.deepEqual(await invoke(facade), { kind: "success", value: { accepted: true } });
    assert.equal(host.invocations.length, 1);
    assert.equal(host.releaseCount(), 0);
  }
  assert.equal(harness.fake.snapshot().createdSessionIds.length, 1);
  assert.equal(harness.fake.snapshot().resumedSessionIds.length, 1);
  assert.equal(harness.fake.snapshot().branchedSessionIds.length, 1);
  await Promise.all(sessions.map((session) => session.close({ reason: "idle" })));
  assert.deepEqual(hosts.map((host) => host.releaseCount()), [1, 1, 1]);
  await harness.registry.dispose();
});

test("a claimed binding cannot be reused during opening, across opening paths or after successful cleanup", async () => {
  const opening = deferred<void>();
  const entered = deferred<void>();
  const harness = await createHarness({ beforeOpen() {
    entered.resolve();
    return opening.promise;
  } });
  const host = makeBinding();
  const first = Promise.resolve(harness.open("create", host.binding));
  await entered.promise;
  for (const kind of openingKinds) {
    await assert.rejects(async () => harness.open(kind, host.binding), hasContractCode("host_binding_reused"));
  }
  assert.equal(harness.contexts.length, 1);
  assert.equal(host.releaseCount(), 0, "A rejected reuse cannot release the already claimed session lease.");
  opening.resolve();
  const session = await first;
  await session.close({ reason: "idle" });
  await assert.rejects(async () => harness.open("resume", host.binding), hasContractCode("host_binding_reused"));
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("support, instruction placement, abort and invalid context checks occur after a single-use claim on every opening path", async (t) => {
  for (const kind of openingKinds) {
    for (const scenario of ["absent_support", "unsupported", "placement", "pre_aborted", "invalid_context"] as const) {
      await t.test(`${kind}: ${scenario}`, async () => {
        const support = scenario === "absent_support" ? null
          : scenario === "unsupported" ? { kind: "unsupported" as const }
          : scenario === "placement" ? { kind: "supported" as const, toolTransport: "callback" as const, instructionPlacements: ["tool_context" as const] }
          : undefined;
        const harness = await createHarness({ support });
        const host = makeBinding();
        const controller = new AbortController();
        const cancellation = new DOMException("Opening canceled", "AbortError");
        if (scenario === "pre_aborted") controller.abort(cancellation);
        const overrides = scenario === "pre_aborted" ? { signal: controller.signal }
          : scenario === "invalid_context" ? { workingDirectory: "relative/path" } : {};
        await assert.rejects(async () => harness.open(kind, host.binding, overrides),
          scenario === "pre_aborted" ? (error: unknown) => error === cancellation
            : scenario === "invalid_context" ? (error: unknown) => error instanceof TypeError
            : hasContractCode("host_binding_unsupported"));
        assert.equal(harness.contexts.length, 0);
        assert.equal(host.releaseCount(), 1);
        await assert.rejects(async () => harness.open(kind, host.binding), hasContractCode("host_binding_reused"));
        assert.equal(host.releaseCount(), 1);
        await harness.registry.dispose();
      });
    }
  }
});

test("malformed minimal binding envelopes stay caller-owned", async (t) => {
  for (const invalid of [{ bindingId: " padded " }, { invoke: null }, { release: null }]) {
    await t.test(Object.keys(invalid)[0]!, async () => {
      const harness = await createHarness();
      const host = makeBinding();
      Object.assign(host.binding, invalid);
      await assert.rejects(async () => harness.open("create", host.binding), hasContractCode("invalid_host_binding"));
      assert.equal(harness.contexts.length, 0);
      assert.equal(host.releaseCount(), 0);
      await harness.registry.dispose();
    });
  }
});

test("adapter-declared native collision preserves rejection and releases the claimed binding", async () => {
  const harness = await createHarness({ beforeOpen() {
    throw new AgentProviderContractError(harness.fake.definition.providerKey, "host_tool_name_conflict", "Native tool collision.");
  } });
  const host = makeBinding();
  await assert.rejects(async () => harness.open("create", host.binding), hasContractCode("host_tool_name_conflict"));
  assert.equal(harness.fake.snapshot().createdSessionIds.length, 0);
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("candidate contract rejection cleans up the exact returned session on every opening path", async (t) => {
  for (const kind of openingKinds) {
    await t.test(kind, async () => {
      let closedCandidate: AgentProviderSession | undefined;
      const harness = await createHarness({ transformSession(session) {
        const candidate: AgentProviderSession = { ...session, async close(input) {
          assert.equal(this, candidate);
          closedCandidate = candidate;
          await session.close(input);
        } };
        return Object.assign(candidate, { invalidExtraPort: true });
      } });
      const host = makeBinding();
      await assert.rejects(async () => harness.open(kind, host.binding), hasContractCode("invalid_session"));
      assert.equal(closedCandidate, harness.candidates[0]);
      assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
      assert.equal(host.releaseCount(), 1);
      await harness.registry.dispose();
    });
  }
});

test("a host binding observer failure preserves the original error and releases the claimed lease", async (t) => {
  for (const kind of ["create", "branch"] as const) {
    await t.test(kind, async () => {
      const harness = await createHarness();
      const host = makeBinding();
      const observerFailure = new Error("Host persistence refused the native conversation binding.");
      await assert.rejects(async () => harness.open(kind, host.binding, {
        onBindingCreated() { throw observerFailure; },
      }), (error: unknown) => error === observerFailure);
      assert.equal(host.releaseCount(), 1);
      await harness.registry.dispose();
    });
  }
});

test("ordinary turn completion leaves the host binding available until explicit session close", async () => {
  const harness = await createHarness({ transformSession(session, context) {
    const candidate: AgentProviderSession = {
      ...session,
      startTurn: fixtureTurn(async function* (input) {
        const base = {
          protocolVersion: 10 as const, sessionId: context.sessionId, turnId: input.turnId,
          occurredAt: parseAgentIsoDateTime("2026-10-10T12:00:00.000Z"),
        };
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
      }),
    };
    return candidate;
  } });
  const host = makeBinding();
  const session = await harness.open("create", host.binding);
  const outputs = [];
  for await (const output of session.startTurn({
    turnId: parseAgentTurnId("completed-parent-turn"), interactionMode: "default",
    parts: [{ type: "text", text: "Complete this parent turn." }],
  }).outputs) outputs.push(output);
  assert.equal(outputs.length, 2);
  assert.equal(host.releaseCount(), 0);
  await invoke(harness.facade());
  assert.equal(host.invocations.length, 1);
  await session.close({ reason: "idle" });
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("close stops admission and aborts callbacks before native shutdown, then drains before releasing once", async () => {
  const events: string[] = [];
  const callbackEntered = deferred<void>();
  const callbackAborted = deferred<void>();
  const callbackFinish = deferred<void>();
  const nativeCloseEntered = deferred<void>();
  const nativeCloseFinish = deferred<void>();
  let nativeCloseCount = 0;
  const host = makeBinding({ events, async invoke(input) {
    events.push("callback_entered");
    input.signal!.addEventListener("abort", () => {
      events.push("callback_aborted");
      callbackAborted.resolve();
    }, { once: true });
    callbackEntered.resolve();
    await callbackFinish.promise;
    events.push("callback_settled");
    return { kind: "success", value: null };
  } });
  const harness = await createHarness({ transformSession(session) {
    const candidate: AgentProviderSession = {
      ...session,
      async close(input) {
        assert.equal(this, candidate);
        nativeCloseCount += 1;
        events.push("native_close_entered");
        nativeCloseEntered.resolve();
        await nativeCloseFinish.promise;
        await session.close(input);
        events.push("native_resources_released");
      },
    };
    return candidate;
  } });
  const session = await harness.open("create", host.binding);
  const callback = invoke(harness.facade());
  await callbackEntered.promise;
  const closing = Promise.resolve(session.close({ reason: "shutdown" }));
  const concurrentClose = Promise.resolve(session.close({ reason: "shutdown" }));
  await Promise.all([callbackAborted.promise, nativeCloseEntered.promise]);
  await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
  assert.equal(nativeCloseCount, 1);
  assert.equal(host.releaseCount(), 0);
  nativeCloseFinish.resolve();
  await setImmediate();
  assert.equal(host.releaseCount(), 0, "Native shutdown cannot release an unsettled host callback.");
  callbackFinish.resolve();
  await Promise.all([callback, closing, concurrentClose]);
  assert.equal(host.releaseCount(), 1);
  assert.ok(events.indexOf("callback_aborted") < events.indexOf("native_close_entered"));
  assert.ok(events.indexOf("native_resources_released") < events.indexOf("host_release"));
  assert.ok(events.indexOf("callback_settled") < events.indexOf("host_release"));
  await session.close({ reason: "shutdown" });
  assert.equal(nativeCloseCount, 1);
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("native rejection before returning a candidate drains any entered callbacks before releasing", async () => {
  const failure = new Error("Native opening failed after partial native cleanup.");
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const finish = deferred<AgentHostToolResult>();
  let callback: Promise<AgentHostToolResult> | undefined;
  const host = makeBinding({ invoke(input) {
    input.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    return finish.promise;
  } });
  const harness = await createHarness({ async beforeOpen(context) {
    callback = invoke(context.hostBinding!);
    await entered.promise;
    throw failure;
  } });
  const opening = Promise.resolve(harness.open("create", host.binding));
  const rejected = assert.rejects(opening, (error: unknown) => error === failure);
  await aborted.promise;
  assert.equal(host.releaseCount(), 0);
  assert.equal(harness.candidates.length, 0);
  finish.resolve({ kind: "success", value: null });
  await Promise.all([rejected, callback]);
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("rejected candidates retain failed native cleanup and expose a single-flight retry that cannot revive tools", async () => {
  const failure = new Error("Native producers are still active.");
  const retryEntered = deferred<void>();
  const retryFinish = deferred<void>();
  const events: string[] = [];
  let closeCalls = 0;
  const harness = await createHarness({ transformSession(session) {
    const candidate: AgentProviderSession = {
      ...session,
      async close(input) {
        assert.equal(this, candidate);
        closeCalls += 1;
        if (closeCalls === 1) throw failure;
        retryEntered.resolve();
        await retryFinish.promise;
        await session.close(input);
        events.push("native_closed");
      },
    };
    return Object.assign(candidate, { invalidExtraPort: true });
  } });
  const host = makeBinding({ events });
  let cleanup: AgentProviderHostBindingCleanupError | undefined;
  await assert.rejects(async () => harness.open("create", host.binding), (error: unknown) => {
    assert.ok(error instanceof AgentProviderHostBindingCleanupError);
    cleanup = error;
    assert.equal(error.providerKey, harness.fake.definition.providerKey);
    assert.ok(error.errors.some(hasContractCode("invalid_session")));
    assert.ok(error.errors.includes(failure));
    return true;
  });
  assert.equal(host.releaseCount(), 0);
  assert.equal(closeCalls, 1);
  await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
  const firstRetry = cleanup!.retryCleanup();
  const secondRetry = cleanup!.retryCleanup();
  await retryEntered.promise;
  assert.equal(closeCalls, 2);
  assert.equal(host.releaseCount(), 0);
  retryFinish.resolve();
  await Promise.all([firstRetry, secondRetry]);
  assert.deepEqual(events, ["native_closed", "host_release"]);
  await cleanup!.retryCleanup();
  assert.equal(closeCalls, 2);
  assert.equal(host.releaseCount(), 1);
  await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
  await harness.registry.dispose();
});

test("opening cleanup retries only host release once native candidate shutdown succeeded", async () => {
  const releaseFailure = new Error("Host lease release failed.");
  const host = makeBinding({ release() {
    if (host.releaseCount() === 1) throw releaseFailure;
  } });
  const harness = await createHarness({ transformSession(session) {
    return Object.assign(session, { invalidExtraPort: true });
  } });
  let cleanup: AgentProviderHostBindingCleanupError | undefined;
  await assert.rejects(async () => harness.open("create", host.binding), (error: unknown) => {
    assert.ok(error instanceof AgentProviderHostBindingCleanupError);
    assert.ok(error.errors.includes(releaseFailure));
    cleanup = error;
    return true;
  });
  assert.equal(host.releaseCount(), 1);
  assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
  await cleanup!.retryCleanup();
  await cleanup!.retryCleanup();
  assert.equal(host.releaseCount(), 2);
  assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
  await harness.registry.dispose();
});

test("a returned candidate without callable close retains its stopped binding until exact-candidate cleanup succeeds", async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const finish = deferred<AgentHostToolResult>();
  const events: string[] = [];
  let callback: Promise<AgentHostToolResult> | undefined;
  let restoreClose!: () => void;
  const host = makeBinding({ events, invoke(input) {
    input.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    return finish.promise;
  } });
  const harness = await createHarness({
    async beforeOpen(context) {
      callback = invoke(context.hostBinding!);
      await entered.promise;
    },
    transformSession(session) {
      const nativeClose = session.close;
      restoreClose = () => Object.defineProperty(session, "close", { value: async function(input: Parameters<typeof nativeClose>[0]) {
        assert.equal(this, session);
        await nativeClose.call(session, input);
        events.push("native_closed");
      } });
      Object.defineProperty(session, "close", { value: undefined, configurable: true });
      return session;
    },
  });
  const opening = Promise.resolve(harness.open("create", host.binding)).catch((error: unknown) => error);
  await aborted.promise;
  assert.equal(host.releaseCount(), 0);
  finish.resolve({ kind: "success", value: null });
  await callback;
  const cleanup = await opening;
  assert.equal(host.releaseCount(), 0, "Settled callbacks do not prove native producer quiescence.");
  assert.ok(cleanup instanceof AgentProviderHostBindingCleanupError, "A returned candidate without shutdown authority must retain a cleanup handle.");
  assert.ok(cleanup.errors.some(hasContractCode("invalid_session")));
  await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
  await assert.rejects(cleanup.retryCleanup());
  assert.equal(host.releaseCount(), 0);
  restoreClose();
  await cleanup.retryCleanup();
  await cleanup.retryCleanup();
  assert.deepEqual(events, ["native_closed", "host_release"]);
  assert.equal(Object.values(harness.fake.snapshot().closeCounts)[0], 1);
  await harness.registry.dispose();
});

test("opened-session close retries retain failed cleanup without repeating successful native shutdown", async (t) => {
  for (const failureAt of ["native_close", "host_release"] as const) {
    await t.test(failureAt, async () => {
      const failure = new Error(`Synthetic ${failureAt} failure.`);
      let closeCalls = 0;
      const host = makeBinding({ release() {
        if (failureAt === "host_release" && host.releaseCount() === 1) throw failure;
      } });
      const harness = await createHarness({ transformSession(session) {
        const candidate: AgentProviderSession = { ...session, async close(input) {
          assert.equal(this, candidate);
          closeCalls += 1;
          if (failureAt === "native_close" && closeCalls === 1) throw failure;
          await session.close(input);
        } };
        return candidate;
      } });
      const session = await harness.open("create", host.binding);
      await assert.rejects(async () => session.close({ reason: "shutdown" }), (error: unknown) => error === failure);
      assert.equal(host.releaseCount(), failureAt === "native_close" ? 0 : 1);
      await assert.rejects(invoke(harness.facade()), hasContractCode("host_binding_closed"));
      await session.close({ reason: "shutdown" });
      await session.close({ reason: "shutdown" });
      assert.equal(closeCalls, failureAt === "native_close" ? 2 : 1);
      assert.equal(host.releaseCount(), failureAt === "native_close" ? 1 : 2);
      await harness.registry.dispose();
    });
  }
});

test("sessions without host bindings retain native collaboration and port receivers", async () => {
  const harness = await createHarness({ support: null, transformSession(session) {
    assert.equal(session.collaboration.kind, "supported");
    if (session.collaboration.kind !== "supported") throw new Error("Missing native collaboration.");
    const native = session.collaboration;
    const collaboration = { ...native,
      spawnCollaboration(input: Parameters<typeof native.spawnCollaboration>[0]) {
        assert.equal(this, collaboration);
        return native.spawnCollaboration(input);
      },
      controlCollaboration(input: Parameters<typeof native.controlCollaboration>[0]) {
        assert.equal(this, collaboration);
        return native.controlCollaboration(input);
      },
    };
    return { ...session, collaboration };
  } });
  assert.deepEqual(harness.adapter.hostBinding, { kind: "unsupported" });
  const session = await harness.open("create");
  assert.equal(Object.hasOwn(harness.contexts[0]!, "hostBinding"), false);
  assert.equal(session.collaboration.kind, "supported");
  if (session.collaboration.kind !== "supported") throw new Error("Native collaboration disappeared.");
  const collaborationId = parseAgentCollaborationId("native-child");
  const node = await session.collaboration.spawnCollaboration({ spawn: {
    collaborationId, role: "reviewer", title: "Native review", objective: "Review using the provider's native collaboration.",
    createdAt: parseAgentIsoDateTime("2026-10-10T12:00:00.000Z"),
  } });
  assert.equal(node.status, "running");
  const stopped = await session.collaboration.controlCollaboration({ control: {
    collaborationId, action: "stop", reason: "user_requested",
  } });
  assert.equal(stopped.status, "canceled");
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});
