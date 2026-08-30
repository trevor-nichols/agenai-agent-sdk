// ------------------------------------------------------------------------------------------------
//                v7SessionValidation.test.ts - Stateful V7 refusal and context proofs
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentApprovalOptionId,
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentIsoDateTime,
  parseAgentItemId,
  parseAgentProviderKey,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentEvent,
  type AgentRequest,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentProviderAdapter,
  type AgentProviderOutput,
  type AgentProviderSession,
} from "../src/index.js";

// ------------------------------------------------------------------------------------------------
//                Fixtures
// ------------------------------------------------------------------------------------------------

const providerKey = parseAgentProviderKey("v7-session-validation");
const sessionId = parseAgentSessionId("v7-session-validation");
const occurredAt = parseAgentIsoDateTime("2026-08-29T15:00:00.000Z");
const allowOnceOptionId = parseAgentApprovalOptionId("approval:allow-once");
const denyOnceOptionId = parseAgentApprovalOptionId("approval:deny-once");
const configuration = {
  revision: parseAgentConfigurationRevisionId("v7-session-validation"),
  values: {},
};

const baseCapabilities: AgentCapabilities = parseAgentCapabilities({
  protocolVersion: 7,
  providerKey,
  sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
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
  interactionExtensions: {
    slashCommands: false,
    mcp: false,
    subagents: false,
    imageGeneration: false,
  },
  authentication: { kind: "unsupported" },
  versionReporting: false,
});

