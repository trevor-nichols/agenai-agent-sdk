// ------------------------------------------------------------------------------------------------
//                sessionValidation.ts - Session lifecycle and operation enforcement - Dependencies: protocol, runtime contracts
// ------------------------------------------------------------------------------------------------

import {
  matchesAgentSessionBinding,
  parseAgentRequestResolution,
  parseAgentRequestResolutionFor,
  parseAgentSessionBinding,
  parseAgentSessionConfiguration,
  parseAgentTurnId,
  parseAgentTurnInputContent,
  parseAgentTurnInterruptionInput,
  parseAgentTurnRunInput,
  type AgentCapabilities,
  type AgentContextCumulativeUsage,
  type AgentContextMeasurementScope,
  type AgentContextUsage,
  type AgentEvent,
  type AgentItemKind,
  type AgentItemStatus,
  type AgentOperationInputCapability,
  type AgentProviderKey,
  type AgentRequest,
  type AgentSessionBinding,
  type AgentSessionId,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  assertAgentSessionConfigurationSupported,
} from "./configurationValidation.js";
import {
  AgentProviderDelegatedOperationError,
  throwAgentProviderContractError,
} from "./contractErrors.js";
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
  AgentProviderApplyConfigurationInput,
  AgentProviderCloseSessionInput,
  AgentProviderInterruptTurnInput,
  AgentProviderOperationResult,
  AgentProviderResolveRequestInput,
  AgentProviderRunTurnInput,
  AgentProviderSession,
  AgentSessionBindingCreatedObserver,
  AgentTurnSteeringResult,
} from "./sessions.js";
import { validateAgentTurnSteeringResult } from "./steeringValidation.js";

//                Session Validation
// ------------------------------------------------------------------------------------------------

function validateSessionPorts(
  capabilities: AgentCapabilities,
  session: AgentProviderSession,
): void {
  if (
    typeof session.runTurn !== "function" ||
    typeof session.resolveRequest !== "function" ||
    typeof session.close !== "function" ||
    session.interruption === null ||
    typeof session.interruption !== "object" ||
    !["supported", "unsupported"].includes(session.interruption.kind) ||
    session.steering === null ||
    typeof session.steering !== "object" ||
    !["supported", "unsupported"].includes(session.steering.kind) ||
    session.configuration === null ||
    typeof session.configuration !== "object" ||
    !["managed", "selectable"].includes(session.configuration.kind)
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "invalid_session",
      `Provider ${capabilities.providerKey} returned an incomplete session.`,
    );
  }
  if (
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
      typeof session.configuration.applyConfiguration !== "function")
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "capability_port_mismatch",
      `Provider ${capabilities.providerKey} session ports do not match its capabilities.`,
    );
  }
}

