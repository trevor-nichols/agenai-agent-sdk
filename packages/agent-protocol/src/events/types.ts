// ------------------------------------------------------------------------------------------------
//                types.ts - Provider-observed event protocol - Dependencies: semantic domains
// ------------------------------------------------------------------------------------------------

import type { AgentArtifactDescriptor } from '../artifacts/index.js';
import type {
  AgentArtifactId,
  AgentError,
  AgentErrorContext,
  AgentIsoDateTime,
  AgentItemId,
  AgentProviderRefs,
  AgentRequestId,
  AgentSessionId,
  AgentTurnId,
} from '../foundation/index.js';
import type { AgentRequest } from '../requests/index.js';
import type {
  AgentContentStreamKind,
  AgentDiffSummary,
  AgentItemSnapshot,
  AgentPlanStep,
  AgentTurnCompletedPayload,
  AgentTurnState,
} from '../turns/index.js';

export const AGENT_EVENT_TYPES = [
  'turn.started',
  'turn.state_changed',
  'turn.completed',
  'item.started',
  'item.updated',
  'item.completed',
  'content.delta',
  'turn.plan.updated',
  'turn.plan.proposed',
  'turn.diff.updated',
  'request.opened',
  'progress.updated',
  'artifact.referenced',
  'runtime.warning',
  'runtime.error',
  'provider.diagnostic',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

interface AgentEventBase<Type extends AgentEventType, Payload> {
  readonly protocolVersion: 6;
  readonly type: Type;
  readonly sessionId: AgentSessionId;
  readonly providerRefs?: AgentProviderRefs;
  readonly occurredAt: AgentIsoDateTime;
  readonly payload: Payload;
}

interface AgentTurnEventBase<Type extends AgentEventType, Payload>
  extends AgentEventBase<Type, Payload> {
  readonly turnId: AgentTurnId;
}

interface AgentOptionallyTurnScopedEventBase<
  Type extends AgentEventType,
  Payload,
> extends AgentEventBase<Type, Payload> {
  readonly turnId?: AgentTurnId;
}

export type AgentTurnStartedEvent = AgentTurnEventBase<
  'turn.started',
  Readonly<{ message?: string }>
>;

export type AgentTurnStateChangedEvent = AgentTurnEventBase<
  'turn.state_changed',
  Readonly<{
    state: AgentTurnState;
    requestId?: AgentRequestId;
    message?: string;
  }>
>;

export type AgentTurnCompletedEvent = AgentTurnEventBase<
  'turn.completed',
  AgentTurnCompletedPayload
>;

export type AgentItemStartedEvent = AgentTurnEventBase<
  'item.started',
  AgentItemSnapshot
>;

export type AgentItemUpdatedEvent = AgentTurnEventBase<
  'item.updated',
  AgentItemSnapshot
>;

export type AgentItemCompletedEvent = AgentTurnEventBase<
  'item.completed',
  AgentItemSnapshot
>;

export type AgentContentDeltaEvent = AgentTurnEventBase<
  'content.delta',
  Readonly<{
    itemId: AgentItemId;
    streamKind: AgentContentStreamKind;
    delta: string;
  }>
>;

export type AgentPlanUpdatedEvent = AgentTurnEventBase<
  'turn.plan.updated',
  Readonly<{
    explanation?: string;
    steps: readonly AgentPlanStep[];
  }>
>;

export type AgentPlanProposedEvent = AgentTurnEventBase<
  'turn.plan.proposed',
  Readonly<{
    artifactId: AgentArtifactId;
    requestId: AgentRequestId;
  }>
>;

export type AgentDiffUpdatedEvent = AgentTurnEventBase<
  'turn.diff.updated',
  AgentDiffSummary
>;

export type AgentRequestOpenedEvent = AgentTurnEventBase<
  'request.opened',
  Readonly<{ request: AgentRequest }>
>;

export type AgentProgressUpdatedEvent = AgentTurnEventBase<
  'progress.updated',
  Readonly<{
    progressId: string;
    kind: 'task' | 'hook' | 'tool' | 'unknown';
    phase: 'started' | 'updated' | 'completed';
    title?: string;
    message?: string;
    current?: number;
    total?: number;
  }>
>;

export type AgentArtifactReferencedEvent = AgentOptionallyTurnScopedEventBase<
  'artifact.referenced',
  Readonly<{ artifact: AgentArtifactDescriptor }>
>;

export type AgentRuntimeWarningEvent = AgentOptionallyTurnScopedEventBase<
  'runtime.warning',
  Readonly<{
    code: string;
    message: string;
    retryable?: boolean;
    context?: AgentErrorContext;
  }>
>;

export type AgentRuntimeErrorEvent = AgentOptionallyTurnScopedEventBase<
  'runtime.error',
  Readonly<{ error: AgentError }>
>;

export type AgentProviderDiagnosticEvent = AgentOptionallyTurnScopedEventBase<
  'provider.diagnostic',
  Readonly<{
    code: string;
    message: string;
    context?: AgentErrorContext;
  }>
>;

export type AgentEvent =
  | AgentTurnStartedEvent
  | AgentTurnStateChangedEvent
  | AgentTurnCompletedEvent
  | AgentItemStartedEvent
  | AgentItemUpdatedEvent
  | AgentItemCompletedEvent
  | AgentContentDeltaEvent
  | AgentPlanUpdatedEvent
  | AgentPlanProposedEvent
  | AgentDiffUpdatedEvent
  | AgentRequestOpenedEvent
  | AgentProgressUpdatedEvent
  | AgentArtifactReferencedEvent
  | AgentRuntimeWarningEvent
  | AgentRuntimeErrorEvent
  | AgentProviderDiagnosticEvent;
