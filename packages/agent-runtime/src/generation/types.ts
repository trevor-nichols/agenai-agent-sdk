import type {
  AgentOutputDefinition, AgentRequest, AgentRequestResolution, AgentSessionId, AgentTurnId,
} from "@agen-ai/agent-protocol";

import type { MaybePromise } from "../foundation.js";
import type { ValidatedMaterializedAgentProviderInstance } from "../providerDriver.js";
import type { AgentCreateSessionInput, AgentProviderOutputObserver, AgentProviderStartTurnInput } from "../sessions.js";

export interface AgentGenerateObjectInput<T> {
  readonly instance: ValidatedMaterializedAgentProviderInstance;
  readonly session: Omit<AgentCreateSessionInput, "output" | "signal" | "onBindingCreated" | "nativeContinuations">;
  readonly turn: Omit<AgentProviderStartTurnInput, "output" | "signal" | "onProviderExecutionStarted">;
  readonly output: AgentOutputDefinition<T>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onOutput?: AgentProviderOutputObserver;
  readonly onRequest?: (request: AgentRequest, context: Readonly<{ signal: AbortSignal }>) => MaybePromise<AgentRequestResolution>;
}

export interface AgentGeneratedObject<T> {
  readonly value: T;
  readonly sessionId: AgentSessionId;
  readonly turnId: AgentTurnId;
}
