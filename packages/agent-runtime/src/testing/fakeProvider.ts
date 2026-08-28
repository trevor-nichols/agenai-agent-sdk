// ------------------------------------------------------------------------------------------------
//                fakeProvider.ts - Deterministic neutral provider fixture - Dependencies: runtime
// ------------------------------------------------------------------------------------------------

import {
  parseAgentCapabilities,
  parseAgentInstanceId,
  parseAgentIsoDateTime,
  parseAgentProviderConversationId,
  parseAgentProviderHistoryAnchor,
  parseAgentProviderKey,
  parseAgentRequestId,
  parseAgentRequestResolutionFor,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentIsoDateTime,
  type AgentProviderKey,
  type AgentRequest,
  type AgentRequestResolution,
  type AgentSessionBinding,
  type AgentSessionId,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import { createAgentEventOutput } from "../outputs.js";
import {
  defineAgentProviderDriver,
  type AgentProviderDriver,
  type AgentProviderInstanceDefinition,
} from "../providerDriver.js";
import { createAgentProviderReadiness } from "../readiness.js";
import type {
  AgentProviderAdapter,
  AgentProviderOperationResult,
  AgentProviderRunTurnInput,
  AgentProviderSession,
  AgentProviderSessionContext,
  AgentProviderSteerTurnInput,
  AgentTurnSteeringResult,
} from "../sessions.js";
import { throwIfAgentOperationAborted } from "../foundation.js";

// ------------------------------------------------------------------------------------------------
//                Fixture Contracts
// ------------------------------------------------------------------------------------------------

export interface FakeAgentProviderOptions {
  readonly providerKey?: string;
  readonly instanceId?: string;
  readonly capabilities?: AgentCapabilities;
  readonly now?: () => string;
  readonly steeringResult?: AgentTurnSteeringResult;
}

export type FakeAgentSteeringInput = Readonly<
  Omit<AgentProviderSteerTurnInput, "signal">
>;

export interface FakeAgentProviderSnapshot {
  readonly materializationCount: number;
  readonly instanceDisposeCount: number;
  readonly createdSessionIds: readonly AgentSessionId[];
  readonly resumedSessionIds: readonly AgentSessionId[];
  readonly branchedSessionIds: readonly AgentSessionId[];
  readonly turnIds: readonly AgentTurnId[];
  readonly resolutions: readonly AgentRequestResolution[];
  readonly interruptedTurnIds: readonly AgentTurnId[];
  readonly steeringInputs: readonly FakeAgentSteeringInput[];
  readonly configurationRevisions: readonly string[];
  readonly closeCounts: Readonly<Record<string, number>>;
}

export interface FakeAgentProvider {
  readonly driver: AgentProviderDriver;
  readonly definition: AgentProviderInstanceDefinition;
  readonly capabilities: AgentCapabilities;
  readonly snapshot: () => FakeAgentProviderSnapshot;
}

interface MutableFakeState {
  materializationCount: number;
  instanceDisposeCount: number;
  bindingSequence: number;
  readonly createdSessionIds: AgentSessionId[];
  readonly resumedSessionIds: AgentSessionId[];
  readonly branchedSessionIds: AgentSessionId[];
  readonly turnIds: AgentTurnId[];
  readonly resolutions: AgentRequestResolution[];
  readonly interruptedTurnIds: AgentTurnId[];
  readonly steeringInputs: FakeAgentSteeringInput[];
  readonly configurationRevisions: string[];
  readonly closeCounts: Map<string, number>;
}

// ------------------------------------------------------------------------------------------------
//                Deterministic Events and Sessions
// ------------------------------------------------------------------------------------------------

function defaultCapabilities(providerKey: AgentProviderKey): AgentCapabilities {
  const input = {
    text: true,
    images: {
      kind: "supported",
      sourceKinds: ["url", "base64", "local_file"],
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
      maxImages: 6,
      maxBytesPerImage: 10 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
      maxWidthPixels: 6_000,
      maxHeightPixels: 6_000,
      maxPixelsPerImage: 36_000_000,
      supportsImageOnly: true,
    },
  } as const;
  return parseAgentCapabilities({
    protocolVersion: 6,
    providerKey,
    sessions: { create: true, resume: true, branch: { kind: "through_turn" } },
    turns: {
      interactionModes: ["default"],
      interrupt: true,
      steer: { kind: "supported", input },
    },
    requests: { approval: true, elicitation: { kind: "structured" } },
    input,
    output: {
      streaming: true,
      plans: true,
      fileChanges: "structured",
      artifactKinds: ["plan", "diff"],
    },
    configuration: {
      kind: "selectable",
      fields: [
        { key: "mode", optionIds: ["agent"] },
        {
          key: "model",
          optionIds: ["fake-model", "fake-model-2"],
        },
      ],
    },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: "unsupported" },
    versionReporting: true,
  });
}

