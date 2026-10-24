// ------------------------------------------------------------------------------------------------
//                approvalContextValidation.test.ts - Stateful refusal and context proofs
// ------------------------------------------------------------------------------------------------

import { fixtureTurn, collectToRequest, resolveAndCollectTurn } from "./fixtures/turnExecution.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentApprovalOptionId,
  parseAgentArtifactId,
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentIsoDateTime,
  parseAgentItemId,
  parseAgentProviderKey,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentApprovalConsequence,
  type AgentApprovalRequest,
  type AgentEvent,
  type AgentRequest,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  createAgentEventOutput,
  createAgentLifecycleOutput,
  validateAgentProviderAdapter,
  type AgentProviderAdapter,
  type AgentProviderOutput,
  type AgentProviderSession,
} from "../src/index.js";

// ------------------------------------------------------------------------------------------------
//                Fixtures
// ------------------------------------------------------------------------------------------------

const providerKey = parseAgentProviderKey("v8-session-validation");
const sessionId = parseAgentSessionId("v8-session-validation");
const occurredAt = parseAgentIsoDateTime("2026-08-29T15:00:00.000Z");
const allowOnceOptionId = parseAgentApprovalOptionId("approval:allow-once");
const denyOnceOptionId = parseAgentApprovalOptionId("approval:deny-once");
const configuration = {
  kind: "managed" as const,
  revision: parseAgentConfigurationRevisionId("v8-session-validation"),
};

