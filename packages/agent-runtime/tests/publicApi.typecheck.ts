// ------------------------------------------------------------------------------------------------
//                publicApi.typecheck.ts - Compile-time public SPI boundary proofs
// ------------------------------------------------------------------------------------------------

import {
  parseAgentConfigurationRevisionId,
  createAgentOutputDefinition,
  type AgentJsonObject,
  parseAgentInstanceId,
  parseAgentProviderKey,
  parseAgentSessionId,
  type AgentInstanceId,
  type AgentSessionId,
  type AgentStructuredOutputRequest,
  type AgentTurnInputContent,
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
  type AgentCreateSessionInput,
  type AgentResumeSessionInput,
  type AgentBranchSessionInput,
  type AgentProviderCreateSessionInput,
  type AgentProviderResumeSessionInput,
  type AgentProviderBranchSessionInput,
  type AgentProviderSteerTurnInput,
} from "../src/index.js";
import { generateObject, type AgentGenerateObjectInput } from "../src/generation/index.js";

function generatedValueInference(input: Omit<AgentGenerateObjectInput<never>, "output">) {
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } as const;
  const title = createAgentOutputDefinition(schema, (value) => typeof value.title === "string"
    ? { success: true, data: { title: value.title } }
    : { success: false, issues: [{ code: "title_required", path: ["title"], message: "A title is required." }] });
  const generated = generateObject({ ...input, output: title });
  generated.then((result) => {
    result.value.title satisfies string;
    // @ts-expect-error Decoder inference exposes only actual title fields.
    result.value.missing;
    // @ts-expect-error A title decoder cannot claim a numeric result.
    result.value.title satisfies number;
  });
  const untyped = generateObject({ ...input, output: createAgentOutputDefinition(schema) });
  untyped.then((result) => {
    result.value satisfies AgentJsonObject;
    // @ts-expect-error A schema without a real decoder cannot promise a string title.
    result.value.title satisfies string;
  });
  // @ts-expect-error Schema-only definitions cannot assert an arbitrary generic output type.
  createAgentOutputDefinition<{ title: string }>(schema);
  // @ts-expect-error The helper owns output placement and cannot accept a session-level override.
  generateObject({ ...input, session: { ...input.session, output: { kind: "json_schema", schema } }, output: title });
  // @ts-expect-error The helper cannot run schema-bound native continuations.
  generateObject({ ...input, session: { ...input.session, nativeContinuations: { onExecution() {} } }, output: title });
}
void generatedValueInference;

const instanceId: AgentInstanceId = parseAgentInstanceId("instance:external");
const sessionId: AgentSessionId = parseAgentSessionId("session:external");

// @ts-expect-error Branded session IDs cannot select a materialized instance.
const invalidInstanceId: AgentInstanceId = sessionId;
void invalidInstanceId;

// @ts-expect-error Branded instance IDs cannot identify a provider session.
const invalidSessionId: AgentSessionId = instanceId;
void invalidSessionId;

function structuredOutputPlacement(
  request: AgentStructuredOutputRequest,
  create: AgentCreateSessionInput,
  nativeCreate: AgentProviderCreateSessionInput,
  turn: AgentProviderStartTurnInput,
  resume: AgentResumeSessionInput,
  nativeResume: AgentProviderResumeSessionInput,
  branch: AgentBranchSessionInput,
  nativeBranch: AgentProviderBranchSessionInput,
) {
  ({ ...create, output: request }) satisfies AgentCreateSessionInput;
  ({ ...nativeCreate, output: request }) satisfies AgentProviderCreateSessionInput;
  ({ ...turn, output: request }) satisfies AgentProviderStartTurnInput;
  // @ts-expect-error Resume cannot restore a structured output binding.
  ({ ...resume, output: request }) satisfies AgentResumeSessionInput;
  // @ts-expect-error Native resume cannot silently restore a structured output binding.
  ({ ...nativeResume, output: request }) satisfies AgentProviderResumeSessionInput;
  // @ts-expect-error Branch cannot inherit a structured output binding.
  ({ ...branch, output: request }) satisfies AgentBranchSessionInput;
  // @ts-expect-error Native branch cannot silently inherit a structured output binding.
  ({ ...nativeBranch, output: request }) satisfies AgentProviderBranchSessionInput;
  // @ts-expect-error Steering cannot change a structured output binding.
  ({ ...turn, output: request }) satisfies AgentProviderSteerTurnInput;
  // @ts-expect-error Persistable turn content excludes structured output options.
  ({ parts: turn.parts, output: request }) satisfies AgentTurnInputContent;
}
void structuredOutputPlacement;

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
