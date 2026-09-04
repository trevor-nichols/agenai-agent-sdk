// ------------------------------------------------------------------------------------------------
//                adapterValidation.test.ts - Capability and session invariant coverage
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGENT_COLLABORATION_GRAPH_LIMITS,
  AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT,
  parseAgentArtifactId,
  parseAgentApprovalOptionId,
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentGeneratedResourceDescriptor,
  parseAgentGeneratedResourceId,
  parseAgentIsoDateTime,
  parseAgentItemId,
  parseAgentProviderConversationId,
  parseAgentProviderHistoryAnchor,
  parseAgentProviderKey,
  parseAgentRequestFieldId,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentIsoDateTime,
  type AgentRequest,
  type AgentSessionConfiguration,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  AgentProviderDelegatedOperationError,
  createAgentAuthenticationOutput,
  createAgentArtifactOutput,
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentProviderAdapter,
  type AgentProviderOperationResult,
  type AgentProviderOutput,
  type AgentProviderSession,
  type AgentProviderSteerTurnInput,
  type AgentTurnSteeringResult,
} from "../src/index.js";
import { validateAgentGeneratedResourceForCapabilities } from "../src/interactionValidation.js";
import { createFakeAgentProvider } from "../src/testing/index.js";

const providerKey = parseAgentProviderKey("contract-fixture");
const capabilities: AgentCapabilities = parseAgentCapabilities({
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
    streaming: true,
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
  versionReporting: false,
});
const requestCapabilities: AgentCapabilities = parseAgentCapabilities({
  ...capabilities,
  requests: {
    approval: {
      kind: "supported",
      modes: [{ persistence: "once", scopeKinds: ["exact_action"] }],
    },
    elicitation: { kind: "unsupported" },
  },
});
const interruptibleRequestCapabilities: AgentCapabilities =
  parseAgentCapabilities({
    ...requestCapabilities,
    turns: {
      interactionModes: ["default"],
      interrupt: true,
      steer: { kind: "unsupported" },
    },
  });
const steeringCapabilities: AgentCapabilities = parseAgentCapabilities({
  ...capabilities,
  turns: {
    interactionModes: ["default"],
    interrupt: false,
    steer: {
      kind: "supported",
      input: { text: true, images: { kind: "unsupported" } },
    },
  },
});
const authenticationCapabilities: AgentCapabilities = parseAgentCapabilities({
  ...capabilities,
  authentication: {
    kind: "supported",
    flows: ["device_code", "browser"],
  },
});
const sessionId = parseAgentSessionId("contract-session");
const configuration = {
  kind: "managed" as const,
  revision: parseAgentConfigurationRevisionId("contract-configuration"),
};

const allowOnceOptionId = parseAgentApprovalOptionId("approval:allow-once");
const denyOnceOptionId = parseAgentApprovalOptionId("approval:deny-once");

function approvalRequest(input: {
  readonly requestId: ReturnType<typeof parseAgentRequestId>;
  readonly itemId?: ReturnType<typeof parseAgentItemId>;
  readonly title?: string;
}): Extract<AgentRequest, { readonly requestKind: "approval" }> {
  return {
    requestKind: "approval",
    requestId: input.requestId,
    prompt: "Approve the operation?",
    subject: {
      kind: "other",
      title: input.title ?? "Pending operation",
      itemId: input.itemId ?? parseAgentItemId(`item:${input.requestId}`),
    },
    options: [
      {
        optionId: allowOnceOptionId,
        label: "Allow once",
        decision: "approved",
        persistence: "once",
        scope: { kind: "exact_action" },
      },
      {
        optionId: denyOnceOptionId,
        label: "Deny",
        decision: "denied",
        persistence: "once",
        scope: { kind: "exact_action" },
      },
    ],
  };
}

function allowOnceResolution(requestId: ReturnType<typeof parseAgentRequestId>) {
  return {
    requestKind: "approval" as const,
    requestId,
    disposition: "selected" as const,
    optionId: allowOnceOptionId,
  };
}

function eventBase(turnId: AgentTurnId, occurredAt: AgentIsoDateTime) {
  return { protocolVersion: 8 as const, sessionId, turnId, occurredAt };
}

function waitingForRequestOutputs(input: {
  readonly turnId: AgentTurnId;
  readonly request: AgentRequest;
  readonly occurredAt: AgentIsoDateTime;
}) {
  const correlationOutputs = input.request.requestKind !== "approval"
    ? []
    : input.request.subject.kind === "plan"
      ? [
          createAgentEventOutput({
            ...eventBase(input.turnId, input.occurredAt),
            type: "turn.plan.proposed",
            payload: {
              artifactId: input.request.subject.artifactId,
              requestId: input.request.requestId,
            },
          }),
        ]
      : [
          createAgentEventOutput({
            ...eventBase(input.turnId, input.occurredAt),
            type: "item.started",
            payload: {
              itemId: input.request.subject.itemId,
              itemKind: "unknown",
              status: "in_progress",
            },
          }),
        ];
  return [
    ...correlationOutputs,
    createAgentEventOutput({
      ...eventBase(input.turnId, input.occurredAt),
      type: "request.opened",
      payload: { request: input.request },
    }),
    createAgentEventOutput({
      ...eventBase(input.turnId, input.occurredAt),
      type: "turn.state_changed",
      payload: {
        state: "waiting_for_request",
        requestId: input.request.requestId,
      },
    }),
  ];
}

function completedTurnOutputs(
  turnId: AgentTurnId,
  occurredAt: AgentIsoDateTime,
) {
  return [
    createAgentEventOutput({
      ...eventBase(turnId, occurredAt),
      type: "turn.state_changed",
      payload: { state: "running" },
    }),
    createAgentEventOutput({
      ...eventBase(turnId, occurredAt),
      type: "turn.completed",
      payload: { outcome: "completed" },
    }),
  ];
}

async function collectOutputs(
  outputs: AsyncIterable<AgentProviderOutput>,
): Promise<readonly AgentProviderOutput[]> {
  const collected: AgentProviderOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
}

function session(
  overrides: Partial<AgentProviderSession> = {},
): AgentProviderSession {
  return {
    binding: { conversationId: "contract-conversation" as never },
    runTurn: async function* (input) {
      yield createAgentEventOutput({
        protocolVersion: 8,
        type: "turn.started",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: {},
      });
      yield createAgentEventOutput({
        protocolVersion: 8,
        type: "turn.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: { outcome: "completed" },
      });
    },
    resolveRequest: async function* () {},
    interruption: { kind: "unsupported" },
    steering: { kind: "unsupported" },
    configuration: { kind: "managed" },
    operations: { kind: "unsupported" },
    managedContent: { kind: "unsupported" },
    integrations: { kind: "unsupported" },
    collaboration: { kind: "unsupported" },
    generatedResources: { kind: "unsupported" },
    close: async () => undefined,
    ...overrides,
  };
}

function adapter(
  createSession: AgentProviderAdapter["createSession"],
): AgentProviderAdapter {
  return {
    createSession,
    resumption: {
      kind: "supported",
      resumeSession: (input) => session({ binding: input.binding }),
    },
    branching: { kind: "unsupported" },
    authentication: { kind: "unsupported" },
  };
}

test("adapter validation rejects C1 controls in working directories", async () => {
  let delegated = false;
  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      delegated = true;
      const opened = session();
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );

  await assert.rejects(
    async () =>
      validated.createSession({
        sessionId,
        workingDirectory: "/host/session\u0085directory",
        configuration,
        onBindingCreated: () => undefined,
      }),
    TypeError,
  );
  assert.equal(delegated, false);
});

test("managed configuration rejects selected state before provider delegation", async () => {
  let delegated = false;
  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      delegated = true;
      const opened = session();
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );

  await assert.rejects(
    async () =>
      validated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration: {
          kind: "selected",
          revision: parseAgentConfigurationRevisionId("managed-values"),
          catalogRevision: 1,
          selections: [{
            key: "model",
            fieldRevision: 1,
            value: {
              fieldKind: "single_select",
              optionId: "provider-model",
            },
          }],
        },
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "configuration_key_unsupported",
  );
  assert.equal(delegated, false);
});

test("selectable configuration kinds and catalog selections are enforced before delegation", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const selectableCapabilities = parseAgentCapabilities({
    ...instance.capabilities,
    configuration: {
      kind: "selectable",
      fieldKinds: ["single_select"],
      maxFields: 2,
    },
  });
  const validated = validateAgentProviderAdapter(
    selectableCapabilities,
    instance.adapter,
  );
  const unsupportedConfigurations: readonly {
    readonly code:
      | "configuration_key_unsupported"
      | "configuration_value_unsupported";
    readonly configuration: AgentSessionConfiguration;
  }[] = [
    {
      code: "configuration_key_unsupported" as const,
      configuration: {
        kind: "managed",
        revision: parseAgentConfigurationRevisionId("unknown-key"),
      },
    },
    {
      code: "configuration_value_unsupported" as const,
      configuration: {
        kind: "selected",
        revision: parseAgentConfigurationRevisionId("non-string-option"),
        catalogRevision: 1,
        selections: [{
          key: "temperature",
          fieldRevision: 1,
          value: { fieldKind: "bounded_integer", value: 42 },
        }],
      },
    },
  ];
  const assertUnsupported = (
    operation: () => unknown,
    code: "configuration_key_unsupported" | "configuration_value_unsupported",
  ) =>
    assert.rejects(
      async () => operation(),
      (error: unknown) =>
        error instanceof AgentProviderContractError && error.code === code,
    );

  for (const unsupported of unsupportedConfigurations) {
    await assertUnsupported(
      () =>
        validated.createSession({
          sessionId,
          workingDirectory: "/host/session",
          configuration: unsupported.configuration,
          onBindingCreated: () => undefined,
        }),
      unsupported.code,
    );
  }
  const { resumption } = validated;
  assert.equal(resumption.kind, "supported");
  if (resumption.kind !== "supported") return;
  await assertUnsupported(
    () =>
      resumption.resumeSession({
        sessionId,
        workingDirectory: "/host/session",
        binding: {
          conversationId: parseAgentProviderConversationId(
            "contract-conversation",
          ),
        },
        configuration: unsupportedConfigurations[0]!.configuration,
      }),
    "configuration_key_unsupported",
  );
  const { branching } = validated;
  assert.equal(branching.kind, "through_turn");
  if (branching.kind !== "through_turn") return;
  await assertUnsupported(
    () =>
      branching.branchSession({
        sessionId,
        workingDirectory: "/host/session",
        source: {
          sessionId: parseAgentSessionId("contract-source-session"),
          binding: {
            conversationId: parseAgentProviderConversationId(
              "contract-conversation",
            ),
            historyAnchor: parseAgentProviderHistoryAnchor(
              "contract-source-anchor",
            ),
          },
          throughTurn: {
            turnId: parseAgentTurnId("contract-source-turn"),
            historyAnchor: parseAgentProviderHistoryAnchor(
              "contract-source-anchor",
            ),
          },
        },
        configuration: unsupportedConfigurations[0]!.configuration,
        onBindingCreated: () => undefined,
      }),
    "configuration_key_unsupported",
  );
  const unopenedSnapshot = fake.snapshot();
  assert.deepEqual(
    {
      created: unopenedSnapshot.createdSessionIds,
      resumed: unopenedSnapshot.resumedSessionIds,
      branched: unopenedSnapshot.branchedSessionIds,
    },
    {
      created: [],
      resumed: [],
      branched: [],
    },
  );

  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration: {
      kind: "selected",
      revision: parseAgentConfigurationRevisionId("supported-configuration"),
      catalogRevision: 1,
      selections: [{
        key: "model",
        fieldRevision: 1,
        value: { fieldKind: "single_select", optionId: "fake-model" },
      }],
    },
    onBindingCreated: () => undefined,
  });
  const { configuration: configurationControl } = opened;
  assert.equal(configurationControl.kind, "selectable");
  if (configurationControl.kind !== "selectable") return;
  await assertUnsupported(
    () =>
      configurationControl.applyConfigurationSelection({
        selection: {
          key: "permission_mode",
          expectedCatalogRevision: 1,
          expectedFieldRevision: 1,
          value: {
            fieldKind: "single_select",
            optionId: "workspace-write",
          },
        },
      }),
    "configuration_value_unsupported",
  );
  assert.deepEqual(fake.snapshot().createdSessionIds, [sessionId]);
  assert.deepEqual(fake.snapshot().configurationRevisions, []);
  await opened.close({ reason: "idle" });
  await instance.dispose();
});