const baseCapabilities: AgentCapabilities = parseAgentCapabilities({
  environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
  protocolVersion: 13,
  providerKey,
  sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
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

const approvalCapabilities = parseAgentCapabilities({
  ...baseCapabilities,
  requests: {
    approval: {
      kind: "supported", providerManagedRemembrance: false,
      modes: [{ persistence: "once", scopeKinds: ["exact_action"] }],
    },
    elicitation: { kind: "unsupported" },
  },
});

const planApprovalCapabilities = parseAgentCapabilities({
  ...approvalCapabilities,
  output: {
    ...approvalCapabilities.output,
    plans: true,
  },
});

const contextCapabilities = parseAgentCapabilities({
  ...baseCapabilities,
  context: {
    usage: {
      kind: "supported",
      measurementScopes: ["session", "materialization"],
      cumulativeFields: ["inputTokens", "turns"],
    },
    compaction: {
      kind: "supported",
      triggers: ["automatic", "manual"],
      sameSessionContinuation: true,
    },
  },
});

function approvalRequest(input: {
  readonly requestId: ReturnType<typeof parseAgentRequestId>;
  readonly expiresAt?: ReturnType<typeof parseAgentIsoDateTime>;
  readonly persistence?: "once" | "session";
  readonly scopeKind?: "exact_action" | "tool";
  readonly subject?: Extract<
    AgentRequest,
    { readonly requestKind: "approval" }
  >["subject"];
}): Extract<AgentRequest, { readonly requestKind: "approval" }> {
  return {
    requestKind: "approval",
    requestId: input.requestId,
    prompt: "Approve the correlated operation?",
    subject: input.subject ?? {
      kind: "tool",
      title: "Run the correlated tool",
      itemId: parseAgentItemId(`item:${input.requestId}`),
    },
    options: [
      {
        optionId: allowOnceOptionId,
        label: "Allow",
        decision: "approved",
        consequence: { kind: 'scoped', persistence: input.persistence ?? "once", scope: { kind: input.scopeKind ?? "exact_action" } },
      },
      {
        optionId: denyOnceOptionId,
        label: "Deny",
        decision: "denied",
        consequence: { kind: 'scoped', persistence: "once", scope: { kind: "exact_action" } },
      },
    ],
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
}

function event<TType extends AgentEvent["type"]>(
  turnId: AgentTurnId,
  type: TType,
  payload: Extract<AgentEvent, { readonly type: TType }>["payload"],
) {
  return createAgentEventOutput({
    protocolVersion: 13,
    sessionId,
    turnId,
    occurredAt,
    type,
    payload,
  } as Extract<AgentEvent, { readonly type: TType }>);
}

function candidateSession(
  overrides: Partial<AgentProviderSession>,
): AgentProviderSession {
  return {
    binding: { conversationId: "v8-session-validation" as never },
    startTurn: fixtureTurn(async function* ({ turnId }) {
      yield event(turnId, "turn.started", {});
      yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
    }, async function* () {}),

    interruption: { kind: "unsupported" },
    steering: { kind: "unsupported" },
    configuration: { kind: "managed" },
    operations: { kind: "unsupported" },
    managedContent: { kind: "unsupported" },
    environment: { kind: "unsupported" },
    collaboration: { kind: "unsupported" },
    generatedResources: { kind: "unsupported" },
    close: async () => undefined,
    ...overrides,
  };
}

async function openSession(
  capabilities: AgentCapabilities,
  candidate: AgentProviderSession,
): Promise<AgentProviderSession> {
  const adapter: AgentProviderAdapter = {
    createSession: (input) => {
      input.onBindingCreated(candidate.binding);
      return candidate;
    },
    resumption: { kind: "unsupported" },
    branching: { kind: "unsupported" },
    authentication: { kind: "unsupported" },
  };
  return validateAgentProviderAdapter(capabilities, adapter).createSession({
    sessionId,
    workingDirectory: "/host/session",
    configuration,
    onBindingCreated: () => undefined,
  });
}

async function collect(outputs: AsyncIterable<AgentProviderOutput>): Promise<void> {
  for await (const _output of outputs) {
    // Consume every output so validation observes the terminal boundary.
  }
}

function waitingApprovalOutputs(turnId: AgentTurnId, request: AgentRequest) {
  assert.equal(request.requestKind, "approval");
  assert.notEqual(request.subject.kind, "plan");
  if (request.requestKind !== "approval" || request.subject.kind === "plan") {
    throw new TypeError("The test fixture requires an item-correlated approval.");
  }
  return [
    event(turnId, "turn.started", {}),
    event(turnId, "item.started", {
      itemId: request.subject.itemId,
      itemKind: "dynamic_tool_call",
      status: "in_progress",
    }),
    event(turnId, "request.opened", { request }),
    event(turnId, "turn.state_changed", {
      state: "waiting_for_request",
      requestId: request.requestId,
    }),
  ] as const;
}

// ------------------------------------------------------------------------------------------------
//                Approval Refusal Boundaries
// ------------------------------------------------------------------------------------------------

const rememberedConsequence: AgentApprovalConsequence = {
  kind: "provider_managed_remembrance",
  duration: { kind: "unknown" },
  applicability: { kind: "unknown" },
  explanation: "The provider remembers this decision with unknown duration and applicability.",
};

test("checks every offered consequence before exposing an answerable approval", async () => {
  const source = approvalRequest({ requestId: parseAgentRequestId("request:remembered-refusal") });
  const remembered = { ...source, options: source.options.map((option) => ({ ...option, consequence: rememberedConsequence })) };
  const mixed = { ...source, options: [...source.options.slice(0, 1), ...remembered.options.slice(1)] };
  const rememberedOnly = parseAgentCapabilities({
    ...baseCapabilities,
    requests: { ...baseCapabilities.requests,
      approval: { kind: "supported", modes: [], providerManagedRemembrance: true } },
  });
  for (const [name, capabilities, request] of [
    ["precise-only", approvalCapabilities, mixed],
    ["remembered-only", rememberedOnly, mixed],
    ["unsupported", baseCapabilities, remembered],
  ] as const) {
    const turnId = parseAgentTurnId(`turn:remembered-refusal:${name}`);
    const answers: unknown[] = [];
    const opened = await openSession(capabilities, candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield* waitingApprovalOutputs(turnId, request);
      }, async function* (answer) { answers.push(answer.resolution); }),
    }));
    const execution = opened.startTurn({ turnId, interactionMode: "default",
      parts: [{ type: "text", text: "Reject unsupported consequences." }] });
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const visible = [await iterator.next(), await iterator.next()];
    assert.deepEqual(visible.map((entry) => !entry.done && entry.value.kind === "event" ? entry.value.event.type : null),
      ["turn.started", "item.started"]);
    await assert.rejects(iterator.next(), (error: unknown) => error instanceof AgentProviderContractError
      && error.code === "output_capability_mismatch", name);
    await assert.rejects(execution.resolveRequest({ resolution: {
      requestKind: "approval", requestId: request.requestId, disposition: "selected", optionId: allowOnceOptionId,
    } }), (error: unknown) => error instanceof AgentProviderContractError);
    assert.deepEqual(answers, [], name);
    await opened.close({ reason: "idle" });
  }
});

