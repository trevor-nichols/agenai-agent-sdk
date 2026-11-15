// ------------------------------------------------------------------------------------------------
//                ledger.ts - Transactional token-usage admission - Dependencies: scope accounting
// ------------------------------------------------------------------------------------------------

import {
  AGENT_TOKEN_USAGE_LIMITS,
  parseAgentSessionId,
  safeParseAgentUsageObservedEvent,
  type AgentSessionId,
  type AgentTokenUsageObservation,
  type AgentUsageObservedEvent,
  type AgentUsageScopeId,
  type ValidationIssue,
} from "@agen-ai/agent-protocol";

import { canonicalUsageJson, deepFreeze, usageJsonBytes } from "./canonical.js";
import { checkedAdd, mapCounters } from "./counts.js";
import {
  usageLedgerState,
  wrapUsageLedger,
  type UsageLedgerState,
  type UsageScopeState,
  type UsageViewState,
} from "./ledgerState.js";
import { rejectUsage, TokenUsageRejection } from "./rejection.js";
import { applyScopeObservation, scopeContribution, scopeMagnitude } from "./scopeAccounting.js";
import {
  AGENT_TOKEN_USAGE_LEDGER_LIMITS as LIMITS,
  type AgentTokenUsageAdmission,
  type AgentTokenUsageErrorCode,
  type AgentTokenUsageLedger,
} from "./types.js";

const EMPTY_MAGNITUDE = mapCounters(() => 0);

// ------------------------------------------------------------------------------------------------
//                Boundary Classification
// ------------------------------------------------------------------------------------------------

const CAPACITY_PATHS = new Set(["payload.measurement.epoch", "payload.measurement.attribution.rows"]);

/** Epoch and model-row maxima are capacity limits; every other parse issue is invalid usage. */
export function classifyTokenUsageEventIssues(issues: readonly ValidationIssue[]): AgentTokenUsageErrorCode {
  return issues.length > 0 && issues.every((issue) => issue.code === "too_big" && CAPACITY_PATHS.has(issue.path.join(".")))
    ? "usage_capacity_exceeded"
    : "usage_invalid";
}

const envelopeSessionId = (event: unknown): unknown =>
  event !== null && typeof event === "object" && "sessionId" in event ? event.sessionId : undefined;

// ------------------------------------------------------------------------------------------------
//                Views and Scopes
// ------------------------------------------------------------------------------------------------

function admitView(state: UsageLedgerState, observation: AgentTokenUsageObservation): UsageViewState {
  const { view, scope } = observation;
  const canonical = canonicalUsageJson(view);
  const prior = state.views.get(view.viewId);
  if (prior !== undefined) {
    if (prior.canonical !== canonical || prior.scopeKind !== scope.kind) {
      rejectUsage("usage_scope_mismatch", "A usage view descriptor and its scope kind are immutable.");
    }
    return prior;
  }
  if (state.views.size >= AGENT_TOKEN_USAGE_LIMITS.views) rejectUsage("usage_capacity_exceeded", "Usage view capacity is exhausted.");
  if (view.authority === "authoritative" && state.authoritativeViewId !== null) {
    rejectUsage("usage_scope_mismatch", "A session has at most one authoritative usage view.");
  }
  return { canonical, view, scopeKind: scope.kind, scopeIds: [], magnitude: EMPTY_MAGNITUDE };
}

type ScopeAdmission = Readonly<{ prior: UsageScopeState | undefined; canonical: string; semanticKey: string | null }>;

function admitScope(state: UsageLedgerState, observation: AgentTokenUsageObservation): ScopeAdmission {
  const { view: { viewId }, scope } = observation;
  const canonical = canonicalUsageJson([viewId, scope]);
  const prior = state.scopes.get(scope.scopeId);
  if (prior !== undefined) {
    if (prior.canonical !== canonical) rejectUsage("usage_scope_mismatch", "A usage scope descriptor is immutable.");
    if (prior.final) rejectUsage("usage_sequence_invalid", "The usage scope already settled with a final observation.");
    return { prior, canonical, semanticKey: null };
  }
  if (state.scopes.size >= LIMITS.scopes) rejectUsage("usage_capacity_exceeded", "Usage scope capacity is exhausted.");
  const semanticKey = scope.kind === "turn" ? canonicalUsageJson([viewId, "turn", scope.turnId])
    : scope.kind === "session" ? canonicalUsageJson([viewId, "session"]) : null;
  if (semanticKey !== null && state.semanticScopes.has(semanticKey)) {
    rejectUsage("usage_scope_mismatch", "One session or SDK turn cannot have two accounting scopes in a view.");
  }
  const containedIn = "containedIn" in scope ? scope.containedIn : undefined;
  const container = containedIn === undefined ? undefined : state.scopes.get(containedIn);
  if (container?.viewId === viewId || state.containers.get(scope.scopeId)?.includes(viewId)) {
    rejectUsage("usage_scope_mismatch", "A contained scope must belong to another view than its container.");
  }
  return { prior: undefined, canonical, semanticKey };
}

// ------------------------------------------------------------------------------------------------
//                Admission
// ------------------------------------------------------------------------------------------------

