// ------------------------------------------------------------------------------------------------
//                sessionValidation.ts - Session lifecycle and operation enforcement - Dependencies: protocol, runtime contracts
// ------------------------------------------------------------------------------------------------

import {
  AGENT_COLLABORATION_GRAPH_LIMITS,
  AGENT_CONTENT_REFERENCES_MAX_LENGTH,
  findAgentContentReferenceTextIssue,
  matchesAgentSessionBinding,
  parseAgentCollaborationControlInput,
  parseAgentCollaborationSpawnInput,
  parseAgentConfigurationSelectionFor,
  parseAgentGeneratedResourceId,
  parseAgentOperationInvocation,
  parseAgentOperationInvocationFor,
  parseAgentSessionBinding,
  parseAgentTurnId,
  parseAgentTurnInputContent,
  parseAgentTurnInterruptionInput,
  parseAgentTurnRunInput,
  type AgentCapabilities,
  type AgentCollaborationNode,
  type AgentContextCumulativeUsage,
  type AgentContextMeasurementScope,
  type AgentContextUsage,
  type AgentEvent,
  type AgentGeneratedResourceDescriptor,
  type AgentItemKind,
  type AgentItemStatus,
  type AgentOperationInputCapability,
  type AgentOperationInvocation,
  type AgentOperationResult,
  type AgentProviderKey,
  type AgentRequest,
  type AgentSessionBinding,
  type AgentSessionId,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  createAgentArtifactCandidate,
  type AgentArtifactCandidate,
} from "./artifacts.js";
import { validateAgentEnvironmentObservationPort } from "./environment/validation.js";
import {
  validateAgentCollaborationNodeForCapabilities,
  validateAgentConfigurationCatalogForCapabilities,
  validateAgentGeneratedResourceForCapabilities,
  validateAgentManagedContentCatalogForCapabilities,
  validateAgentOperationCatalogForCapabilities,
  validateAgentOperationResultForInvocation,
  validateAgentOperationResultTransition,
} from "./interactionValidation.js";
import {
  AgentProviderDelegatedOperationError,
  AgentProviderSessionCleanupError,
  throwAgentProviderContractError,
  type AgentProviderDelegatedOperation,
} from "./contractErrors.js";
import { createAgentHostBindingCleanupError, type AgentHostBindingLease } from "./hostBindings/lifetime.js";
import { associateAgentSessionCleanupError } from "./sessionCleanup.js";
import { hasExactOwnKeys } from "./internal/objectShape.js";
import {
  throwIfAgentOperationAborted,
  type MaybePromise,
} from "./foundation.js";
import {
  validateAgentProviderOperationResult,
  validateAgentProviderOutputForContext,
  type AgentProviderOutputValidationContext,
} from "./outputValidation.js";
import type { AgentProviderOutput } from "./outputs.js";
import type {
  AgentProviderApplyConfigurationSelectionInput,
  AgentProviderCloseSessionInput,
  AgentProviderControlCollaborationInput,
  AgentProviderGetGeneratedResourceInput,
  AgentProviderInterruptTurnInput,
  AgentProviderInvokeOperationInput,
  AgentProviderOperationResult,
  AgentProviderStartTurnInput,
  AgentProviderTurnInterruptionResult,
  AgentProviderSession,
  AgentProviderSpawnCollaborationInput,
  AgentGeneratedResourceInspection,
  AgentSessionBindingCreatedObserver,
  AgentTurnSteeringResult,
} from "./sessions.js";
import { validateAgentTurnSteeringResult } from "./steeringValidation.js";
import { createValidatedAgentTurnExecution, type ValidatedAgentTurnExecution } from "./turnExecution/execution.js";
import { validateAgentProviderTurnInterruptionResult } from "./turnExecution/receipts.js";
import type { PendingAgentRequest } from "./turnExecution/requests.js";
import type { SessionInteractionOwner } from "./sessionInteractions/lifetime.js";

//                Session Validation
// ------------------------------------------------------------------------------------------------

function validateCloseReason(reason: AgentProviderCloseSessionInput["reason"]): void {
  if (reason !== undefined && !["idle", "shutdown", "replaced", "contract_rejected", "error", "other"].includes(reason)) {
    throw new TypeError("Provider session close reason is unsupported.");
  }
}

