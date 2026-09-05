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
} from "@agen-ai/agent-protocol";

import {
  validateAgentProviderAdapter,
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

test("the deterministic fake passes the reusable provider conformance suite", async () => {
  const fake = createFakeAgentProvider();
  const report = await runAgentProviderConformance({
    driver: fake.driver,
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
  assert.deepEqual(report.checks, [
    "duplicate_instance",
    "instance_identity",
    "capabilities",
    "authentication_capability",
    "readiness",
    "version_reporting_capability",
    "create_session",
    "binding_callback",
    "abort",
    "turn_order",
    "request_resolution",
    "steering",
    "interruption",
    "configuration",
    "operations",
    "managed_content",
    "integrations",
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
    "external-turn:1",
    "external-turn:interruption",
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
      protocolVersion: 8,
      providerKey,
      sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
      turns: {
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
      input: { text: true, images: { kind: "unsupported" } },
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
    steeringResult: {
      status: "rejected",
      error: {
        code: "fake_steering_rejected",
        message: "The fake provider rejected steering.",
        retryable: false,
      },
    },
  });

  await assert.rejects(
    runAgentProviderConformance({
      driver: fake.driver,
      definition: fake.definition,
      workingDirectory: "/host/workspaces/rejected-steering",
      configuration,
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
