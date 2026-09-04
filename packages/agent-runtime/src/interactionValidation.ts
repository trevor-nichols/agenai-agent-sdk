// ------------------------------------------------------------------------------------------------
//                interactionValidation.ts - Capability-bound interaction validation - Dependencies: protocol, contract errors
// ------------------------------------------------------------------------------------------------

import { isDeepStrictEqual } from "node:util";

import {
  parseAgentCollaborationNode,
  parseAgentConfigurationCatalog,
  parseAgentGeneratedResourceDescriptor,
  parseAgentIntegrationCatalog,
  parseAgentManagedContentCatalog,
  parseAgentOperationCatalog,
  parseAgentOperationResultFor,
  type AgentCapabilities,
  type AgentCollaborationNode,
  type AgentCollaborationStatus,
  type AgentConfigurationCatalog,
  type AgentGeneratedResourceDescriptor,
  type AgentIntegrationCatalog,
  type AgentManagedContentCatalog,
  type AgentOperationCatalog,
  type AgentOperationInvocation,
  type AgentOperationDescriptor,
  type AgentOperationResult,
  type AgentOperationResultStatus,
  type AgentProviderKey,
  type AgentGeneratedResourceStatus,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "./contractErrors.js";

// ------------------------------------------------------------------------------------------------
//                Catalog Validation
// ------------------------------------------------------------------------------------------------

function invalidInventory(providerKey: AgentProviderKey, message: string): never {
  return throwAgentProviderContractError(providerKey, "invalid_inventory", message);
}

export function validateAgentOperationCatalogForCapabilities(
  capabilities: AgentCapabilities,
  candidate: unknown,
): AgentOperationCatalog {
  let catalog: AgentOperationCatalog;
  try {
    catalog = parseAgentOperationCatalog(candidate);
  } catch {
    return invalidInventory(capabilities.providerKey, "Provider returned an invalid operation catalog.");
  }
  const capability = capabilities.operations;
  if (
    capability.kind !== "supported"
    || catalog.operations.length > capability.maxOperations
    || catalog.operations.some(
      (operation) =>
        !capability.operationKinds.includes(operation.kind)
        || !capability.executionModes.includes(operation.executionMode)
        || operation.fields.length > capability.maxFieldsPerOperation
        || operation.fields.some(
          (field) => !capability.fieldKinds.includes(field.fieldKind),
        ),
    )
  ) {
    return invalidInventory(
      capabilities.providerKey,
      "Operation catalog exceeds the provider's declared capability.",
    );
  }
  return catalog;
}

export function validateAgentManagedContentCatalogForCapabilities(
  capabilities: AgentCapabilities,
  candidate: unknown,
): AgentManagedContentCatalog {
  let catalog: AgentManagedContentCatalog;
  try {
    catalog = parseAgentManagedContentCatalog(candidate);
  } catch {
    return invalidInventory(capabilities.providerKey, "Provider returned an invalid managed-content catalog.");
  }
  const capability = capabilities.managedContent;
  if (
    capability.kind !== "supported"
    || catalog.entries.length > capability.maxEntries
    || catalog.entries.some(
      (entry) => !capability.contentKinds.includes(entry.kind),
    )
  ) {
    return invalidInventory(
      capabilities.providerKey,
      "Managed-content catalog exceeds the provider's declared capability.",
    );
  }
  return catalog;
}

export function validateAgentConfigurationCatalogForCapabilities(
  capabilities: AgentCapabilities,
  candidate: unknown,
): AgentConfigurationCatalog {
  let catalog: AgentConfigurationCatalog;
  try {
    catalog = parseAgentConfigurationCatalog(candidate);
  } catch {
    return invalidInventory(capabilities.providerKey, "Provider returned an invalid configuration catalog.");
  }
  const capability = capabilities.configuration;
  if (
    capability.kind !== "selectable"
    || catalog.fields.length > capability.maxFields
    || catalog.fields.some(
      (field) => !capability.fieldKinds.includes(field.fieldKind),
    )
  ) {
    return invalidInventory(
      capabilities.providerKey,
      "Configuration catalog exceeds the provider's declared capability.",
    );
  }
  return catalog;
}

export function validateAgentIntegrationCatalogForCapabilities(
  capabilities: AgentCapabilities,
  candidate: unknown,
): AgentIntegrationCatalog {
  let catalog: AgentIntegrationCatalog;
  try {
    catalog = parseAgentIntegrationCatalog(candidate);
  } catch {
    return invalidInventory(capabilities.providerKey, "Provider returned an invalid integration catalog.");
  }
  const capability = capabilities.integrations;
  if (
    capability.kind !== "supported"
    || catalog.integrations.length > capability.maxIntegrations
    || catalog.integrations.some(
      (integration) =>
        !capability.integrationKinds.includes(integration.kind)
        || integration.servers.length
          > capability.maxServersPerIntegration
        || integration.servers.some(
          (server) =>
            server.tools.length > capability.maxToolsPerServer
            || server.resources.length
              > capability.maxResourcesPerServer,
        ),
    )
  ) {
    return invalidInventory(
      capabilities.providerKey,
      "Integration catalog exceeds the provider's declared capability.",
    );
  }
  return catalog;
}

// ------------------------------------------------------------------------------------------------
//                Operation, Collaboration, and Resource Validation
// ------------------------------------------------------------------------------------------------

export function validateAgentOperationResultForInvocation(
  providerKey: AgentProviderKey,
  descriptor: AgentOperationDescriptor,
  invocation: AgentOperationInvocation,
  candidate: unknown,
): AgentOperationResult {
  try {
    return parseAgentOperationResultFor(descriptor, invocation, candidate);
  } catch {
    return throwAgentProviderContractError(
      providerKey,
      "invalid_operation_result",
      "Provider returned an invalid or uncorrelated operation result.",
    );
  }
}

const OPERATION_RESULT_TRANSITIONS: Readonly<
  Record<AgentOperationResultStatus, readonly AgentOperationResultStatus[]>
> = {
  accepted: ["accepted", "waiting_for_request", "completed", "failed", "canceled"],
  waiting_for_request: ["waiting_for_request", "accepted", "completed", "failed", "canceled"],
  completed: ["completed"],
  failed: ["failed"],
  canceled: ["canceled"],
};

export function validateAgentOperationResultTransition(input: {
  readonly providerKey: AgentProviderKey;
  readonly candidate: AgentOperationResult;
  readonly previous?: AgentOperationResult;
}): AgentOperationResult {
  if (
    input.previous !== undefined
    && !OPERATION_RESULT_TRANSITIONS[input.previous.status].includes(
      input.candidate.status,
    )
  ) {
    return throwAgentProviderContractError(
      input.providerKey,
      "invalid_operation_result",
      "Provider returned an invalid operation lifecycle transition.",
    );
  }
  if (
    input.previous !== undefined
    && ["completed", "failed", "canceled"].includes(input.previous.status)
    && JSON.stringify(input.previous) !== JSON.stringify(input.candidate)
  ) {
    return throwAgentProviderContractError(
      input.providerKey,
      "invalid_operation_result",
      "Provider changed a terminal operation result.",
    );
  }
  return input.candidate;
}

const COLLABORATION_TRANSITIONS: Readonly<
  Record<AgentCollaborationStatus, readonly AgentCollaborationStatus[]>
> = {
  queued: ["queued", "starting", "running", "waiting", "completed", "failed", "canceled"],
  starting: ["starting", "running", "waiting", "completed", "failed", "canceled"],
  running: ["running", "waiting", "completed", "failed", "canceled"],
  waiting: ["waiting", "running", "completed", "failed", "canceled"],
  completed: ["completed"],
  failed: ["failed"],
  canceled: ["canceled"],
};

function collaborationUsageIsMonotonic(
  previous: AgentCollaborationNode["usage"],
  next: AgentCollaborationNode["usage"],
): boolean {
  if (previous.kind === "unavailable") return true;
  if (next.kind === "unavailable") return false;
  const fields = [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "modelCalls",
  ] as const;
  return fields.every((field) =>
    previous[field] === undefined
    || (next[field] !== undefined && next[field] >= previous[field]),
  );
}

export function validateAgentCollaborationNodeForCapabilities(input: {
  readonly capabilities: AgentCapabilities;
  readonly candidate: unknown;
  readonly previous?: AgentCollaborationNode;
}): AgentCollaborationNode {
  let node: AgentCollaborationNode;
  try {
    node = parseAgentCollaborationNode(input.candidate);
  } catch {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "output_collaboration_mismatch",
      "Provider returned an invalid collaboration node.",
    );
  }
  const capability = input.capabilities.collaboration;
  if (capability.kind !== "supported" || !capability.roles.includes(node.role)) {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "output_capability_mismatch",
      "Provider returned collaboration state outside its declared capability.",
    );
  }
  if (
    input.previous !== undefined
    && !COLLABORATION_TRANSITIONS[input.previous.status].includes(node.status)
  ) {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "invalid_collaboration_transition",
      "Provider returned an invalid collaboration lifecycle transition.",
    );
  }
  if (
    input.previous !== undefined
    && Date.parse(node.updatedAt) === Date.parse(input.previous.updatedAt)
    && !isDeepStrictEqual(node, input.previous)
  ) {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "invalid_collaboration_transition",
      "Provider changed collaboration state without advancing its observation timestamp.",
    );
  }
  if (
    input.previous !== undefined
    && (
      node.collaborationId !== input.previous.collaborationId
      || node.rootCollaborationId !== input.previous.rootCollaborationId
      || node.parentCollaborationId !== input.previous.parentCollaborationId
      || node.role !== input.previous.role
      || node.title !== input.previous.title
      || node.objective !== input.previous.objective
      || node.createdAt !== input.previous.createdAt
      || Date.parse(node.updatedAt) < Date.parse(input.previous.updatedAt)
      || !collaborationUsageIsMonotonic(input.previous.usage, node.usage)
      || (
        input.previous.terminalAt !== undefined
        && node.terminalAt !== input.previous.terminalAt
      )
      || (
        input.previous.closedAt !== undefined
        && node.closedAt !== input.previous.closedAt
      )
      || (
        input.previous.outcome !== undefined
        && !isDeepStrictEqual(node.outcome, input.previous.outcome)
      )
      || (
        input.previous.artifactIds !== undefined
        && !isDeepStrictEqual(node.artifactIds, input.previous.artifactIds)
      )
      || (
        input.previous.resourceIds !== undefined
        && !isDeepStrictEqual(node.resourceIds, input.previous.resourceIds)
      )
    )
  ) {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "output_collaboration_mismatch",
      "Provider changed immutable collaboration identity.",
    );
  }
  return node;
}

