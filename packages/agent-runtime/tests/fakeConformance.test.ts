// ------------------------------------------------------------------------------------------------
//                fakeConformance.test.ts - Fake provider and public conformance coverage
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentCapabilities,
  parseAgentCollaborationId,
  parseAgentConfigurationRevisionId,
  parseAgentGeneratedResourceId,
  parseAgentIsoDateTime,
  parseAgentOperationId,
  parseAgentOperationInvocationId,
  parseAgentProviderKey,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentSessionConfiguration,
  type AgentEnvironmentInvalidation,
} from "@agen-ai/agent-protocol";

import {
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentProviderDriver,
} from "../src/index.js";
import {
  AgentProviderConformanceError,
  createFakeAgentProvider,
  runAgentProviderConformance,
} from "../src/testing/index.js";
const configuration: AgentSessionConfiguration = {
  kind: "selected",
  revision: parseAgentConfigurationRevisionId("configuration:1"),
  catalogRevision: 1,
  selections: [{
    key: "model",
    fieldRevision: 1,
    value: { fieldKind: "single_select", optionId: "fake-model" },
  }],
};

test('conformance accepts idle environment watches and closes both subscriptions', async () => {
  const base = createFakeAgentProvider().capabilities;
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...base,
    sessions: { create: true, resume: true, branch: { kind: 'unsupported' } },
    turns: { structuredOutput: { kind: "unsupported" }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
    requests: { approval: { kind: 'unsupported' }, elicitation: { kind: 'unsupported' } },
    configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
    collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
  }) });
  let opened = 0;
  let closed = 0;
  async function* watchEnvironment({ signal }: { readonly signal: AbortSignal }): AsyncIterable<AgentEnvironmentInvalidation> {
    opened++;
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally { closed++; }
  }
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    assert.equal(instance.environment.kind, 'read_and_watch');
    return { ...instance,
      environment: { ...instance.environment, watchEnvironment },
      adapter: { ...instance.adapter, async createSession(context) {
        const session = await instance.adapter.createSession(context);
        assert.equal(session.environment.kind, 'read_and_watch');
        return { ...session, environment: { ...session.environment, watchEnvironment } };
      } },
    };
  } };
  const report = await runAgentProviderConformance({
    driver, definition: fake.definition, workingDirectory: '/workspace',
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('idle') },
    createSessionId: parseAgentSessionId('idle-create'), resumeSessionId: parseAgentSessionId('idle-resume'),
    abortedSessionId: parseAgentSessionId('idle-abort'), interruptionSessionId: parseAgentSessionId('idle-interrupt'),
    turn: { turnId: parseAgentTurnId('idle-turn'), interactionMode: 'default', parts: [{ type: 'text', text: 'test' }] },
    interruptionTurn: { turnId: parseAgentTurnId('idle-interruption-turn'), interactionMode: 'default', parts: [{ type: 'text', text: 'test' }] },
    resolutionFor() { throw new Error('Unexpected request'); },
  });
  assert.ok(report.checks.includes('environment_instance'));
  assert.ok(report.checks.includes('environment_session'));
  assert.equal(opened, 2);
  assert.equal(closed, 2);
});