function sessionBinding(
  state: MutableFakeState,
  sessionId: AgentSessionId,
): AgentSessionBinding {
  state.bindingSequence += 1;
  return {
    conversationId: parseAgentProviderConversationId(
      `fake-conversation:${sessionId}:${state.bindingSequence}`,
    ),
    historyAnchor: parseAgentProviderHistoryAnchor(
      `fake-history:${sessionId}:${state.bindingSequence}`,
    ),
  };
}

function eventBase(
  sessionId: AgentSessionId,
  turnId: AgentTurnId,
  occurredAt: AgentIsoDateTime,
) {
  return { protocolVersion: 6 as const, sessionId, turnId, occurredAt };
}

function requestForTurn(turnId: AgentTurnId): AgentRequest {
  return {
    requestKind: "approval",
    requestId: parseAgentRequestId(`fake-request:${turnId}`),
    prompt: "Approve the deterministic fake operation?",
    subject: { kind: "other", title: "Fake provider operation" },
  };
}

function completedResult(
  outputs: readonly ReturnType<typeof createAgentEventOutput>[] = [],
): AgentProviderOperationResult {
  return Object.freeze({
    status: "completed" as const,
    outputs: Object.freeze(outputs),
  });
}

function fakeSession(input: {
  readonly state: MutableFakeState;
  readonly capabilities: AgentCapabilities;
  readonly context: AgentProviderSessionContext;
  readonly binding: AgentSessionBinding;
  readonly now: () => AgentIsoDateTime;
  readonly steeringResult: AgentTurnSteeringResult;
}): AgentProviderSession {
  const pendingRequests = new Map<
    string,
    { request: AgentRequest; turnId: AgentTurnId }
  >();
  let closed = false;

  const runTurn = async function* (turnInput: AgentProviderRunTurnInput) {
    throwIfAgentOperationAborted(turnInput.signal);
    input.state.turnIds.push(turnInput.turnId);
    const occurredAt = input.now();
    yield createAgentEventOutput({
      ...eventBase(input.context.sessionId, turnInput.turnId, occurredAt),
      type: "turn.started",
      payload: { message: "Fake provider turn started." },
    });
    if (input.capabilities.output.streaming) {
      yield createAgentEventOutput({
        ...eventBase(input.context.sessionId, turnInput.turnId, occurredAt),
        type: "content.delta",
        payload: {
          itemId: `fake-item:${turnInput.turnId}`,
          streamKind: "assistant_text",
          delta: "Deterministic fake output.",
        },
      });
    }

    if (input.capabilities.requests.approval) {
      const request = requestForTurn(turnInput.turnId);
      pendingRequests.set(request.requestId, {
        request,
        turnId: turnInput.turnId,
      });
      yield createAgentEventOutput({
        ...eventBase(input.context.sessionId, turnInput.turnId, occurredAt),
        type: "request.opened",
        payload: { request },
      });
      yield createAgentEventOutput({
        ...eventBase(input.context.sessionId, turnInput.turnId, occurredAt),
        type: "turn.state_changed",
        payload: { state: "waiting_for_request", requestId: request.requestId },
      });
      return;
    }

    yield createAgentEventOutput({
      ...eventBase(input.context.sessionId, turnInput.turnId, occurredAt),
      type: "turn.completed",
      payload: { outcome: "completed", reason: "Fake provider completed." },
    });
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    input.state.closeCounts.set(
      input.context.sessionId,
      (input.state.closeCounts.get(input.context.sessionId) ?? 0) + 1,
    );
  };

  return {
    binding: input.binding,
    runTurn,
    resolveRequest: async function* (requestInput) {
      throwIfAgentOperationAborted(requestInput.signal);
      const pending = pendingRequests.get(requestInput.resolution.requestId);
      if (!pending)
        throw new TypeError("Fake provider has no matching pending request.");
      const resolution = parseAgentRequestResolutionFor(
        pending.request,
        requestInput.resolution,
      );
      input.state.resolutions.push(resolution);
      pendingRequests.delete(resolution.requestId);
      const occurredAt = input.now();
      yield createAgentEventOutput({
        ...eventBase(input.context.sessionId, pending.turnId, occurredAt),
        type: "turn.state_changed",
        payload: { state: "running" },
      });
      yield createAgentEventOutput({
        ...eventBase(input.context.sessionId, pending.turnId, occurredAt),
        type: "turn.completed",
        payload: { outcome: "completed", reason: "Fake request resolved." },
      });
    },
    interruption: input.capabilities.turns.interrupt
      ? {
          kind: "supported",
          interruptTurn: async (interruptionInput) => {
            throwIfAgentOperationAborted(interruptionInput.signal);
            input.state.interruptedTurnIds.push(interruptionInput.turnId);
            return completedResult([
              createAgentEventOutput({
                ...eventBase(
                  input.context.sessionId,
                  interruptionInput.turnId,
                  input.now(),
                ),
                type: "turn.completed",
                payload: {
                  outcome: "canceled",
                  reason: interruptionInput.reason,
                },
              }),
            ]);
          },
        }
      : { kind: "unsupported" },
    steering:
      input.capabilities.turns.steer.kind === "supported"
        ? {
            kind: "supported",
            steerTurn: async (steeringInput) => {
              throwIfAgentOperationAborted(steeringInput.signal);
              input.state.steeringInputs.push(
                Object.freeze({
                  turnId: steeringInput.turnId,
                  parts: Object.freeze([...steeringInput.parts]),
                  ...(steeringInput.summary === undefined
                    ? {}
                    : { summary: steeringInput.summary }),
                }),
              );
              return input.steeringResult;
            },
          }
        : { kind: "unsupported" },
    configuration:
      input.capabilities.configuration.kind === "selectable"
        ? {
            kind: "selectable",
            applyConfiguration: async (configurationInput) => {
              throwIfAgentOperationAborted(configurationInput.signal);
              input.state.configurationRevisions.push(
                configurationInput.configuration.revision,
              );
              return completedResult();
            },
          }
        : { kind: "managed" },
    close,
  };
}