test("remembered approval and denial retain exact selection and the original pending reader", async () => {
  for (const selectedId of [allowOnceOptionId, denyOnceOptionId]) {
    const turnId = parseAgentTurnId(`turn:remembered:${selectedId}`);
    const source = approvalRequest({ requestId: parseAgentRequestId(`request:remembered:${selectedId}`) });
    const request: AgentApprovalRequest = { ...source, options: source.options.map((option) => ({ ...option, consequence: rememberedConsequence })) };
    const capabilities = parseAgentCapabilities({ ...baseCapabilities, requests: {
      ...baseCapabilities.requests, approval: { kind: "supported", modes: [], providerManagedRemembrance: true },
    } });
    const answers: unknown[] = [];
    let starts = 0;
    const opened = await openSession(capabilities, candidateSession({
      startTurn: fixtureTurn(async function* () {
        starts += 1;
        yield* waitingApprovalOutputs(turnId, request);
      }, async function* ({ resolution }) {
        answers.push(resolution);
        yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
      }),
    }));
    const execution = opened.startTurn({ turnId, interactionMode: "default",
      parts: [{ type: "text", text: "Choose an offered remembered consequence." }] });
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const visible = [await iterator.next(), await iterator.next(), await iterator.next(), await iterator.next()];
    const requestOutput = visible[2];
    assert.deepEqual(!requestOutput?.done && requestOutput?.value.kind === "event" ? requestOutput.value.event.payload : null,
      { request });
    const pending = iterator.next();
    const resolution = { requestKind: "approval" as const, requestId: request.requestId,
      disposition: "selected" as const, optionId: selectedId };
    assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
    assert.deepEqual(answers, [resolution]);
    await assert.rejects(execution.resolveRequest({ resolution }), (error: unknown) =>
      error instanceof AgentProviderContractError && error.code === "request_resolution_mismatch");
    const terminal = await pending;
    assert.deepEqual(!terminal.done && terminal.value.kind === "event" ? terminal.value.event.payload : null,
      { outcome: "completed", structuredOutput: { kind: "not_requested" } });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.equal(starts, 1);
    await opened.close({ reason: "idle" });
  }
});

test("refuses unoffered and expired approval choices before provider delegation", async () => {
  const scenarios = [
    {
      name: "unoffered option",
      request: approvalRequest({
        requestId: parseAgentRequestId("request:v8-unoffered"),
      }),
      resolutionOptionId: parseAgentApprovalOptionId("approval:not-offered"),
    },
    {
      name: "expired request",
      request: approvalRequest({
        requestId: parseAgentRequestId("request:v8-expired"),
        expiresAt: parseAgentIsoDateTime("2000-01-01T00:00:00.000Z"),
      }),
      resolutionOptionId: allowOnceOptionId,
    },
  ] as const;

  for (const scenario of scenarios) {
    const turnId = parseAgentTurnId(`turn:${scenario.name.replaceAll(" ", "-")}`);
    let delegatedResolutions = 0;
    const request = scenario.request;
    const opened = await openSession(
      approvalCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield* waitingApprovalOutputs(turnId, request);
        }, async function* () {
          delegatedResolutions += 1;
        }),

      }),
    );
    const execution = opened.startTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Request approval." }],
    });
await collectToRequest(execution);

    await assert.rejects(
      async () => (resolveAndCollectTurn(execution, {
        resolution: {
          requestKind: "approval",
          requestId: request.requestId,
          disposition: "selected",
          optionId: scenario.resolutionOptionId,
        },
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "request_resolution_mismatch",
    );
    assert.equal(delegatedResolutions, 0, scenario.name);
  }
});

