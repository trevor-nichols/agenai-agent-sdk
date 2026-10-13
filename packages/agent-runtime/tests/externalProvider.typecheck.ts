// ------------------------------------------------------------------------------------------------
//                externalProvider.typecheck.ts - Two-package third-party provider compile proof
// ------------------------------------------------------------------------------------------------

import {
  createAgentEventOutput,
  createAgentProviderReadiness,
  defineAgentProviderDriver,
  type AgentProviderSession,
  type AgentTurnSteeringResult,
  type AgentSessionHostBinding,
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

export const externalHostBinding: AgentSessionHostBinding = {
  bindingId: "external-host-binding",
  tools: [{
    name: "external_status",
    description: "Inspect the host-authorized session.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object", properties: {}, additionalProperties: false,
    },
  }],
  invoke(input) {
    input.invocationId satisfies string;
    input.signal satisfies AbortSignal | undefined;
    return { kind: "success", value: { status: "ready" } };
  },
  release() {},
};
const capabilities = parseAgentCapabilities({
  environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
  protocolVersion: 10,
  providerKey,
  sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
  turns: {
    interactionModes: ["default"],
    interrupt: false,
    steer: {
      kind: "supported",
      input: {
        contentReferences: { kind: "unsupported" as const }, text: true, images: { kind: "unsupported" } },
    },
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
    startTurn(input) {
      return { turnId: input.turnId, async resolveRequest() { return { status: "delivered" }; }, outputs: (async function* () {
      yield createAgentEventOutput({
        protocolVersion: 10,
        type: "turn.started",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: {},
      });
      yield createAgentEventOutput({
        protocolVersion: 10,
        type: "item.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: commandItem,
      });
      yield createAgentEventOutput({
        protocolVersion: 10,
        type: "turn.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: { outcome: "completed" },
      });
    })() };
    },

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
    operations: { kind: "unsupported" },
    managedContent: { kind: "unsupported" },
    environment: { kind: "unsupported" },
    collaboration: { kind: "unsupported" },
    generatedResources: { kind: "unsupported" },
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
      environment: { kind: "unsupported" as const },
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
      accountQuota: { kind: "unsupported" },
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
  kind: "managed" as const,
  revision: parseAgentConfigurationRevisionId("external-configuration"),
};

const delivered: AgentTurnSteeringResult = { status: "delivered" };
// @ts-expect-error Steering receipts cannot transfer provider outputs.
delivered.outputs;

// @ts-expect-error Provider queue modes were deleted from the runtime SPI.
type RemovedActiveTurnInput = import("@agen-ai/agent-runtime").AgentActiveTurnInput;

void (null as unknown as RemovedActiveTurnInput);