const approvalCapabilities = parseAgentCapabilities({
  ...baseCapabilities,
  requests: {
    approval: {
      kind: "supported",
      modes: [{ persistence: "once", scopeKinds: ["exact_action"] }],
    },
    elicitation: { kind: "unsupported" },
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
}): Extract<AgentRequest, { readonly requestKind: "approval" }> {
  return {
    requestKind: "approval",
    requestId: input.requestId,
    prompt: "Approve the correlated operation?",
    subject: {
      kind: "tool",
      title: "Run the correlated tool",
      itemId: parseAgentItemId(`item:${input.requestId}`),
    },
    options: [
      {
        optionId: allowOnceOptionId,
        label: "Allow",
        decision: "approved",
        persistence: input.persistence ?? "once",
        scope: { kind: input.scopeKind ?? "exact_action" },
      },
      {
        optionId: denyOnceOptionId,
        label: "Deny",
        decision: "denied",
        persistence: "once",
        scope: { kind: "exact_action" },
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
    protocolVersion: 7,
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
    binding: { conversationId: "v7-session-validation" as never },
    runTurn: async function* ({ turnId }) {
      yield event(turnId, "turn.started", {});
      yield event(turnId, "turn.completed", { outcome: "completed" });
    },
    resolveRequest: async function* () {},
    interruption: { kind: "unsupported" },
    steering: { kind: "unsupported" },
    configuration: { kind: "managed" },
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

test("V7 refuses unoffered and expired approval choices before provider delegation", async () => {
  const scenarios = [
    {
      name: "unoffered option",
      request: approvalRequest({
        requestId: parseAgentRequestId("request:v7-unoffered"),
      }),
      resolutionOptionId: parseAgentApprovalOptionId("approval:not-offered"),
    },
    {
      name: "expired request",
      request: approvalRequest({
        requestId: parseAgentRequestId("request:v7-expired"),
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
        runTurn: async function* () {
          yield* waitingApprovalOutputs(turnId, request);
        },
        resolveRequest: async function* () {
          delegatedResolutions += 1;
        },
      }),
    );
    await collect(opened.runTurn({
      turnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Request approval." }],
    }));

    await assert.rejects(
      collect(opened.resolveRequest({
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

test("V7 refuses uncorrelated approvals and unadvertised approval modes", async () => {
  const uncorrelatedTurnId = parseAgentTurnId("turn:v7-uncorrelated");
  const uncorrelatedRequest = approvalRequest({
    requestId: parseAgentRequestId("request:v7-uncorrelated"),
  });
  const uncorrelated = await openSession(
    approvalCapabilities,
    candidateSession({
      runTurn: async function* () {
        yield event(uncorrelatedTurnId, "turn.started", {});
        yield event(uncorrelatedTurnId, "request.opened", {
          request: uncorrelatedRequest,
        });
      },
    }),
  );
  await assert.rejects(
    collect(uncorrelated.runTurn({
      turnId: uncorrelatedTurnId,
      interactionMode: "default",
      parts: [{ type: "text", text: "Reject missing correlation." }],
    })),
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "invalid_turn_sequence",
  );

  for (const request of [
    approvalRequest({
      requestId: parseAgentRequestId("request:v7-session-persistence"),
      persistence: "session",
    }),
    approvalRequest({
      requestId: parseAgentRequestId("request:v7-tool-scope"),
      scopeKind: "tool",
    }),
  ]) {
    const turnId = parseAgentTurnId(`turn:${request.requestId}`);
    const opened = await openSession(
      approvalCapabilities,
      candidateSession({
        runTurn: async function* () {
          yield* waitingApprovalOutputs(turnId, request);
        },
      }),
    );
    await assert.rejects(
      collect(opened.runTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject an unadvertised mode." }],
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_capability_mismatch",
    );
  }
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

test("V7 accepts monotonic usage and one post-compaction occupancy decrease", async () => {
  const turnId = parseAgentTurnId("turn:v7-valid-compaction");
  const nextTurnId = parseAgentTurnId("turn:v7-valid-next");
  let runs = 0;
  const opened = await openSession(
    contextCapabilities,
    candidateSession({
      runTurn: async function* ({ turnId: activeTurnId }) {
        runs += 1;
        yield event(activeTurnId, "turn.started", {});
        if (activeTurnId === turnId) {
          yield contextUsage(activeTurnId, 90, 100, 1);
          yield event(activeTurnId, "item.completed", {
            itemId: parseAgentItemId("item:v7-compaction"),
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
        yield event(activeTurnId, "turn.completed", { outcome: "completed" });
      },
    }),
  );

  await collect(opened.runTurn({
    turnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Compact this context." }],
  }));
  await collect(opened.runTurn({
    turnId: nextTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Continue the same materialization." }],
  }));
  assert.equal(runs, 2);
});

test("V7 rejects duplicate, regressing, and post-terminal context samples", async () => {
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
      name: "occupancy regression without compaction",
      outputs: (turnId) => [
        contextUsage(turnId, 90, 100, 1),
        contextUsage(turnId, 40, 100, 1),
      ],
    },
    {
      name: "sample after terminal",
      outputs: (turnId) => [
        event(turnId, "turn.completed", { outcome: "completed" }),
        contextUsage(turnId, 50, 100, 1),
      ],
    },
  ];

  for (const scenario of scenarios) {
    const turnId = parseAgentTurnId(`turn:${scenario.name.replaceAll(" ", "-")}`);
    const opened = await openSession(
      contextCapabilities,
      candidateSession({
        runTurn: async function* () {
          yield event(turnId, "turn.started", {});
          yield* scenario.outputs(turnId);
        },
      }),
    );
    await assert.rejects(
      collect(opened.runTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject invalid usage state." }],
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "invalid_turn_sequence",
      scenario.name,
    );
  }
});

test("V7 refuses context facts outside the advertised capability", async () => {
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
    event(parseAgentTurnId("turn:v7-wrong-scope"), "context.usage.updated", {
      measurementScope: "materialization",
      usedTokens: 10,
      maxTokens: 100,
      cumulative: { turns: 1 },
    }),
    event(parseAgentTurnId("turn:v7-wrong-counter"), "context.usage.updated", {
      measurementScope: "session",
      usedTokens: 10,
      maxTokens: 100,
      cumulative: { inputTokens: 10 },
    }),
    event(parseAgentTurnId("turn:v7-unadvertised-compaction"), "context.usage.updated", {
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
        runTurn: async function* () {
          yield event(turnId, "turn.started", {});
          yield output;
        },
      }),
    );
    await assert.rejects(
      collect(opened.runTurn({
        turnId,
        interactionMode: "default",
        parts: [{ type: "text", text: "Reject unsupported context facts." }],
      })),
      (error: unknown) =>
        error instanceof AgentProviderContractError
        && error.code === "output_capability_mismatch",
    );
  }
});
