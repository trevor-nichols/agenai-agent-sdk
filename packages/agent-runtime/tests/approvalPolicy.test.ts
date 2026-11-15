import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentCapabilities, parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  AgentProviderSessionCleanupError,
  isAgentProviderSessionCleanupErrorFor,
  validateAgentProviderAdapter,
  type AgentApprovalPolicy,
  type AgentApprovalPolicyKind,
  type AgentApprovalPolicyOperation,
  type AgentApprovalPolicySupport,
  type AgentCreateSessionInput,
  type AgentProviderCloseSessionInput,
  type AgentProviderDriver,
  type AgentProviderSession,
  type AgentSessionApprovalPolicy,
} from "../src/index.js";
import { createFakeAgentProvider, runAgentProviderConformance } from "../src/testing/index.js";
import { createHarness, deferred, hasContractCode, makeBinding } from "./fixtures/hostBindings/harness.js";

const openingOperations = ["create", "resume", "branch"] as const;

function allPolicySupport() {
  return {
    kind: "supported",
    policies: [
      { policy: "host", operations: ["create", "resume", "branch"] },
      { policy: "provider_auto_review", operations: ["create", "resume", "branch"] },
      { policy: "provider_bypass", operations: ["create", "resume", "branch"] },
      { policy: "provider_accept_edits", operations: ["create", "resume", "branch"] },
    ],
  } satisfies AgentApprovalPolicySupport;
}

function withEffectivePolicy(session: AgentProviderSession, policy: AgentApprovalPolicy | undefined): AgentProviderSession {
  return policy === undefined ? session : {
    ...session,
    approvalPolicy: { policy, verification: "controlled_configuration" },
  };
}

test("approval-policy support is closed, unique, nonempty and restricted to available opening ports", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const descriptor = { policy: "host", operations: ["create"] };
  const cases: readonly unknown[] = [
    null, [], { kind: "unknown" }, { kind: "unsupported", policies: [descriptor] },
    { kind: "supported" }, { kind: "supported", policies: [] },
    { kind: "supported", policies: [descriptor], extra: true },
    { kind: "supported", policies: [{ ...descriptor, extra: true }] },
    { kind: "supported", policies: [{ ...descriptor, policy: "unknown" }] },
    { kind: "supported", policies: [{ ...descriptor, operations: [] }] },
    { kind: "supported", policies: [{ ...descriptor, operations: ["create", "create"] }] },
    { kind: "supported", policies: [{ ...descriptor, operations: ["close"] }] },
    { kind: "supported", policies: [{ ...descriptor, operations: ["create", "resume", "branch", "create"] }] },
    { kind: "supported", policies: [descriptor, { ...descriptor, operations: ["resume"] }] },
    { kind: "supported", policies: [descriptor], [Symbol("extra")]: true },
  ];
  try {
    for (const support of cases) {
      assert.throws(() => validateAgentProviderAdapter(instance.capabilities, {
        ...instance.adapter, approvalPolicy: support as never,
      }), hasContractCode("invalid_adapter"));
    }
    for (const operation of ["resume", "branch"] as const) {
      const capabilities = parseAgentCapabilities({ ...instance.capabilities,
        sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
      });
      assert.throws(() => validateAgentProviderAdapter(capabilities, {
        ...instance.adapter,
        resumption: { kind: "unsupported" }, branching: { kind: "unsupported" },
        approvalPolicy: { kind: "supported", policies: [{ policy: "host", operations: [operation] }] },
      }), hasContractCode("invalid_adapter"));
    }
    assert.deepEqual(validateAgentProviderAdapter(instance.capabilities, {
      ...instance.adapter, approvalPolicy: allPolicySupport(),
    }).approvalPolicy, allPolicySupport());
    assert.deepEqual(validateAgentProviderAdapter(instance.capabilities, {
      ...instance.adapter, approvalPolicy: { kind: "unsupported" },
    }).approvalPolicy, { kind: "unsupported" });
  } finally {
    await instance.dispose();
  }
});