test("admits only neutral cancellation after approval expiry", async () => {
  const turnId = parseAgentTurnId("turn:v8-expired-cancellation");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:v8-expired-cancellation"),
    expiresAt: parseAgentIsoDateTime("2000-01-01T00:00:00.000Z"),
  });
  let delegatedResolutions = 0;
  const opened = await openSession(
    approvalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield* waitingApprovalOutputs(turnId, request);
      }, async function* ({ resolution }) {
        delegatedResolutions += 1;
        assert.deepEqual(resolution, {
          requestKind: "approval",
          requestId: request.requestId,
          disposition: "canceled",
        });
        yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "canceled" });
      }),

    }),
  );
  const execution = opened.startTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Request approval." }],
  });
await collectToRequest(execution);

  await resolveAndCollectTurn(execution, {
    resolution: {
      requestKind: "approval",
      requestId: request.requestId,
      disposition: "canceled",
    },
  });
  assert.equal(delegatedResolutions, 1);
});

test("refuses uncorrelated approvals and unadvertised approval modes", async () => {
  const uncorrelatedTurnId = parseAgentTurnId("turn:v8-uncorrelated");
  const uncorrelatedRequest = approvalRequest({
    requestId: parseAgentRequestId("request:v8-uncorrelated"),
  });
  const uncorrelated = await openSession(
    approvalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(uncorrelatedTurnId, "turn.started", {});
        yield event(uncorrelatedTurnId, "request.opened", {
          request: uncorrelatedRequest,
        });
      }),
    }),
  );
  await assert.rejects(
    async () => (collect(uncorrelated.startTurn({
      turnId: uncorrelatedTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Reject missing correlation." }],
    }).outputs)),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence",
  );

  for (const request of [
    approvalRequest({
      requestId: parseAgentRequestId("request:v8-session-persistence"),
      persistence: "session",
    }),
    approvalRequest({
      requestId: parseAgentRequestId("request:v8-tool-scope"),
      scopeKind: "tool",
    }),
  ]) {
    const turnId = parseAgentTurnId(`turn:${request.requestId}`);
    const opened = await openSession(
      approvalCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield* waitingApprovalOutputs(turnId, request);
        }),
      }),
    );
    await assert.rejects(
      async () => (collect(opened.startTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject an unadvertised mode." }],
      }).outputs)),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_capability_mismatch",
    );
  }
});

test("rejects a pending plan approval when its correlation is replaced", async () => {
  const turnId = parseAgentTurnId("turn:v8-replaced-plan-correlation");
  const artifactId = parseAgentArtifactId("artifact:v8-replaced-plan-correlation");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:v8-original-plan-approval"),
    subject: {
      kind: "plan",
      title: "Approve the proposed plan",
      artifactId,
    },
  });
  const replacementRequestId = parseAgentRequestId(
    "request:v8-replacement-plan-approval",
  );
  let delegatedResolutions = 0;
  const opened = await openSession(
    planApprovalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(turnId, "turn.started", {});
        yield event(turnId, "turn.plan.proposed", {
          artifactId,
          requestId: request.requestId,
        });
        yield event(turnId, "request.opened", { request });
        yield event(turnId, "turn.plan.proposed", {
          artifactId,
          requestId: replacementRequestId,
        });
        yield event(turnId, "turn.state_changed", {
          state: "waiting_for_request",
          requestId: request.requestId,
        });
      }, async function* () {
        delegatedResolutions += 1;
      }),

    }),
  );

  await assert.rejects(
    async () => (collect(opened.startTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Reject stale plan approval authority." }],
    }).outputs)),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence"
      && error.message.includes(
        "does not identify a proposed plan from this turn",
      ),
  );
  assert.equal(delegatedResolutions, 0);
});

