// ------------------------------------------------------------------------------------------------
//                fakeConformance.test.ts - Fake provider and public conformance coverage
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentProviderKey,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentSessionConfiguration,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderConformanceError,
  createFakeAgentProvider,
  runAgentProviderConformance,
} from "../src/testing/index.js";
const configuration: AgentSessionConfiguration = {
  revision: parseAgentConfigurationRevisionId("configuration:1"),
  values: { model: "fake-model", mode: "agent" },
};

test("the deterministic fake passes the reusable provider conformance suite", async () => {
  const fake = createFakeAgentProvider();
  const report = await runAgentProviderConformance({
    driver: fake.driver,
    definition: fake.definition,
    workingDirectory: "/host/workspaces/external-session",
    configuration,
    updatedConfiguration: {
      revision: parseAgentConfigurationRevisionId("configuration:2"),
      values: { model: "fake-model-2", mode: "agent" },
    },
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
    resolutionFor: (request) => ({
      requestKind: "approval",
      requestId: request.requestId,
      decision: "approved",
    }),
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
  assert.deepEqual(snapshot.configurationRevisions, ["configuration:2"]);
  assert.deepEqual(snapshot.closeCounts, {
    "external-session:create": 1,
    "external-session:interruption": 1,
    "external-session:resume": 1,
    "external-session:branch": 1,
  });
});

test("conformance verifies explicit unsupported operation discriminants", async () => {
  const providerKey = parseAgentProviderKey("limited-fake-provider");
  const fake = createFakeAgentProvider({
    providerKey,
    instanceId: "limited-fake-instance",
    capabilities: parseAgentCapabilities({
      protocolVersion: 6,
      providerKey,
      sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
      turns: {
        interactionModes: ["default"],
        interrupt: false,
        steer: { kind: "unsupported" },
      },
      requests: { approval: false, elicitation: { kind: "unsupported" } },
      input: { text: true, images: { kind: "unsupported" } },
      output: {
        streaming: false,
        plans: false,
        fileChanges: "none",
        artifactKinds: [],
      },
      configuration: { kind: "managed" },
      interactionExtensions: {
        slashCommands: false,
        mcp: false,
        subagents: false,
        imageGeneration: false,
      },
      authentication: { kind: "unsupported" },
      versionReporting: true,
    }),
  });
  const report = await runAgentProviderConformance({
    driver: fake.driver,
    definition: fake.definition,
    workingDirectory: "/host/workspaces/limited-session",
    configuration: {
      revision: parseAgentConfigurationRevisionId("limited-configuration:1"),
      values: {},
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
      updatedConfiguration: {
        revision: parseAgentConfigurationRevisionId("configuration:2"),
        values: { model: "fake-model-2", mode: "agent" },
      },
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
      resolutionFor: (request) => ({
        requestKind: "approval",
        requestId: request.requestId,
        decision: "approved",
      }),
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