test("the deterministic fake passes conformance with a provider retry after request waiting", async () => {
  const fake = createFakeAgentProvider();
  let observedRetries = 0;
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      return {
        ...instance,
        adapter: {
          ...instance.adapter,
          async createSession(input) {
            const opened = await instance.adapter.createSession(input);
            return {
              ...opened,
              startTurn(turnInput) {
                const execution = opened.startTurn(turnInput);
                return { ...execution, outputs: (async function* () {
                for await (const output of execution.outputs) {
                  yield output;
                  if (output.kind === "event" && output.event.type === "turn.state_changed"
                    && output.event.payload.state === "waiting_for_request") {
                    observedRetries += 1;
                    yield createAgentEventOutput({
                      protocolVersion: 13,
                      sessionId: input.sessionId,
                      turnId: turnInput.turnId,
                      occurredAt: "2026-10-11T00:00:00.000Z",
                      type: "runtime.retrying",
                      payload: {
                        owner: "provider",
                        error: {
                          category: "overloaded",
                          code: "provider_overloaded",
                          message: "The provider is temporarily overloaded.",
                          recovery: { kind: "retry" },
                        },
                      },
                    });
                  }
                }
              })() };
              },
            };
          },
        },
      };
    },
  };
  const report = await runAgentProviderConformance({
    driver,
    definition: fake.definition,
    workingDirectory: "/host/workspaces/external-session",
    configuration,
    configurationSelection: {
      key: "model",
      expectedCatalogRevision: 1,
      expectedFieldRevision: 1,
      value: { fieldKind: "single_select", optionId: "fake-model-2" },
    },
    operationInvocation: {
      invocationId: parseAgentOperationInvocationId("fake-invocation:1"),
      operationId: parseAgentOperationId("fake.session.reset"),
      expectedRevision: 1,
      values: [],
    },
    collaborationSpawn: {
      collaborationId: parseAgentCollaborationId("fake-collaboration:1"),
      role: "reviewer",
      title: "Fake provider review",
      objective: "Review the fake provider.",
      createdAt: parseAgentIsoDateTime("2026-01-01T00:00:00.000Z"),
    },
    generatedResourceId: parseAgentGeneratedResourceId("fake-resource:1"),
    createSessionId: parseAgentSessionId("external-session:create"),
    resumeSessionId: parseAgentSessionId("external-session:resume"),
    branchSessionId: parseAgentSessionId("external-session:branch"),
    abortedSessionId: parseAgentSessionId("external-session:aborted"),
    interruptionSessionId: parseAgentSessionId(
      "external-session:interruption",
    ),
    turn: {
      turnId: parseAgentTurnId("external-turn:1"),
      interactionMode: "default",
      parts: [{ type: "text", text: "Exercise the provider." }],
      summary: "Conformance turn",
    },
    interruptionTurn: {
      turnId: parseAgentTurnId("external-turn:interruption"),
      interactionMode: "default",
      parts: [{ type: "text", text: "Interrupt this provider turn." }],
    },
    steeringInput: {
      parts: [{ type: "text", text: "Also run the integration tests." }],
      summary: "Additional validation",
    },
    resolutionFor: (request) => {
      if (request.requestKind !== "approval") {
        throw new TypeError("Expected the fake approval request.");
      }
      return {
        requestKind: "approval",
        requestId: request.requestId,
        disposition: "selected",
        optionId: request.options[0]!.optionId,
      };
    },
    branchSource: (binding, turnId) => ({
      sessionId: parseAgentSessionId("external-session:create"),
      binding,
      throughTurn: {
        turnId,
        historyAnchor: binding.historyAnchor!,
      },
    }),
  });

  assert.equal(report.providerKey, "fake-provider");
  assert.equal(observedRetries, 1);
  assert.deepEqual(report.checks, [
    "duplicate_instance",
    "instance_identity",
    "capabilities",
    "authentication_capability",
    "readiness",
    "version_reporting_capability",
    "account_quota",
    "environment_instance",
    "create_session",
    "binding_callback",
    "environment_session",
    "structured_output_unsupported",
    "abort",
    "turn_order",
    "request_resolution",
    "steering",
    "interruption",
    "configuration",
    "operations",
    "managed_content",
    "collaboration",
    "generated_resources",
    "idempotent_session_close",
    "resume_session",
    "branch_session",
    "idempotent_disposal",
  ]);

  const snapshot = fake.snapshot();
  assert.equal(snapshot.materializationCount, 1);
  assert.equal(snapshot.instanceDisposeCount, 1);
  assert.deepEqual(snapshot.createdSessionIds, [
    "external-session:create",
    "external-session:interruption",
  ]);
  assert.deepEqual(snapshot.resumedSessionIds, ["external-session:resume"]);
  assert.deepEqual(snapshot.branchedSessionIds, ["external-session:branch"]);
  assert.deepEqual(snapshot.turnIds, [
    "external-turn:interruption",
    "external-turn:1",
  ]);
  assert.equal(snapshot.resolutions.length, 1);
  assert.deepEqual(snapshot.interruptedTurnIds, [
    "external-turn:interruption",
  ]);
  assert.deepEqual(snapshot.steeringInputs, [
    {
      turnId: "external-turn:1",
      parts: [{ type: "text", text: "Also run the integration tests." }],
      summary: "Additional validation",
    },
  ]);
  assert.deepEqual(snapshot.configurationRevisions, ["1:model"]);
  assert.deepEqual(snapshot.closeCounts, {
    "external-session:create": 1,
    "external-session:interruption": 1,
    "external-session:resume": 1,
    "external-session:branch": 1,
  });
});