test("rejects terminal item revival before approval visibility", async () => {
  const scenarios = [
    {
      name: "completed-event",
      terminalEventType: "item.completed",
      terminalStatus: "completed",
    },
    {
      name: "terminal-status-update",
      terminalEventType: "item.updated",
      terminalStatus: "canceled",
    },
  ] as const;

  for (const scenario of scenarios) {
    const turnId = parseAgentTurnId(`turn:v8-${scenario.name}-revival`);
    const request = approvalRequest({
      requestId: parseAgentRequestId(`request:v8-${scenario.name}-revival`),
    });
    assert.notEqual(request.subject.kind, "plan");
    if (request.subject.kind === "plan") {
      throw new TypeError("The test fixture requires an item-correlated approval.");
    }
    const itemId = request.subject.itemId;
    let delegatedResolutions = 0;
    const opened = await openSession(
      approvalCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield event(turnId, "turn.started", {});
          yield event(turnId, scenario.terminalEventType, {
            itemId,
            itemKind: "dynamic_tool_call",
            status: scenario.terminalStatus,
          });
          yield event(turnId, "item.updated", {
            itemId,
            itemKind: "dynamic_tool_call",
            status: "in_progress",
          });
          yield event(turnId, "request.opened", { request });
          yield event(turnId, "turn.state_changed", {
            state: "waiting_for_request",
            requestId: request.requestId,
          });
        }, async function* () {
          delegatedResolutions += 1;
        }),

      }),
    );

    await assert.rejects(
      async () => (collect(opened.startTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject terminal item revival." }],
      }).outputs)),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "invalid_turn_sequence",
    );
    assert.equal(delegatedResolutions, 0);
  }
});

test("rejects approvals opened after completion with a live status", async () => {
  const turnId = parseAgentTurnId("turn:v8-completed-live-approval");
  const request = approvalRequest({
    requestId: parseAgentRequestId("request:v8-completed-live-approval"),
  });
  assert.notEqual(request.subject.kind, "plan");
  if (request.subject.kind === "plan") {
    throw new TypeError("The test fixture requires an item-correlated approval.");
  }
  const itemId = request.subject.itemId;
  const opened = await openSession(
    approvalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(turnId, "turn.started", {});
        yield event(turnId, "item.completed", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "in_progress",
        });
        yield event(turnId, "request.opened", { request });
        yield event(turnId, "turn.state_changed", {
          state: "waiting_for_request",
          requestId: request.requestId,
        });
      }),
    }),
  );

  await assert.rejects(
    async () => (collect(opened.startTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Reject a terminal approval subject." }],
    }).outputs)),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence",
  );
});

test("rejects a pending approval when its subject becomes terminal", async () => {
  const scenarios = [
    {
      name: "completed-event",
      terminalEventType: "item.completed",
      terminalStatus: "completed",
    },
    {
      name: "terminal-status-update",
      terminalEventType: "item.updated",
      terminalStatus: "canceled",
    },
    {
      name: "completed-event-live-status",
      terminalEventType: "item.completed",
      terminalStatus: "in_progress",
    },
  ] as const;

  for (const scenario of scenarios) {
    const turnId = parseAgentTurnId(`turn:v8-${scenario.name}-pending-approval`);
    const request = approvalRequest({
      requestId: parseAgentRequestId(
        `request:v8-${scenario.name}-pending-approval`,
      ),
    });
    assert.notEqual(request.subject.kind, "plan");
    if (request.subject.kind === "plan") {
      throw new TypeError("The test fixture requires an item-correlated approval.");
    }
    const itemId = request.subject.itemId;
    let delegatedResolutions = 0;
    const opened = await openSession(
      approvalCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield event(turnId, "turn.started", {});
          yield event(turnId, "item.started", {
            itemId,
            itemKind: "dynamic_tool_call",
            status: "pending",
          });
          yield event(turnId, "request.opened", { request });
          yield event(turnId, scenario.terminalEventType, {
            itemId,
            itemKind: "dynamic_tool_call",
            status: scenario.terminalStatus,
          });
          yield event(turnId, "turn.state_changed", {
            state: "waiting_for_request",
            requestId: request.requestId,
          });
        }, async function* () {
          delegatedResolutions += 1;
        }),

      }),
    );

    await assert.rejects(
      async () => (collect(opened.startTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject terminal approval subjects." }],
      }).outputs)),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "invalid_turn_sequence",
    );
    assert.equal(delegatedResolutions, 0);
  }
});