export function validateAgentGeneratedResourceForCapabilities(input: {
  readonly capabilities: AgentCapabilities;
  readonly candidate: unknown;
  readonly expectedResourceId: string;
  readonly previous?: AgentGeneratedResourceDescriptor;
}): AgentGeneratedResourceDescriptor {
  let resource: AgentGeneratedResourceDescriptor;
  try {
    resource = parseAgentGeneratedResourceDescriptor(input.candidate);
  } catch {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "output_resource_mismatch",
      "Provider returned an invalid generated resource.",
    );
  }
  const capability = input.capabilities.generatedResources;
  if (
    capability.kind !== "supported"
    || resource.resourceId !== input.expectedResourceId
    || !capability.resourceKinds.includes(resource.kind)
    || (
      resource.byteSize !== undefined
      && resource.byteSize > capability.maxBytesPerResource
    )
  ) {
    return throwAgentProviderContractError(
      input.capabilities.providerKey,
      "output_resource_mismatch",
      "Provider returned a generated resource outside its declared capability or correlation.",
    );
  }
  if (input.previous !== undefined) {
    const transitions: Readonly<
      Record<AgentGeneratedResourceStatus, readonly AgentGeneratedResourceStatus[]>
    > = {
      pending: ["pending", "available", "unavailable", "expired"],
      available: ["available", "expired"],
      unavailable: ["unavailable", "expired"],
      expired: ["expired"],
    };
    if (
      resource.kind !== input.previous.kind
      || resource.displayName !== input.previous.displayName
      || !isDeepStrictEqual(resource.producer, input.previous.producer)
      || resource.createdAt !== input.previous.createdAt
      || !transitions[input.previous.status].includes(resource.status)
      || (
        input.previous.status !== "pending"
        && input.previous.status === resource.status
        && !isDeepStrictEqual(resource, input.previous)
      )
    ) {
      return throwAgentProviderContractError(
        input.capabilities.providerKey,
        "output_resource_mismatch",
        "Provider changed immutable resource identity or returned an invalid lifecycle transition.",
      );
    }
  }
  return resource;
}