test("omitted selection preserves ambient opening and exposes no invented effective policy", async () => {
  for (const declaration of [undefined, { kind: "unsupported" } as const, allPolicySupport()]) {
    const harness = await createHarness({ transformAdapter: (adapter) => declaration === undefined ? adapter : Object.assign(adapter, { approvalPolicy: declaration }) });
    try {
      for (const operation of openingOperations) {
        const opened = await harness.open(operation);
        assert.equal(Object.hasOwn(harness.contexts.at(-1)!, "approvalPolicy"), false);
        assert.equal(Object.hasOwn(opened, "approvalPolicy"), false);
        await opened.close({ reason: "idle" });
      }
      assert.deepEqual(Object.values(harness.fake.snapshot().closeCounts), [1, 1, 1]);
    } finally {
      await harness.registry.dispose();
    }
  }
});

test("policy and operation admission precedes provider opening, binding observers and host lease acquisition", async () => {
  const support: AgentApprovalPolicySupport = {
    kind: "supported", policies: [
      { policy: "host", operations: ["create"] },
      { policy: "provider_auto_review", operations: ["resume"] },
      { policy: "provider_bypass", operations: ["branch"] },
      { policy: "provider_accept_edits", operations: ["create"] },
    ],
  };
  const selected: Record<AgentApprovalPolicyOperation, AgentApprovalPolicyKind> = {
    create: "provider_accept_edits", resume: "provider_auto_review", branch: "provider_bypass",
  };
  for (const operation of openingOperations) {
    let observers = 0;
    const harness = await createHarness({
      transformAdapter: (adapter) => Object.assign(adapter, { approvalPolicy: support }),
      transformSession: (session, context) => withEffectivePolicy(session, context.approvalPolicy),
    });
    const host = makeBinding();
    try {
      const rejected: readonly AgentApprovalPolicyKind[] = operation === "create"
        ? ["provider_auto_review"] : ["host", "provider_accept_edits"];
      for (const kind of rejected) await assert.rejects(async () => harness.open(operation, host.binding, {
        approvalPolicy: { kind }, onBindingCreated() { observers += 1; },
      }), hasContractCode("approval_policy_unsupported"));
      assert.equal(harness.contexts.length, 0);
      assert.equal(observers, 0);
      assert.equal(host.releaseCount(), 0);
      assert.equal(harness.fake.snapshot().materializationCount, 1, "Instance materialization remains eager.");
      const opened = await harness.open(operation, host.binding, {
        approvalPolicy: { kind: selected[operation] }, onBindingCreated() { observers += 1; },
      });
      assert.deepEqual(opened.approvalPolicy, {
        policy: { kind: selected[operation] }, verification: "controlled_configuration",
      });
      assert.equal(harness.contexts.length, 1);
      assert.equal(observers, operation === "resume" ? 0 : 1);
      await opened.close({ reason: "idle" });
      assert.equal(host.releaseCount(), 1, "The refused attempt must leave the original binding reusable.");
    } finally {
      await harness.registry.dispose();
    }
  }
});

test("absent and unsupported declarations reject explicit policies on every opening path", async () => {
  for (const support of [undefined, { kind: "unsupported" } as const]) {
    const harness = await createHarness({ transformAdapter: (adapter) => support === undefined ? adapter : Object.assign(adapter, { approvalPolicy: support }) });
    try {
      for (const operation of openingOperations) for (const kind of ["host", "provider_accept_edits"] as const) {
        await assert.rejects(async () => harness.open(operation, undefined, { approvalPolicy: { kind } }),
          hasContractCode("approval_policy_unsupported"));
      }
      assert.equal(harness.contexts.length, 0);
      const legacy = await harness.open("create");
      assert.equal(Object.hasOwn(legacy, "approvalPolicy"), false);
      await legacy.close({ reason: "idle" });
    } finally {
      await harness.registry.dispose();
    }
  }
});