function admit(ledger: AgentTokenUsageLedger, event: AgentUsageObservedEvent): AgentTokenUsageAdmission {
  const state = usageLedgerState(ledger);
  if (event.sessionId !== state.sessionId) rejectUsage("usage_scope_mismatch", "The observation belongs to another session.");
  const observation = event.payload;
  const canonical = canonicalUsageJson(observation);
  const bytes = usageJsonBytes(canonical);
  if (bytes > LIMITS.observationBytes) {
    rejectUsage("usage_capacity_exceeded", `The observation exceeds ${LIMITS.observationBytes} canonical bytes.`);
  }
  const retained = state.observations.get(observation.observationId);
  if (retained === canonical) return Object.freeze({ status: "duplicate", ledger });
  if (retained !== undefined) rejectUsage("usage_identity_conflict", "An observation identity was reused with different content.");
  const { measurement, scope, view } = observation;
  const revisionKey = measurement.kind === "snapshot"
    ? canonicalUsageJson([scope.scopeId, measurement.epoch, measurement.revision])
    : null;
  if (revisionKey !== null && state.snapshotRevisions.has(revisionKey)) {
    rejectUsage("usage_identity_conflict", "A snapshot revision was reused by another observation.");
  }
  if (state.observations.size >= LIMITS.retainedObservations || state.retainedBytes + bytes > LIMITS.retainedBytes) {
    rejectUsage("usage_capacity_exceeded", "Retained usage identity capacity is exhausted.");
  }
  const viewState = admitView(state, observation);
  const scopeAdmission = admitScope(state, observation);
  const accounting = applyScopeObservation(scopeAdmission.prior?.accounting, observation);
  const contribution = scopeContribution(accounting);
  const magnitude = scopeMagnitude(accounting);
  if (scope.kind === "turn" && magnitude.turns > 1) {
    rejectUsage("usage_scope_mismatch", "An SDK-turn scope cannot count more than one entered SDK turn.");
  }
  const priorMagnitude = scopeAdmission.prior?.magnitude ?? EMPTY_MAGNITUDE;
  const viewMagnitude = mapCounters((name) => checkedAdd(viewState.magnitude[name] - priorMagnitude[name], magnitude[name]));
  const created = scopeAdmission.prior === undefined;
  const containedIn = "containedIn" in scope ? scope.containedIn : undefined;
  const containers = new Map(state.containers);
  if (created && containedIn !== undefined) containers.set(containedIn, [...(containers.get(containedIn) ?? []), view.viewId]);
  return Object.freeze({
    status: "recorded",
    ledger: wrapUsageLedger({
      sessionId: state.sessionId,
      observations: new Map(state.observations).set(observation.observationId, canonical),
      snapshotRevisions: revisionKey === null ? state.snapshotRevisions : new Set(state.snapshotRevisions).add(revisionKey),
      retainedBytes: state.retainedBytes + bytes,
      views: new Map(state.views).set(view.viewId, {
        ...viewState,
        scopeIds: created ? [...viewState.scopeIds, scope.scopeId] : viewState.scopeIds,
        magnitude: viewMagnitude,
      }),
      scopes: new Map(state.scopes).set(scope.scopeId, {
        canonical: scopeAdmission.canonical,
        viewId: view.viewId,
        final: observation.finality === "final",
        accounting,
        contribution,
        magnitude,
      }),
      containers,
      semanticScopes: scopeAdmission.semanticKey === null
        ? state.semanticScopes
        : new Set(state.semanticScopes).add(scopeAdmission.semanticKey),
      authoritativeViewId: view.authority === "authoritative" ? view.viewId : state.authoritativeViewId,
    }),
  });
}

const rejectedAdmission = (error: unknown): AgentTokenUsageAdmission => {
  if (!(error instanceof TokenUsageRejection)) throw error;
  return Object.freeze({ status: "rejected", code: error.code, message: error.message });
};

// ------------------------------------------------------------------------------------------------
//                Public Ledger API
// ------------------------------------------------------------------------------------------------

export function createTokenUsageLedger(input: Readonly<{ sessionId: AgentSessionId }>): AgentTokenUsageLedger {
  return wrapUsageLedger({
    sessionId: parseAgentSessionId(input.sessionId),
    observations: new Map(),
    snapshotRevisions: new Set(),
    retainedBytes: 0,
    views: new Map(),
    scopes: new Map(),
    containers: new Map(),
    semanticScopes: new Set(),
    authoritativeViewId: null,
  });
}

/** Returns recorded, duplicate or rejected; a rejection leaves the supplied ledger valid and unchanged. */
export function admitTokenUsageEvent(ledger: AgentTokenUsageLedger, event: AgentUsageObservedEvent): AgentTokenUsageAdmission {
  const state = usageLedgerState(ledger);
  const parsed = safeParseAgentUsageObservedEvent(event);
  if (!parsed.success) {
    const envelopeValid = parsed.issues.every((issue) => issue.path[0] === "payload");
    if (envelopeValid && envelopeSessionId(event) !== state.sessionId) {
      return rejectedAdmission(new TokenUsageRejection("usage_scope_mismatch", "The observation belongs to another session."));
    }
    const code = envelopeValid ? classifyTokenUsageEventIssues(parsed.issues) : "usage_invalid";
    return Object.freeze({ status: "rejected", code, message: "The usage event does not satisfy the Agent14 contract." });
  }
  return admitValidatedTokenUsageEvent(ledger, deepFreeze(parsed.data));
}

/** Runtime-internal admission of an event the output boundary already parsed. */
export function admitValidatedTokenUsageEvent(
  ledger: AgentTokenUsageLedger,
  event: AgentUsageObservedEvent,
): AgentTokenUsageAdmission {
  try {
    return admit(ledger, event);
  } catch (error) {
    return rejectedAdmission(error);
  }
}

export const tokenUsageLedgerHasScope = (ledger: AgentTokenUsageLedger, scopeId: AgentUsageScopeId): boolean =>
  usageLedgerState(ledger).scopes.has(scopeId);
