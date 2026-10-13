// ------------------------------------------------------------------------------------------------
//                fixtures.ts - Host-certified inputs for public policy tests
// ------------------------------------------------------------------------------------------------

import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey } from "@agen-ai/agent-protocol";
import {
  parseDelegationPolicySnapshot,
  type DelegationExclusion,
  type DelegationTarget,
  type DelegationTargetCatalog,
  type DelegationUserSelection,
} from "../src/index.js";

export const providerKey = parseAgentProviderKey("example-harness");

export function makeTarget(targetId: string, overrides: Partial<DelegationTarget> = {}): DelegationTarget {
  return {
    reference: { catalogId: "catalog", catalogRevision: 1, targetId, targetRevision: 1, sourceId: "source", sourceRevision: 1 },
    instanceId: parseAgentInstanceId("instance:authorized"), providerKey,
    modelId: "model-a", label: targetId, options: [],
    reasoning: { kind: "certified", value: "max" },
    executionMode: { kind: "certified", value: "standard" },
    certification: { mappingId: "host-mapping", mappingRevision: 1 },
    availability: { kind: "available" }, limitations: [],
    application: {
      configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"), catalogRevision: 1, selections: [] },
      beforeFirstTurn: [],
    },
    ...overrides,
  };
}

export function makeCatalog(targets: readonly DelegationTarget[]): DelegationTargetCatalog {
  return { catalogId: "catalog", revision: 1, targets };
}

export function enabledPolicy(exclusions: readonly DelegationExclusion[] = [], selection?: DelegationUserSelection) {
  return parseDelegationPolicySnapshot({
    revision: 1, developer: { enabled: true, exclusions },
    user: { enabled: true, ...(selection === undefined ? {} : { selection }) },
  });
}

export function explicitSelection(...targetIds: string[]): DelegationUserSelection {
  return { kind: "explicit", targets: targetIds.map((targetId) => ({ catalogId: "catalog", targetId })) };
}