test("required-idempotency operation replays return the correlated result without redelegation", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const adapter = validateAgentProviderAdapter(
    instance.capabilities,
    instance.adapter,
  );
  const session = await adapter.createSession({
    sessionId: parseAgentSessionId("idempotency-session:1"),
    workingDirectory: "/host/workspaces/idempotency-session",
    configuration,
    onBindingCreated: () => undefined,
  });
  assert.equal(session.operations.kind, "supported");
  if (session.operations.kind !== "supported") return;
  const invocation = {
    invocationId: parseAgentOperationInvocationId("idempotency-invocation:1"),
    operationId: parseAgentOperationId("fake.session.reset"),
    expectedRevision: 1,
    values: [],
  };
  let executionStartCount = 0;
  const first = await session.operations.invokeOperation({
    invocation,
    observationTurnId: parseAgentTurnId(invocation.invocationId),
    onProviderExecutionStarted: () => {
      executionStartCount += 1;
    },
  });
  const replay = await session.operations.invokeOperation({
    invocation,
    observationTurnId: parseAgentTurnId(invocation.invocationId),
    onProviderExecutionStarted: () => {
      executionStartCount += 1;
    },
  });
  assert.deepEqual(replay, first);
  assert.equal(executionStartCount, 1);
  await session.close({ reason: "idle" });
  await instance.dispose();
});

test("conformance verifies explicit unsupported operation discriminants", async () => {
  const providerKey = parseAgentProviderKey("limited-fake-provider");
  const fake = createFakeAgentProvider({
    providerKey,
    instanceId: "limited-fake-instance",
    capabilities: parseAgentCapabilities({
      environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
      protocolVersion: 13,
      providerKey,
      sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
      turns: {
        structuredOutput: { kind: "unsupported" },
        interactionModes: ["default"],
        interrupt: false,
        steer: { kind: "unsupported" },
      },
      requests: {
        approval: { kind: "unsupported" },
        elicitation: { kind: "unsupported" },
      },
      context: {
        usage: { kind: "unsupported" },
        compaction: { kind: "unsupported" },
      },
      input: {
        contentReferences: { kind: "unsupported" as const }, text: true, images: { kind: "unsupported" } },
      output: {
        streaming: false,
        plans: false,
        fileChanges: "none",
        artifactKinds: [],
      },
      configuration: { kind: "managed" },
      operations: { kind: "unsupported" },
      managedContent: { kind: "unsupported" },
      integrations: { kind: "unsupported" },
      collaboration: { kind: "unsupported" },
      generatedResources: { kind: "unsupported" },
      authentication: { kind: "unsupported" },
      versionReporting: true,
    }),
  });
  const report = await runAgentProviderConformance({
    driver: fake.driver,
    definition: fake.definition,
    workingDirectory: "/host/workspaces/limited-session",
    configuration: {
      kind: "managed",
      revision: parseAgentConfigurationRevisionId("limited-configuration:1"),
    },
    createSessionId: parseAgentSessionId("limited-session:create"),
    resumeSessionId: parseAgentSessionId("limited-session:resume"),
    abortedSessionId: parseAgentSessionId("limited-session:aborted"),
    interruptionSessionId: parseAgentSessionId(
      "limited-session:interruption",
    ),
    turn: {
      turnId: parseAgentTurnId("limited-turn:1"),
      interactionMode: "default",
      parts: [{ type: "text", text: "Exercise the limited provider." }],
    },
    interruptionTurn: {
      turnId: parseAgentTurnId("limited-turn:interruption"),
      interactionMode: "default",
      parts: [{ type: "text", text: "Unused interruption fixture." }],
    },
    resolutionFor: () => {
      throw new Error("Limited provider must not open a request.");
    },
  });

  assert.ok(report.checks.includes("branch_session"));
  assert.ok(report.checks.includes("interruption"));
  assert.ok(report.checks.includes("configuration"));
});