test("malformed selections reject before taking the host binding and do not fall back to ambient policy", async () => {
  const harness = await createHarness({
    transformAdapter: (adapter) => Object.assign(adapter, { approvalPolicy: allPolicySupport() }),
    transformSession: (session, context) => withEffectivePolicy(session, context.approvalPolicy),
  });
  const host = makeBinding();
  try {
    for (const selection of [null, false, "host", [], {}, { kind: "unknown" },
      { kind: "host", autoApprove: true }, { kind: "provider_bypass", verification: "native_observation" },
      { kind: "host", [Symbol("extra")]: true }]) {
      await assert.rejects(async () => harness.open("create", host.binding, { approvalPolicy: selection as never }),
        hasContractCode("approval_policy_invalid"));
    }
    assert.equal(harness.contexts.length, 0);
    assert.equal(host.releaseCount(), 0);
    const opened = await harness.open("create", host.binding, { approvalPolicy: { kind: "host" } });
    assert.deepEqual(opened.approvalPolicy, { policy: { kind: "host" }, verification: "controlled_configuration" });
    await opened.close({ reason: "idle" });
    assert.equal(host.releaseCount(), 1);
  } finally {
    await harness.registry.dispose();
  }
});

test("all opening paths capture immutable detached support, selection and effective results", async () => {
  for (const kind of ["provider_auto_review", "provider_accept_edits"] as const) for (const operation of openingOperations) {
    const support = allPolicySupport();
    const finish = deferred<void>();
    let nativeResult: AgentSessionApprovalPolicy | undefined;
    const harness = await createHarness({
      transformAdapter: (adapter) => Object.assign(adapter, { approvalPolicy: support }),
      beforeOpen: () => finish.promise,
      transformSession(session, context) {
        assert.deepEqual(context.approvalPolicy, { kind });
        nativeResult = { policy: { kind }, verification: "native_observation" };
        return { ...session, approvalPolicy: nativeResult };
      },
    });
    const selection: { kind: AgentApprovalPolicyKind } = { kind };
    try {
      Object.assign(support.policies.find((entry) => entry.policy === kind)!, { policy: "host", operations: ["branch"] });
      const opening = harness.open(operation, undefined, { approvalPolicy: selection });
      selection.kind = "provider_bypass";
      const received = harness.contexts.at(-1)!.approvalPolicy;
      assert.deepEqual(received, { kind });
      assert.notEqual(received, selection);
      assert.equal(Object.isFrozen(received), true);
      assert.deepEqual(harness.adapter.approvalPolicy, allPolicySupport());
      const acceptedSupport = harness.adapter.approvalPolicy;
      assert.equal(acceptedSupport?.kind, "supported");
      if (acceptedSupport?.kind !== "supported") throw new Error("Expected supported policies.");
      for (const value of [acceptedSupport, acceptedSupport.policies, acceptedSupport.policies[1], acceptedSupport.policies[1]!.operations]) {
        assert.equal(Object.isFrozen(value), true);
      }
      finish.resolve();
      const opened = await opening;
      assert.notEqual(opened.approvalPolicy, nativeResult);
      Object.assign(nativeResult!.policy, { kind: "provider_bypass" });
      Object.assign(nativeResult!, { verification: "unknown" });
      assert.deepEqual(opened.approvalPolicy, {
        policy: { kind }, verification: "native_observation",
      });
      assert.equal(Object.isFrozen(opened.approvalPolicy), true);
      assert.equal(Object.isFrozen(opened.approvalPolicy!.policy), true);
      await opened.close({ reason: "idle" });
    } finally {
      finish.resolve();
      await harness.registry.dispose();
    }
  }
});