function fakeAdapter(input: {
  readonly state: MutableFakeState;
  readonly capabilities: AgentCapabilities;
  readonly now: () => AgentIsoDateTime;
  readonly steeringResult: AgentTurnSteeringResult;
}): AgentProviderAdapter {
  const open = (
    context: AgentProviderSessionContext,
    binding: AgentSessionBinding,
  ): AgentProviderSession => fakeSession({ ...input, context, binding });

  return {
    createSession(createInput) {
      throwIfAgentOperationAborted(createInput.signal);
      input.state.createdSessionIds.push(createInput.sessionId);
      const binding = sessionBinding(input.state, createInput.sessionId);
      createInput.onBindingCreated(binding);
      return open(createInput, binding);
    },
    resumption: input.capabilities.sessions.resume
      ? {
          kind: "supported",
          resumeSession(resumeInput) {
            throwIfAgentOperationAborted(resumeInput.signal);
            input.state.resumedSessionIds.push(resumeInput.sessionId);
            return open(resumeInput, resumeInput.binding);
          },
        }
      : { kind: "unsupported" },
    branching:
      input.capabilities.sessions.branch.kind === "through_turn"
        ? {
            kind: "through_turn",
            branchSession(branchInput) {
              throwIfAgentOperationAborted(branchInput.signal);
              input.state.branchedSessionIds.push(branchInput.sessionId);
              const binding = sessionBinding(
                input.state,
                branchInput.sessionId,
              );
              branchInput.onBindingCreated(binding);
              return open(branchInput, binding);
            },
          }
        : { kind: "unsupported" },
    authentication:
      input.capabilities.authentication.kind === "supported"
        ? {
            kind: "supported",
            start: async function* () {
              return;
            },
            cancel: async () => completedResult(),
          }
        : { kind: "unsupported" },
  };
}

