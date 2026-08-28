// ------------------------------------------------------------------------------------------------
//                providerCatalog.ts - Technical runtime catalog projections - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  parseAgentCapabilities,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import type {
  AgentProviderDriver,
  MaterializedAgentProviderInstance,
} from "./providerDriver.js";

// ------------------------------------------------------------------------------------------------
//                Catalog Contracts
// ------------------------------------------------------------------------------------------------

export interface AgentProviderCatalogEntry {
  readonly providerKey: AgentProviderKey;
  readonly supportsMultipleInstances: boolean;
}

export interface AgentProviderInstanceCatalogEntry {
  readonly instanceId: AgentInstanceId;
  readonly capabilities: AgentCapabilities;
}

// ------------------------------------------------------------------------------------------------
//                Deterministic Catalog Projection
// ------------------------------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function createAgentProviderCatalogEntries(
  drivers: Iterable<AgentProviderDriver>,
): readonly AgentProviderCatalogEntry[] {
  return Object.freeze(
    [...drivers]
      .map((driver) =>
        Object.freeze({
          providerKey: driver.providerKey,
          supportsMultipleInstances: driver.supportsMultipleInstances,
        }),
      )
      .sort((left, right) =>
        compareStrings(left.providerKey, right.providerKey),
      ),
  );
}

export function createAgentProviderInstanceCatalogEntries(
  instances: readonly MaterializedAgentProviderInstance[],
): readonly AgentProviderInstanceCatalogEntry[] {
  return Object.freeze(
    instances
      .map((instance) =>
        Object.freeze({
          instanceId: instance.instanceId,
          capabilities: parseAgentCapabilities(instance.capabilities),
        }),
      )
      .sort((left, right) => compareStrings(left.instanceId, right.instanceId)),
  );
}