test("unconfirmed, unsolicited and mismatched effective policies reject and close each original candidate", async (t) => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    result?: unknown;
    omittedSelection?: boolean;
    selection?: AgentApprovalPolicy;
    code: "approval_policy_unconfirmed" | "approval_policy_mismatch";
  }>> = [
    { name: "missing", code: "approval_policy_unconfirmed" },
    { name: "null", result: null, code: "approval_policy_unconfirmed" },
    { name: "unknown policy", result: { policy: { kind: "unknown" }, verification: "native_observation" }, code: "approval_policy_unconfirmed" },
    { name: "extra policy key", result: { policy: { kind: "host", bypass: true }, verification: "native_observation" }, code: "approval_policy_unconfirmed" },
    { name: "unknown verification", result: { policy: { kind: "host" }, verification: "requested" }, code: "approval_policy_unconfirmed" },
    { name: "extra result key", result: { policy: { kind: "host" }, verification: "native_observation", observed: true }, code: "approval_policy_unconfirmed" },
    { name: "different policy", result: { policy: { kind: "provider_bypass" }, verification: "controlled_configuration" }, code: "approval_policy_mismatch" },
    { name: "accept edits cannot fall back to host", selection: { kind: "provider_accept_edits" },
      result: { policy: { kind: "host" }, verification: "controlled_configuration" }, code: "approval_policy_mismatch" },
    { name: "unsolicited", omittedSelection: true, result: { policy: { kind: "host" }, verification: "native_observation" }, code: "approval_policy_unconfirmed" },
  ];
  for (const operation of openingOperations) for (const row of cases) {
    await t.test(`${operation}: ${row.name}`, async () => {
      const closed: AgentProviderCloseSessionInput[] = [];
      const harness = await createHarness({
        transformAdapter: (adapter) => Object.assign(adapter, { approvalPolicy: allPolicySupport() }),
        transformSession(session) {
          const candidate: AgentProviderSession = {
            ...session,
            ...(row.result === undefined ? {} : { approvalPolicy: row.result as never }),
            close(input) {
              assert.equal(this, candidate);
              closed.push(input);
              return session.close(input);
            },
          };
          return candidate;
        },
      });
      try {
        await assert.rejects(async () => harness.open(operation, undefined,
          row.omittedSelection ? {} : { approvalPolicy: row.selection ?? { kind: "host" } }), hasContractCode(row.code));
        assert.deepEqual(closed, [{ reason: "contract_rejected" }]);
        assert.deepEqual(Object.values(harness.fake.snapshot().closeCounts), [1]);
      } finally {
        await harness.registry.dispose();
      }
    });
  }
});

