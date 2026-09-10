// ------------------------------------------------------------------------------------------------
//                types.ts - Scoped environment discovery and observation ports
// ------------------------------------------------------------------------------------------------

import type {
  AgentEnvironmentDomain,
  AgentEnvironmentId,
  AgentEnvironmentInvalidation,
  AgentEnvironmentSnapshot,
  AgentSessionConfiguration,
} from "@agen-ai/agent-protocol";
import type { AgentProviderExecutionStartedObserver } from "../sessions.js";

// ------------------------------------------------------------------------------------------------
//                Port Inputs
// ------------------------------------------------------------------------------------------------

/** Input supplied when a materialized instance discovers its host-scoped environment. */
export interface AgentEnvironmentDiscoveryInput {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
  readonly workingDirectory: string;
  readonly configuration: AgentSessionConfiguration;
  /** Runtime receipt invoked immediately before the provider read candidate. */
  readonly onProviderExecutionStarted?: AgentProviderExecutionStartedObserver;
}

/** Input supplied to a discovery watch. Watches have no provider-start receipt. */
export interface AgentEnvironmentDiscoveryWatchInput {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
  readonly workingDirectory: string;
  readonly configuration: AgentSessionConfiguration;
}

/** Input supplied when an opened provider session observes its bound environment. */
export interface AgentEnvironmentObservationInput {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
  /** Runtime receipt invoked immediately before the provider read candidate. */
  readonly onProviderExecutionStarted?: AgentProviderExecutionStartedObserver;
}

/** Input supplied to an observation watch. Watches have no provider-start receipt. */
export interface AgentEnvironmentObservationWatchInput {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}

export type AgentEnvironmentDiscovery = (
  input: AgentEnvironmentDiscoveryInput,
) => Promise<AgentEnvironmentSnapshot>;

export type AgentEnvironmentObservation = (
  input: AgentEnvironmentObservationInput,
) => Promise<AgentEnvironmentSnapshot>;

export type AgentEnvironmentDiscoveryWatch = (
  input: AgentEnvironmentDiscoveryWatchInput,
) => AsyncIterable<AgentEnvironmentInvalidation>;

export type AgentEnvironmentObservationWatch = (
  input: AgentEnvironmentObservationWatchInput,
) => AsyncIterable<AgentEnvironmentInvalidation>;

// ------------------------------------------------------------------------------------------------
//                Capability-Matched Ports
// ------------------------------------------------------------------------------------------------

export type AgentEnvironmentDiscoveryPort =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "read";
      domains: readonly AgentEnvironmentDomain[];
      readEnvironment: AgentEnvironmentDiscovery;
    }>
  | Readonly<{
      kind: "read_and_watch";
      domains: readonly AgentEnvironmentDomain[];
      readEnvironment: AgentEnvironmentDiscovery;
      watchEnvironment: AgentEnvironmentDiscoveryWatch;
    }>;

export type AgentEnvironmentObservationPort =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "read";
      domains: readonly AgentEnvironmentDomain[];
      readEnvironment: AgentEnvironmentObservation;
    }>
  | Readonly<{
      kind: "read_and_watch";
      domains: readonly AgentEnvironmentDomain[];
      readEnvironment: AgentEnvironmentObservation;
      watchEnvironment: AgentEnvironmentObservationWatch;
    }>;