test("preserves a pending approval across an unknown item update", async () => {
  const turnId = parseAgentTurnId("turn:v8-pending-approval-unknown-update");
  const request = approvalRequest({
    requestId: parseAgentRequestId(
      "request:v8-pending-approval-unknown-update",
    ),
  });
  assert.notEqual(request.subject.kind, "plan");
  if (request.subject.kind === "plan") {
    throw new TypeError("The test fixture requires an item-correlated approval.");
  }
  const itemId = request.subject.itemId;
  const opened = await openSession(
    approvalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(turnId, "turn.started", {});
        yield event(turnId, "item.started", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "in_progress",
        });
        yield event(turnId, "request.opened", { request });
        yield event(turnId, "item.updated", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "unknown",
        });
        yield event(turnId, "turn.state_changed", {
          state: "waiting_for_request",
          requestId: request.requestId,
        });
      }),
    }),
  );

  const outputs = await collectToRequest(opened.startTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Keep the live approval correlated." }],
  }));
  const last = outputs.at(-1);
  assert.equal(last?.kind === "event" ? last.event.type : null, "turn.state_changed");
  await opened.close({ reason: "idle" });
});

test("preserves terminal item authority across request continuations", async () => {
  const turnId = parseAgentTurnId("turn:v8-continuation-item-revival");
  const firstRequest = approvalRequest({
    requestId: parseAgentRequestId("request:v8-continuation-first"),
  });
  const revivedRequest = approvalRequest({
    requestId: parseAgentRequestId("request:v8-continuation-revived"),
  });
  assert.notEqual(firstRequest.subject.kind, "plan");
  assert.notEqual(revivedRequest.subject.kind, "plan");
  if (
    firstRequest.subject.kind === "plan"
    || revivedRequest.subject.kind === "plan"
  ) {
    throw new TypeError("The test fixture requires item-correlated approvals.");
  }
  const firstItemId = firstRequest.subject.itemId;
  const revivedItemId = revivedRequest.subject.itemId;
  let delegatedResolutions = 0;
  const opened = await openSession(
    approvalCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(turnId, "turn.started", {});
        yield event(turnId, "item.completed", {
          itemId: revivedItemId,
          itemKind: "dynamic_tool_call",
          status: "completed",
        });
        yield event(turnId, "item.started", {
          itemId: firstItemId,
          itemKind: "dynamic_tool_call",
          status: "in_progress",
        });
        yield event(turnId, "request.opened", { request: firstRequest });
        yield event(turnId, "turn.state_changed", {
          state: "waiting_for_request",
          requestId: firstRequest.requestId,
        });
      }, async function* () {
        delegatedResolutions += 1;
        yield event(turnId, "item.updated", {
          itemId: revivedItemId,
          itemKind: "dynamic_tool_call",
          status: "in_progress",
        });
        yield event(turnId, "request.opened", { request: revivedRequest });
        yield event(turnId, "turn.state_changed", {
          state: "waiting_for_request",
          requestId: revivedRequest.requestId,
        });
      }),

    }),
  );

  const execution = opened.startTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Preserve item authority while waiting." }],
  });
await collectToRequest(execution);
  await assert.rejects(
    async () => (resolveAndCollectTurn(execution, {
      resolution: {
        requestKind: "approval",
        requestId: firstRequest.requestId,
        disposition: "selected",
        optionId: allowOnceOptionId,
      },
    })),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence",
  );
  assert.equal(delegatedResolutions, 1);
});

test("preserves the in-progress watermark through unknown item updates", async () => {
  const turnId = parseAgentTurnId("turn:v8-indirect-item-regression");
  const itemId = parseAgentItemId("item:v8-indirect-item-regression");
  const opened = await openSession(
    baseCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* () {
        yield event(turnId, "turn.started", {});
        yield event(turnId, "item.started", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "in_progress",
        });
        yield event(turnId, "item.updated", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "unknown",
        });
        yield event(turnId, "item.updated", {
          itemId,
          itemKind: "dynamic_tool_call",
          status: "pending",
        });
        yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
      }),
    }),
  );

  await assert.rejects(
    async () => (collect(opened.startTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Reject an indirect lifecycle regression." }],
    }).outputs)),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence",
  );
});

// ------------------------------------------------------------------------------------------------
//                Context Usage and Compaction State
// ------------------------------------------------------------------------------------------------