function validateSessionPorts(
  capabilities: AgentCapabilities,
  session: AgentProviderSession,
): void {
  if (
    !hasExactOwnKeys(session, [
      "binding",
      "startTurn",
      "interruption",
      "steering",
      "configuration",
      "operations",
      "managedContent",
      "environment",
      "collaboration",
      "generatedResources",
      "close",
    ]) ||
    typeof session.startTurn !== "function" ||
    typeof session.close !== "function" ||
    session.interruption === null ||
    typeof session.interruption !== "object" ||
    !["supported", "unsupported"].includes(session.interruption.kind) ||
    session.steering === null ||
    typeof session.steering !== "object" ||
    !["supported", "unsupported"].includes(session.steering.kind) ||
    session.configuration === null ||
    typeof session.configuration !== "object" ||
    !["managed", "selectable"].includes(session.configuration.kind) ||
    session.operations === null ||
    typeof session.operations !== "object" ||
    !["supported", "unsupported"].includes(session.operations.kind) ||
    session.managedContent === null ||
    typeof session.managedContent !== "object" ||
    !["supported", "unsupported"].includes(session.managedContent.kind) ||
    session.environment === null ||
    typeof session.environment !== "object" ||
    !["read", "read_and_watch", "unsupported"].includes(session.environment.kind) ||
    session.collaboration === null ||
    typeof session.collaboration !== "object" ||
    !["supported", "unsupported"].includes(session.collaboration.kind) ||
    session.generatedResources === null ||
    typeof session.generatedResources !== "object" ||
    !["supported", "unsupported"].includes(session.generatedResources.kind)
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "invalid_session",
      `Provider ${capabilities.providerKey} returned an incomplete session.`,
    );
  }
  if (
    !hasExactOwnKeys(
      session.interruption,
      session.interruption.kind === "supported"
        ? ["kind", "interruptTurn"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.steering,
      session.steering.kind === "supported"
        ? ["kind", "steerTurn"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.configuration,
      session.configuration.kind === "selectable"
        ? ["kind", "listConfiguration", "applyConfigurationSelection"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.operations,
      session.operations.kind === "supported"
        ? ["kind", "listOperations", "invokeOperation"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.managedContent,
      session.managedContent.kind === "supported"
        ? ["kind", "listManagedContent"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.environment,
      session.environment.kind === "unsupported"
        ? ["kind"]
        : session.environment.kind === "read"
          ? ["kind", "domains", "readEnvironment"]
          : ["kind", "domains", "readEnvironment", "watchEnvironment"],
    ) ||
    !hasExactOwnKeys(
      session.collaboration,
      session.collaboration.kind === "supported"
        ? ["kind", "spawnCollaboration", "controlCollaboration"]
        : ["kind"],
    ) ||
    !hasExactOwnKeys(
      session.generatedResources,
      session.generatedResources.kind === "supported"
        ? ["kind", "getGeneratedResource"]
        : ["kind"],
    ) ||
    (session.interruption.kind === "supported") !==
      capabilities.turns.interrupt ||
    (session.steering.kind === "supported") !==
      (capabilities.turns.steer.kind === "supported") ||
    session.configuration.kind !== capabilities.configuration.kind ||
    (session.interruption.kind === "supported" &&
      typeof session.interruption.interruptTurn !== "function") ||
    (session.steering.kind === "supported" &&
      typeof session.steering.steerTurn !== "function") ||
    (session.configuration.kind === "selectable" &&
      (typeof session.configuration.listConfiguration !== "function" ||
        typeof session.configuration.applyConfigurationSelection !== "function")) ||
    (session.operations.kind === "supported") !==
      (capabilities.operations.kind === "supported") ||
    (session.operations.kind === "supported" &&
      (typeof session.operations.listOperations !== "function" ||
        typeof session.operations.invokeOperation !== "function")) ||
    (session.managedContent.kind === "supported") !==
      (capabilities.managedContent.kind === "supported") ||
    (session.managedContent.kind === "supported" &&
      typeof session.managedContent.listManagedContent !== "function") ||
    session.environment.kind !== capabilities.environment.session.kind ||
    (session.environment.kind !== "unsupported" &&
      (typeof session.environment.readEnvironment !== "function" ||
        (session.environment.kind === "read_and_watch" &&
          typeof session.environment.watchEnvironment !== "function"))) ||
    (session.collaboration.kind === "supported") !==
      (capabilities.collaboration.kind === "supported") ||
    (session.collaboration.kind === "supported" &&
      (typeof session.collaboration.spawnCollaboration !== "function" ||
        typeof session.collaboration.controlCollaboration !== "function")) ||
    (session.generatedResources.kind === "supported") !==
      (capabilities.generatedResources.kind === "supported") ||
    (session.generatedResources.kind === "supported" &&
      typeof session.generatedResources.getGeneratedResource !== "function")
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "capability_port_mismatch",
      `Provider ${capabilities.providerKey} session ports do not match its capabilities.`,
    );
  }
}

interface ObservedAgentItem {
  readonly itemKind: AgentItemKind;
  readonly status: AgentItemStatus;
  readonly inProgressObserved: boolean;
  readonly terminal: boolean;
}

interface AgentTurnSequenceState {
  readonly fileChangeMode: AgentCapabilities["output"]["fileChanges"];
  readonly observedItems: Map<string, ObservedAgentItem>;
  readonly proposedPlans: Map<string, string>;
  readonly generatedResourceIds: Set<string>;
  started: boolean;
  terminal: boolean;
  finalDiffObserved: boolean;
}

interface AgentContextUsageSequenceState {
  readonly latestByScope: Map<AgentContextMeasurementScope, AgentContextUsage>;
  readonly cumulativeByScope: Map<
    AgentContextMeasurementScope,
    AgentContextCumulativeUsage
  >;
  readonly compactionReadyScopes: Set<AgentContextMeasurementScope>;
}

interface TrackedAgentOperationInvocation {
  readonly invocation: AgentOperationInvocation;
  result?: AgentOperationResult;
}

interface AgentInteractionSequenceState {
  readonly operationResults: Map<string, AgentOperationResult>;
  readonly operationInvocations: Map<string, TrackedAgentOperationInvocation>;
  readonly collaborationNodes: Map<string, AgentCollaborationNode>;
  readonly collaborationSpawnReservations: Map<
    string,
    AgentCollaborationSpawnReservation
  >;
  readonly generatedResources: Map<string, AgentGeneratedResourceDescriptor>;
}

const TERMINAL_COLLABORATION_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
]);

interface AgentCollaborationSpawnReservation {
  readonly parentCollaborationId?: string;
}

interface AgentCollaborationGraphCandidate {
  readonly collaborationId: string;
  readonly rootCollaborationId: string;
  readonly parentCollaborationId?: string;
  readonly active: boolean;
}

type AgentCollaborationGraphAdmission =
  | Readonly<{
      kind: "admitted";
      parent?: AgentCollaborationNode;
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "capacity_exceeded" }>;

function evaluateCollaborationGraphAdmission(input: {
  readonly capability: Extract<
    AgentCapabilities["collaboration"],
    Readonly<{ kind: "supported" }>
  >;
  readonly candidate: AgentCollaborationGraphCandidate;
  readonly nodes: ReadonlyMap<string, AgentCollaborationNode>;
  readonly reservations: ReadonlyMap<
    string,
    AgentCollaborationSpawnReservation
  >;
}): AgentCollaborationGraphAdmission {
  const existing = input.nodes.get(input.candidate.collaborationId);
  if (existing !== undefined) {
    const parent = existing.parentCollaborationId === undefined
      ? undefined
      : input.nodes.get(existing.parentCollaborationId);
    return parent === undefined
      ? Object.freeze({ kind: "admitted" })
      : Object.freeze({ kind: "admitted", parent });
  }

  const reservation = input.reservations.get(input.candidate.collaborationId);
  if (
    reservation !== undefined
    && reservation.parentCollaborationId
      !== input.candidate.parentCollaborationId
  ) {
    return Object.freeze({ kind: "conflict" });
  }

  const parent = input.candidate.parentCollaborationId === undefined
    ? undefined
    : input.nodes.get(input.candidate.parentCollaborationId);
  if (
    (input.candidate.parentCollaborationId === undefined
      && input.candidate.rootCollaborationId
        !== input.candidate.collaborationId)
    || (input.candidate.parentCollaborationId !== undefined
      && (
        parent === undefined
        || input.candidate.rootCollaborationId !== parent.rootCollaborationId
        || TERMINAL_COLLABORATION_STATUSES.has(parent.status)
        || parent.closedAt !== undefined
      ))
  ) {
    return Object.freeze({ kind: "conflict" });
  }

  let depth = 1;
  const visitedIds = new Set([input.candidate.collaborationId]);
  for (let ancestor = parent; ancestor !== undefined;) {
    if (visitedIds.has(ancestor.collaborationId)) {
      return Object.freeze({ kind: "conflict" });
    }
    visitedIds.add(ancestor.collaborationId);
    depth += 1;
    if (ancestor.parentCollaborationId === undefined) break;
    ancestor = input.nodes.get(ancestor.parentCollaborationId);
    if (ancestor === undefined) {
      return Object.freeze({ kind: "conflict" });
    }
  }

  if (reservation !== undefined) {
    return parent === undefined
      ? Object.freeze({ kind: "admitted" })
      : Object.freeze({ kind: "admitted", parent });
  }

  const unmaterializedReservations = [...input.reservations].filter(
    ([collaborationId]) => !input.nodes.has(collaborationId),
  );
  const childCount = parent === undefined
    ? 0
    : [...input.nodes.values()].filter(
        (node) => node.parentCollaborationId === parent.collaborationId,
      ).length
      + unmaterializedReservations.filter(
        ([, retainedReservation]) =>
          retainedReservation.parentCollaborationId === parent.collaborationId,
      ).length;
  const activeCount = [...input.nodes.values()].filter(
    (node) => !TERMINAL_COLLABORATION_STATUSES.has(node.status),
  ).length + unmaterializedReservations.length;
  if (
    input.nodes.size + unmaterializedReservations.length
      >= AGENT_COLLABORATION_GRAPH_LIMITS.maxNodes
    || childCount >= input.capability.maxChildrenPerNode
    || depth > input.capability.maxDepth
    || (
      input.candidate.active
      && activeCount >= input.capability.maxActiveNodes
    )
  ) {
    return Object.freeze({ kind: "capacity_exceeded" });
  }

  return parent === undefined
    ? Object.freeze({ kind: "admitted" })
    : Object.freeze({ kind: "admitted", parent });
}

interface ActiveAgentTurn {
  readonly turnId: AgentTurnId;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly state: AgentTurnSequenceState;
  readonly inFlightOperations: Set<Promise<void>>;
  readonly owner: ValidatedAgentTurnExecution;
}

function invalidTurnSequence(
  providerKey: AgentProviderKey,
  message: string,
): never {
  return throwAgentProviderContractError(
    providerKey,
    "invalid_turn_sequence",
    message,
  );
}

function completeTurnSequence(input: {
  readonly providerKey: AgentProviderKey;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: ReadonlyMap<string, PendingAgentRequest>;
}): void {
  if (input.pendingRequests.size > 0) {
    invalidTurnSequence(
      input.providerKey,
      "Provider completed a turn while an interaction request remained pending.",
    );
  }
  input.state.terminal = true;
}

const FINAL_DIFF_TRAILING_EVENT_TYPES: readonly AgentEvent["type"][] = [
  "artifact.referenced",
  "collaboration.updated",
  "operation.updated",
  "provider.diagnostic",
  "resource.updated",
  "runtime.error",
  "runtime.warning",
  "turn.completed",
];

const TERMINAL_ITEM_STATUSES = new Set<AgentItemStatus>([
  "completed",
  "failed",
  "canceled",
]);

function observeItemLifecycle(input: {
  readonly providerKey: AgentProviderKey;
  readonly event: Extract<
    AgentEvent,
    {
      readonly type: "item.started" | "item.updated" | "item.completed";
    }
  >;
  readonly state: AgentTurnSequenceState;
}): void {
  const { event, providerKey, state } = input;
  const previous = state.observedItems.get(event.payload.itemId);
  if (
    event.type === "item.completed"
    && !TERMINAL_ITEM_STATUSES.has(event.payload.status)
  ) {
    invalidTurnSequence(
      providerKey,
      "Provider completed an item without a terminal item status.",
    );
  }
  if (previous?.terminal) {
    invalidTurnSequence(
      providerKey,
      "Provider emitted an item lifecycle event after the item became terminal.",
    );
  }
  if (
    previous?.itemKind !== undefined
    && previous.itemKind !== event.payload.itemKind
  ) {
    invalidTurnSequence(
      providerKey,
      "Provider changed the kind of an existing item identity.",
    );
  }
  if (previous !== undefined && event.type === "item.started") {
    invalidTurnSequence(
      providerKey,
      "Provider started an item identity more than once.",
    );
  }
  if (previous?.inProgressObserved && event.payload.status === "pending") {
    invalidTurnSequence(
      providerKey,
      "Provider regressed an in-progress item to pending.",
    );
  }

  state.observedItems.set(event.payload.itemId, {
    itemKind: event.payload.itemKind,
    status: event.payload.status,
    inProgressObserved:
      previous?.inProgressObserved === true
      || event.payload.status === "in_progress",
    terminal:
      event.type === "item.completed"
      || TERMINAL_ITEM_STATUSES.has(event.payload.status),
  });
}

function assertApprovalSubjectCorrelation(input: {
  readonly providerKey: AgentProviderKey;
  readonly request: AgentRequest;
  readonly state: AgentTurnSequenceState;
}): void {
  const { request } = input;
  if (request.requestKind !== "approval") return;
  if (request.subject.kind === "plan") {
    if (
      input.state.proposedPlans.get(request.subject.artifactId)
      !== request.requestId
    ) {
      invalidTurnSequence(
        input.providerKey,
        "Provider approval request does not identify a proposed plan from this turn.",
      );
    }
    return;
  }
  const item = input.state.observedItems.get(request.subject.itemId);
  const itemIsLive = item !== undefined
    && !item.terminal
    && (
      item.status === "pending"
      || item.status === "in_progress"
      || (item.status === "unknown" && item.inProgressObserved)
    );
  if (!itemIsLive) {
    invalidTurnSequence(
      input.providerKey,
      "Provider approval request does not identify a live item from this turn.",
    );
  }
}

function assertPendingApprovalSubjectCorrelations(input: {
  readonly providerKey: AgentProviderKey;
  readonly pendingRequests: ReadonlyMap<string, PendingAgentRequest>;
  readonly state: AgentTurnSequenceState;
}): void {
  for (const pending of input.pendingRequests.values()) {
    assertApprovalSubjectCorrelation({
      providerKey: input.providerKey,
      request: pending.request,
      state: input.state,
    });
  }
}

function observeContextUsage(input: {
  readonly providerKey: AgentProviderKey;
  readonly usage: AgentContextUsage;
  readonly state: AgentContextUsageSequenceState;
}): void {
  const previous = input.state.latestByScope.get(input.usage.measurementScope);
  if (previous !== undefined) {
    if (JSON.stringify(previous) === JSON.stringify(input.usage)) {
      invalidTurnSequence(
        input.providerKey,
        "Provider emitted a duplicate context usage sample.",
      );
    }
    if (
      input.usage.usedTokens < previous.usedTokens
      && !input.state.compactionReadyScopes.has(input.usage.measurementScope)
    ) {
      invalidTurnSequence(
        input.providerKey,
        "Provider context occupancy cannot decrease without completed compaction.",
      );
    }
  }
  const cumulative = input.usage.cumulative;
  if (cumulative !== undefined) {
    const previousCumulative = input.state.cumulativeByScope.get(
      input.usage.measurementScope,
    );
    for (const field of Object.keys(cumulative) as Array<
      keyof AgentContextCumulativeUsage
    >) {
      const value = cumulative[field];
      const previousValue = previousCumulative?.[field];
      if (
        value !== undefined
        && previousValue !== undefined
        && value < previousValue
      ) {
        invalidTurnSequence(
          input.providerKey,
          "Provider context cumulative counters cannot decrease.",
        );
      }
    }
    input.state.cumulativeByScope.set(input.usage.measurementScope, {
      ...previousCumulative,
      ...cumulative,
    });
  }
  input.state.latestByScope.set(input.usage.measurementScope, input.usage);
  input.state.compactionReadyScopes.delete(input.usage.measurementScope);
}

function observeContextMaterializationBoundary(
  state: AgentContextUsageSequenceState,
): void {
  state.latestByScope.delete("materialization");
  state.cumulativeByScope.delete("materialization");
  state.compactionReadyScopes.delete("materialization");
}

function observeTurnEvent(input: {
  readonly providerKey: AgentProviderKey;
  readonly event: AgentEvent;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly openedRequestIds: Set<string>;
  readonly turnRequestIds: Set<string>;
  readonly contextUsageState: AgentContextUsageSequenceState;
}): void {
  const {
    contextUsageState,
    event,
    openedRequestIds,
    turnRequestIds,
    pendingRequests,
    providerKey,
    state,
  } = input;
  if (state.terminal) {
    invalidTurnSequence(
      providerKey,
      "Provider emitted an event after turn completion.",
    );
  }
  if (event.type === "turn.started") {
    if (state.started) {
      invalidTurnSequence(
        providerKey,
        "Provider emitted turn.started more than once.",
      );
    }
    state.started = true;
  } else if (!state.started) {
    invalidTurnSequence(
      providerKey,
      "Provider emitted turn data before turn.started.",
    );
  }
  if (state.fileChangeMode === "final_diff") {
    if (event.type === "turn.diff.updated") {
      if (pendingRequests.size > 0) {
        invalidTurnSequence(
          providerKey,
          "Provider emitted a terminal diff while an interaction request remained pending.",
        );
      }
      if (state.finalDiffObserved) {
        invalidTurnSequence(
          providerKey,
          "Provider emitted more than one terminal diff for a turn.",
        );
      }
      state.finalDiffObserved = true;
    } else if (
      state.finalDiffObserved &&
      !FINAL_DIFF_TRAILING_EVENT_TYPES.includes(event.type)
    ) {
      invalidTurnSequence(
        providerKey,
        "Provider emitted turn materialization after its terminal diff.",
      );
    }
  }
  if (
    event.type === "item.started"
    || event.type === "item.updated"
    || event.type === "item.completed"
  ) {
    observeItemLifecycle({ providerKey, event, state });
    assertPendingApprovalSubjectCorrelations({
      providerKey,
      pendingRequests,
      state,
    });
    if (
      event.payload.itemKind === "context_compaction"
      && event.type === "item.completed"
      && event.payload.status === "completed"
    ) {
      for (const scope of ["session", "materialization"] as const) {
        contextUsageState.compactionReadyScopes.add(scope);
      }
    }
  }
  if (event.type === "turn.plan.proposed") {
    state.proposedPlans.set(event.payload.artifactId, event.payload.requestId);
    assertPendingApprovalSubjectCorrelations({
      providerKey,
      pendingRequests,
      state,
    });
  }
  if (event.type === "context.usage.updated") {
    observeContextUsage({
      providerKey,
      usage: event.payload,
      state: contextUsageState,
    });
  }
  if (event.type === "request.opened") {
    if (pendingRequests.size > 0) {
      invalidTurnSequence(
        providerKey,
        "Provider opened more than one pending request for a session.",
      );
    }
    const requestId = event.payload.request.requestId;
    if (openedRequestIds.has(requestId)) {
      invalidTurnSequence(
        providerKey,
        "Provider reused a request ID within a session.",
      );
    }
    assertApprovalSubjectCorrelation({
      providerKey,
      request: event.payload.request,
      state,
    });
    openedRequestIds.add(requestId);
    turnRequestIds.add(requestId);
    pendingRequests.set(requestId, {
      request: event.payload.request,
      turnId: event.turnId,
    });
  }
  if (event.type === "turn.state_changed") {
    const waiting = event.payload.state === "waiting_for_request";
    if (
      waiting &&
      !turnRequestIds.has(event.payload.requestId as string)
    ) {
      invalidTurnSequence(
        providerKey,
        "Provider entered a waiting state for a request it did not open.",
      );
    }
  }
  if (event.type === "turn.completed") {
    if (event.payload.outcome !== "completed") pendingRequests.clear();
    completeTurnSequence({ providerKey, state, pendingRequests });
  }
}

function observeTurnOutput(input: {
  readonly capabilities: AgentCapabilities;
  readonly providerKey: AgentProviderKey;
  readonly output: AgentProviderOutput;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly openedRequestIds: Set<string>;
  readonly turnRequestIds: Set<string>;
  readonly contextUsageState: AgentContextUsageSequenceState;
  readonly interactionState: AgentInteractionSequenceState;
}): void {
  if (
    input.output.kind === "lifecycle"
    && input.output.lifecycle.type === "process.started"
  ) {
    observeContextMaterializationBoundary(input.contextUsageState);
  }
  if (input.output.kind !== "event") return;
  if (input.output.event.type === "operation.updated") {
    const result = validateAgentOperationResultTransition({
      providerKey: input.providerKey,
      candidate: input.output.event.payload.result,
      previous: input.interactionState.operationResults.get(
        input.output.event.payload.result.invocationId,
      ),
    });
    input.interactionState.operationResults.set(result.invocationId, result);
    const invocation = input.interactionState.operationInvocations.get(
      result.invocationId,
    );
    if (invocation !== undefined) invocation.result = result;
  }
  if (input.output.event.type === "collaboration.updated") {
    const node = validateAgentCollaborationNodeForCapabilities({
      capabilities: input.capabilities,
      candidate: input.output.event.payload.node,
      previous: input.interactionState.collaborationNodes.get(
        input.output.event.payload.node.collaborationId,
      ),
    });
    const capability = input.capabilities.collaboration;
    if (capability.kind !== "supported") {
      throwAgentProviderContractError(
        input.providerKey,
        "output_capability_mismatch",
        "Provider emitted collaboration state without declaring support.",
      );
    }
    const admission = evaluateCollaborationGraphAdmission({
      capability,
      candidate: {
        collaborationId: node.collaborationId,
        rootCollaborationId: node.rootCollaborationId,
        ...(node.parentCollaborationId === undefined
          ? {}
          : { parentCollaborationId: node.parentCollaborationId }),
        active: !TERMINAL_COLLABORATION_STATUSES.has(node.status),
      },
      nodes: input.interactionState.collaborationNodes,
      reservations: input.interactionState.collaborationSpawnReservations,
    });
    if (admission.kind === "conflict") {
      throwAgentProviderContractError(
        input.providerKey,
        "output_collaboration_mismatch",
        "Provider emitted a collaboration node outside the canonical graph.",
      );
    }
    if (admission.kind === "capacity_exceeded") {
      throwAgentProviderContractError(
        input.providerKey,
        "output_capability_mismatch",
        "Provider emitted a collaboration graph outside its declared limits.",
      );
    }
    input.interactionState.collaborationNodes.set(node.collaborationId, node);
  }
  if (input.output.event.type === "resource.updated") {
    const capability = input.capabilities.generatedResources;
    const resourceId = input.output.event.payload.resource.resourceId;
    if (
      capability.kind !== "supported"
      || (
        !input.state.generatedResourceIds.has(resourceId)
        && input.state.generatedResourceIds.size >= capability.maxResourcesPerTurn
      )
    ) {
      throwAgentProviderContractError(
        input.providerKey,
        "output_capability_mismatch",
        "Provider exceeded its declared generated-resource count for the turn.",
      );
    }
    const resource = validateAgentGeneratedResourceForCapabilities({
      capabilities: input.capabilities,
      candidate: input.output.event.payload.resource,
      expectedResourceId: input.output.event.payload.resource.resourceId,
      previous: input.interactionState.generatedResources.get(
        input.output.event.payload.resource.resourceId,
      ),
    });
    input.state.generatedResourceIds.add(resource.resourceId);
    input.interactionState.generatedResources.set(resource.resourceId, resource);
  }
  observeTurnEvent({
    providerKey: input.providerKey,
    event: input.output.event,
    state: input.state,
    pendingRequests: input.pendingRequests,
    openedRequestIds: input.openedRequestIds,
    turnRequestIds: input.turnRequestIds,
    contextUsageState: input.contextUsageState,
  });
}

const SESSION_OPERATION_OBSERVATION_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "item.started",
  "item.updated",
  "item.completed",
  "progress.updated",
  "context.usage.updated",
  "operation.updated",
  "resource.updated",
  "runtime.warning",
  "runtime.error",
  "provider.diagnostic",
]);