test("a rejected policy retains its original opening cleanup owner until native cleanup settles", async () => {
  for (const withHostBinding of [false, true]) {
    const cleanupFailure = new Error("Original native close remains incomplete.");
    const finish = deferred<void>();
    const events: string[] = [];
    const harness = await createHarness({
      transformAdapter: (adapter) => Object.assign(adapter, { approvalPolicy: allPolicySupport() }),
      transformSession(session) {
        let attempts = 0;
        const candidate: AgentProviderSession = {
          ...session,
          approvalPolicy: { policy: { kind: "provider_bypass" }, verification: "native_observation" },
          async close(input) {
            assert.equal(this, candidate);
            assert.deepEqual(input, { reason: "contract_rejected" });
            attempts += 1;
            events.push(`native_close:${attempts}`);
            if (attempts === 1) throw cleanupFailure;
            await finish.promise;
            await session.close(input);
            events.push("native_closed");
          },
        };
        return candidate;
      },
    });
    const host = makeBinding({ events });
    const opening: AgentCreateSessionInput = {
      sessionId: parseAgentSessionId(`policy-cleanup:${withHostBinding}`), workingDirectory: "/host/workspace",
      configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"), catalogRevision: 1, selections: [] },
      onBindingCreated() {}, approvalPolicy: { kind: "provider_accept_edits" },
      ...(withHostBinding ? { hostBinding: host.binding } : {}),
    };
    try {
      const error: unknown = await Promise.resolve(harness.adapter.createSession(opening)).catch((failure: unknown) => failure);
      assert.ok(error instanceof AgentProviderSessionCleanupError);
      assert.equal(isAgentProviderSessionCleanupErrorFor(error, opening), true);
      assert.equal(isAgentProviderSessionCleanupErrorFor(error, { ...opening }), false);
      assert.equal(error.errors[0] instanceof AgentProviderContractError && error.errors[0].code, "approval_policy_mismatch");
      assert.equal(error.errors[1], cleanupFailure);
      assert.deepEqual(events, ["native_close:1"]);
      assert.equal(host.releaseCount(), 0);
      const retry = error.retryCleanup();
      assert.equal(error.retryCleanup(), retry);
      await Promise.resolve();
      assert.deepEqual(events, ["native_close:1", "native_close:2"]);
      assert.equal(host.releaseCount(), 0);
      finish.resolve();
      await retry;
      await error.retryCleanup();
      assert.deepEqual(events, ["native_close:1", "native_close:2", "native_closed", ...(withHostBinding ? ["host_release"] : [])]);
      assert.deepEqual(Object.values(harness.fake.snapshot().closeCounts), [1]);
      assert.equal(host.releaseCount(), withHostBinding ? 1 : 0);
    } finally {
      finish.resolve();
      await harness.registry.dispose();
    }
  }
});

test("optional conformance selection exercises the provider's established policy and normal lifecycle", async () => {
  const base = createFakeAgentProvider();
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...base.capabilities,
    sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
    turns: { ...base.capabilities.turns, interrupt: false, steer: { kind: "unsupported" } },
    requests: { approval: { kind: "unsupported" }, elicitation: { kind: "unsupported" } },
    configuration: { kind: "managed" }, operations: { kind: "unsupported" },
    collaboration: { kind: "unsupported" }, generatedResources: { kind: "unsupported" },
  }) });
  const received: AgentApprovalPolicy[] = [];
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    return { ...instance, adapter: {
      ...instance.adapter,
      approvalPolicy: { kind: "supported", policies: [{ policy: "provider_accept_edits", operations: ["create"] }] },
      async createSession(context) {
        if (context.approvalPolicy !== undefined) received.push(context.approvalPolicy);
        return withEffectivePolicy(await instance.adapter.createSession(context), context.approvalPolicy);
      },
    } };
  } };
  const report = await runAgentProviderConformance({
    driver, definition: fake.definition, workingDirectory: "/host/workspace",
    configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("policy-conformance") },
    approvalPolicy: { kind: "provider_accept_edits" },
    createSessionId: parseAgentSessionId("policy-conformance:create"),
    resumeSessionId: parseAgentSessionId("policy-conformance:resume"),
    abortedSessionId: parseAgentSessionId("policy-conformance:abort"),
    interruptionSessionId: parseAgentSessionId("policy-conformance:interrupt"),
    turn: { turnId: parseAgentTurnId("policy-conformance:turn"), interactionMode: "default", parts: [{ type: "text", text: "Exercise the selected policy." }] },
    interruptionTurn: { turnId: parseAgentTurnId("policy-conformance:unused"), interactionMode: "default", parts: [{ type: "text", text: "Unused." }] },
    resolutionFor() { throw new Error("Unexpected residual request."); },
  });
  assert.deepEqual(received, [{ kind: "provider_accept_edits" }]);
  assert.deepEqual(report.checks.filter((check) => check === "approval_policy"), ["approval_policy"]);
  assert.deepEqual(fake.snapshot().turnIds, ["policy-conformance:turn"]);
  assert.deepEqual(fake.snapshot().closeCounts, { "policy-conformance:create": 1 });
  assert.equal(fake.snapshot().instanceDisposeCount, 1);
});