test("a failed execution-start observer preserves the pre-delegation error and session", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const validated = validateAgentProviderAdapter(
    instance.capabilities,
    instance.adapter,
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration: {
      kind: "selected",
      revision: parseAgentConfigurationRevisionId("observer-failure"),
      catalogRevision: 1,
      selections: [{
        key: "model",
        fieldRevision: 1,
        value: { fieldKind: "single_select", optionId: "fake-model" },
      }],
    },
    onBindingCreated: () => undefined,
  });
  const configurationControl = opened.configuration;
  assert.equal(configurationControl.kind, "selectable");
  if (configurationControl.kind !== "selectable") return;
  const selection = {
    key: "model",
    expectedCatalogRevision: 1,
    expectedFieldRevision: 1,
    value: { fieldKind: "single_select" as const, optionId: "fake-model-2" },
  };
  const observerFailure = new Error("durable execution-start receipt failed");

  await assert.rejects(
    async () => configurationControl.applyConfigurationSelection({
      selection,
      onProviderExecutionStarted: () => {
        throw observerFailure;
      },
    }),
    (error: unknown) => error === observerFailure,
  );
  assert.deepEqual(fake.snapshot().configurationRevisions, []);

  assert.deepEqual(
    await configurationControl.applyConfigurationSelection({ selection }),
    { status: "completed", outputs: [] },
  );
  assert.deepEqual(fake.snapshot().configurationRevisions, ["1:model"]);
  await opened.close({ reason: "idle" });
  await instance.dispose();
});

test("adapter validation requires the binding callback exactly once", async () => {
  let rejectedCloseCount = 0;
  const missing = validateAgentProviderAdapter(
    capabilities,
    adapter(() =>
      session({
        close: async () => {
          rejectedCloseCount += 1;
        },
      }),
    ),
  );
  await assert.rejects(
    async () =>
      missing.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "binding_callback_missing",
  );
  assert.equal(rejectedCloseCount, 1);

  const repeated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const binding = { conversationId: "contract-conversation" as never };
      input.onBindingCreated(binding);
      input.onBindingCreated(binding);
      return session({ binding });
    }),
  );
  await assert.rejects(
    async () =>
      repeated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "binding_callback_repeated",
  );
});

test("resume validation closes a provider session with a mismatched binding", async () => {
  let rejectedCloseCount = 0;
  const validated = validateAgentProviderAdapter(capabilities, {
    ...adapter(() => session()),
    resumption: {
      kind: "supported",
      resumeSession: () =>
        session({
          binding: { conversationId: "another-conversation" as never },
          close: async () => {
            rejectedCloseCount += 1;
          },
        }),
    },
  });
  assert.equal(validated.resumption.kind, "supported");
  if (validated.resumption.kind !== "supported") return;
  const resumption = validated.resumption;

  await assert.rejects(
    async () =>
      resumption.resumeSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        binding: { conversationId: "expected-conversation" as never },
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "resume_binding_mismatch",
  );
  assert.equal(rejectedCloseCount, 1);
});