function observeSessionOperationOutput(input: {
  readonly capabilities: AgentCapabilities;
  readonly providerKey: AgentProviderKey;
  readonly output: AgentProviderOutput;
  readonly state: AgentTurnSequenceState;
  readonly contextUsageState: AgentContextUsageSequenceState;
  readonly interactionState: AgentInteractionSequenceState;
}): void {
  if (input.output.kind === "event") {
    const event = input.output.event;
    if (!SESSION_OPERATION_OBSERVATION_EVENT_TYPES.has(event.type)) {
      invalidTurnSequence(
        input.providerKey,
        "Provider emitted turn-owned output from a session operation.",
      );
    }
    if (
      (
        event.type === "item.started"
        || event.type === "item.updated"
        || event.type === "item.completed"
      )
      && event.payload.itemKind !== "context_compaction"
    ) {
      invalidTurnSequence(
        input.providerKey,
        "Provider emitted a non-compaction item from a session operation.",
      );
    }
  }
  observeTurnOutput({
    capabilities: input.capabilities,
    providerKey: input.providerKey,
    output: input.output,
    state: input.state,
    pendingRequests: new Map(),
    openedRequestIds: new Set(),
    turnRequestIds: new Set(),
    contextUsageState: input.contextUsageState,
    interactionState: input.interactionState,
  });
}