interface PendingAgentRequest {
  readonly request: AgentRequest;
  readonly turnId: AgentTurnId;
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
  started: boolean;
  terminal: boolean;
  waiting: boolean;
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

interface ActiveAgentTurn {
  readonly turnId: AgentTurnId;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly state: AgentTurnSequenceState;
  readonly inFlightOperations: Set<Promise<void>>;
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
  input.state.waiting = false;
}

const FINAL_DIFF_TRAILING_EVENT_TYPES: readonly AgentEvent["type"][] = [
  "artifact.referenced",
  "provider.diagnostic",
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
  if (item?.status !== "pending" && item?.status !== "in_progress") {
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

function observeTurnEvent(input: {
  readonly providerKey: AgentProviderKey;
  readonly event: AgentEvent;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly openedRequestIds: Set<string>;
  readonly contextUsageState: AgentContextUsageSequenceState;
}): void {
  const {
    contextUsageState,
    event,
    openedRequestIds,
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
    pendingRequests.set(requestId, {
      request: event.payload.request,
      turnId: event.turnId,
    });
  }
  if (event.type === "turn.state_changed") {
    state.waiting = event.payload.state === "waiting_for_request";
    if (
      state.waiting &&
      !pendingRequests.has(event.payload.requestId as string)
    ) {
      invalidTurnSequence(
        providerKey,
        "Provider entered a waiting state for a request it did not open.",
      );
    }
  }
  if (event.type === "turn.completed") {
    completeTurnSequence({ providerKey, state, pendingRequests });
  }
}

function assertStableTurnBoundary(input: {
  readonly providerKey: AgentProviderKey;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: ReadonlyMap<string, PendingAgentRequest>;
}): void {
  const terminal = input.state.terminal && !input.state.waiting;
  const waiting =
    !input.state.terminal &&
    input.state.waiting &&
    input.pendingRequests.size === 1;
  if ((terminal && input.pendingRequests.size === 0) || waiting) return;
  invalidTurnSequence(
    input.providerKey,
    "Provider turn must finish with completion or exactly one pending request.",
  );
}

function replacePendingRequests(
  target: Map<string, PendingAgentRequest>,
  source: ReadonlyMap<string, PendingAgentRequest>,
): void {
  target.clear();
  for (const [requestId, pending] of source) target.set(requestId, pending);
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

function interruptionTerminalizesTurn(input: {
  readonly turnId: AgentTurnId;
  readonly result: AgentProviderOperationResult;
}): boolean {
  if (["completed", "canceled"].includes(input.result.status)) {
    return true;
  }
  return (input.result.outputs ?? []).some(
    (output) =>
      output.kind === "event" &&
      output.event.turnId === input.turnId &&
      output.event.type === "turn.completed",
  );
}

function observeTurnOperationOutputs(input: {
  readonly providerKey: AgentProviderKey;
  readonly outputs: readonly AgentProviderOutput[] | undefined;
  readonly state: AgentTurnSequenceState;
  readonly pendingRequests: Map<string, PendingAgentRequest>;
  readonly openedRequestIds: Set<string>;
  readonly contextUsageState: AgentContextUsageSequenceState;
}): void {
  for (const output of input.outputs ?? []) {
    if (output.kind !== "event") continue;
    observeTurnEvent({
      providerKey: input.providerKey,
      event: output.event,
      state: input.state,
      pendingRequests: input.pendingRequests,
      openedRequestIds: input.openedRequestIds,
      contextUsageState: input.contextUsageState,
    });
  }
}

function reconstructWaitingTurn(input: {
  readonly pendingRequests: ReadonlyMap<string, PendingAgentRequest>;
  readonly turnId: AgentTurnId;
  readonly state: AgentTurnSequenceState | undefined;
}): Pick<ActiveAgentTurn, "state" | "pendingRequests"> | null {
  const targetedPendingRequests = new Map(
    [...input.pendingRequests].filter(
      ([, pending]) => pending.turnId === input.turnId,
    ),
  );
  if (
    targetedPendingRequests.size === 0
    || input.state === undefined
    || input.state.terminal
    || !input.state.waiting
  ) return null;
  return {
    state: input.state,
    pendingRequests: targetedPendingRequests,
  };
}

function clearPendingRequestsForTurn(
  pendingRequests: Map<string, PendingAgentRequest>,
  turnId: AgentTurnId,
): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.turnId === turnId) pendingRequests.delete(requestId);
  }
}

function assertAgentTurnInputCapability(input: {
  readonly capability: AgentOperationInputCapability;
  readonly parts: AgentProviderRunTurnInput["parts"];
  readonly providerKey: AgentProviderKey;
}): void {
  const imageParts = input.parts.filter((part) => part.type === "image");
  if (imageParts.length === 0) return;

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

export function validateAgentProviderSession(input: {
  readonly capabilities: AgentCapabilities;
  readonly sessionId: AgentSessionId;
  readonly candidate: AgentProviderSession;
  readonly expectedBinding?: AgentSessionBinding;
  readonly sourceBinding?: AgentSessionBinding;
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

  const pendingRequests = new Map<string, PendingAgentRequest>();
  const waitingTurnStates = new Map<AgentTurnId, AgentTurnSequenceState>();
  const openedRequestIds = new Set<string>();
  const contextUsageState: AgentContextUsageSequenceState = {
    latestByScope: new Map<AgentContextMeasurementScope, AgentContextUsage>(),
    cumulativeByScope: new Map<
      AgentContextMeasurementScope,
      AgentContextCumulativeUsage
    >(),
    compactionReadyScopes: new Set<AgentContextMeasurementScope>(),
  };
  let activeTurn: ActiveAgentTurn | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;
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
  const delegateOperation = async (
    operation: () => MaybePromise<AgentProviderOperationResult>,
    turnId?: AgentTurnId,
  ): Promise<AgentProviderOperationResult> => {
    try {
      return validateAgentProviderOperationResult(
        await operation(),
        outputContext(turnId),
      );
    } catch (error) {
      unusable = true;
      throw error;
    }
  };

  const runTurn = async function* (
    turnInput: AgentProviderRunTurnInput,
  ): AsyncIterable<AgentProviderOutput> {
    requireUsable();
    throwIfAgentOperationAborted(turnInput.signal);
    const parsedInput = parseAgentTurnRunInput({
      turnId: turnInput.turnId,
      interactionMode: turnInput.interactionMode,
      parts: turnInput.parts,
      ...(turnInput.summary === undefined
        ? {}
        : { summary: turnInput.summary }),
      ...(turnInput.deadlineAt === undefined
        ? {}
        : { deadlineAt: turnInput.deadlineAt }),
    });
    assertAgentTurnInputCapability({
      capability: capabilities.input,
      parts: parsedInput.parts,
      providerKey,
    });
    if (!capabilities.turns.interactionModes.includes(parsedInput.interactionMode)) {
      throwAgentProviderContractError(
        providerKey,
        "input_capability_mismatch",
        `Provider ${providerKey} does not support ${parsedInput.interactionMode} turn interaction mode.`,
      );
    }
    if (pendingRequests.size > 0) {
      throwAgentProviderContractError(
        providerKey,
        "request_pending",
        "Provider session cannot start another turn while a request is pending.",
      );
    }
    if (activeTurn !== null) {
      throwAgentProviderContractError(
        providerKey,
        "concurrent_turn",
        "Provider session already has an active turn.",
      );
    }
    let reachedStableBoundary = false;
    const currentTurn: ActiveAgentTurn = {
      turnId: parsedInput.turnId,
      pendingRequests: new Map<string, PendingAgentRequest>(),
      state: {
        fileChangeMode: capabilities.output.fileChanges,
        observedItems: new Map<string, ObservedAgentItem>(),
        proposedPlans: new Map<string, string>(),
        started: false,
        terminal: false,
        waiting: false,
        finalDiffObserved: false,
      },
      inFlightOperations: new Set<Promise<void>>(),
    };
    activeTurn = currentTurn;
    try {
      turnInput.onProviderExecutionStarted?.();
      for await (const candidate of input.candidate.runTurn({
        ...parsedInput,
        ...(turnInput.signal === undefined ? {} : { signal: turnInput.signal }),
      })) {
        const output = validateAgentProviderOutputForContext(
          candidate,
          outputContext(parsedInput.turnId),
        );
        if (output.kind === "event") {
          observeTurnEvent({
            providerKey,
            event: output.event,
            state: currentTurn.state,
            pendingRequests: currentTurn.pendingRequests,
            openedRequestIds,
            contextUsageState,
          });
        }
        yield output;
      }
      while (currentTurn.inFlightOperations.size > 0) {
        await Promise.all(currentTurn.inFlightOperations);
      }
      if (!currentTurn.state.started) {
        invalidTurnSequence(
          providerKey,
          "Provider turn must emit turn.started before reaching a stable boundary.",
        );
      }
      assertStableTurnBoundary({
        providerKey,
        state: currentTurn.state,
        pendingRequests: currentTurn.pendingRequests,
      });
      if (currentTurn.state.waiting) {
        replacePendingRequests(pendingRequests, currentTurn.pendingRequests);
        waitingTurnStates.set(currentTurn.turnId, currentTurn.state);
      } else {
        waitingTurnStates.delete(currentTurn.turnId);
      }
      reachedStableBoundary = true;
    } finally {
      if (!reachedStableBoundary) unusable = true;
      if (activeTurn === currentTurn) activeTurn = null;
    }
  };

  const resolveRequest = async function* (
    requestInput: AgentProviderResolveRequestInput,
  ): AsyncIterable<AgentProviderOutput> {
    requireUsable();
    throwIfAgentOperationAborted(requestInput.signal);
    const resolution = parseAgentRequestResolution(requestInput.resolution);
    const pending = pendingRequests.get(resolution.requestId);
    if (!pending) {
      throwAgentProviderContractError(
        providerKey,
        "request_resolution_mismatch",
        "Provider request resolution does not identify a pending request.",
      );
    }
    try {
      parseAgentRequestResolutionFor(pending.request, resolution);
    } catch {
      throwAgentProviderContractError(
        providerKey,
        "request_resolution_mismatch",
        "Provider request resolution does not match the opened request.",
      );
    }
    if (
      pending.request.expiresAt !== undefined
      && Date.parse(pending.request.expiresAt) <= Date.now()
      && resolution.disposition !== "canceled"
    ) {
      throwAgentProviderContractError(
        providerKey,
        "request_resolution_mismatch",
        "Provider request resolution identifies an expired request.",
      );
    }
    const nextPendingRequests = new Map(pendingRequests);
    nextPendingRequests.delete(resolution.requestId);
    if (activeTurn !== null) {
      throwAgentProviderContractError(
        providerKey,
        "concurrent_turn",
        "Provider session already has an active turn.",
      );
    }
    const waitingTurnState = waitingTurnStates.get(pending.turnId);
    if (
      waitingTurnState === undefined
      || waitingTurnState.terminal
      || !waitingTurnState.waiting
    ) {
      throwAgentProviderContractError(
        providerKey,
        "request_resolution_mismatch",
        "Provider request resolution does not identify a waiting turn.",
      );
    }
    waitingTurnState.waiting = false;
    const currentTurn: ActiveAgentTurn = {
      turnId: pending.turnId,
      pendingRequests: nextPendingRequests,
      state: waitingTurnState,
      inFlightOperations: new Set<Promise<void>>(),
    };
    let reachedStableBoundary = false;
    activeTurn = currentTurn;
    try {
      for await (const candidate of input.candidate.resolveRequest({
        resolution,
        ...(requestInput.signal === undefined
          ? {}
          : { signal: requestInput.signal }),
      })) {
        const output = validateAgentProviderOutputForContext(
          candidate,
          outputContext(pending.turnId),
        );
        if (output.kind === "event") {
          observeTurnEvent({
            providerKey,
            event: output.event,
            state: currentTurn.state,
            pendingRequests: currentTurn.pendingRequests,
            openedRequestIds,
            contextUsageState,
          });
        }
        yield output;
      }
      while (currentTurn.inFlightOperations.size > 0) {
        await Promise.all(currentTurn.inFlightOperations);
      }
      assertStableTurnBoundary({
        providerKey,
        state: currentTurn.state,
        pendingRequests: currentTurn.pendingRequests,
      });
      replacePendingRequests(pendingRequests, currentTurn.pendingRequests);
      if (currentTurn.state.waiting) {
        waitingTurnStates.set(currentTurn.turnId, currentTurn.state);
      } else {
        waitingTurnStates.delete(currentTurn.turnId);
      }
      reachedStableBoundary = true;
    } finally {
      if (!reachedStableBoundary) unusable = true;
      if (activeTurn === currentTurn) activeTurn = null;
    }
  };

  const declaredInterruption = input.candidate.interruption;
  const interruption =
    declaredInterruption.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          interruptTurn: async (
            interruptionInput: AgentProviderInterruptTurnInput,
          ): Promise<AgentProviderOperationResult> => {
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
            const targetedWaitingTurn = targetedActiveTurn === null
              ? reconstructWaitingTurn({
                  pendingRequests,
                  turnId: parsed.turnId,
                  state: waitingTurnStates.get(parsed.turnId),
                })
              : null;
            const targetedTurn = targetedActiveTurn ?? targetedWaitingTurn;
            if (targetedTurn === null) {
              throwAgentProviderContractError(
                providerKey,
                "active_turn_mismatch",
                "Provider interruption does not identify an active or waiting turn.",
              );
            }
            const settleActiveInterruption = trackActiveTurnOperation(
              targetedActiveTurn,
            );
            try {
              const result = await delegateOperation(
                () =>
                  declaredInterruption.interruptTurn({
                    ...parsed,
                    ...(interruptionInput.signal === undefined
                      ? {}
                      : { signal: interruptionInput.signal }),
                  }),
                parsed.turnId,
              );
              const terminalized = interruptionTerminalizesTurn({
                turnId: parsed.turnId,
                result,
              });
              if (terminalized || result.status === "accepted") {
                clearPendingRequestsForTurn(pendingRequests, parsed.turnId);
                clearPendingRequestsForTurn(
                  targetedTurn.pendingRequests,
                  parsed.turnId,
                );
                targetedTurn.state.waiting = false;
                waitingTurnStates.delete(parsed.turnId);
              }
              try {
                observeTurnOperationOutputs({
                  providerKey,
                  outputs: result.outputs,
                  state: targetedTurn.state,
                  pendingRequests: targetedTurn.pendingRequests,
                  openedRequestIds,
                  contextUsageState,
                });
                if (terminalized && !targetedTurn.state.terminal) {
                  completeTurnSequence({
                    providerKey,
                    state: targetedTurn.state,
                    pendingRequests: targetedTurn.pendingRequests,
                  });
                }
              } catch (error) {
                unusable = true;
                throw error;
              }
              if (
                result.status === "accepted" &&
                targetedWaitingTurn !== null &&
                !terminalized
              ) {
                unusable = true;
              }
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
              activeTurn.state.terminal ||
              activeTurn.state.waiting
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
                return validateAgentTurnSteeringResult(
                  await declaredSteering.steerTurn({
                    turnId,
                    ...content,
                    ...(steeringInput.signal === undefined
                      ? {}
                      : { signal: steeringInput.signal }),
                  }),
                  providerKey,
                );
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
          applyConfiguration: async (
            configurationInput: AgentProviderApplyConfigurationInput,
          ): Promise<AgentProviderOperationResult> => {
            requireUsable();
            throwIfAgentOperationAborted(configurationInput.signal);
            const configuration = parseAgentSessionConfiguration(
              configurationInput.configuration,
            );
            assertAgentSessionConfigurationSupported(
              capabilities,
              configuration,
            );
            return delegateOperation(
              () =>
                declaredConfiguration.applyConfiguration({
                  configuration,
                  ...(configurationInput.signal === undefined
                    ? {}
                    : { signal: configurationInput.signal }),
                }),
            );
          },
        });

  const close = (closeInput: AgentProviderCloseSessionInput): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    throwIfAgentOperationAborted(closeInput.signal);
    if (
      closeInput.reason !== undefined &&
      ![
        "idle",
        "shutdown",
        "replaced",
        "contract_rejected",
        "error",
        "other",
      ].includes(closeInput.reason)
    ) {
      throw new TypeError("Provider session close reason is unsupported.");
    }
    unusable = true;
    closePromise = Promise.resolve()
      .then(() => input.candidate.close(closeInput))
      .then(() => {
        closed = true;
      })
      .finally(() => {
        closePromise = null;
      });
    return closePromise;
  };

  return Object.freeze({
    binding,
    runTurn,
    resolveRequest,
    interruption,
    steering,
    configuration,
    close,
  });
}

export async function closeRejectedAgentProviderSession(
  session: AgentProviderSession | null,
  error: unknown,
): Promise<never> {
  if (!session || typeof session.close !== "function") throw error;
  try {
    await session.close({ reason: "contract_rejected" });
  } catch (cleanupError) {
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
      ...(input.sourceBinding === undefined
        ? {}
        : { sourceBinding: input.sourceBinding }),
    });
    tracker.requireMatch(session.binding);
    return session;
  } catch (error) {
    return closeRejectedAgentProviderSession(candidate, error);
  }
}

// ------------------------------------------------------------------------------------------------
