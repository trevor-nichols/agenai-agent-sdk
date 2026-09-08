// ------------------------------------------------------------------------------------------------
//                types.ts - Account quota observation port - Dependencies: protocol, runtime
// ------------------------------------------------------------------------------------------------

import type {
  AgentAccountQuotaSnapshot,
  AgentProviderKey,
} from "@agen-ai/agent-protocol";

import type { MaybePromise } from "../foundation.js";

// ------------------------------------------------------------------------------------------------
//                Observation Inputs and Port Variants
// ------------------------------------------------------------------------------------------------

export interface AgentAccountQuotaQueryInput {
  readonly signal: AbortSignal;
}

export type AgentAccountQuotaQuery = (
  input: AgentAccountQuotaQueryInput,
) => MaybePromise<AgentAccountQuotaSnapshot>;

export type AgentAccountQuotaObserve = (
  input: AgentAccountQuotaQueryInput,
) => AsyncIterable<AgentAccountQuotaSnapshot>;

export type AgentAccountQuotaPort =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "query"; query: AgentAccountQuotaQuery }>
  | Readonly<{ kind: "observe"; observe: AgentAccountQuotaObserve }>
  | Readonly<{
      kind: "query_and_observe";
      query: AgentAccountQuotaQuery;
      observe: AgentAccountQuotaObserve;
    }>;

export interface ValidateAgentAccountQuotaPortInput {
  readonly providerKey: AgentProviderKey;
  readonly port: unknown;
  readonly signal: AbortSignal;
}