function trackActiveTurnOperation(
  turn: ActiveAgentTurn | null,
): (() => void) | null {
  if (!turn) return null;
  let settle!: () => void;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  turn.inFlightOperations.add(settlement);
  return () => {
    turn.inFlightOperations.delete(settlement);
    settle();
  };
}

function assertAgentTurnInputCapability(input: {
  readonly capability: AgentOperationInputCapability;
  readonly parts: AgentProviderStartTurnInput["parts"];
  readonly providerKey: AgentProviderKey;
}): void {
  const imageParts = input.parts.filter((part) => part.type === "image");
  if (imageParts.length > 0) {
    const imageCapability = input.capability.images;
    if (imageCapability.kind === "unsupported") {
      throwAgentProviderContractError(
        input.providerKey,
        "input_capability_mismatch",
        `Provider ${input.providerKey} does not accept image input.`,
      );
    }

    const reject = (reason: string): never =>
      throwAgentProviderContractError(
        input.providerKey,
        "input_capability_mismatch",
        `Provider ${input.providerKey} cannot accept this image input: ${reason}.`,
      );

    if (imageParts.length > imageCapability.maxImages) {
      reject("image count exceeds the declared limit");
    }
    if (
      !imageCapability.supportsImageOnly &&
      !input.parts.some((part) => part.type === "text" && part.text.trim().length > 0)
    ) {
      reject("image-only input is unsupported");
    }

    let totalBytes = 0;
    for (const part of imageParts) {
      const { source } = part;
      if (!imageCapability.sourceKinds.includes(source.type)) {
        reject(`source kind ${source.type} is unsupported`);
      }
      if (!imageCapability.mediaTypes.includes(source.mediaType)) {
        reject(`media type ${source.mediaType} is unsupported`);
      }
      if (source.byteSize > imageCapability.maxBytesPerImage) {
        reject("an image exceeds the declared byte limit");
      }
      if (
        source.widthPixels > imageCapability.maxWidthPixels ||
        source.heightPixels > imageCapability.maxHeightPixels ||
        source.widthPixels * source.heightPixels
          > imageCapability.maxPixelsPerImage
      ) {
        reject("an image exceeds the declared dimension or pixel limit");
      }
      totalBytes += source.byteSize;
    }
    if (totalBytes > imageCapability.maxTotalBytes) {
      reject("aggregate image bytes exceed the declared limit");
    }
  }

  const contentReferenceParts = input.parts.filter(
    (part) => part.type === "content_reference",
  );
  if (contentReferenceParts.length === 0) return;
  const contentReferenceCapability = input.capability.contentReferences;
  const rejectReference = (reason: string): never =>
    throwAgentProviderContractError(
      input.providerKey,
      "input_capability_mismatch",
      `Provider ${input.providerKey} cannot accept this content reference input: ${reason}.`,
    );
  if (contentReferenceParts.length > AGENT_CONTENT_REFERENCES_MAX_LENGTH) {
    rejectReference("content reference count exceeds the protocol limit");
  }
  if (contentReferenceCapability.kind === "unsupported") {
    return rejectReference("content references are unsupported");
  }
  if (contentReferenceParts.length > contentReferenceCapability.maxReferences) {
    rejectReference("content reference count exceeds the declared limit");
  }
  if (
    !contentReferenceCapability.arguments
    && contentReferenceParts.some((part) => part.arguments !== undefined)
  ) {
    rejectReference("reference arguments are unsupported");
  }
  const textIssue = findAgentContentReferenceTextIssue({
    prompt: input.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    arguments: contentReferenceParts.map((part) => part.arguments ?? ''),
    textFormats: contentReferenceCapability.textFormats,
  });
  if (textIssue) rejectReference(`${textIssue.target} must use ${textIssue.format} text`);
}

