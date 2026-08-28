// ------------------------------------------------------------------------------------------------
//                providerDriver.ts - Driver and materialized-instance SPI - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  parseAgentInstanceId,
  parseAgentProviderKey,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import type { MaybePromise } from "./foundation.js";
import type { AgentProviderReadiness } from "./readiness.js";
import type { AgentProviderAdapter } from "./sessions.js";

// ------------------------------------------------------------------------------------------------
//                Instance Contracts
// ------------------------------------------------------------------------------------------------

export interface AgentProviderInstanceDefinition {
  readonly providerKey: AgentProviderKey;
  readonly instanceId: AgentInstanceId;
  readonly driverConfiguration: unknown;
}

export interface AgentProviderReadinessCheckInput {
  readonly signal?: AbortSignal;
}

export interface MaterializedAgentProviderInstance {
  readonly instanceId: AgentInstanceId;
  readonly capabilities: AgentCapabilities;
  readonly adapter: AgentProviderAdapter;
  readonly checkReadiness: (
    input?: AgentProviderReadinessCheckInput,
  ) => MaybePromise<AgentProviderReadiness>;
  readonly dispose: () => MaybePromise<void>;
}

// ------------------------------------------------------------------------------------------------
//                Driver Contracts
// ------------------------------------------------------------------------------------------------

export interface AgentProviderDriverCreateInput<Configuration> {
  readonly instanceId: AgentInstanceId;
  readonly configuration: Configuration;
}

export interface AgentProviderDriverDefinition<Configuration> {
  readonly providerKey: AgentProviderKey;
  readonly supportsMultipleInstances: boolean;
  readonly parseConfiguration: (input: unknown) => Configuration;
  readonly validateConfiguration?: (
    input: AgentProviderDriverCreateInput<Configuration>,
  ) => void;
  readonly createInstance: (
    input: AgentProviderDriverCreateInput<Configuration>,
  ) => MaybePromise<MaterializedAgentProviderInstance>;
}

export interface AgentProviderDriver {
  readonly providerKey: AgentProviderKey;
  readonly supportsMultipleInstances: boolean;
  readonly materialize: (
    definition: AgentProviderInstanceDefinition,
  ) => MaybePromise<MaterializedAgentProviderInstance>;
}

export class AgentProviderConfigurationError extends Error {
  constructor(
    readonly providerKey: AgentProviderKey,
    options?: ErrorOptions,
  ) {
    super(
      `Agent provider configuration is invalid for ${providerKey}.`,
      options,
    );
    this.name = "AgentProviderConfigurationError";
  }
}

// ------------------------------------------------------------------------------------------------
//                Driver Definition
// ------------------------------------------------------------------------------------------------

export function defineAgentProviderDriver<Configuration>(
  definition: AgentProviderDriverDefinition<Configuration>,
): AgentProviderDriver {
  const providerKey = parseAgentProviderKey(definition.providerKey);
  return Object.freeze({
    providerKey,
    supportsMultipleInstances: definition.supportsMultipleInstances,
    materialize(instanceDefinition: AgentProviderInstanceDefinition) {
      let requestedProviderKey: AgentProviderKey;
      try {
        requestedProviderKey = parseAgentProviderKey(
          instanceDefinition.providerKey,
        );
      } catch (cause) {
        throw new AgentProviderConfigurationError(providerKey, { cause });
      }
      if (requestedProviderKey !== providerKey) {
        throw new AgentProviderConfigurationError(providerKey);
      }
      let createInput: AgentProviderDriverCreateInput<Configuration>;
      try {
        createInput = {
          instanceId: parseAgentInstanceId(instanceDefinition.instanceId),
          configuration: definition.parseConfiguration(
            instanceDefinition.driverConfiguration,
          ),
        };
        definition.validateConfiguration?.(createInput);
      } catch (cause) {
        throw new AgentProviderConfigurationError(providerKey, { cause });
      }
      return definition.createInstance(createInput);
    },
  });
}
