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
} from "@agen-ai/agent-protocol";

import {
  createAgentEventOutput,
  createAgentEvidenceOutput,
  createAgentProviderEvidence,
  defineAgentProviderDriver,
  type AgentAccountQuotaPort,
  type AgentProviderSessionContext,
  type AgentSessionBranching,
  type AgentTurnSteering,
  type AgentTurnSteeringResult,
  type AgentProviderSession,
  type AgentProviderStartTurnInput,
  type AgentProviderOperationResult,
  type AgentProviderTurnInterruptionResult,
  type AgentRequestResolutionResult,
  type AgentHostToolInputSchema,
  type AgentHostToolResult,
  type AgentSessionHostBindingSupport,
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

function continuousTurnContract(session: AgentProviderSession, input: AgentProviderStartTurnInput) {
  const execution = session.startTurn(input);
  execution.turnId satisfies typeof input.turnId;
  execution.outputs satisfies AsyncIterable<unknown>;
  // @ts-expect-error The removed segmented operation has no compatibility alias.
  session.runTurn;
  // @ts-expect-error Answers belong to their exact live turn execution.
  session.resolveRequest;
  // @ts-expect-error Output ownership cannot move into a delivery receipt.
  const invalid: AgentRequestResolutionResult = { status: "delivered", outputs: execution.outputs };
  void invalid;
  // @ts-expect-error A definitive refusal must identify exact callback availability.
  const incomplete: AgentRequestResolutionResult = { status: "rejected", error: {
    category: "provider", code: "refused", message: "Refused.", recovery: { kind: "none" },
  } };
  void incomplete;
}
void continuousTurnContract;

const outputBearingOperation: AgentProviderOperationResult = { status: "completed", outputs: [] };
// @ts-expect-error Generic operation output cannot be passed through an interruption receipt.
const invalidInterruption: AgentProviderTurnInterruptionResult = outputBearingOperation;
void invalidInterruption;

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
    kind: "managed",
    revision: parseAgentConfigurationRevisionId("configuration:1"),
  },
  // @ts-expect-error Product identity is not part of the provider session context.
  teamId: 42,
};
void context;

const unsupportedBinding: AgentSessionHostBindingSupport = { kind: "unsupported" };
// @ts-expect-error Unsupported bindings do not promise instruction placements.
unsupportedBinding.instructionPlacements;

// @ts-expect-error Tool roots must explicitly select the supported schema dialect.
const missingToolDialect: AgentHostToolInputSchema = {
  type: "object", properties: {}, additionalProperties: false,
};
void missingToolDialect;

// @ts-expect-error Portable host tool results cannot contain functions.
const executableToolResult: AgentHostToolResult = { kind: "success", value: () => undefined };
void executableToolResult;

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

const unsupportedQuota: AgentAccountQuotaPort = { kind: "unsupported" };
// @ts-expect-error Unsupported quota must not expose a callable query.
unsupportedQuota.query;
// @ts-expect-error A supported quota query requires its callable method.
const missingQuotaQuery: AgentAccountQuotaPort = { kind: "query" };
void missingQuotaQuery;
// @ts-expect-error Query plus observation requires both callable methods.
const missingQuotaObserver: AgentAccountQuotaPort = { kind: "query_and_observe", query: () => { throw new Error("unused"); } };
void missingQuotaObserver;