export function validateAgentProviderSession(input: {
  readonly capabilities: AgentCapabilities;
  readonly sessionId: AgentSessionId;
  readonly candidate: AgentProviderSession;
  readonly expectedBinding?: AgentSessionBinding;
  readonly sourceBinding?: AgentSessionBinding;
  readonly hostBindingLease?: AgentHostBindingLease;
  readonly sessionInteractionOwner?: SessionInteractionOwner;
}): AgentProviderSession {
  const { capabilities, sessionId } = input;
  const providerKey = capabilities.providerKey;
  if (input.candidate === null || typeof input.candidate !== "object") {
    throwAgentProviderContractError(
      providerKey,
      "invalid_session",
      "Provider returned an invalid session.",
    );
  }

  let binding: AgentSessionBinding;
  try {
    binding = parseAgentSessionBinding(input.candidate.binding);
  } catch {
    throwAgentProviderContractError(
      providerKey,
      "invalid_binding",
      "Provider returned an invalid binding.",
    );
  }
  if (
    input.expectedBinding &&
    !matchesAgentSessionBinding(binding, input.expectedBinding)
  ) {
    throwAgentProviderContractError(
      providerKey,
      "resume_binding_mismatch",
      "Provider resumed another binding.",
    );
  }
  if (
    input.sourceBinding &&
    matchesAgentSessionBinding(binding, input.sourceBinding)
  ) {
    throwAgentProviderContractError(
      providerKey,
      "branch_binding_reused",
      "Provider branch reused its source binding.",
    );
  }
  validateSessionPorts(capabilities, input.candidate);

  const sessionLifetime = new AbortController();
  const environment = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: capabilities.environment.session,
    port: input.candidate.environment,
    signal: sessionLifetime.signal,
  });

  const openedRequestIds = new Set<string>();
  const contextUsageState: AgentContextUsageSequenceState = {
    latestByScope: new Map<AgentContextMeasurementScope, AgentContextUsage>(),
    cumulativeByScope: new Map<
      AgentContextMeasurementScope,
      AgentContextCumulativeUsage
    >(),
    compactionReadyScopes: new Set<AgentContextMeasurementScope>(),
  };
  const interactionState: AgentInteractionSequenceState = {
    operationResults: new Map<string, AgentOperationResult>(),
    operationInvocations: new Map(),
    collaborationNodes: new Map<string, AgentCollaborationNode>(),
    collaborationSpawnReservations: new Map(),
    generatedResources: new Map<string, AgentGeneratedResourceDescriptor>(),
  };
  const collaborationNodes = interactionState.collaborationNodes;
  const collaborationSpawnReservations =
    interactionState.collaborationSpawnReservations;
  let activeTurn: ActiveAgentTurn | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;
  let providerClosed = false;
  let unusable = false;

  const requireOpen = (): void => {
    if (closed)
      throwAgentProviderContractError(
        providerKey,
        "session_closed",
        "Provider session is closed.",
      );
  };
  const requireUsable = (): void => {
    input.sessionInteractionOwner?.requireUsable();
    requireOpen();
    if (unusable) {
      throwAgentProviderContractError(
        providerKey,
        "session_unusable",
        "Provider session cannot be reused after an incomplete operation.",
      );
    }
  };
  const outputContext = (
    turnId?: AgentTurnId,
  ): AgentProviderOutputValidationContext => ({
    capabilities,
    providerKey,
    sessionId,
    ...(turnId === undefined ? {} : { turnId }),
  });
  const delegateProviderMutation = async <Result>(input: {
    readonly operation: AgentProviderDelegatedOperation;
    readonly observer?: () => void;
    readonly invoke: (
      onProviderExecutionStarted: () => void,
      onOutput: (candidate: unknown) => Promise<void>,
    ) => MaybePromise<unknown>;
    readonly observeOutput?: (candidate: unknown) => MaybePromise<void>;
    readonly validate: (candidate: unknown) => Result;
  }): Promise<Result> => {
    let executionStarted = false;
    const onProviderExecutionStarted = (): void => {
      if (executionStarted) {
        throwAgentProviderContractError(
          providerKey,
          "invalid_operation_result",
          "Provider reported operation execution more than once.",
        );
      }
      input.observer?.();
      executionStarted = true;
    };
    const onOutput = async (candidate: unknown): Promise<void> => {
      if (!executionStarted) {
        throwAgentProviderContractError(
          providerKey,
          "invalid_operation_result",
          "Provider emitted operation output before reporting execution start.",
        );
      }
      await input.observeOutput?.(candidate);
    };
    try {
      requireUsable();
      const candidate = await input.invoke(onProviderExecutionStarted, onOutput);
      if (!executionStarted) {
        throwAgentProviderContractError(
          providerKey,
          "invalid_operation_result",
          "Provider completed an operation without reporting execution start.",
        );
      }
      return input.validate(candidate);
    } catch (error) {
      if (!executionStarted) throw error;
      unusable = true;
      throw new AgentProviderDelegatedOperationError(
        providerKey,
        input.operation,
        error,
      );
    }
  };

  const startTurn = (turnInput: AgentProviderStartTurnInput) => {
    requireUsable();
    throwIfAgentOperationAborted(turnInput.signal);
    const parsedInput = parseAgentTurnRunInput({
      turnId: turnInput.turnId,
      interactionMode: turnInput.interactionMode,
      parts: turnInput.parts,
      ...(turnInput.summary === undefined ? {} : { summary: turnInput.summary }),
      ...(turnInput.deadlineAt === undefined ? {} : { deadlineAt: turnInput.deadlineAt }),
    });
    assertAgentTurnInputCapability({ capability: capabilities.input, parts: parsedInput.parts, providerKey });
    if (!capabilities.turns.interactionModes.includes(parsedInput.interactionMode)) {
      throwAgentProviderContractError(providerKey, "input_capability_mismatch",
        `Provider ${providerKey} does not support ${parsedInput.interactionMode} turn interaction mode.`);
    }
    if (activeTurn !== null) {
      throwAgentProviderContractError(providerKey, "concurrent_turn", "Provider session already has an active turn.");
    }
    const pendingRequests = new Map<string, PendingAgentRequest>();
    const turnRequestIds = new Set<string>();
    const state: AgentTurnSequenceState = {
      fileChangeMode: capabilities.output.fileChanges,
      observedItems: new Map<string, ObservedAgentItem>(),
      proposedPlans: new Map<string, string>(),
      generatedResourceIds: new Set<string>(),
      started: false, terminal: false, finalDiffObserved: false,
    };
    const inFlightOperations = new Set<Promise<void>>();
    const owner = createValidatedAgentTurnExecution({
      providerKey,
      turnInput: { ...parsedInput,
        ...(turnInput.signal === undefined ? {} : { signal: turnInput.signal }),
        ...(turnInput.onProviderExecutionStarted === undefined ? {} : { onProviderExecutionStarted: turnInput.onProviderExecutionStarted }),
      },
      pendingRequests, inFlightOperations,
      start: (inputTurn) => input.candidate.startTurn(inputTurn),
      requireUsable,
      isTerminal: () => state.terminal,
      observe(candidate) {
        const output = validateAgentProviderOutputForContext(candidate, outputContext(parsedInput.turnId));
        observeTurnOutput({ capabilities, providerKey, output, state, pendingRequests, openedRequestIds,
          turnRequestIds, contextUsageState, interactionState });
        return output;
      },
      assertCompleted() {
        if (!state.started || !state.terminal || pendingRequests.size > 0) {
          invalidTurnSequence(providerKey, "Provider turn output must remain open until actual terminal completion.");
        }
      },
      release() { if (activeTurn?.owner === owner) activeTurn = null; },
      retire() { unusable = true; },
      abandon: () => close({ reason: "other" }),
    });
    activeTurn = { turnId: parsedInput.turnId, pendingRequests, state, inFlightOperations, owner };
    return owner.execution;
  };

  const declaredInterruption = input.candidate.interruption;
  const interruption =
    declaredInterruption.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          interruptTurn: async (
            interruptionInput: AgentProviderInterruptTurnInput,
          ): Promise<AgentProviderTurnInterruptionResult> => {
            requireUsable();
            throwIfAgentOperationAborted(interruptionInput.signal);
            const parsed = parseAgentTurnInterruptionInput({
              turnId: interruptionInput.turnId,
              reason: interruptionInput.reason,
              ...(interruptionInput.requestedAt === undefined
                ? {}
                : { requestedAt: interruptionInput.requestedAt }),
            });
            const targetedActiveTurn =
              activeTurn?.turnId === parsed.turnId ? activeTurn : null;
            const targetedTurn = targetedActiveTurn;
            if (targetedTurn === null || targetedTurn.state.terminal || !targetedTurn.owner.hasEntered()) {
              throwAgentProviderContractError(providerKey, "active_turn_mismatch",
                "Provider interruption does not identify an active turn.");
            }
            const settleActiveInterruption = trackActiveTurnOperation(
              targetedActiveTurn,
            );
            try {
              const suspendedRequests = targetedTurn.owner.suspendRequests();
              let result: AgentProviderTurnInterruptionResult;
              try {
                result = validateAgentProviderTurnInterruptionResult(
                  await declaredInterruption.interruptTurn({
                    ...parsed,
                    ...(interruptionInput.signal === undefined
                      ? {}
                      : { signal: interruptionInput.signal }),
                  }),
                  outputContext(parsed.turnId),
                );
              } catch (error) {
                suspendedRequests.withdraw();
                unusable = true;
                throw error;
              }
              if (result.status === "failed") {
                suspendedRequests.restore();
              } else suspendedRequests.withdraw();
              // Dispatch acceptance does not retire the live stream or synthesize native completion.
              return result;
            } finally {
              settleActiveInterruption?.();
            }
          },
        });

  const declaredSteering = input.candidate.steering;
  const steering =
    declaredSteering.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          steerTurn: async (
            steeringInput: Parameters<typeof declaredSteering.steerTurn>[0],
          ): Promise<AgentTurnSteeringResult> => {
            requireUsable();
            throwIfAgentOperationAborted(steeringInput.signal);
            const turnId = parseAgentTurnId(steeringInput.turnId);
            if (
              activeTurn?.turnId !== turnId ||
              !activeTurn.owner.hasEntered() ||
              activeTurn.state.terminal ||
              activeTurn.pendingRequests.size > 0
            ) {
              throwAgentProviderContractError(
                providerKey,
                "active_turn_mismatch",
                "Provider steering does not identify a running turn.",
              );
            }
            const content = parseAgentTurnInputContent({
              parts: steeringInput.parts,
              ...(steeringInput.summary === undefined
                ? {}
                : { summary: steeringInput.summary }),
            });
            assertAgentTurnInputCapability({
              capability:
                capabilities.turns.steer.kind === "supported"
                  ? capabilities.turns.steer.input
                  : capabilities.input,
              parts: content.parts,
              providerKey,
            });
            const targetedActiveTurn = activeTurn;
            const settleSteering = trackActiveTurnOperation(targetedActiveTurn);
            try {
              try {
                const result = validateAgentTurnSteeringResult(
                  await declaredSteering.steerTurn({
                    turnId,
                    ...content,
                    ...(steeringInput.signal === undefined
                      ? {}
                      : { signal: steeringInput.signal }),
                  }),
                  providerKey,
                );
                if (result.status === "delivery_uncertain") unusable = true;
                return result;
              } catch (error) {
                unusable = true;
                throw new AgentProviderDelegatedOperationError(
                  providerKey,
                  "steer_turn",
                  error,
                );
              }
            } finally {
              settleSteering?.();
            }
          },
        });

  const declaredConfiguration = input.candidate.configuration;
  const configuration =
    declaredConfiguration.kind === "managed"
      ? Object.freeze({ kind: "managed" as const })
      : Object.freeze({
          kind: "selectable" as const,
          listConfiguration: async (
            listInput: Parameters<typeof declaredConfiguration.listConfiguration>[0] = {},
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(listInput.signal);
            return validateAgentConfigurationCatalogForCapabilities(
              capabilities,
              await declaredConfiguration.listConfiguration(
                listInput.signal === undefined ? {} : { signal: listInput.signal },
              ),
            );
          },
          applyConfigurationSelection: async (
            configurationInput: AgentProviderApplyConfigurationSelectionInput,
          ): Promise<AgentProviderOperationResult> => {
            requireUsable();
            throwIfAgentOperationAborted(configurationInput.signal);
            const catalog = validateAgentConfigurationCatalogForCapabilities(
              capabilities,
              await declaredConfiguration.listConfiguration(
                configurationInput.signal === undefined
                  ? {}
                  : { signal: configurationInput.signal },
              ),
            );
            let selection;
            try {
              selection = parseAgentConfigurationSelectionFor(
                catalog,
                configurationInput.selection,
              );
            } catch {
              return throwAgentProviderContractError(
                providerKey,
                "configuration_value_unsupported",
                "Configuration selection is stale or outside the offered catalog.",
              );
            }
            return delegateProviderMutation({
              operation: "apply_configuration",
              observer: configurationInput.onProviderExecutionStarted,
              invoke: (onProviderExecutionStarted) =>
                declaredConfiguration.applyConfigurationSelection({
                  selection,
                  onProviderExecutionStarted,
                  ...(configurationInput.signal === undefined
                    ? {}
                    : { signal: configurationInput.signal }),
                }),
              validate: (candidate) =>
                validateAgentProviderOperationResult(
                  candidate as AgentProviderOperationResult,
                  outputContext(),
                ),
            });
          },
        });

  const declaredOperations = input.candidate.operations;
  const operations =
    declaredOperations.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          listOperations: async (
            listInput: Parameters<typeof declaredOperations.listOperations>[0] = {},
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(listInput.signal);
            return validateAgentOperationCatalogForCapabilities(
              capabilities,
              await declaredOperations.listOperations(
                listInput.signal === undefined ? {} : { signal: listInput.signal },
              ),
            );
          },
          invokeOperation: async (
            operationInput: AgentProviderInvokeOperationInput,
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(operationInput.signal);
            let invocation: AgentOperationInvocation;
            let observationTurnId: AgentTurnId;
            try {
              invocation = parseAgentOperationInvocation(operationInput.invocation);
              observationTurnId = parseAgentTurnId(
                operationInput.observationTurnId,
              );
            } catch {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Operation invocation is invalid.",
              );
            }
            const catalog = validateAgentOperationCatalogForCapabilities(
              capabilities,
              await declaredOperations.listOperations(
                operationInput.signal === undefined
                  ? {}
                  : { signal: operationInput.signal },
              ),
            );
            const descriptor = catalog.operations.find(
              (operation) => operation.operationId === invocation.operationId,
            );
            if (descriptor === undefined) {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Operation invocation does not identify an offered operation.",
              );
            }
            try {
              invocation = parseAgentOperationInvocationFor(
                descriptor,
                invocation,
              );
            } catch {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Operation invocation is stale or outside the offered descriptor.",
              );
            }
            const existing = interactionState.operationInvocations.get(
              invocation.invocationId,
            );
            if (existing !== undefined) {
              if (JSON.stringify(existing.invocation) !== JSON.stringify(invocation)) {
                return throwAgentProviderContractError(
                  providerKey,
                  "input_operation_mismatch",
                  "Operation invocation ID was reused with conflicting input.",
                );
              }
              if (
                descriptor.idempotency === "required"
                && existing.result !== undefined
              ) {
                return existing.result;
              }
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Operation invocation ID is already active or is not replayable.",
              );
            }
            const trackedInvocation: TrackedAgentOperationInvocation = {
              invocation,
            };
            const observationState: AgentTurnSequenceState = {
              fileChangeMode: capabilities.output.fileChanges,
              observedItems: new Map(),
              proposedPlans: new Map(),
              generatedResourceIds: new Set(),
              started: true,
              terminal: false,
              finalDiffObserved: false,
            };
            interactionState.operationInvocations.set(
              invocation.invocationId,
              trackedInvocation,
            );
            try {
              const result = await delegateProviderMutation({
                operation: "invoke_operation",
                observer: operationInput.onProviderExecutionStarted,
                invoke: (onProviderExecutionStarted, onOutput) =>
                  declaredOperations.invokeOperation({
                    invocation,
                    observationTurnId,
                    onProviderExecutionStarted,
                    onOutput,
                    ...(operationInput.signal === undefined
                      ? {}
                      : { signal: operationInput.signal }),
                  }),
                observeOutput: async (candidate) => {
                  const output = validateAgentProviderOutputForContext(
                    candidate as AgentProviderOutput,
                    {
                      ...outputContext(observationTurnId),
                      operationInvocationId: invocation.invocationId,
                    },
                  );
                  observeSessionOperationOutput({
                    capabilities,
                    providerKey,
                    output,
                    state: observationState,
                    contextUsageState,
                    interactionState,
                  });
                  await operationInput.onOutput?.(output);
                },
                validate: (candidate) => {
                  const result = validateAgentOperationResultTransition({
                    providerKey,
                    candidate: validateAgentOperationResultForInvocation(
                      providerKey,
                      descriptor,
                      invocation,
                      candidate,
                    ),
                    previous: interactionState.operationResults.get(
                      invocation.invocationId,
                    ),
                  });
                  interactionState.operationResults.set(
                    result.invocationId,
                    result,
                  );
                  return result;
                },
              });
              trackedInvocation.result = result;
              return result;
            } catch (error) {
              if (!(error instanceof AgentProviderDelegatedOperationError)) {
                interactionState.operationInvocations.delete(
                  invocation.invocationId,
                );
              }
              throw error;
            }
          },
        });

  const declaredManagedContent = input.candidate.managedContent;
  const managedContent =
    declaredManagedContent.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          listManagedContent: async (
            listInput: Parameters<typeof declaredManagedContent.listManagedContent>[0] = {},
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(listInput.signal);
            return validateAgentManagedContentCatalogForCapabilities(
              capabilities,
              await declaredManagedContent.listManagedContent(
                listInput.signal === undefined ? {} : { signal: listInput.signal },
              ),
            );
          },
        });

  const declaredCollaboration = input.candidate.collaboration;
  const collaboration =
    declaredCollaboration.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          spawnCollaboration: async (
            collaborationInput: AgentProviderSpawnCollaborationInput,
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(collaborationInput.signal);
            let spawn;
            try {
              spawn = parseAgentCollaborationSpawnInput(collaborationInput.spawn);
            } catch {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Collaboration spawn input is invalid.",
              );
            }
            const capability = capabilities.collaboration;
            if (
              capability.kind !== "supported"
              || !capability.controlActions.includes("spawn")
              || !capability.roles.includes(spawn.role)
              || collaborationNodes.has(spawn.collaborationId)
              || collaborationSpawnReservations.has(spawn.collaborationId)
            ) {
              return throwAgentProviderContractError(
                providerKey,
                "input_capability_mismatch",
                "Collaboration spawn is outside the provider's declared capability.",
              );
            }
            const observedParent = spawn.parentCollaborationId === undefined
              ? undefined
              : collaborationNodes.get(spawn.parentCollaborationId);
            const admission = evaluateCollaborationGraphAdmission({
              capability,
              candidate: {
                collaborationId: spawn.collaborationId,
                rootCollaborationId:
                  observedParent?.rootCollaborationId ?? spawn.collaborationId,
                ...(spawn.parentCollaborationId === undefined
                  ? {}
                  : { parentCollaborationId: spawn.parentCollaborationId }),
                active: true,
              },
              nodes: collaborationNodes,
              reservations: collaborationSpawnReservations,
            });
            if (admission.kind === "conflict") {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Collaboration parent is unavailable in the canonical graph.",
              );
            }
            if (admission.kind === "capacity_exceeded") {
              return throwAgentProviderContractError(
                providerKey,
                "input_capability_mismatch",
                "Collaboration graph limit would be exceeded.",
              );
            }
            const parent = admission.parent;
            collaborationSpawnReservations.set(
              spawn.collaborationId,
              Object.freeze({
                ...(spawn.parentCollaborationId === undefined
                  ? {}
                  : { parentCollaborationId: spawn.parentCollaborationId }),
              }),
            );
            try {
              const node = await delegateProviderMutation({
                operation: "spawn_collaboration",
                observer: collaborationInput.onProviderExecutionStarted,
                invoke: (onProviderExecutionStarted) =>
                  declaredCollaboration.spawnCollaboration({
                    spawn,
                    onProviderExecutionStarted,
                    ...(collaborationInput.signal === undefined
                      ? {}
                      : { signal: collaborationInput.signal }),
                  }),
                validate: (candidate) => {
                  const node = validateAgentCollaborationNodeForCapabilities({
                    capabilities,
                    candidate,
                  });
                  if (
                    node.collaborationId !== spawn.collaborationId
                    || node.parentCollaborationId !== spawn.parentCollaborationId
                    || node.role !== spawn.role
                    || node.title !== spawn.title
                    || node.objective !== spawn.objective
                    || node.createdAt !== spawn.createdAt
                    || node.rootCollaborationId
                      !== (parent?.rootCollaborationId ?? spawn.collaborationId)
                  ) {
                    return throwAgentProviderContractError(
                      providerKey,
                      "output_collaboration_mismatch",
                      "Provider collaboration node does not match the spawn input.",
                    );
                  }
                  return node;
                },
              });
              collaborationNodes.set(node.collaborationId, node);
              collaborationSpawnReservations.delete(spawn.collaborationId);
              return node;
            } catch (error) {
              if (!(error instanceof AgentProviderDelegatedOperationError)) {
                collaborationSpawnReservations.delete(spawn.collaborationId);
              }
              throw error;
            }
          },
          controlCollaboration: async (
            collaborationInput: AgentProviderControlCollaborationInput,
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(collaborationInput.signal);
            let control;
            try {
              control = parseAgentCollaborationControlInput(
                collaborationInput.control,
              );
            } catch {
              return throwAgentProviderContractError(
                providerKey,
                "input_operation_mismatch",
                "Collaboration control input is invalid.",
              );
            }
            const capability = capabilities.collaboration;
            const previous = collaborationNodes.get(control.collaborationId);
            if (
              capability.kind !== "supported"
              || !capability.controlActions.includes(control.action)
              || previous === undefined
            ) {
              return throwAgentProviderContractError(
                providerKey,
                "input_capability_mismatch",
                "Collaboration control is outside the observed graph or declared capability.",
              );
            }
            const terminal = ["completed", "failed", "canceled"].includes(
              previous.status,
            );
            if (control.action === "close" && previous.closedAt !== undefined) {
              return previous;
            }
            if (
              (control.action === "close" && !terminal)
              || (control.action === "stop" && terminal)
              || (control.action === "steer" && terminal)
              || (control.action !== "inspect" && previous.closedAt !== undefined)
            ) {
              return throwAgentProviderContractError(
                providerKey,
                "input_capability_mismatch",
                "Collaboration control is unavailable in the current lifecycle state.",
              );
            }
            const node = await delegateProviderMutation({
              operation: "control_collaboration",
              observer: collaborationInput.onProviderExecutionStarted,
              invoke: (onProviderExecutionStarted) =>
                declaredCollaboration.controlCollaboration({
                  control,
                  onProviderExecutionStarted,
                  ...(collaborationInput.signal === undefined
                    ? {}
                    : { signal: collaborationInput.signal }),
                }),
              validate: (candidate) => {
                const validated = validateAgentCollaborationNodeForCapabilities({
                  capabilities,
                  candidate,
                  previous,
                });
                if (
                  (control.action === "stop" && validated.status !== "canceled")
                  || (
                    control.action === "close"
                    && (
                      validated.status !== previous.status
                      || validated.closedAt === undefined
                    )
                  )
                ) {
                  return throwAgentProviderContractError(
                    providerKey,
                    "output_collaboration_mismatch",
                    "Provider collaboration result does not settle the requested control action.",
                  );
                }
                return validated;
              },
            });
            collaborationNodes.set(node.collaborationId, node);
            return node;
          },
        });

  function validateGeneratedResourceInspection(
    candidate: unknown,
    resourceId: string,
  ): AgentGeneratedResourceInspection {
    if (
      candidate === null
      || typeof candidate !== "object"
      || !hasExactOwnKeys(candidate, [
        "descriptor",
        ...("candidate" in candidate ? ["candidate"] : []),
      ])
    ) {
      return throwAgentProviderContractError(
        providerKey,
        "output_resource_mismatch",
        "Provider returned an invalid generated-resource inspection.",
      );
    }
    const rawInspection = candidate as Readonly<{
      descriptor?: unknown;
      candidate?: unknown;
    }>;
    const descriptor = validateAgentGeneratedResourceForCapabilities({
      capabilities,
      candidate: rawInspection.descriptor,
      expectedResourceId: resourceId,
      previous: interactionState.generatedResources.get(resourceId),
    });
    const hasCandidate = Object.prototype.hasOwnProperty.call(
      rawInspection,
      "candidate",
    );
    if ((descriptor.status === "available") !== hasCandidate) {
      return throwAgentProviderContractError(
        providerKey,
        "output_resource_mismatch",
        "Exactly available generated resources must include owned artifact bytes.",
      );
    }
    if (!hasCandidate) return Object.freeze({ descriptor });

    let artifactCandidate: AgentArtifactCandidate;
    try {
      artifactCandidate = createAgentArtifactCandidate(
        rawInspection.candidate as AgentArtifactCandidate,
      );
    } catch {
      return throwAgentProviderContractError(
        providerKey,
        "output_resource_mismatch",
        "Provider returned invalid generated-resource artifact bytes.",
      );
    }
    const artifact = artifactCandidate.descriptor;
    const expectedArtifactKind = descriptor.kind === "image" ? "image" : "file";
    if (
      artifactCandidate.delivery !== "required_before_reference"
      || artifact.artifactId !== descriptor.artifactId
      || artifact.kind !== expectedArtifactKind
      || artifact.displayName !== descriptor.displayName
      || artifact.mediaType !== descriptor.mediaType
      || artifact.byteSize !== descriptor.byteSize
      || artifact.digest?.algorithm !== "sha256"
      || artifact.digest?.value !== descriptor.sha256
      || artifact.summary !== descriptor.summary
    ) {
      return throwAgentProviderContractError(
        providerKey,
        "output_resource_mismatch",
        "Generated-resource metadata does not match its immutable artifact candidate.",
      );
    }
    return Object.freeze({ descriptor, candidate: artifactCandidate });
  }

  const declaredGeneratedResources = input.candidate.generatedResources;
  const generatedResources =
    declaredGeneratedResources.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          getGeneratedResource: async (
            resourceInput: AgentProviderGetGeneratedResourceInput,
          ) => {
            requireUsable();
            throwIfAgentOperationAborted(resourceInput.signal);
            const resourceId = parseAgentGeneratedResourceId(
              resourceInput.resourceId,
            );
            const inspection = validateGeneratedResourceInspection(
              await declaredGeneratedResources.getGeneratedResource({
                resourceId,
                ...(resourceInput.signal === undefined
                  ? {}
                  : { signal: resourceInput.signal }),
              }),
              resourceId,
            );
            interactionState.generatedResources.set(
              inspection.descriptor.resourceId,
              inspection.descriptor,
            );
            return inspection;
          },
        });

  const closeOwned = (closeInput: AgentProviderCloseSessionInput, explicit: boolean): Promise<void> => {
    if (closed && !input.sessionInteractionOwner) return Promise.resolve();
    if (!input.sessionInteractionOwner && closePromise) return closePromise;
    throwIfAgentOperationAborted(closeInput.signal);
    validateCloseReason(closeInput.reason);
    unusable = true;
    sessionLifetime.abort(new DOMException("The provider session was closed.", "AbortError"));
    input.hostBindingLease?.stop();
    const closingTurn = activeTurn;
    closingTurn?.owner.stop(new DOMException("The provider session was closed.", "AbortError"));
    const cleanup = async (): Promise<void> => {
      if (!providerClosed) {
        await input.candidate.close(closeInput);
        providerClosed = true;
      }
      await input.sessionInteractionOwner?.join();
      await closingTurn?.owner.join();
      await input.hostBindingLease?.release();
      closed = true;
    };
    if (input.sessionInteractionOwner) return input.sessionInteractionOwner.close(cleanup, explicit);
    closePromise = Promise.resolve().then(cleanup).finally(() => { closePromise = null; });
    return closePromise;
  };

  const close = (closeInput: AgentProviderCloseSessionInput): Promise<void> => closeOwned(closeInput, true);
  input.sessionInteractionOwner?.installClose(() => closeOwned({ reason: "error" }, false));

  return Object.freeze({
    binding,
    startTurn,
    interruption,
    steering,
    configuration,
    operations,
    managedContent,
    environment,
    collaboration,
    generatedResources,
    close,
  });
}

