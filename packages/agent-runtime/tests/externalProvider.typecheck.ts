// ------------------------------------------------------------------------------------------------
//                externalProvider.typecheck.ts - Two-package third-party provider compile proof
// ------------------------------------------------------------------------------------------------

import {
  createAgentEventOutput,
  createAgentProviderReadiness,
  defineAgentProviderDriver,
  type AgentProviderSession,
  type AgentTurnSteeringResult,
} from "@agen-ai/agent-runtime";
import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentItemId,
  parseAgentProviderConversationId,
  parseAgentProviderKey,
  parseAgentSessionId,
  type AgentItemSnapshot,
} from "@agen-ai/agent-protocol";

const providerKey = parseAgentProviderKey("external-provider");
const capabilities = parseAgentCapabilities({
  protocolVersion: 6,
  providerKey,
  sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
  turns: {
    interactionModes: ["default"],
    interrupt: false,
    steer: {
      kind: "supported",
      input: { text: true, images: { kind: "unsupported" } },
    },
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
  versionReporting: false,
});

const commandItem: AgentItemSnapshot = {
  itemId: parseAgentItemId("external-command"),
  itemKind: "command_execution",
  status: "completed",
  details: {
    commandSummary: "Run external provider checks",
    workingPath: "workspace",
    exitCode: 0,
  },
};

export const invalidMessageItem: AgentItemSnapshot = {
  itemId: parseAgentItemId("external-invalid-message"),
  itemKind: "assistant_message",
  status: "completed",
  // @ts-expect-error Message variants cannot carry structured tool details.
  details: { actionSummary: "Cross-kind details are forbidden" },
};

function providerSession(
  sessionId = parseAgentSessionId("external-session"),
): AgentProviderSession {
  return {
    binding: {
      conversationId: parseAgentProviderConversationId("external-conversation"),
    },
    runTurn: async function* (input) {
      yield createAgentEventOutput({
        protocolVersion: 6,
        type: "turn.started",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: {},
      });
      yield createAgentEventOutput({
        protocolVersion: 6,
        type: "item.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: commandItem,
      });
      yield createAgentEventOutput({
        protocolVersion: 6,
        type: "turn.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: { outcome: "completed" },
      });
    },
    resolveRequest: async function* () {},
    interruption: { kind: "unsupported" },
    steering: {
      kind: "supported",
      steerTurn: async (input) => {
        input.turnId satisfies string;
        input.parts satisfies readonly unknown[];
        return { status: "delivered" };
      },
    },
    configuration: { kind: "managed" },
    close: async () => undefined,
  };
}

export const externalProviderDriver = defineAgentProviderDriver({
  providerKey,
  supportsMultipleInstances: true,
  parseConfiguration(input) {
    if (input === null || typeof input !== "object")
      throw new TypeError("Invalid config.");
    return { executable: "/opt/external-provider/bin/provider" };
  },
  createInstance({ instanceId }) {
    return {
      instanceId,
      capabilities,
      adapter: {
        createSession(input) {
          const session = providerSession(input.sessionId);
          input.onBindingCreated(session.binding);
          return session;
        },
        resumption: {
          kind: "supported",
          resumeSession: (input) => providerSession(input.sessionId),
        },
        branching: { kind: "unsupported" },
        authentication: { kind: "unsupported" },
      },
      checkReadiness: () =>
        createAgentProviderReadiness({
          status: "ready",
          checkedAt: "2026-08-04T00:00:00.000Z",
        }),
      dispose: async () => undefined,
    };
  },
});

export const externalProviderDefinition = {
  providerKey,
  instanceId: parseAgentInstanceId("external-instance"),
  driverConfiguration: { executable: "/opt/external-provider/bin/provider" },
};

export const externalConfiguration = {
  revision: parseAgentConfigurationRevisionId("external-configuration"),
  values: {},
};

const delivered: AgentTurnSteeringResult = { status: "delivered" };
// @ts-expect-error Steering receipts cannot transfer provider outputs.
delivered.outputs;

// @ts-expect-error Provider queue modes were deleted from the runtime SPI.
type RemovedActiveTurnInput = import("@agen-ai/agent-runtime").AgentActiveTurnInput;

void (null as unknown as RemovedActiveTurnInput);