test("conformance rejects a definitive steering rejection on a live turn", async () => {
  const fake = createFakeAgentProvider({
    capabilities: parseAgentCapabilities({
      ...createFakeAgentProvider().capabilities,
      configuration: { kind: "managed" },
      operations: { kind: "unsupported" },
      collaboration: { kind: "unsupported" },
      generatedResources: { kind: "unsupported" },
    }),
    steeringResult: {
      status: "rejected",
      error: {
        category: "unknown",
        code: "fake_steering_rejected",
        message: "The fake provider rejected steering.",
        recovery: { kind: "unknown" },
      },
    },
  });

  await assert.rejects(
    runAgentProviderConformance({
      driver: fake.driver,
      definition: fake.definition,
      workingDirectory: "/host/workspaces/rejected-steering",
      configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("rejected-steering:configuration") },
      createSessionId: parseAgentSessionId("rejected-steering:create"),
      resumeSessionId: parseAgentSessionId("rejected-steering:resume"),
      branchSessionId: parseAgentSessionId("rejected-steering:branch"),
      abortedSessionId: parseAgentSessionId("rejected-steering:aborted"),
      interruptionSessionId: parseAgentSessionId(
        "rejected-steering:interruption",
      ),
      turn: {
        turnId: parseAgentTurnId("rejected-steering:turn"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Exercise steering." }],
      },
      interruptionTurn: {
        turnId: parseAgentTurnId("rejected-steering:interrupt-turn"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Exercise interruption." }],
      },
      resolutionFor: (request) => {
        if (request.requestKind !== "approval") {
          throw new TypeError("Expected the fake approval request.");
        }
        return {
          requestKind: "approval",
          requestId: request.requestId,
          disposition: "selected",
          optionId: request.options[0]!.optionId,
        };
      },
      branchSource: (binding, turnId) => ({
        sessionId: parseAgentSessionId("rejected-steering:create"),
        binding,
        throughTurn: { turnId, historyAnchor: binding.historyAnchor! },
      }),
    }),
    (error: unknown) =>
      error instanceof AgentProviderConformanceError &&
      error.check === "steering",
  );
});

test("conformance retains the original error and failed cleanup without disposing the instance", { timeout: 3_000 }, async () => {
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...createFakeAgentProvider().capabilities,
    sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
    turns: { structuredOutput: { kind: "unsupported" }, interactionModes: ["default"], interrupt: false, steer: { kind: "unsupported" } },
    configuration: { kind: "managed" }, operations: { kind: "unsupported" },
    collaboration: { kind: "unsupported" }, generatedResources: { kind: "unsupported" },
  }) });
  const original = new Error("Human input failed.");
  const cleanup = new Error("Native cleanup remains incomplete.");
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    return { ...instance, adapter: { ...instance.adapter, async createSession(input) {
      const session = await instance.adapter.createSession(input);
      return { ...session, async close(context) { await session.close(context); throw cleanup; } };
    } } };
  } };
  const failures = (error: unknown): unknown[] => error instanceof AggregateError
    ? error.errors.flatMap(failures) : [error];
  await assert.rejects(runAgentProviderConformance({
    driver, definition: fake.definition, workingDirectory: "/workspace",
    configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("cleanup:configuration") },
    createSessionId: parseAgentSessionId("cleanup:create"), resumeSessionId: parseAgentSessionId("cleanup:resume"),
    abortedSessionId: parseAgentSessionId("cleanup:aborted"), interruptionSessionId: parseAgentSessionId("cleanup:interrupt"),
    turn: { turnId: parseAgentTurnId("cleanup:turn"), interactionMode: "default", parts: [{ type: "text", text: "test" }] },
    interruptionTurn: { turnId: parseAgentTurnId("cleanup:unused"), interactionMode: "default", parts: [{ type: "text", text: "unused" }] },
    async resolutionFor() { await Promise.resolve(); throw original; },
  }), (error: unknown) => {
    const retained = failures(error);
    return retained.includes(original) && retained.includes(cleanup);
  });
  assert.equal(fake.snapshot().instanceDisposeCount, 0);
  assert.equal(fake.snapshot().resolutions.length, 0);
  assert.equal(fake.snapshot().closeCounts["cleanup:create"], 1);
});