export async function closeRejectedAgentProviderSession(
  session: AgentProviderSession | null,
  error: unknown,
  hostBinding?: Readonly<{ providerKey: AgentProviderKey; lease: AgentHostBindingLease }>,
  opening?: Readonly<{ providerKey: AgentProviderKey; input: object }>,
  interactions?: SessionInteractionOwner,
): Promise<never> {
  if (!session) throw error;
  hostBinding?.lease.stop();
  interactions?.stop();
  let providerClosed = false;
  const cleanup = async (): Promise<void> => {
    if (!providerClosed) {
      if (typeof session.close !== "function") {
        throw new TypeError("Rejected provider session has no callable close port.");
      }
      await session.close({ reason: "contract_rejected" });
      providerClosed = true;
    }
    await interactions?.join();
    await hostBinding?.lease.release();
  };
  try {
    if (interactions) await interactions.close(cleanup, false);
    else await cleanup();
  } catch (cleanupError) {
    if (hostBinding) {
      const retained = createAgentHostBindingCleanupError({
        providerKey: hostBinding.providerKey,
        lease: hostBinding.lease,
        errors: [error, cleanupError],
        retryCleanup: () => interactions ? interactions.close(cleanup, false) : cleanup(),
      });
      throw opening ? associateAgentSessionCleanupError(retained, opening.input) : retained;
    }
    if (opening) throw associateAgentSessionCleanupError(new AgentProviderSessionCleanupError({
      providerKey: opening.providerKey, errors: [error, cleanupError],
      retryCleanup: () => interactions ? interactions.close(cleanup, false) : cleanup(),
    }), opening.input);
    throw new AggregateError(
      [error, cleanupError],
      "Provider returned an invalid session and cleanup failed.",
    );
  }
  throw error;
}