function contextUsage(
  turnId: AgentTurnId,
  usedTokens: number,
  inputTokens: number,
  turns: number,
) {
  return event(turnId, "context.usage.updated", {
    measurementScope: "materialization",
    usedTokens,
    maxTokens: 100,
    cumulative: { inputTokens, turns },
  });
}

function processStarted() {
  return createAgentLifecycleOutput({
    type: "process.started",
    occurredAt,
    message: "Provider materialization started.",
  });
}

test("accepts monotonic usage and one post-compaction occupancy decrease", async () => {
  const turnId = parseAgentTurnId("turn:v8-valid-compaction");
  const nextTurnId = parseAgentTurnId("turn:v8-valid-next");
  let runs = 0;
  const opened = await openSession(
    contextCapabilities,
    candidateSession({
      startTurn: fixtureTurn(async function* ({ turnId: activeTurnId }) {
        runs += 1;
        yield event(activeTurnId, "turn.started", {});
        if (activeTurnId === turnId) {
          yield contextUsage(activeTurnId, 90, 100, 1);
          yield event(activeTurnId, "item.completed", {
            itemId: parseAgentItemId("item:v8-compaction"),
            itemKind: "context_compaction",
            status: "completed",
            details: {
              trigger: "automatic",
              beforeTokens: 90,
              afterTokens: 40,
              durationMs: 25,
              summaryPreview: "Earlier context was compacted.",
            },
          });
          yield contextUsage(activeTurnId, 40, 100, 1);
        } else {
          yield contextUsage(activeTurnId, 50, 120, 2);
        }
        yield event(activeTurnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
      }),
    }),
  );

  await collect(opened.startTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Compact this context." }],
  }).outputs);
  await collect(opened.startTurn({
    turnId: nextTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Continue the same materialization." }],
  }).outputs);
  assert.equal(runs, 2);
});

test("resets only materialization usage at an observed process boundary", async () => {
  const runScenario = async (
    measurementScope: "session" | "materialization",
  ): Promise<void> => {
    const firstTurnId = parseAgentTurnId(`turn:v8-${measurementScope}-first`);
    const secondTurnId = parseAgentTurnId(`turn:v8-${measurementScope}-second`);
    const opened = await openSession(
      contextCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* ({ turnId }) {
          yield processStarted();
          yield event(turnId, "turn.started", {});
          const firstMaterialization = turnId === firstTurnId;
          yield event(turnId, "context.usage.updated", {
            measurementScope,
            usedTokens: firstMaterialization ? 80 : 20,
            maxTokens: 100,
            cumulative: {
              inputTokens: firstMaterialization ? 100 : 10,
              turns: 1,
            },
          });
          yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
        }),
      }),
    );

    await collect(opened.startTurn({
      turnId: firstTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Record the first process usage." }],
    }).outputs);
    const secondTurn = collect(opened.startTurn({
      turnId: secondTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Start a replacement process." }],
    }).outputs);
    if (measurementScope === "materialization") {
      await secondTurn;
      return;
    }
    await assert.rejects(
      secondTurn,
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "invalid_turn_sequence",
    );
  };

  await runScenario("materialization");
  await runScenario("session");
});

test("accepts unknown compaction only as a supported-provider fallback", async () => {
  const manualOnlyCapabilities = parseAgentCapabilities({
    ...baseCapabilities,
    context: {
      usage: { kind: "unsupported" },
      compaction: {
        kind: "supported",
        triggers: ["manual"],
        sameSessionContinuation: true,
      },
    },
  });
  const runCompaction = async (
    capabilities: AgentCapabilities,
    trigger: "automatic" | "unknown",
  ): Promise<void> => {
    const turnId = parseAgentTurnId(`turn:v8-${trigger}-compaction`);
    const opened = await openSession(
      capabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield event(turnId, "turn.started", {});
          yield event(turnId, "item.completed", {
            itemId: parseAgentItemId(`item:v8-${trigger}-compaction`),
            itemKind: "context_compaction",
            status: "completed",
            details: { trigger },
          });
          yield event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" });
        }),
      }),
    );
    await collect(opened.startTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Observe provider compaction." }],
    }).outputs);
  };

  await runCompaction(manualOnlyCapabilities, "unknown");
  await assert.rejects(
    async () => (runCompaction(manualOnlyCapabilities, "automatic")),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "output_capability_mismatch",
  );
  await assert.rejects(
    async () => (runCompaction(baseCapabilities, "unknown")),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "output_capability_mismatch",
  );
});

