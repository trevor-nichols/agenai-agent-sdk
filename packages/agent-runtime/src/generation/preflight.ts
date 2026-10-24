import {
  agentProtocolSerializedJsonBytes, parseAgentOutputSchema, parseAgentSessionOpenInput, parseAgentTurnRunInput,
} from "@agen-ai/agent-protocol";

import { assertAgentSessionConfigurationSupported } from "../configurationValidation.js";
import { throwAgentProviderContractError } from "../contractErrors.js";
import { throwIfAgentOperationAborted } from "../foundation.js";
import { assertAgentTurnInputCapability } from "../sessionValidation.js";
import { AGENT_GENERATION_MAX_TIMEOUT_MS, AGENT_GENERATION_TIMEOUT_MS } from "./deadline.js";
import { AgentGenerationError } from "./errors.js";
import type { AgentGenerateObjectInput } from "./types.js";

export function preflightGeneration<T>(input: AgentGenerateObjectInput<T>) {
  throwIfAgentOperationAborted(input.signal);
  const timeoutMs = input.timeoutMs ?? AGENT_GENERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > AGENT_GENERATION_MAX_TIMEOUT_MS) {
    throw new RangeError("Object generation timeout must be a positive integer of at most one hour.");
  }
  for (const key of ["output", "signal", "onBindingCreated", "nativeContinuations"]) {
    if (Reflect.has(input.session, key)) throw new TypeError(`Object generation owns session ${key}.`);
  }
  for (const key of ["output", "signal", "onProviderExecutionStarted"]) {
    if (Reflect.has(input.turn, key)) throw new TypeError(`Object generation owns turn ${key}.`);
  }
  if (typeof input.output?.decode !== "function") throw new TypeError("Object generation requires an output decoder.");
  if (input.onOutput !== undefined && typeof input.onOutput !== "function") throw new TypeError("Object output observer must be a function.");
  if (input.onRequest !== undefined && typeof input.onRequest !== "function") throw new TypeError("Object request handler must be a function.");
  const schema = parseAgentOutputSchema(input.output.schema);
  const capability = input.instance.capabilities.turns.structuredOutput;
  if (capability.kind !== "supported") throw new AgentGenerationError("unsupported", "Provider does not support structured object generation.");
  const boundedSchema = parseAgentOutputSchema(schema, { maxOutputBytes: capability.maxOutputBytes });
  if (agentProtocolSerializedJsonBytes(boundedSchema) > capability.maxSchemaBytes) {
    throwAgentProviderContractError(input.instance.capabilities.providerKey, "invalid_structured_output", "Object schema exceeds the provider's advertised byte limit.");
  }
  const session = parseAgentSessionOpenInput({ operation: "create", sessionId: input.session.sessionId, configuration: input.session.configuration });
  assertAgentSessionConfigurationSupported(input.instance.capabilities, session.configuration);
  const turn = parseAgentTurnRunInput(input.turn);
  assertAgentTurnInputCapability({ capability: input.instance.capabilities.input, parts: turn.parts, providerKey: input.instance.capabilities.providerKey });
  if (!input.instance.capabilities.turns.interactionModes.includes(turn.interactionMode)) {
    throwAgentProviderContractError(input.instance.capabilities.providerKey, "input_capability_mismatch", "Provider does not support the requested interaction mode.");
  }
  const deadlineAt = Math.min(Date.now() + timeoutMs, turn.deadlineAt === undefined ? Infinity : Date.parse(turn.deadlineAt));
  if (deadlineAt <= Date.now()) throw new AgentGenerationError("timeout", "Object generation deadline has expired.");
  return { schema: boundedSchema, decode: input.output.decode, capability, session: { ...input.session, configuration: session.configuration }, turn, deadlineAt };
}