interface BindingTracker {
  readonly observe: AgentSessionBindingCreatedObserver;
  readonly requireMatch: (binding: AgentSessionBinding) => void;
}

function bindingTracker(input: {
  readonly providerKey: AgentProviderKey;
  readonly observer: AgentSessionBindingCreatedObserver;
  readonly sourceBinding?: AgentSessionBinding;
}): BindingTracker {
  let observed: AgentSessionBinding | null = null;
  return {
    observe(candidate) {
      if (observed) {
        throwAgentProviderContractError(
          input.providerKey,
          "binding_callback_repeated",
          "Provider reported session binding creation more than once.",
        );
      }
      let binding: AgentSessionBinding;
      try {
        binding = parseAgentSessionBinding(candidate);
      } catch {
        throwAgentProviderContractError(
          input.providerKey,
          "invalid_binding",
          "Provider reported an invalid binding.",
        );
      }
      if (
        input.sourceBinding &&
        matchesAgentSessionBinding(binding, input.sourceBinding)
      ) {
        throwAgentProviderContractError(
          input.providerKey,
          "branch_binding_reused",
          "Provider branch reused its source binding.",
        );
      }
      input.observer(binding);
      observed = binding;
    },
    requireMatch(binding) {
      if (!observed) {
        throwAgentProviderContractError(
          input.providerKey,
          "binding_callback_missing",
          "Provider did not report binding creation before returning a session.",
        );
      }
      if (!matchesAgentSessionBinding(observed, binding)) {
        throwAgentProviderContractError(
          input.providerKey,
          "binding_callback_mismatch",
          "Provider returned a different binding than it reported.",
        );
      }
    },
  };
}