test("capability declarations must match callable adapter and session ports", async () => {
  assert.throws(
    () =>
      validateAgentProviderAdapter(capabilities, {
        ...adapter(() => session()),
        authentication: {
          kind: "supported",
          start: async function* () {
            // No output is needed for capability validation.
          },
          cancel: async () => ({ status: "completed" }),
        },
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "capability_port_mismatch",
  );

  assert.throws(
    () =>
      validateAgentProviderAdapter(
        authenticationCapabilities,
        adapter(() => session()),
      ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "capability_port_mismatch",
  );

  assert.throws(
    () =>
      validateAgentProviderAdapter(capabilities, {
        ...adapter(() => session()),
        branching: {
          kind: "through_turn",
          branchSession: () => session(),
        },
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "capability_port_mismatch",
  );

  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        interruption: {
          kind: "supported",
          interruptTurn: async () => ({ status: "completed" }),
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  await assert.rejects(
    async () =>
      validated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "capability_port_mismatch",
  );

  for (const [declaredCapabilities, steering] of [
    [
      capabilities,
      {
        kind: "supported" as const,
        steerTurn: async () => ({ status: "delivered" as const }),
      },
    ],
    [steeringCapabilities, { kind: "unsupported" as const }],
  ] as const) {
    const mismatched = validateAgentProviderAdapter(
      declaredCapabilities,
      adapter((input) => {
        const opened = session({ steering });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    await assert.rejects(
      async () =>
        mismatched.createSession({
          sessionId,
          workingDirectory: "/host/session",
          configuration,
          onBindingCreated: () => undefined,
        }),
      (error: unknown) =>
      error instanceof AgentProviderContractError &&
        error.code === "capability_port_mismatch",
    );
  }

  const hiddenUnsupportedPort = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        operations: {
          kind: "unsupported",
          invokeOperation: async () => ({
            invocationId: "invocation:hidden",
            status: "completed",
          }),
        } as never,
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  await assert.rejects(
    async () => hiddenUnsupportedPort.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "capability_port_mismatch",
  );

  const extraSessionSurface = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = {
        ...session(),
        nativeCommands: async () => [],
      } as unknown as AgentProviderSession;
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  await assert.rejects(
    async () => extraSessionSurface.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_session",
  );

  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const supportedPortDowngrades: readonly Partial<AgentProviderSession>[] = [
    { configuration: { kind: "managed" } },
    { operations: { kind: "unsupported" } },
    { managedContent: { kind: "unsupported" } },
    { integrations: { kind: "unsupported" } },
    { collaboration: { kind: "unsupported" } },
    { generatedResources: { kind: "unsupported" } },
  ];
  for (const downgrade of supportedPortDowngrades) {
    const candidate = validateAgentProviderAdapter(instance.capabilities, {
      ...instance.adapter,
      createSession: async (input) => ({
        ...await instance.adapter.createSession(input),
        ...downgrade,
      }),
    });
    await assert.rejects(
      async () => candidate.createSession({
          sessionId,
          workingDirectory: "/host/session",
          configuration: {
            kind: "selected",
            revision: parseAgentConfigurationRevisionId("supported-ports"),
            catalogRevision: 1,
            selections: [{
              key: "model",
              fieldRevision: 1,
              value: { fieldKind: "single_select", optionId: "fake-model" },
            }],
          },
          onBindingCreated: () => undefined,
        }),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "capability_port_mismatch",
    );
  }
  await instance.dispose();
});

test("provider output cannot exceed declared event, item, artifact, or request capabilities", async () => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const finalDiffCapabilities = parseAgentCapabilities({
    ...capabilities,
    output: { ...capabilities.output, fileChanges: "final_diff" },
  });
  const boundaryCases: readonly {
    readonly name: string;
    readonly capabilities: AgentCapabilities;
    readonly output: (turnId: AgentTurnId) => AgentProviderOutput;
  }[] = [
    {
      name: "streaming",
      capabilities: parseAgentCapabilities({
        ...capabilities,
        output: { ...capabilities.output, streaming: false },
      }),
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "content.delta",
          payload: {
            itemId: parseAgentItemId("contract-item"),
            streamKind: "assistant_text",
            delta: "Undeclared stream output.",
          },
        }),
    },
    {
      name: "plan",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "turn.plan.updated",
          payload: {
            steps: [
              {
                stepId: "contract-step",
                text: "Undeclared plan output.",
                status: "in_progress",
              },
            ],
          },
        }),
    },
    {
      name: "plan_item",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.completed",
          payload: {
            itemId: parseAgentItemId("contract-plan-item"),
            itemKind: "plan",
            status: "completed",
          },
        }),
    },
    {
      name: "plan_stream",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "content.delta",
          payload: {
            itemId: parseAgentItemId("contract-plan-stream"),
            streamKind: "plan_text",
            delta: "Undeclared plan stream.",
          },
        }),
    },
    {
      name: "file_change",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "turn.diff.updated",
          payload: {
            summary: "Undeclared file change.",
            fileCount: 1,
            byteSize: 32,
          },
        }),
    },
    {
      name: "structured_file_change_item",
      capabilities: finalDiffCapabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.completed",
          payload: {
            itemId: parseAgentItemId("contract-file-change-item"),
            itemKind: "file_change",
            status: "completed",
            details: {
              changes: [{ path: "src/contract.ts", changeKind: "modified" }],
            },
          },
        }),
    },
    {
      name: "structured_file_change_stream",
      capabilities: finalDiffCapabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "content.delta",
          payload: {
            itemId: parseAgentItemId("contract-file-change-stream"),
            streamKind: "file_change_output",
            delta: "Undeclared structured file-change stream.",
          },
        }),
    },
    {
      name: "mcp_item_started",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.started",
          payload: {
            itemId: parseAgentItemId("contract-mcp-started"),
            itemKind: "mcp_tool_call",
            status: "in_progress",
          },
        }),
    },
    {
      name: "mcp_item_updated",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.updated",
          payload: {
            itemId: parseAgentItemId("contract-mcp-updated"),
            itemKind: "mcp_tool_call",
            status: "in_progress",
          },
        }),
    },
    {
      name: "mcp_item_completed",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.completed",
          payload: {
            itemId: parseAgentItemId("contract-mcp-completed"),
            itemKind: "mcp_tool_call",
            status: "completed",
          },
        }),
    },
    {
      name: "subagent_item_started",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.started",
          payload: {
            itemId: parseAgentItemId("contract-subagent-started"),
            itemKind: "collaboration_tool_call",
            status: "in_progress",
          },
        }),
    },
    {
      name: "subagent_item_updated",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.updated",
          payload: {
            itemId: parseAgentItemId("contract-subagent-updated"),
            itemKind: "collaboration_tool_call",
            status: "in_progress",
          },
        }),
    },
    {
      name: "subagent_item_completed",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "item.completed",
          payload: {
            itemId: parseAgentItemId("contract-subagent-completed"),
            itemKind: "collaboration_tool_call",
            status: "completed",
          },
        }),
    },
    {
      name: "artifact_kind",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "artifact.referenced",
          payload: {
            artifact: {
              artifactId: parseAgentArtifactId("contract-artifact"),
              kind: "diff",
              displayName: "contract.diff",
            },
          },
        }),
    },
    {
      name: "artifact_candidate_kind",
      capabilities,
      output: () =>
        createAgentArtifactOutput({
          descriptor: {
            artifactId: parseAgentArtifactId("contract-artifact-candidate"),
            kind: "diff",
            displayName: "contract.diff",
          },
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
          delivery: "best_effort",
        }),
    },
    {
      name: "approval_request",
      capabilities,
      output: (turnId) =>
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "request.opened",
          payload: {
            request: approvalRequest({
              requestId: parseAgentRequestId("contract-output-approval"),
              title: "Undeclared approval",
            }),
          },
        }),
    },
  ];

  for (const boundaryCase of boundaryCases) {
    const validated = validateAgentProviderAdapter(
      boundaryCase.capabilities,
      adapter((input) => {
        const opened = session({
          runTurn: async function* (turnInput) {
            yield createAgentEventOutput({
              ...eventBase(turnInput.turnId, occurredAt),
              type: "turn.started",
              payload: {},
            });
            yield boundaryCase.output(turnInput.turnId);
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });

    await assert.rejects(
      collectOutputs(
        opened.runTurn({
          turnId: parseAgentTurnId(`contract-output-${boundaryCase.name}`),
          interactionMode: "default",
          parts: [{ type: "text", text: "Exercise output validation." }],
        }),
      ),
      (error: unknown) =>
        error instanceof AgentProviderContractError &&
        error.code === "output_capability_mismatch",
      boundaryCase.name,
    );
    await opened.close({ reason: "contract_rejected" });
  }
});

test("generated-resource inspection returns only exact owned artifact candidates", async () => {
  const resourceCapabilities = parseAgentCapabilities({
    ...capabilities,
    generatedResources: {
      kind: "supported",
      resourceKinds: ["image"],
      maxResourcesPerTurn: 1,
      maxBytesPerResource: 1_024,
    },
  });
  const resourceId = parseAgentGeneratedResourceId("resource:owned-preview");
  const artifactId = parseAgentArtifactId("artifact:owned-preview");
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let inspectionCount = 0;
  const validated = validateAgentProviderAdapter(
    resourceCapabilities,
    adapter((input) => {
      const opened = session({
        generatedResources: {
          kind: "supported",
          getGeneratedResource: async () => {
            inspectionCount += 1;
            const displayName = inspectionCount === 1
              ? "Generated preview"
              : "Mutated terminal preview";
            return {
              descriptor: {
                resourceId,
                kind: "image",
                status: "available",
                displayName,
                producer: { kind: "session", sessionId },
                artifactId,
                mediaType: "image/png",
                byteSize: bytes.byteLength,
                sha256,
                widthPixels: 1,
                heightPixels: 1,
                createdAt: "2026-08-04T00:00:00.000Z" as never,
              },
              candidate: {
                descriptor: {
                  artifactId,
                  kind: "image",
                  displayName,
                  mediaType: "image/png",
                  byteSize: bytes.byteLength,
                  digest: { algorithm: "sha256", value: sha256 },
                },
                source: { kind: "bytes", bytes },
                delivery: "required_before_reference",
              },
            };
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  assert.equal(opened.generatedResources.kind, "supported");
  if (opened.generatedResources.kind !== "supported") return;
  const generatedResources = opened.generatedResources;

  const inspection = await generatedResources.getGeneratedResource({ resourceId });
  assert.equal(inspection.descriptor.resourceId, resourceId);
  assert.equal(inspection.candidate?.delivery, "required_before_reference");
  assert.deepEqual(
    inspection.candidate?.source.kind === "bytes"
      ? [...inspection.candidate.source.bytes]
      : null,
    [...bytes],
  );
  await assert.rejects(
    async () => generatedResources.getGeneratedResource({ resourceId }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "output_resource_mismatch",
  );
  await opened.close({ reason: "contract_rejected" });
});

test("generated-resource lifecycle admits stable expiration from settled states", () => {
  const resourceCapabilities = parseAgentCapabilities({
    ...capabilities,
    generatedResources: {
      kind: "supported",
      resourceKinds: ["image"],
      maxResourcesPerTurn: 1,
      maxBytesPerResource: 1_024,
    },
  });
  const createdAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const expiresAt = parseAgentIsoDateTime("2026-08-04T00:05:00.000Z");

  for (const previousStatus of ["available", "unavailable"] as const) {
    const resourceId = parseAgentGeneratedResourceId(
      `resource:expires-from-${previousStatus}`,
    );
    const identity = {
      resourceId,
      kind: "image" as const,
      displayName: "Generated preview",
      producer: { kind: "session" as const, sessionId },
      createdAt,
    };
    const previous = parseAgentGeneratedResourceDescriptor(
      previousStatus === "available"
        ? {
            ...identity,
            status: previousStatus,
            artifactId: parseAgentArtifactId(`artifact:${previousStatus}`),
            mediaType: "image/png",
            byteSize: 3,
            sha256: "0".repeat(64),
            widthPixels: 1,
            heightPixels: 1,
          }
        : {
            ...identity,
            status: previousStatus,
            error: {
              code: "generation_failed",
              message: "The preview could not be generated.",
              retryable: false,
            },
          },
    );
    const expired = parseAgentGeneratedResourceDescriptor({
      ...identity,
      status: "expired",
      expiresAt,
    });

    assert.deepEqual(
      validateAgentGeneratedResourceForCapabilities({
        capabilities: resourceCapabilities,
        candidate: expired,
        expectedResourceId: resourceId,
        previous,
      }),
      expired,
    );
    assert.throws(
      () => validateAgentGeneratedResourceForCapabilities({
        capabilities: resourceCapabilities,
        candidate: { ...expired, summary: "Changed after expiry." },
        expectedResourceId: resourceId,
        previous: expired,
      }),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_resource_mismatch",
    );
  }
});

test("generated-resource inspection rejects missing and mismatched candidates", async () => {
  const resourceCapabilities = parseAgentCapabilities({
    ...capabilities,
    generatedResources: {
      kind: "supported",
      resourceKinds: ["image"],
      maxResourcesPerTurn: 2,
      maxBytesPerResource: 1_024,
    },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const scenarios = [
    {
      name: "available without candidate",
      resourceId: parseAgentGeneratedResourceId("resource:missing-candidate"),
      inspection: {
        descriptor: {
          resourceId: parseAgentGeneratedResourceId("resource:missing-candidate"),
          kind: "image" as const,
          status: "available" as const,
          displayName: "Generated preview",
          producer: { kind: "session" as const, sessionId },
          artifactId: parseAgentArtifactId("artifact:missing-candidate"),
          mediaType: "image/png",
          byteSize: bytes.byteLength,
          sha256,
          widthPixels: 1,
          heightPixels: 1,
          createdAt: "2026-08-04T00:00:00.000Z" as never,
        },
      },
    },
    {
      name: "candidate metadata mismatch",
      resourceId: parseAgentGeneratedResourceId("resource:mismatched-candidate"),
      inspection: {
        descriptor: {
          resourceId: parseAgentGeneratedResourceId("resource:mismatched-candidate"),
          kind: "image" as const,
          status: "available" as const,
          displayName: "Generated preview",
          producer: { kind: "session" as const, sessionId },
          artifactId: parseAgentArtifactId("artifact:mismatched-candidate"),
          mediaType: "image/png",
          byteSize: bytes.byteLength,
          sha256,
          widthPixels: 1,
          heightPixels: 1,
          createdAt: "2026-08-04T00:00:00.000Z" as never,
        },
        candidate: {
          descriptor: {
            artifactId: parseAgentArtifactId("artifact:mismatched-candidate"),
            kind: "image" as const,
            displayName: "Different preview",
            mediaType: "image/png",
            byteSize: bytes.byteLength,
            digest: { algorithm: "sha256" as const, value: sha256 },
          },
          source: { kind: "bytes" as const, bytes },
          delivery: "required_before_reference" as const,
        },
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const validated = validateAgentProviderAdapter(
      resourceCapabilities,
      adapter((input) => {
        const opened = session({
          generatedResources: {
            kind: "supported",
            getGeneratedResource: async () => scenario.inspection,
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
    assert.equal(opened.generatedResources.kind, "supported");
    if (opened.generatedResources.kind !== "supported") continue;
    const generatedResources = opened.generatedResources;
    await assert.rejects(
      async () => generatedResources.getGeneratedResource({
        resourceId: scenario.resourceId,
      }),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_resource_mismatch",
      scenario.name,
    );
    await opened.close({ reason: "contract_rejected" });
  }
});

test("interaction observations enforce per-turn bounds and forward-only lifecycles", async () => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const operationCapabilities = parseAgentCapabilities({
    ...capabilities,
    operations: {
      kind: "supported",
      operationKinds: ["session_control"],
      fieldKinds: ["boolean"],
      executionModes: ["immediate"],
      maxOperations: 1,
      maxFieldsPerOperation: 1,
    },
  });
  const collaborationCapabilities = parseAgentCapabilities({
    ...capabilities,
    collaboration: {
      kind: "supported",
      roles: ["reviewer"],
      controlActions: ["spawn", "inspect"],
      maxDepth: 2,
      maxChildrenPerNode: 1,
      maxActiveNodes: 2,
    },
  });
  const resourceCapabilities = parseAgentCapabilities({
    ...capabilities,
    generatedResources: {
      kind: "supported",
      resourceKinds: ["image"],
      maxResourcesPerTurn: 1,
      maxBytesPerResource: 1_024,
    },
  });
  const completedOperation = {
    invocationId: "invocation:observed" as never,
    status: "completed" as const,
  };
  const completedCollaboration = {
    collaborationId: "collaboration:observed" as never,
    rootCollaborationId: "collaboration:observed" as never,
    role: "reviewer" as const,
    title: "Interaction lifecycle review",
    status: "completed" as const,
    objective: "Review the interaction lifecycle.",
    usage: { kind: "unavailable" as const },
    outcome: { kind: "completed" as const },
    createdAt: occurredAt,
    updatedAt: occurredAt,
    terminalAt: occurredAt,
  };
  const scenarios: readonly {
    readonly name: string;
    readonly capabilities: AgentCapabilities;
    readonly expectedCode:
      | "invalid_operation_result"
      | "invalid_collaboration_transition"
      | "output_capability_mismatch"
      | "output_collaboration_mismatch";
    readonly ports: Partial<AgentProviderSession>;
    readonly outputs: readonly AgentProviderOutput[];
  }[] = [
    {
      name: "terminal operation revival",
      capabilities: operationCapabilities,
      expectedCode: "invalid_operation_result",
      ports: {
        operations: {
          kind: "supported",
          listOperations: async () => ({ revision: 1, operations: [] }),
          invokeOperation: async ({ invocation }) => ({
            invocationId: invocation.invocationId,
            status: "completed",
          }),
        },
      },
      outputs: [
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:operation-lifecycle"), occurredAt),
          type: "operation.updated",
          payload: { result: completedOperation },
        }),
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:operation-lifecycle"), occurredAt),
          type: "operation.updated",
          payload: { result: { ...completedOperation, status: "accepted" } },
        }),
      ],
    },
    {
      name: "terminal collaboration revival",
      capabilities: collaborationCapabilities,
      expectedCode: "invalid_collaboration_transition",
      ports: {
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn }) => ({
            collaborationId: spawn.collaborationId,
            rootCollaborationId: spawn.collaborationId,
            role: spawn.role,
            title: spawn.title,
            status: "queued",
            objective: spawn.objective,
            usage: { kind: "unavailable" },
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }),
          controlCollaboration: async () => completedCollaboration,
        },
      },
      outputs: [
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-lifecycle"), occurredAt),
          type: "collaboration.updated",
          payload: { node: completedCollaboration },
        }),
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-lifecycle"), occurredAt),
          type: "collaboration.updated",
          payload: {
            node: {
              collaborationId: completedCollaboration.collaborationId,
              rootCollaborationId: completedCollaboration.rootCollaborationId,
              role: completedCollaboration.role,
              title: completedCollaboration.title,
              status: "running",
              objective: completedCollaboration.objective,
              usage: completedCollaboration.usage,
              createdAt: completedCollaboration.createdAt,
              updatedAt: completedCollaboration.updatedAt,
            },
          },
        }),
      ],
    },
    {
      name: "terminal collaboration parent extension",
      capabilities: collaborationCapabilities,
      expectedCode: "output_collaboration_mismatch",
      ports: {
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn }) => ({
            collaborationId: spawn.collaborationId,
            rootCollaborationId: spawn.collaborationId,
            role: spawn.role,
            title: spawn.title,
            status: "queued",
            objective: spawn.objective,
            usage: { kind: "unavailable" },
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }),
          controlCollaboration: async () => completedCollaboration,
        },
      },
      outputs: [
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-terminal-parent"), occurredAt),
          type: "collaboration.updated",
          payload: { node: completedCollaboration },
        }),
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-terminal-parent"), occurredAt),
          type: "collaboration.updated",
          payload: {
            node: {
              collaborationId: "collaboration:observed-child" as never,
              rootCollaborationId: completedCollaboration.collaborationId,
              parentCollaborationId: completedCollaboration.collaborationId,
              role: "reviewer",
              title: "Late child",
              status: "running",
              objective: "Attempt to extend a completed collaboration.",
              usage: { kind: "unavailable" },
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          },
        }),
      ],
    },
    {
      name: "collaboration node count",
      capabilities: collaborationCapabilities,
      expectedCode: "output_capability_mismatch",
      ports: {
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn }) => ({
            collaborationId: spawn.collaborationId,
            rootCollaborationId: spawn.collaborationId,
            role: spawn.role,
            title: spawn.title,
            status: "queued",
            objective: spawn.objective,
            usage: { kind: "unavailable" },
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }),
          controlCollaboration: async () => completedCollaboration,
        },
      },
      outputs: Array.from(
        { length: AGENT_COLLABORATION_GRAPH_LIMITS.maxNodes + 1 },
        (_, index) => {
          const collaborationId = `collaboration:observed:${index}` as never;
          return createAgentEventOutput({
            ...eventBase(parseAgentTurnId("turn:collaboration-node-limit"), occurredAt),
            type: "collaboration.updated",
            payload: {
              node: {
                ...completedCollaboration,
                collaborationId,
                rootCollaborationId: collaborationId,
                title: `Observed collaboration ${index}`,
              },
            },
          });
        },
      ),
    },
    {
      name: "same timestamp collaboration mutation",
      capabilities: collaborationCapabilities,
      expectedCode: "invalid_collaboration_transition",
      ports: {
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn }) => ({
            collaborationId: spawn.collaborationId,
            rootCollaborationId: spawn.collaborationId,
            role: spawn.role,
            title: spawn.title,
            status: "queued",
            objective: spawn.objective,
            usage: { kind: "unavailable" },
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }),
          controlCollaboration: async () => completedCollaboration,
        },
      },
      outputs: [
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-same-time"), occurredAt),
          type: "collaboration.updated",
          payload: {
            node: {
              ...completedCollaboration,
              status: "running",
              outcome: undefined,
              terminalAt: undefined,
            },
          },
        }),
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:collaboration-same-time"), occurredAt),
          type: "collaboration.updated",
          payload: {
            node: {
              ...completedCollaboration,
              status: "waiting",
              progress: "Waiting without advancing the observation clock.",
              outcome: undefined,
              terminalAt: undefined,
            },
          },
        }),
      ],
    },
    {
      name: "generated resource count",
      capabilities: resourceCapabilities,
      expectedCode: "output_capability_mismatch",
      ports: {
        generatedResources: {
          kind: "supported",
          getGeneratedResource: async ({ resourceId }) => ({
            descriptor: {
              resourceId,
              kind: "image",
              status: "pending",
              displayName: "Preview",
              producer: { kind: "session", sessionId },
              createdAt: occurredAt,
            },
          }),
        },
      },
      outputs: [
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:resource-limit"), occurredAt),
          type: "resource.updated",
          payload: {
            resource: {
              resourceId: "resource:first" as never,
              kind: "image",
              status: "pending",
              displayName: "First preview",
              producer: { kind: "turn", turnId: parseAgentTurnId("turn:resource-limit") },
              createdAt: occurredAt,
            },
          },
        }),
        createAgentEventOutput({
          ...eventBase(parseAgentTurnId("turn:resource-limit"), occurredAt),
          type: "resource.updated",
          payload: {
            resource: {
              resourceId: "resource:second" as never,
              kind: "image",
              status: "pending",
              displayName: "Second preview",
              producer: { kind: "turn", turnId: parseAgentTurnId("turn:resource-limit") },
              createdAt: occurredAt,
            },
          },
        }),
      ],
    },
  ];

  for (const scenario of scenarios) {
    const turnId = scenario.outputs[0]!.kind === "event"
      ? scenario.outputs[0].event.turnId!
      : parseAgentTurnId(`turn:${scenario.name}`);
    const validated = validateAgentProviderAdapter(
      scenario.capabilities,
      adapter((input) => {
        const opened = session({
          ...scenario.ports,
          runTurn: async function* () {
            yield createAgentEventOutput({
              ...eventBase(turnId, occurredAt),
              type: "turn.started",
              payload: {},
            });
            yield* scenario.outputs;
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
    await assert.rejects(
      collectOutputs(opened.runTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Observe interactions." }],
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === scenario.expectedCode,
      scenario.name,
    );
    await opened.close({ reason: "contract_rejected" });
  }
});

test("collaboration spawn validates every immutable identity field after delegation", async () => {
  const collaborationCapabilities = parseAgentCapabilities({
    ...capabilities,
    collaboration: {
      kind: "supported",
      roles: ["reviewer"],
      controlActions: ["spawn", "inspect"],
      maxDepth: 2,
      maxChildrenPerNode: 1,
      maxActiveNodes: 2,
    },
  });
  const createdAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");

  for (const mismatch of ["title", "createdAt"] as const) {
    const validated = validateAgentProviderAdapter(
      collaborationCapabilities,
      adapter((input) => {
        const opened = session({
          collaboration: {
            kind: "supported",
            spawnCollaboration: async ({ spawn, onProviderExecutionStarted }) => {
              onProviderExecutionStarted?.();
              const nodeCreatedAt = mismatch === "createdAt"
                ? parseAgentIsoDateTime("2026-08-04T00:00:01.000Z")
                : spawn.createdAt;
              return {
                collaborationId: spawn.collaborationId,
                rootCollaborationId: spawn.collaborationId,
                role: spawn.role,
                title: mismatch === "title" ? "Provider-rewritten title" : spawn.title,
                status: "queued",
                objective: spawn.objective,
                usage: { kind: "unavailable" },
                createdAt: nodeCreatedAt,
                updatedAt: nodeCreatedAt,
              };
            },
            controlCollaboration: async () => {
              throw new Error("control must not run");
            },
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
    const collaboration = opened.collaboration;
    assert.equal(collaboration.kind, "supported");
    if (collaboration.kind !== "supported") continue;

    await assert.rejects(
      async () => collaboration.spawnCollaboration({
        spawn: {
          collaborationId: `collaboration:${mismatch}` as never,
          role: "reviewer",
          title: "Review the implementation",
          objective: "Find correctness defects.",
          createdAt,
        },
      }),
      (error: unknown) =>
        error instanceof AgentProviderDelegatedOperationError
        && error.operation === "spawn_collaboration"
        && error.providerExecution === "started"
        && error.cause instanceof AgentProviderContractError
        && error.cause.code === "output_collaboration_mismatch",
      mismatch,
    );
    await opened.close({ reason: "contract_rejected" });
  }
});

test("collaboration spawn reserves active capacity before provider delegation", async () => {
  const collaborationCapabilities = parseAgentCapabilities({
    ...capabilities,
    collaboration: {
      kind: "supported",
      roles: ["reviewer"],
      controlActions: ["spawn", "inspect"],
      maxDepth: 2,
      maxChildrenPerNode: 1,
      maxActiveNodes: 1,
    },
  });
  const createdAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  let providerInvocations = 0;
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const validated = validateAgentProviderAdapter(
    collaborationCapabilities,
    adapter((input) => {
      const opened = session({
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn, onProviderExecutionStarted }) => {
            providerInvocations += 1;
            onProviderExecutionStarted?.();
            await providerGate;
            return {
              collaborationId: spawn.collaborationId,
              rootCollaborationId: spawn.collaborationId,
              role: spawn.role,
              title: spawn.title,
              status: "running",
              objective: spawn.objective,
              usage: { kind: "unavailable" },
              createdAt: spawn.createdAt,
              updatedAt: spawn.createdAt,
            };
          },
          controlCollaboration: async () => {
            throw new Error("control must not run");
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const collaboration = opened.collaboration;
  assert.equal(collaboration.kind, "supported");
  if (collaboration.kind !== "supported") return;

  const firstSpawn = collaboration.spawnCollaboration({
    spawn: {
      collaborationId: "collaboration:reserved" as never,
      role: "reviewer",
      title: "Reserved review",
      objective: "Hold the only active collaboration slot.",
      createdAt,
    },
  });
  assert.equal(providerInvocations, 1);
  await assert.rejects(
    async () => collaboration.spawnCollaboration({
      spawn: {
        collaborationId: "collaboration:over-capacity" as never,
        role: "reviewer",
        title: "Concurrent review",
        objective: "Attempt to exceed the active collaboration limit.",
        createdAt,
      },
    }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "input_capability_mismatch",
  );
  assert.equal(providerInvocations, 1);

  releaseProvider();
  assert.equal((await firstSpawn).collaborationId, "collaboration:reserved");
  await opened.close({ reason: "idle" });
});

test("collaboration spawn rejects terminal parents and exhausted node capacity before delegation", async () => {
  const collaborationCapabilities = parseAgentCapabilities({
    ...capabilities,
    collaboration: {
      kind: "supported",
      roles: ["reviewer"],
      controlActions: ["spawn", "inspect"],
      maxDepth: AGENT_COLLABORATION_GRAPH_LIMITS.maxDepth,
      maxChildrenPerNode:
        AGENT_COLLABORATION_GRAPH_LIMITS.maxChildrenPerNode,
      maxActiveNodes: AGENT_COLLABORATION_GRAPH_LIMITS.maxActiveNodes,
    },
  });
  const createdAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  let providerInvocations = 0;
  const validated = validateAgentProviderAdapter(
    collaborationCapabilities,
    adapter((input) => {
      const opened = session({
        collaboration: {
          kind: "supported",
          spawnCollaboration: async ({ spawn, onProviderExecutionStarted }) => {
            providerInvocations += 1;
            onProviderExecutionStarted?.();
            return {
              collaborationId: spawn.collaborationId,
              rootCollaborationId: spawn.collaborationId,
              role: spawn.role,
              title: spawn.title,
              status: "completed",
              objective: spawn.objective,
              usage: { kind: "unavailable" },
              outcome: { kind: "completed" },
              createdAt: spawn.createdAt,
              updatedAt: spawn.createdAt,
              terminalAt: spawn.createdAt,
            };
          },
          controlCollaboration: async () => {
            throw new Error("control must not run");
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const collaboration = opened.collaboration;
  assert.equal(collaboration.kind, "supported");
  if (collaboration.kind !== "supported") return;

  const rootId = "collaboration:terminal-parent" as never;
  await collaboration.spawnCollaboration({
    spawn: {
      collaborationId: rootId,
      role: "reviewer",
      title: "Completed root",
      objective: "Provide a terminal parent fixture.",
      createdAt,
    },
  });
  await assert.rejects(
    async () => collaboration.spawnCollaboration({
      spawn: {
        collaborationId: "collaboration:late-child" as never,
        parentCollaborationId: rootId,
        role: "reviewer",
        title: "Late child",
        objective: "Attempt to extend a completed collaboration.",
        createdAt,
      },
    }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "input_operation_mismatch",
  );
  assert.equal(providerInvocations, 1);

  for (
    let index = 1;
    index < AGENT_COLLABORATION_GRAPH_LIMITS.maxNodes;
    index += 1
  ) {
    await collaboration.spawnCollaboration({
      spawn: {
        collaborationId: `collaboration:terminal:${index}` as never,
        role: "reviewer",
        title: `Completed collaboration ${index}`,
        objective: "Fill the bounded collaboration graph.",
        createdAt,
      },
    });
  }
  assert.equal(
    providerInvocations,
    AGENT_COLLABORATION_GRAPH_LIMITS.maxNodes,
  );
  await assert.rejects(
    async () => collaboration.spawnCollaboration({
      spawn: {
        collaborationId: "collaboration:over-node-limit" as never,
        role: "reviewer",
        title: "Excess collaboration",
        objective: "Attempt to exceed the session graph node limit.",
        createdAt,
      },
    }),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "input_capability_mismatch",
  );
  assert.equal(
    providerInvocations,
    AGENT_COLLABORATION_GRAPH_LIMITS.maxNodes,
  );

  await opened.close({ reason: "idle" });
});

test("final_diff enforces one terminal materialization while structured diffs remain incremental", async (context) => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const finalDiffCapabilities = parseAgentCapabilities({
    ...capabilities,
    output: {
      ...capabilities.output,
      fileChanges: "final_diff",
      artifactKinds: ["diff"],
    },
  });
  const structuredDiffCapabilities = parseAgentCapabilities({
    ...capabilities,
    output: { ...capabilities.output, fileChanges: "structured" },
  });
  const finalDiffRequestCapabilities = parseAgentCapabilities({
    ...requestCapabilities,
    output: {
      ...requestCapabilities.output,
      fileChanges: "final_diff",
      artifactKinds: ["diff"],
    },
  });
  const structuredDiffRequestCapabilities = parseAgentCapabilities({
    ...requestCapabilities,
    output: {
      ...requestCapabilities.output,
      fileChanges: "structured",
    },
  });
  const finalDiffApprovalRequest = approvalRequest({
    requestId: parseAgentRequestId("request:final-diff-boundary"),
    title: "Pending operation",
  });
  const diffOutput = (turnId: AgentTurnId) =>
    createAgentEventOutput({
      ...eventBase(turnId, occurredAt),
      type: "turn.diff.updated",
      payload: { summary: "One file changed.", fileCount: 1, byteSize: 32 },
    });
  const contentOutput = (turnId: AgentTurnId) =>
    createAgentEventOutput({
      ...eventBase(turnId, occurredAt),
      type: "content.delta",
      payload: {
        itemId: parseAgentItemId("contract-final-diff-item"),
        streamKind: "assistant_text",
        delta: "Later turn content.",
      },
    });
  const completedOutput = (turnId: AgentTurnId) =>
    createAgentEventOutput({
      ...eventBase(turnId, occurredAt),
      type: "turn.completed",
      payload: { outcome: "completed" },
    });
  const scenarios: readonly Readonly<{
    name: string;
    capabilities: AgentCapabilities;
    accepted: boolean;
    outputs: (turnId: AgentTurnId) => readonly AgentProviderOutput[];
  }>[] = [
    {
      name: "single terminal diff",
      capabilities: finalDiffCapabilities,
      accepted: true,
      outputs: (turnId) => [
        contentOutput(turnId),
        diffOutput(turnId),
        createAgentEventOutput({
          ...eventBase(turnId, occurredAt),
          type: "runtime.warning",
          payload: {
            code: "artifact_materialized",
            message: "The terminal diff was materialized with a warning.",
          },
        }),
        createAgentArtifactOutput({
          descriptor: {
            artifactId: parseAgentArtifactId("contract-final-diff"),
            kind: "diff",
            displayName: "working-tree.diff",
          },
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
          delivery: "best_effort",
        }),
        completedOutput(turnId),
      ],
    },
    {
      name: "repeated final diff",
      capabilities: finalDiffCapabilities,
      accepted: false,
      outputs: (turnId) => [
        diffOutput(turnId),
        diffOutput(turnId),
        completedOutput(turnId),
      ],
    },
    {
      name: "content after final diff",
      capabilities: finalDiffCapabilities,
      accepted: false,
      outputs: (turnId) => [
        diffOutput(turnId),
        contentOutput(turnId),
        completedOutput(turnId),
      ],
    },
    {
      name: "final diff at request-waiting boundary",
      capabilities: finalDiffRequestCapabilities,
      accepted: false,
      outputs: (turnId) => [
        ...waitingForRequestOutputs({
          turnId,
          request: finalDiffApprovalRequest,
          occurredAt,
        }),
        diffOutput(turnId),
      ],
    },
    {
      name: "structured diff at request-waiting boundary",
      capabilities: structuredDiffRequestCapabilities,
      accepted: true,
      outputs: (turnId) => [
        ...waitingForRequestOutputs({
          turnId,
          request: finalDiffApprovalRequest,
          occurredAt,
        }),
        diffOutput(turnId),
      ],
    },
    {
      name: "structured incremental diffs",
      capabilities: structuredDiffCapabilities,
      accepted: true,
      outputs: (turnId) => [
        diffOutput(turnId),
        contentOutput(turnId),
        diffOutput(turnId),
        completedOutput(turnId),
      ],
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await context.test(scenario.name, async () => {
      const turnId = parseAgentTurnId(`contract-final-diff-${index}`);
      const validated = validateAgentProviderAdapter(
        scenario.capabilities,
        adapter((input) => {
          const opened = session({
            runTurn: async function* () {
              yield createAgentEventOutput({
                ...eventBase(turnId, occurredAt),
                type: "turn.started",
                payload: {},
              });
              yield* scenario.outputs(turnId);
            },
          });
          input.onBindingCreated(opened.binding);
          return opened;
        }),
      );
      const opened = await validated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      });
      const operation = collectOutputs(
        opened.runTurn({
          turnId,
          interactionMode: "default",
          parts: [{ type: "text", text: "Exercise diff sequencing." }],
        }),
      );
      if (scenario.accepted) {
        await operation;
      } else {
        await assert.rejects(
          operation,
          (error: unknown) =>
            error instanceof AgentProviderContractError &&
            error.code === "invalid_turn_sequence",
        );
      }
      await opened.close({ reason: "idle" });
    });
  }
});

test("elicitation capability admits only declared bounded field kinds", async () => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const textCapabilities = parseAgentCapabilities({
    ...capabilities,
    requests: {
      approval: { kind: "unsupported" },
      elicitation: {
        kind: "supported",
        fieldKinds: ["text"],
        maxFields: 1,
        sensitiveFields: false,
      },
    },
  });
  const structuredCapabilities = parseAgentCapabilities({
    ...capabilities,
    requests: {
      approval: { kind: "unsupported" },
      elicitation: {
        kind: "supported",
        fieldKinds: [
          "text",
          "single_select",
          "multi_select",
          "boolean",
          "confirmation",
        ],
        maxFields: 16,
        sensitiveFields: true,
      },
    },
  });
  const textRequest: AgentRequest = {
    requestKind: "elicitation",
    requestId: parseAgentRequestId("contract-text-elicitation"),
    prompt: "Provide a value.",
    fields: [
      {
        fieldId: parseAgentRequestFieldId("contract-text-field"),
        kind: "text",
        label: "Value",
        required: true,
        sensitivity: "ordinary",
        multiline: false,
        maxLength: 100,
      },
    ],
  };
  const structuredRequest: AgentRequest = {
    requestKind: "elicitation",
    requestId: parseAgentRequestId("contract-structured-elicitation"),
    prompt: "Choose a value.",
    fields: [
      {
        fieldId: parseAgentRequestFieldId("contract-choice-field"),
        kind: "single_select",
        label: "Choice",
        required: true,
        sensitivity: "ordinary",
        options: [{ value: "one", label: "One" }],
        allowOther: false,
      },
    ],
  };
  const openElicitationSession = async (
    declaredCapabilities: AgentCapabilities,
    request: AgentRequest,
  ) => {
    const validated = validateAgentProviderAdapter(
      declaredCapabilities,
      adapter((input) => {
        const opened = session({
          runTurn: async function* (turnInput) {
            yield createAgentEventOutput({
              ...eventBase(turnInput.turnId, occurredAt),
              type: "turn.started",
              payload: {},
            });
            for (const output of waitingForRequestOutputs({
              turnId: turnInput.turnId,
              request,
              occurredAt,
            })) {
              yield output;
            }
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    return validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
  };

  for (const [declaredCapabilities, request, turnName] of [
    [textCapabilities, textRequest, "text-accepted"],
    [structuredCapabilities, structuredRequest, "structured-accepted"],
  ] as const) {
    const opened = await openElicitationSession(declaredCapabilities, request);
    const outputs = await collectOutputs(
      opened.runTurn({
        turnId: parseAgentTurnId(`contract-${turnName}`),
        interactionMode: "default",
        parts: [{ type: "text", text: "Exercise elicitation." }],
      }),
    );
    assert.equal(outputs.length, 3);
    await opened.close({ reason: "idle" });
  }

  const rejected = await openElicitationSession(
    textCapabilities,
    structuredRequest,
  );
  await assert.rejects(
    collectOutputs(
      rejected.runTurn({
        turnId: parseAgentTurnId("contract-structured-rejected"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Exercise elicitation rejection." }],
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "output_capability_mismatch",
  );
  await rejected.close({ reason: "contract_rejected" });
});

test("session validation rejects unknown operation discriminants", async () => {
  for (const malformedPort of [
    { interruption: { kind: "unknown" } as never },
    { steering: { kind: "unknown" } as never },
    { configuration: { kind: "unknown" } as never },
  ]) {
    const validated = validateAgentProviderAdapter(
      capabilities,
      adapter((input) => {
        const opened = session(malformedPort);
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );

    await assert.rejects(
      async () =>
        validated.createSession({
          sessionId,
          workingDirectory: "/host/session",
          configuration,
          onBindingCreated: () => undefined,
        }),
      (error: unknown) =>
        error instanceof AgentProviderContractError &&
        error.code === "invalid_session",
    );
  }
});

test("validated sessions reject cross-session output and malformed turn ordering", async () => {
  const wrongSession = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* (turnInput) {
          yield createAgentEventOutput({
            protocolVersion: 8,
            type: "turn.started",
            sessionId: "another-session",
            turnId: turnInput.turnId,
            occurredAt: "2026-08-04T00:00:00.000Z",
            payload: {},
          });
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await wrongSession.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  await assert.rejects(
    async () => {
      for await (const _output of opened.runTurn({
        turnId: parseAgentTurnId("contract-turn"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Run." }],
      })) {
        // Consume the validated stream.
      }
    },
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "output_session_mismatch",
  );
});

test("run delegation observation follows validated prechecks and precedes the candidate port", async () => {
  const boundaries: string[] = [];
  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* (turnInput) {
          boundaries.push("candidate");
          assert.equal(turnInput.onProviderExecutionStarted, undefined);
          assert.equal(turnInput.interactionMode, "default");
          yield createAgentEventOutput({
            ...eventBase(
              turnInput.turnId,
              parseAgentIsoDateTime("2026-08-04T00:00:00.000Z"),
            ),
            type: "turn.started",
            payload: {},
          });
          yield createAgentEventOutput({
            ...eventBase(
              turnInput.turnId,
              parseAgentIsoDateTime("2026-08-04T00:00:01.000Z"),
            ),
            type: "turn.completed",
            payload: { outcome: "completed" },
          });
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const aborted = new AbortController();
  aborted.abort(new DOMException("Turn aborted.", "AbortError"));

  await assert.rejects(
    collectOutputs(opened.runTurn({
      turnId: parseAgentTurnId("contract-pre-delegation-abort"),
      interactionMode: "default",
      parts: [{ type: "text", text: "Do not delegate this turn." }],
      signal: aborted.signal,
      onProviderExecutionStarted: () => boundaries.push("delegated"),
    })),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(boundaries.length, 0);

  await assert.rejects(
    collectOutputs(opened.runTurn({
      turnId: parseAgentTurnId("contract-missing-interaction-mode"),
      parts: [{ type: "text", text: "Reject missing mode." }],
      onProviderExecutionStarted: () => boundaries.push("delegated"),
    } as unknown as Parameters<typeof opened.runTurn>[0])),
    TypeError,
  );
  assert.equal(boundaries.length, 0);

  await assert.rejects(
    collectOutputs(opened.runTurn({
      turnId: parseAgentTurnId("contract-unsupported-interaction-mode"),
      interactionMode: "plan",
      parts: [{ type: "text", text: "Reject unsupported mode." }],
      onProviderExecutionStarted: () => boundaries.push("delegated"),
    })),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "input_capability_mismatch" &&
      error.message.includes("plan turn interaction mode"),
  );
  assert.equal(boundaries.length, 0);

  await collectOutputs(opened.runTurn({
    turnId: parseAgentTurnId("contract-delegated-turn"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Delegate this turn." }],
    onProviderExecutionStarted: () => boundaries.push("delegated"),
  }));
  assert.deepEqual(boundaries, ["delegated", "candidate"]);
  await opened.close({ reason: "idle" });
});

test("an incomplete provider stream makes its validated session unusable", async () => {
  const turnId = parseAgentTurnId("contract-failed-stream-turn");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:failed-stream"),
    title: "Failed provider operation",
  });
  let closeCount = 0;
  const validated = validateAgentProviderAdapter(
    requestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          yield createAgentEventOutput({
            ...eventBase(
              turnId,
              parseAgentIsoDateTime("2026-08-04T00:00:00.000Z"),
            ),
            type: "turn.started",
            payload: {},
          });
          yield createAgentEventOutput({
            ...eventBase(
              turnId,
              parseAgentIsoDateTime("2026-08-04T00:00:01.000Z"),
            ),
            type: "item.started",
            payload: {
              itemId: request.subject.kind === "plan"
                ? parseAgentItemId("item:failed-stream-fallback")
                : request.subject.itemId,
              itemKind: "unknown",
              status: "in_progress",
            },
          });
          yield createAgentEventOutput({
            ...eventBase(
              turnId,
              parseAgentIsoDateTime("2026-08-04T00:00:01.000Z"),
            ),
            type: "request.opened",
            payload: { request },
          });
          throw new Error("provider stream failed");
        },
        close: async () => {
          closeCount += 1;
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });

  await assert.rejects(async () => {
    for await (const _output of opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Run." }],
    })) {
      // Consume through the provider failure.
    }
  }, /provider stream failed/u);
  await assert.rejects(
    async () => {
      for await (const _output of opened.runTurn({
        turnId: parseAgentTurnId("contract-after-failed-stream"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Run again." }],
      })) {
        // The unusable session must reject before delegation.
      }
    },
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
  await opened.close({ reason: "error" });
  assert.equal(closeCount, 1);
});

test("a failed close quarantines the session while close remains retryable", async () => {
  let closeCount = 0;
  let runCount = 0;
  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          runCount += 1;
        },
        close: () => {
          closeCount += 1;
          if (closeCount === 1) throw new Error("provider close failed");
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });

  await assert.rejects(
    async () => opened.close({ reason: "error" }),
    /provider close failed/u,
  );
  await assert.rejects(
    async () => {
      for await (const _output of opened.runTurn({
        turnId: parseAgentTurnId("contract-after-failed-close"),
        interactionMode: "default",
        parts: [{ type: "text", text: "Run after failed close." }],
      })) {
        // The unusable session must reject before provider delegation.
      }
    },
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
  assert.equal(runCount, 0);

  await opened.close({ reason: "error" });
  await opened.close({ reason: "error" });
  assert.equal(closeCount, 2);
});

test("run input enforces every structured image capability before provider delegation", async () => {
  const imageCapabilities = parseAgentCapabilities({
    ...capabilities,
    input: {
      text: true,
      images: {
        kind: "supported",
        sourceKinds: ["local_file"],
        mediaTypes: ["image/png", "image/jpeg"],
        maxImages: 2,
        maxBytesPerImage: 10,
        maxTotalBytes: 15,
        maxWidthPixels: 10,
        maxHeightPixels: 10,
        maxPixelsPerImage: 64,
        supportsImageOnly: false,
      },
    },
  });
  let delegated = 0;
  let observedStarted = 0;
  const baseSession = session();
  const validated = validateAgentProviderAdapter(
    imageCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* (turnInput) {
          delegated += 1;
          yield* baseSession.runTurn(turnInput);
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const localImage = {
    type: "image" as const,
    source: {
      type: "local_file" as const,
      path: "/run/agenai/input.png",
      mediaType: "image/png" as const,
      byteSize: 8,
      widthPixels: 8,
      heightPixels: 8,
      sha256: "a".repeat(64),
    },
  };
  const invalidInputs = [
    { parts: [localImage] },
    {
      parts: [
        { type: "text" as const, text: " \t " },
        localImage,
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        {
          type: "image" as const,
          source: {
            type: "url" as const,
            url: "https://example.com/image.png",
            mediaType: "image/png" as const,
            byteSize: 8,
            widthPixels: 8,
            heightPixels: 8,
          },
        },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        { ...localImage, source: { ...localImage.source, mediaType: "image/webp" as const } },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        { ...localImage, source: { ...localImage.source, byteSize: 11 } },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        localImage,
        { ...localImage, source: { ...localImage.source, path: "/run/agenai/input-2.png" } },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        { ...localImage, source: { ...localImage.source, widthPixels: 11 } },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        { ...localImage, source: { ...localImage.source, widthPixels: 9 } },
      ],
    },
    {
      parts: [
        { type: "text" as const, text: "Inspect." },
        localImage,
        { ...localImage, source: { ...localImage.source, path: "/run/agenai/input-2.png", byteSize: 1 } },
        { ...localImage, source: { ...localImage.source, path: "/run/agenai/input-3.png", byteSize: 1 } },
      ],
    },
  ] as const;

  for (const [index, invalidInput] of invalidInputs.entries()) {
    await assert.rejects(
      collectOutputs(opened.runTurn({
        turnId: parseAgentTurnId(`image-invalid:${index}`),
        interactionMode: "default",
        parts: invalidInput.parts,
        onProviderExecutionStarted: () => {
          observedStarted += 1;
        },
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError &&
        error.code === "input_capability_mismatch",
    );
  }
  assert.equal(delegated, 0);
  assert.equal(observedStarted, 0);

  const outputs = await collectOutputs(opened.runTurn({
    turnId: parseAgentTurnId("image-valid"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Inspect." }, localImage],
    onProviderExecutionStarted: () => {
      observedStarted += 1;
    },
  }));
  assert.equal(outputs.length, 2);
  assert.equal(delegated, 1);
  assert.equal(observedStarted, 1);
});

test("steering validates canonical content, capabilities, aborts, and active-turn identity", async () => {
  let delegated: AgentProviderSteerTurnInput | null = null;
  const validated = validateAgentProviderAdapter(
    steeringCapabilities,
    adapter((input) => {
      const opened = session({
        steering: {
          kind: "supported",
          steerTurn: async (steeringInput) => {
            delegated = steeringInput;
            return { status: "delivered" };
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const steering = opened.steering;
  assert.equal(steering.kind, "supported");
  if (steering.kind !== "supported") return;
  const turnId = parseAgentTurnId("contract-steering-turn");
  const iterator = opened
    .runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Run." }],
    })
    [Symbol.asyncIterator]();
  await iterator.next();

  await assert.rejects(
    Promise.resolve(
      steering.steerTurn({
        turnId,
        parts: [],
      }),
    ),
    TypeError,
  );
  assert.equal(delegated, null);

  await assert.rejects(
    Promise.resolve(
      steering.steerTurn({
        turnId,
        parts: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/image.png",
              mediaType: "image/png",
              byteSize: 128,
              widthPixels: 16,
              heightPixels: 8,
            },
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "input_capability_mismatch",
  );
  assert.equal(delegated, null);

  await assert.rejects(
    async () => steering.steerTurn({
      turnId,
      parts: Array.from({ length: 17 }, () => ({
        type: "text" as const,
        text: "x".repeat(64_000),
      })),
    }),
    TypeError,
  );
  assert.equal(delegated, null);
  assert.equal(AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT, 1_064_960);

  const aborted = new AbortController();
  aborted.abort(new DOMException("Steering aborted.", "AbortError"));
  await assert.rejects(
    async () => steering.steerTurn({
      turnId,
      parts: [{ type: "text", text: "Do not deliver this." }],
      signal: aborted.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(delegated, null);

  await assert.rejects(
    async () => steering.steerTurn({
      turnId: parseAgentTurnId("contract-another-turn"),
      parts: [{ type: "text", text: "Wrong turn." }],
    }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "active_turn_mismatch",
  );

  assert.deepEqual(
    await steering.steerTurn({
      turnId,
      parts: [{ type: "text", text: "Use Postgres instead." }],
      summary: "Change persistence",
    }),
    { status: "delivered" },
  );
  assert.deepEqual(delegated, {
    turnId,
    parts: [{ type: "text", text: "Use Postgres instead." }],
    summary: "Change persistence",
  });
  await iterator.next();
  await iterator.next();
});

test("steering preserves definitive rejection and delivery uncertainty exactly", async () => {
  const results: readonly AgentTurnSteeringResult[] = [
    {
      status: "rejected",
      error: {
        code: "provider_rejected",
        message: "The active turn no longer accepts input.",
        retryable: false,
      },
    },
    {
      status: "delivery_uncertain",
      error: {
        code: "receipt_lost",
        message: "The provider receipt was lost after dispatch.",
        retryable: false,
      },
    },
  ];

  for (const expected of results) {
    const validated = validateAgentProviderAdapter(
      steeringCapabilities,
      adapter((input) => {
        const opened = session({
          steering: {
            kind: "supported",
            steerTurn: async () => expected,
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
    const steering = opened.steering;
    assert.equal(steering.kind, "supported");
    if (steering.kind !== "supported") continue;
    const turnId = parseAgentTurnId(`contract-${expected.status}`);
    const iterator = opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Run." }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    assert.deepEqual(
      await steering.steerTurn({
        turnId,
        parts: [{ type: "text", text: "Additional input." }],
      }),
      expected,
    );
    await iterator.next();
    await iterator.next();
  }
});

test("steering rejects malformed receipts and provider-owned outputs", async () => {
  const malformedResults = [
    { status: "delivered", outputs: [] },
    { status: "delivered", error: { code: "x", message: "x", retryable: false } },
    { status: "rejected" },
    { status: "delivery_uncertain", error: { code: "", message: "x", retryable: false } },
    { status: "completed" },
  ] as const;

  for (const [index, malformed] of malformedResults.entries()) {
    const validated = validateAgentProviderAdapter(
      steeringCapabilities,
      adapter((input) => {
        const opened = session({
          steering: {
            kind: "supported",
            steerTurn: async () => malformed as never,
          },
        });
        input.onBindingCreated(opened.binding);
        return opened;
      }),
    );
    const opened = await validated.createSession({
      sessionId,
      workingDirectory: "/host/session",
      configuration,
      onBindingCreated: () => undefined,
    });
    const steering = opened.steering;
    assert.equal(steering.kind, "supported");
    if (steering.kind !== "supported") continue;
    const turnId = parseAgentTurnId(`contract-malformed-steering-${index}`);
    const iterator = opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Run." }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await assert.rejects(
      async () => steering.steerTurn({
        turnId,
        parts: [{ type: "text", text: "Steer." }],
      }),
      (error: unknown) =>
        error instanceof AgentProviderDelegatedOperationError &&
        error.operation === "steer_turn" &&
        error.providerExecution === "started" &&
        error.cause instanceof AgentProviderContractError &&
        error.cause.code === "invalid_operation_result",
    );
    await iterator.return?.();
  }
});

test("validated sessions never delegate a resolution for an unknown request", async () => {
  let delegated = false;
  const validated = validateAgentProviderAdapter(
    capabilities,
    adapter((input) => {
      const opened = session({
        resolveRequest: async function* () {
          delegated = true;
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });

  await assert.rejects(
    async () =>
      collectOutputs(
        opened.resolveRequest({
          resolution: allowOnceResolution(
            parseAgentRequestId("request:not-opened"),
          ),
        }),
      ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "request_resolution_mismatch",
  );
  assert.equal(delegated, false);
});

test("validated sessions track sequential requests from one turn", async () => {
  const turnId = parseAgentTurnId("contract-sequential-turn");
  const startedAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const continuedAt = parseAgentIsoDateTime("2026-08-04T00:00:01.000Z");
  const completedAt = parseAgentIsoDateTime("2026-08-04T00:00:02.000Z");
  const firstRequestId = parseAgentRequestId("request:first");
  const secondRequestId = parseAgentRequestId("request:second");
  const firstRequest = approvalRequest({
    requestId: firstRequestId,
    title: "First operation",
  });
  const secondRequest = approvalRequest({
    requestId: secondRequestId,
    title: "Second operation",
  });
  let delegatedSecondResolution = false;
  const validated = validateAgentProviderAdapter(
    requestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          yield createAgentEventOutput({
            ...eventBase(turnId, startedAt),
            type: "turn.started",
            payload: {},
          });
          yield* waitingForRequestOutputs({
            turnId,
            request: firstRequest,
            occurredAt: startedAt,
          });
        },
        resolveRequest: async function* ({ resolution }) {
          if (resolution.requestId === firstRequestId) {
            yield* waitingForRequestOutputs({
              turnId,
              request: secondRequest,
              occurredAt: continuedAt,
            });
            return;
          }
          delegatedSecondResolution = true;
          yield* completedTurnOutputs(turnId, completedAt);
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  for await (const _output of opened.runTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Run sequential operations." }],
  })) {
    // Consume the validated stream.
  }

  const firstOutputs = await collectOutputs(
    opened.resolveRequest({
      resolution: allowOnceResolution(firstRequestId),
    }),
  );
  const firstFinalOutput = firstOutputs.at(-1);
  assert.equal(
    firstFinalOutput?.kind === "event" ? firstFinalOutput.event.type : null,
    "turn.state_changed",
  );

  const secondOutputs = await collectOutputs(
    opened.resolveRequest({
      resolution: allowOnceResolution(secondRequestId),
    }),
  );
  const secondFinalOutput = secondOutputs.at(-1);
  assert.equal(
    secondFinalOutput?.kind === "event" ? secondFinalOutput.event.type : null,
    "turn.completed",
  );
  assert.equal(delegatedSecondResolution, true);
});

test("steering remains active while a request continuation executes", async () => {
  const turnId = parseAgentTurnId("contract-steered-continuation-turn");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:steered-continuation"),
    title: "Continuation",
  });
  let markContinuationStarted!: () => void;
  const continuationStarted = new Promise<void>((resolve) => {
    markContinuationStarted = resolve;
  });
  let releaseContinuation!: () => void;
  const continuationReleased = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  let releaseSteering!: () => void;
  const steeringReleased = new Promise<void>((resolve) => {
    releaseSteering = resolve;
  });
  let delegatedSteering: AgentProviderSteerTurnInput | null = null;
  const validated = validateAgentProviderAdapter(
    parseAgentCapabilities({
      ...requestCapabilities,
      turns: {
        interactionModes: ["default"],
        interrupt: false,
        steer: {
          kind: "supported",
          input: { text: true, images: { kind: "unsupported" } },
        },
      },
    }),
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          yield* waitingForRequestOutputs({ turnId, request, occurredAt });
        },
        resolveRequest: async function* () {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.state_changed",
            payload: { state: "running" },
          });
          markContinuationStarted();
          await continuationReleased;
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "completed" },
          });
        },
        steering: {
          kind: "supported",
          steerTurn: async (steeringInput) => {
            delegatedSteering = steeringInput;
            await steeringReleased;
            return { status: "delivered" };
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  await collectOutputs(
    opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Open a request." }],
    }),
  );

  let continuationSettled = false;
  const continuation = collectOutputs(
    opened.resolveRequest({
      resolution: allowOnceResolution(request.requestId),
    }),
  ).then((outputs) => {
    continuationSettled = true;
    return outputs;
  });
  await continuationStarted;
  assert.equal(opened.steering.kind, "supported");
  if (opened.steering.kind !== "supported") return;
  const steering = opened.steering.steerTurn({
    turnId,
    parts: [{ type: "text", text: "Also run the integration tests." }],
  });
  releaseContinuation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(continuationSettled, false);
  releaseSteering();

  assert.deepEqual(await steering, { status: "delivered" });
  assert.equal((await continuation).at(-1)?.kind, "event");
  assert.deepEqual(delegatedSteering, {
    turnId,
    parts: [{ type: "text", text: "Also run the integration tests." }],
  });
});

test("validated sessions reject request IDs reused after resolution", async () => {
  const firstTurnId = parseAgentTurnId("contract-request-reuse-first-turn");
  const secondTurnId = parseAgentTurnId("contract-request-reuse-second-turn");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:reused"),
    title: "Operation",
  });
  const validated = validateAgentProviderAdapter(
    requestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* ({ turnId }) {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          yield* waitingForRequestOutputs({ turnId, request, occurredAt });
        },
        resolveRequest: async function* () {
          yield* completedTurnOutputs(firstTurnId, occurredAt);
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });

  await collectOutputs(
    opened.runTurn({
      turnId: firstTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Run the first operation." }],
    }),
  );
  await collectOutputs(
    opened.resolveRequest({
      resolution: allowOnceResolution(request.requestId),
    }),
  );

  await assert.rejects(
    collectOutputs(
      opened.runTurn({
        turnId: secondTurnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Run the second operation." }],
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "invalid_turn_sequence",
  );
});

test("an incomplete request continuation makes its session unusable", async () => {
  const turnId = parseAgentTurnId("contract-incomplete-continuation-turn");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:incomplete-continuation"),
    title: "Incomplete continuation",
  });
  let resolutionCount = 0;
  const validated = validateAgentProviderAdapter(
    requestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          yield* waitingForRequestOutputs({ turnId, request, occurredAt });
        },
        resolveRequest: async function* () {
          resolutionCount += 1;
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  await collectOutputs(
    opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Open a request." }],
    }),
  );
  const resolution = allowOnceResolution(request.requestId);

  await assert.rejects(
    collectOutputs(opened.resolveRequest({ resolution })),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "invalid_turn_sequence",
  );
  await assert.rejects(
    collectOutputs(opened.resolveRequest({ resolution })),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
  assert.equal(resolutionCount, 1);
});

test("terminal interruptions stabilize the active turn stream", async (context) => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const scenarios: readonly Readonly<{
    name: string;
    result: (turnId: AgentTurnId) => AgentProviderOperationResult;
  }>[] = [
    {
      name: "terminal operation status",
      result: () => ({ status: "canceled" }),
    },
    {
      name: "terminal operation output",
      result: (turnId) => ({
        status: "accepted",
        outputs: [
          createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "canceled" },
          }),
        ],
      }),
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await context.test(scenario.name, async () => {
      const interruptedTurnId = parseAgentTurnId(
        `contract-active-interruption-${index}`,
      );
      const nextTurnId = parseAgentTurnId(
        `contract-after-active-interruption-${index}`,
      );
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        markStreamStarted = resolve;
      });
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let markStreamClosed!: () => void;
      const streamClosed = new Promise<void>((resolve) => {
        markStreamClosed = resolve;
      });
      let releaseInterruptionResult!: () => void;
      const interruptionResultReleased = new Promise<void>((resolve) => {
        releaseInterruptionResult = resolve;
      });
      const validated = validateAgentProviderAdapter(
        interruptibleRequestCapabilities,
        adapter((input) => {
          const opened = session({
            runTurn: async function* ({ turnId }) {
              yield createAgentEventOutput({
                ...eventBase(turnId, occurredAt),
                type: "turn.started",
                payload: {},
              });
              if (turnId === interruptedTurnId) {
                markStreamStarted();
                try {
                  await streamReleased;
                } finally {
                  markStreamClosed();
                }
                return;
              }
              yield createAgentEventOutput({
                ...eventBase(turnId, occurredAt),
                type: "turn.completed",
                payload: { outcome: "completed" },
              });
            },
            interruption: {
              kind: "supported",
              interruptTurn: async ({ turnId }) => {
                releaseStream();
                await interruptionResultReleased;
                return scenario.result(turnId);
              },
            },
          });
          input.onBindingCreated(opened.binding);
          return opened;
        }),
      );
      const opened = await validated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      });
      const activeOutputsPromise = collectOutputs(
        opened.runTurn({
          turnId: interruptedTurnId,
          interactionMode: "default",
          parts: [{ type: "text", text: "Interrupt this active turn." }],
        }),
      );
      await streamStarted;
      assert.equal(opened.interruption.kind, "supported");
      if (opened.interruption.kind !== "supported") return;

      const interruptionResultPromise = opened.interruption.interruptTurn({
        turnId: interruptedTurnId,
        reason: "user_requested",
      });
      await streamClosed;
      releaseInterruptionResult();
      const interruptionResult = await interruptionResultPromise;
      assert.equal(
        interruptionResult.status === "canceled" ||
          interruptionResult.outputs?.some(
            (output) =>
              output.kind === "event" && output.event.type === "turn.completed",
          ),
        true,
      );
      assert.equal((await activeOutputsPromise).length, 1);

      await collectOutputs(
        opened.runTurn({
          turnId: nextTurnId,
          interactionMode: "default",
          parts: [{ type: "text", text: "Continue in the same session." }],
        }),
      );
    });
  }
});

test("active interruptions reject outputs emitted after turn completion", async () => {
  const activeTurnId = parseAgentTurnId(
    "contract-active-interruption-output-order",
  );
  const nextTurnId = parseAgentTurnId(
    "contract-after-invalid-interruption-output-order",
  );
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const validated = validateAgentProviderAdapter(
    interruptibleRequestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* ({ turnId }) {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          if (turnId === activeTurnId) {
            markStreamStarted();
            await streamReleased;
            return;
          }
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "completed" },
          });
        },
        interruption: {
          kind: "supported",
          interruptTurn: async ({ turnId }) => {
            releaseStream();
            return {
              status: "accepted",
              outputs: [
                createAgentEventOutput({
                  ...eventBase(turnId, occurredAt),
                  type: "turn.completed",
                  payload: { outcome: "canceled" },
                }),
                createAgentEventOutput({
                  ...eventBase(turnId, occurredAt),
                  type: "runtime.warning",
                  payload: {
                    code: "late_warning",
                    message: "This warning followed turn completion.",
                  },
                }),
              ],
            };
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const activeOutputsPromise = collectOutputs(
    opened.runTurn({
      turnId: activeTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Interrupt this active turn." }],
    }),
  );
  await streamStarted;
  const interruption = opened.interruption;
  assert.equal(interruption.kind, "supported");
  if (interruption.kind !== "supported") return;

  await assert.rejects(
    async () =>
      interruption.interruptTurn({
        turnId: activeTurnId,
        reason: "user_requested",
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "invalid_turn_sequence",
  );
  assert.equal((await activeOutputsPromise).length, 1);
  await assert.rejects(
    collectOutputs(
      opened.runTurn({
        turnId: nextTurnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Do not reuse the invalid session." }],
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
});

test("concurrent steering settles before the original run closes and owns no outputs", async () => {
  const activeTurnId = parseAgentTurnId("contract-steering-race-turn");
  const nextTurnId = parseAgentTurnId("contract-after-steering-race-turn");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let markProviderTerminal!: () => void;
  const providerTerminal = new Promise<void>((resolve) => {
    markProviderTerminal = resolve;
  });
  let releaseSteeringResult!: () => void;
  const steeringResultReleased = new Promise<void>((resolve) => {
    releaseSteeringResult = resolve;
  });
  let steeringCallCount = 0;
  const validated = validateAgentProviderAdapter(
    steeringCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* ({ turnId }) {
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          if (turnId === activeTurnId) {
            markStreamStarted();
            await streamReleased;
            yield createAgentEventOutput({
              ...eventBase(turnId, occurredAt),
              type: "turn.completed",
              payload: { outcome: "completed" },
            });
            markProviderTerminal();
            return;
          }
          yield createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "completed" },
          });
        },
        steering: {
          kind: "supported",
          steerTurn: async () => {
            steeringCallCount += 1;
            releaseStream();
            await providerTerminal;
            await steeringResultReleased;
            return { status: "delivered" };
          },
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  const activeOutputsPromise = collectOutputs(
    opened.runTurn({
      turnId: activeTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Keep this turn active." }],
    }),
  );
  let runSettled = false;
  void activeOutputsPromise.then(() => {
    runSettled = true;
  });
  await streamStarted;
  const steering = opened.steering;
  assert.equal(steering.kind, "supported");
  if (steering.kind !== "supported") return;

  const steeringResultPromise = steering.steerTurn({
    turnId: activeTurnId,
    parts: [{ type: "text", text: "Finish with the integration tests." }],
  });
  await providerTerminal;
  assert.equal(runSettled, false);
  releaseSteeringResult();
  assert.deepEqual(await steeringResultPromise, { status: "delivered" });
  assert.equal((await activeOutputsPromise).length, 2);
  assert.equal(steeringCallCount, 1);

  await assert.rejects(
    async () => steering.steerTurn({
      turnId: activeTurnId,
      parts: [{ type: "text", text: "This turn is already terminal." }],
    }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "active_turn_mismatch",
  );
  assert.equal(steeringCallCount, 1);

  await collectOutputs(
    opened.runTurn({
      turnId: nextTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Continue in the same session." }],
    }),
  );
});

test("interrupting a waiting turn releases its pending request state", async () => {
  const waitingTurnId = parseAgentTurnId("contract-interrupted-turn");
  const nextTurnId = parseAgentTurnId("contract-next-turn");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:interrupted"),
    title: "Interrupted operation",
  });
  let runCount = 0;
  const validated = validateAgentProviderAdapter(
    interruptibleRequestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* (turnInput) {
          runCount += 1;
          yield createAgentEventOutput({
            ...eventBase(turnInput.turnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          if (turnInput.turnId === waitingTurnId) {
            yield* waitingForRequestOutputs({
              turnId: waitingTurnId,
              request,
              occurredAt,
            });
            return;
          }
          yield createAgentEventOutput({
            ...eventBase(nextTurnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "completed" },
          });
        },
        interruption: {
          kind: "supported",
          interruptTurn: async ({ turnId }) => ({
            status: "accepted",
            outputs: [
              createAgentEventOutput({
                ...eventBase(turnId, occurredAt),
                type: "turn.completed",
                payload: { outcome: "canceled" },
              }),
            ],
          }),
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });

  for await (const _output of opened.runTurn({
    turnId: waitingTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Wait for approval." }],
  })) {
    // Consume the validated stream.
  }
  assert.equal(opened.interruption.kind, "supported");
  if (opened.interruption.kind !== "supported") return;
  assert.equal(
    (
      await opened.interruption.interruptTurn({
        turnId: waitingTurnId,
        reason: "user_requested",
      })
    ).status,
    "accepted",
  );
  for await (const _output of opened.runTurn({
    turnId: nextTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Continue." }],
  })) {
    // Consume the validated stream.
  }
  assert.equal(runCount, 2);
});

test("waiting-turn interruptions reject invalid terminal output sequences", async (context) => {
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const scenarios: readonly Readonly<{
    name: string;
    result: (turnId: AgentTurnId) => AgentProviderOperationResult;
  }>[] = [
    {
      name: "event after completion",
      result: (turnId) => ({
        status: "accepted",
        outputs: [
          createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "turn.completed",
            payload: { outcome: "canceled" },
          }),
          createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "runtime.warning",
            payload: {
              code: "late_waiting_warning",
              message: "This warning followed waiting-turn completion.",
            },
          }),
        ],
      }),
    },
    {
      name: "request opened by terminal status",
      result: (turnId) => ({
        status: "canceled",
        outputs: [
          createAgentEventOutput({
            ...eventBase(turnId, occurredAt),
            type: "request.opened",
            payload: {
              request: approvalRequest({
                requestId: parseAgentRequestId(
                  "request:terminal-interruption-output",
                ),
                title: "Terminal interruption request",
              }),
            },
          }),
        ],
      }),
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await context.test(scenario.name, async () => {
      const waitingTurnId = parseAgentTurnId(
        `contract-waiting-interruption-invalid-${index}`,
      );
      const nextTurnId = parseAgentTurnId(
        `contract-after-invalid-waiting-interruption-${index}`,
      );
      const request = approvalRequest({
        requestId: parseAgentRequestId(`request:waiting-interruption-${index}`),
        title: "Waiting interruption",
      });
      let runCount = 0;
      const validated = validateAgentProviderAdapter(
        interruptibleRequestCapabilities,
        adapter((input) => {
          const opened = session({
            runTurn: async function* ({ turnId }) {
              runCount += 1;
              yield createAgentEventOutput({
                ...eventBase(turnId, occurredAt),
                type: "turn.started",
                payload: {},
              });
              yield* waitingForRequestOutputs({
                turnId,
                request,
                occurredAt,
              });
            },
            interruption: {
              kind: "supported",
              interruptTurn: async ({ turnId }) => scenario.result(turnId),
            },
          });
          input.onBindingCreated(opened.binding);
          return opened;
        }),
      );
      const opened = await validated.createSession({
        sessionId,
        workingDirectory: "/host/session",
        configuration,
        onBindingCreated: () => undefined,
      });
      await collectOutputs(
        opened.runTurn({
          turnId: waitingTurnId,
          interactionMode: "default",
          parts: [{ type: "text", text: "Wait for approval." }],
        }),
      );
      const interruption = opened.interruption;
      assert.equal(interruption.kind, "supported");
      if (interruption.kind !== "supported") return;

      await assert.rejects(
        async () =>
          interruption.interruptTurn({
            turnId: waitingTurnId,
            reason: "user_requested",
          }),
        (error: unknown) =>
          error instanceof AgentProviderContractError &&
          error.code === "invalid_turn_sequence",
      );
      await assert.rejects(
        collectOutputs(
          opened.runTurn({
            turnId: nextTurnId,
            interactionMode: "default",
            parts: [
              { type: "text", text: "Do not reuse the invalid session." },
            ],
          }),
        ),
        (error: unknown) =>
          error instanceof AgentProviderContractError &&
          error.code === "session_unusable",
      );
      assert.equal(runCount, 1);
    });
  }
});

test("an accepted waiting-turn interruption without a terminal makes the session unusable", async () => {
  const waitingTurnId = parseAgentTurnId("contract-accepted-interruption-turn");
  const nextTurnId = parseAgentTurnId("contract-after-accepted-interruption");
  const occurredAt = parseAgentIsoDateTime("2026-08-04T00:00:00.000Z");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:accepted-interruption"),
    title: "Accepted interruption",
  });
  let runCount = 0;
  let closeCount = 0;
  const validated = validateAgentProviderAdapter(
    interruptibleRequestCapabilities,
    adapter((input) => {
      const opened = session({
        runTurn: async function* () {
          runCount += 1;
          yield createAgentEventOutput({
            ...eventBase(waitingTurnId, occurredAt),
            type: "turn.started",
            payload: {},
          });
          yield* waitingForRequestOutputs({
            turnId: waitingTurnId,
            request,
            occurredAt,
          });
        },
        interruption: {
          kind: "supported",
          interruptTurn: async () => ({ status: "accepted" }),
        },
        close: async () => {
          closeCount += 1;
        },
      });
      input.onBindingCreated(opened.binding);
      return opened;
    }),
  );
  const opened = await validated.createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
  await collectOutputs(
    opened.runTurn({
      turnId: waitingTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Wait for approval." }],
    }),
  );
  assert.equal(opened.interruption.kind, "supported");
  if (opened.interruption.kind !== "supported") return;

  assert.equal(
    (
      await opened.interruption.interruptTurn({
        turnId: waitingTurnId,
        reason: "user_requested",
      })
    ).status,
    "accepted",
  );
  await assert.rejects(
    collectOutputs(
      opened.resolveRequest({
        resolution: allowOnceResolution(request.requestId),
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
  await assert.rejects(
    collectOutputs(
      opened.runTurn({
        turnId: nextTurnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Do not overlap the prior turn." }],
      }),
    ),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "session_unusable",
  );
  assert.equal(runCount, 1);
  await opened.close({ reason: "other" });
  assert.equal(closeCount, 1);
});

test("authentication validates the declared flow and opaque attempt inputs before provider delegation", async () => {
  let startCount = 0;
  let cancelCount = 0;
  const validated = validateAgentProviderAdapter(authenticationCapabilities, {
    ...adapter(() => session()),
    authentication: {
      kind: "supported",
      start: async function* (input) {
        startCount += 1;
        yield createAgentAuthenticationOutput({
          attemptId: input.attemptId,
          status: "completed",
          occurredAt: "2026-08-04T00:00:00.000Z",
        });
      },
      cancel: async () => {
        cancelCount += 1;
        return { status: "completed" };
      },
    },
  });
  assert.equal(validated.authentication.kind, "supported");
  if (validated.authentication.kind !== "supported") return;
  const authentication = validated.authentication;

  await assert.rejects(
    async () => {
      for await (const _output of authentication.start({
        attemptId: "attempt:undeclared-flow",
        flow: "terminal",
      })) {
        // Consume the validated stream.
      }
    },
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "input_capability_mismatch",
  );
  assert.equal(startCount, 0);

  await assert.rejects(async () => {
    for await (const _output of authentication.start({
      attemptId: " invalid-attempt ",
      flow: "browser",
    })) {
      // Consume the validated stream.
    }
  }, TypeError);
  assert.equal(startCount, 0);

  const outputs = [];
  for await (const output of authentication.start({
    attemptId: "attempt:valid",
    flow: "browser",
  })) {
    outputs.push(output);
  }
  assert.equal(outputs.length, 1);
  assert.equal(startCount, 1);

  await assert.rejects(async () => {
    await authentication.cancel({
      attemptId: "attempt:valid",
      reason: "invalid" as never,
    });
  }, TypeError);
  assert.equal(cancelCount, 0);
});

test("authentication output remains correlated to its requested attempt", async () => {
  const validated = validateAgentProviderAdapter(authenticationCapabilities, {
    ...adapter(() => session()),
    authentication: {
      kind: "supported",
      start: async function* () {
        yield createAgentAuthenticationOutput({
          attemptId: "attempt:other",
          status: "completed",
          occurredAt: "2026-08-04T00:00:00.000Z",
        });
      },
      cancel: async () => ({
        status: "canceled",
        outputs: [
          createAgentAuthenticationOutput({
            attemptId: "attempt:other",
            status: "canceled",
            occurredAt: "2026-08-04T00:00:00.000Z",
          }),
        ],
      }),
    },
  });
  assert.equal(validated.authentication.kind, "supported");
  if (validated.authentication.kind !== "supported") return;
  const authentication = validated.authentication;

  await assert.rejects(
    async () => {
      for await (const _output of authentication.start({
        attemptId: "attempt:expected",
        flow: "browser",
      })) {
        // Consume the validated stream.
      }
    },
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "output_authentication_attempt_mismatch",
  );
  await assert.rejects(
    async () =>
      authentication.cancel({
        attemptId: "attempt:expected",
        reason: "user_requested",
      }),
    (error: unknown) =>
      error instanceof AgentProviderContractError &&
      error.code === "output_authentication_attempt_mismatch",
  );
});
