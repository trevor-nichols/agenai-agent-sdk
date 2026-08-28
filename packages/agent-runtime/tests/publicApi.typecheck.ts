// ------------------------------------------------------------------------------------------------
//                publicApi.typecheck.ts - Compile-time public SPI boundary proofs
// ------------------------------------------------------------------------------------------------

import {
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentProviderKey,
  parseAgentSessionId,
  type AgentInstanceId,
  type AgentSessionId,
} from "@agenai/agent-protocol";

import {
  createAgentEventOutput,
  createAgentEvidenceOutput,
  createAgentProviderEvidence,
  defineAgentProviderDriver,
  type AgentProviderSessionContext,
  type AgentSessionBranching,
  type AgentTurnSteering,
  type AgentTurnSteeringResult,
} from "../src/index.js";

const instanceId: AgentInstanceId = parseAgentInstanceId("instance:external");
const sessionId: AgentSessionId = parseAgentSessionId("session:external");

// @ts-expect-error Branded session IDs cannot select a materialized instance.
const invalidInstanceId: AgentInstanceId = sessionId;
void invalidInstanceId;

// @ts-expect-error Branded instance IDs cannot identify a provider session.
const invalidSessionId: AgentSessionId = instanceId;
void invalidSessionId;

const driver = defineAgentProviderDriver({
  providerKey: parseAgentProviderKey("typed-provider"),
  supportsMultipleInstances: true,
  parseConfiguration(input: unknown) {
    if (typeof input !== "object" || input === null)
      throw new TypeError("Invalid.");
    return { executable: "/usr/bin/provider", retries: 2 };
  },
  createInstance(input) {
    input.configuration.executable satisfies string;
    input.configuration.retries satisfies number;
    throw new Error("Type-only fixture.");
  },
});
void driver;

const unsupportedBranching: AgentSessionBranching = { kind: "unsupported" };
if (unsupportedBranching.kind === "unsupported") {
  // @ts-expect-error Unsupported branch discriminants expose no callable port.
  unsupportedBranching.branchSession;
}

const unsupportedSteering: AgentTurnSteering = { kind: "unsupported" };
if (unsupportedSteering.kind === "unsupported") {
  // @ts-expect-error Unsupported steering discriminants expose no callable port.
  unsupportedSteering.steerTurn;
}

const deliveredSteering: AgentTurnSteeringResult = { status: "delivered" };
// @ts-expect-error Steering receipts do not own provider output.
deliveredSteering.outputs;

// @ts-expect-error The active-input port was deleted by the steering hard cut.
type RemovedActiveTurnInput = import("../src/index.js").AgentActiveTurnInput;

// @ts-expect-error The provider text-only active-input shape was deleted.
type RemovedActiveTextInput = import("../src/index.js").AgentProviderActiveTextInput;

void (null as unknown as RemovedActiveTurnInput);
void (null as unknown as RemovedActiveTextInput);

const context: AgentProviderSessionContext = {
  sessionId,
  workingDirectory: "/host/session",
  configuration: {
    revision: parseAgentConfigurationRevisionId("configuration:1"),
    values: {},
  },
  // @ts-expect-error Product identity is not part of the provider session context.
  teamId: 42,
};
void context;

const providerEventEvidence = createAgentProviderEvidence({
  category: "provider_event",
  source: "native.turn.started",
  data: {},
});
const diagnosticEvidence = createAgentProviderEvidence({
  category: "diagnostic",
  source: "provider.stderr",
  data: {},
});

createAgentEventOutput({}, { evidence: providerEventEvidence });
// @ts-expect-error Diagnostic evidence cannot be attached to a provider event.
createAgentEventOutput({}, { evidence: diagnosticEvidence });
// @ts-expect-error Provider source evidence cannot be emitted as standalone evidence.
createAgentEvidenceOutput(providerEventEvidence);