export async function openIdentityCreatingAgentProviderSession(input: {
  readonly capabilities: AgentCapabilities;
  readonly sessionId: AgentSessionId;
  readonly observer: AgentSessionBindingCreatedObserver;
  readonly sourceBinding?: AgentSessionBinding;
  readonly hostBindingLease?: AgentHostBindingLease;
  readonly openingInput?: object;
  readonly sessionInteractionOwner?: SessionInteractionOwner;
  readonly open: (
    observer: AgentSessionBindingCreatedObserver,
  ) => MaybePromise<AgentProviderSession>;
}): Promise<AgentProviderSession> {
  const tracker = bindingTracker({
    providerKey: input.capabilities.providerKey,
    observer: input.observer,
    ...(input.sourceBinding === undefined
      ? {}
      : { sourceBinding: input.sourceBinding }),
  });
  let candidate: AgentProviderSession | null = null;
  try {
    candidate = await input.open(tracker.observe);
    const session = validateAgentProviderSession({
      capabilities: input.capabilities,
      sessionId: input.sessionId,
      candidate,
      ...(input.sessionInteractionOwner === undefined ? {} : { sessionInteractionOwner: input.sessionInteractionOwner }),
      ...(input.hostBindingLease === undefined ? {} : { hostBindingLease: input.hostBindingLease }),
      ...(input.sourceBinding === undefined
        ? {}
        : { sourceBinding: input.sourceBinding }),
    });
    tracker.requireMatch(session.binding);
    input.sessionInteractionOwner?.adopt();
    return session;
  } catch (error) {
    return closeRejectedAgentProviderSession(candidate, error,
      input.hostBindingLease === undefined ? undefined : {
        providerKey: input.capabilities.providerKey, lease: input.hostBindingLease,
      }, input.openingInput === undefined ? undefined : { providerKey: input.capabilities.providerKey, input: input.openingInput }, input.sessionInteractionOwner);
  }
}

// ------------------------------------------------------------------------------------------------