test("conformance inspects a turn-produced resource after terminal output and before session close", async () => {
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...createFakeAgentProvider().capabilities,
    sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
    turns: { structuredOutput: { kind: "unsupported" }, interactionModes: ["default"], interrupt: false, steer: { kind: "unsupported" } },
    requests: { approval: { kind: "unsupported" }, elicitation: { kind: "unsupported" } },
    configuration: { kind: "managed" }, operations: { kind: "unsupported" },
    collaboration: { kind: "unsupported" },
  }) });
  const lifecycle: string[] = [];
  let produced = false;
  let closed = false;
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    return { ...instance, adapter: { ...instance.adapter, async createSession(input) {
      const session = await instance.adapter.createSession(input);
      assert.equal(session.generatedResources.kind, "supported");
      if (session.generatedResources.kind !== "supported") throw new Error("Expected generated resource support.");
      const resources = session.generatedResources;
      return { ...session,
        startTurn(input) {
          const execution = session.startTurn(input);
          return { ...execution, outputs: (async function* () {
            for await (const output of execution.outputs) {
              if (output.kind === "event" && output.event.type === "turn.completed") {
                produced = true;
                lifecycle.push("produced");
              }
              yield output;
            }
          })() };
        },
        generatedResources: { kind: "supported" as const, async getGeneratedResource(input) {
          assert.equal(produced, true, "The producing turn has not generated the resource yet.");
          assert.equal(closed, false, "Resource inspection requires the producing session to remain open.");
          lifecycle.push("inspected");
          return resources.getGeneratedResource(input);
        } },
        async close(input) { if (!closed) lifecycle.push("closed"); closed = true; await session.close(input); },
      };
    } } };
  } };
  const report = await runAgentProviderConformance({
    driver, definition: fake.definition, workingDirectory: "/workspace",
    configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("resource:configuration") },
    generatedResourceId: parseAgentGeneratedResourceId("fake-resource:1"),
    createSessionId: parseAgentSessionId("resource:create"), resumeSessionId: parseAgentSessionId("resource:resume"),
    abortedSessionId: parseAgentSessionId("resource:aborted"), interruptionSessionId: parseAgentSessionId("resource:interrupt"),
    turn: { turnId: parseAgentTurnId("resource:turn"), interactionMode: "default", parts: [{ type: "text", text: "Generate the resource." }] },
    interruptionTurn: { turnId: parseAgentTurnId("resource:unused"), interactionMode: "default", parts: [{ type: "text", text: "unused" }] },
    resolutionFor() { throw new Error("Unexpected request."); },
  });
  assert.deepEqual(lifecycle, ["produced", "inspected", "closed"]);
  assert.ok(report.checks.includes("generated_resources"));
});