test("rejects duplicate, regressing, and post-terminal context samples", async () => {
  const scenarios: readonly {
    readonly name: string;
    readonly outputs: (turnId: AgentTurnId) => readonly AgentProviderOutput[];
  }[] = [
    {
      name: "duplicate sample",
      outputs: (turnId) => {
        const usage = contextUsage(turnId, 50, 100, 1);
        return [usage, usage];
      },
    },
    {
      name: "cumulative regression",
      outputs: (turnId) => [
        contextUsage(turnId, 50, 100, 1),
        contextUsage(turnId, 60, 99, 2),
      ],
    },
    {
      name: "cumulative regression after omitted field",
      outputs: (turnId) => [
        event(turnId, "context.usage.updated", {
          measurementScope: "materialization",
          usedTokens: 50,
          maxTokens: 100,
          cumulative: { inputTokens: 100 },
        }),
        event(turnId, "context.usage.updated", {
          measurementScope: "materialization",
          usedTokens: 60,
          maxTokens: 100,
          cumulative: { turns: 2 },
        }),
        event(turnId, "context.usage.updated", {
          measurementScope: "materialization",
          usedTokens: 70,
          maxTokens: 100,
          cumulative: { inputTokens: 99 },
        }),
      ],
    },
    {
      name: "occupancy regression without compaction",
      outputs: (turnId) => [
        contextUsage(turnId, 90, 100, 1),
        contextUsage(turnId, 40, 100, 1),
      ],
    },
    {
      name: "sample after terminal",
      outputs: (turnId) => [
        event(turnId, "turn.completed", { structuredOutput: { kind: "not_requested" }, outcome: "completed" }),
        contextUsage(turnId, 50, 100, 1),
      ],
    },
  ];

  for (const scenario of scenarios) {
    const turnId = parseAgentTurnId(`turn:${scenario.name.replaceAll(" ", "-")}`);
    const opened = await openSession(
      contextCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield event(turnId, "turn.started", {});
          yield* scenario.outputs(turnId);
        }),
      }),
    );
    await assert.rejects(
      async () => (collect(opened.startTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject invalid usage state." }],
      }).outputs)),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "invalid_turn_sequence",
      scenario.name,
    );
  }
});

test("refuses context facts outside the advertised capability", async () => {
  const limitedCapabilities = parseAgentCapabilities({
    ...baseCapabilities,
    context: {
      usage: {
        kind: "supported",
        measurementScopes: ["session"],
        cumulativeFields: ["turns"],
      },
      compaction: { kind: "unsupported" },
    },
  });
  const scenarios = [
    event(parseAgentTurnId("turn:v8-wrong-scope"), "context.usage.updated", {
      measurementScope: "materialization",
      usedTokens: 10,
      maxTokens: 100,
      cumulative: { turns: 1 },
    }),
    event(parseAgentTurnId("turn:v8-wrong-counter"), "context.usage.updated", {
      measurementScope: "session",
      usedTokens: 10,
      maxTokens: 100,
      cumulative: { inputTokens: 10 },
    }),
    event(parseAgentTurnId("turn:v8-unadvertised-compaction"), "context.usage.updated", {
      measurementScope: "session",
      usedTokens: 90,
      maxTokens: 100,
      compaction: { state: "approaching", thresholdTokens: 90 },
    }),
  ];

  for (const output of scenarios) {
    assert.equal(output.kind, "event");
    if (output.kind !== "event" || output.event.turnId === undefined) continue;
    const turnId = output.event.turnId;
    const opened = await openSession(
      limitedCapabilities,
      candidateSession({
        startTurn: fixtureTurn(async function* () {
          yield event(turnId, "turn.started", {});
          yield output;
        }),
      }),
    );
    await assert.rejects(
      async () => (collect(opened.startTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject unsupported context facts." }],
      }).outputs)),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_capability_mismatch",
    );
  }
});