// ------------------------------------------------------------------------------------------------
//                Fixture Construction
// ------------------------------------------------------------------------------------------------

export function createFakeAgentProvider(
  options: FakeAgentProviderOptions = {},
): FakeAgentProvider {
  const providerKey = parseAgentProviderKey(
    options.providerKey ?? "fake-provider",
  );
  const instanceId = parseAgentInstanceId(
    options.instanceId ?? "fake-instance:primary",
  );
  const capabilities = parseAgentCapabilities(
    options.capabilities ?? defaultCapabilities(providerKey),
  );
  if (capabilities.providerKey !== providerKey) {
    throw new TypeError("Fake provider capabilities must match providerKey.");
  }
  const now = (): AgentIsoDateTime =>
    parseAgentIsoDateTime(options.now?.() ?? "2026-08-04T00:00:00.000Z");
  const steeringResult = options.steeringResult ??
    Object.freeze({ status: "delivered" as const });
  const state: MutableFakeState = {
    materializationCount: 0,
    instanceDisposeCount: 0,
    bindingSequence: 0,
    createdSessionIds: [],
    resumedSessionIds: [],
    branchedSessionIds: [],
    turnIds: [],
    resolutions: [],
    interruptedTurnIds: [],
    steeringInputs: [],
    configurationRevisions: [],
    closeCounts: new Map(),
  };

  const driver = defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: true,
    parseConfiguration(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("Fake driver configuration must be an object.");
      }
      return Object.freeze({ ...input });
    },
    createInstance({ instanceId: createdInstanceId }) {
      state.materializationCount += 1;
      let disposed = false;
      return {
        instanceId: createdInstanceId,
        capabilities,
        adapter: fakeAdapter({ state, capabilities, now, steeringResult }),
        checkReadiness: () =>
          createAgentProviderReadiness({
            status: "ready",
            checkedAt: now(),
            version: "1.0.0-fake",
            diagnostics: { deterministic: true },
          }),
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          state.instanceDisposeCount += 1;
        },
      };
    },
  });

  return Object.freeze({
    driver,
    definition: Object.freeze({
      providerKey,
      instanceId,
      driverConfiguration: Object.freeze({}),
    }),
    capabilities,
    snapshot: () =>
      Object.freeze({
        materializationCount: state.materializationCount,
        instanceDisposeCount: state.instanceDisposeCount,
        createdSessionIds: Object.freeze([...state.createdSessionIds]),
        resumedSessionIds: Object.freeze([...state.resumedSessionIds]),
        branchedSessionIds: Object.freeze([...state.branchedSessionIds]),
        turnIds: Object.freeze([...state.turnIds]),
        resolutions: Object.freeze([...state.resolutions]),
        interruptedTurnIds: Object.freeze([...state.interruptedTurnIds]),
        steeringInputs: Object.freeze([...state.steeringInputs]),
        configurationRevisions: Object.freeze([
          ...state.configurationRevisions,
        ]),
        closeCounts: Object.freeze(Object.fromEntries(state.closeCounts)),
      }),
  });
}

export function createFakeAgentSessionId(value: string): AgentSessionId {
  return parseAgentSessionId(value);
}

export function createFakeAgentTurnId(value: string): AgentTurnId {
  return parseAgentTurnId(value);
}

export function createFakeAgentInstanceId(value: string): AgentInstanceId {
  return parseAgentInstanceId(value);
}
