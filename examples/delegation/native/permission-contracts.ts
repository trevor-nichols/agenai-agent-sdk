// ------------------------------------------------------------------------------------------------
//                permission-contracts.ts - Pinned Grok once-only permission observations
// ------------------------------------------------------------------------------------------------

import { parseAgentApprovalRequest, parseAgentRequestResolutionFor, type AgentApprovalRequest, type AgentApprovalResolution } from '@agen-ai/agent-protocol';
import { array, canonicalJson, digest, exact, integer, NativeInputError, record, textValue } from './json.js';
import { assertBoundedNativeEvidence } from './evidence-values.js';

export type NativeManagedPermissionTool = 'delegation_targets' | 'delegate_task';
export interface HistoricalNativeParentApprovalObservation {
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly purpose: 'admission' | 'cancellation_admission';
  readonly requestId: string;
  readonly itemId: string;
  readonly toolName: NativeManagedPermissionTool;
  readonly title: string;
  readonly itemKind: 'dynamic_tool_call';
  readonly itemStatus: 'pending' | 'in_progress';
  readonly itemObservedAt: number;
  readonly openedAt: number;
  readonly offeredOption: Readonly<{ optionId: string; label: 'allow once'; decision: 'approved'; persistence: 'once'; scopeKind: 'exact_action' }>;
  readonly pendingSettledAt?: number;
  readonly selectedOptionId?: string;
  readonly resolutionStartedAt?: number;
  readonly runningAt?: number;
  readonly continuationSettledAt?: number;
  readonly continuationBoundary?: 'pending_request' | 'completed' | 'canceled' | 'failed';
  readonly invocationId?: string;
}

export interface NativeParentApprovalObservation extends Omit<HistoricalNativeParentApprovalObservation,
  'pendingSettledAt' | 'resolutionStartedAt' | 'continuationSettledAt' | 'continuationBoundary'> {
  readonly requestObservedAt: number;
  readonly deliveryStartedAt?: number;
  readonly deliverySettledAt?: number;
  readonly deliveryStatus?: 'delivered' | 'rejected' | 'delivery_uncertain';
  readonly requestState?: 'pending' | 'unavailable';
  readonly nextBoundaryAt?: number;
  readonly nextBoundary?: 'pending_request' | 'completed' | 'canceled' | 'failed';
}

export interface NativeParentPermissionProof {
  readonly profile: 'grok-1.0.50-managed-mcp-once-v1';
  readonly artifactDigest: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
  readonly sdkDigest: string;
  readonly allocationId: string;
  readonly turnId: string;
  readonly originalRunTurnCount: 1;
  readonly requests: readonly Readonly<{
    at: number;
    turnId: string;
    request: AgentApprovalRequest;
    item: Readonly<{ itemId: string; itemKind: 'dynamic_tool_call'; status: 'in_progress'; title: string; toolNamePresent: false }>;
    selected: AgentApprovalResolution;
    running: Readonly<{ at: number; turnId: string; state: 'running'; resolutionIndex: number }>;
    callback: Readonly<{ at: number; invocationId: string; toolName: NativeManagedPermissionTool }>;
  }>[];
  readonly resolutionStreamsSettled: 2;
  readonly terminal: Readonly<{ at: number; turnId: string; outcome: 'completed' }>;
  readonly observedAssistantText: 'NATIVE_PERMISSION_CONTINUATION_OK';
  readonly cleanup: 'closed';
  readonly cleanupFacts: Readonly<{ sessionClosed: true; registryClosed: true; bridgeClosed: true; allocationReleased: true; executableReleased: true; rootRemoved: true }>;
}

const fail = (): never => { throw new NativeInputError('parent_permission_proof_invalid'); };
function requireFact(value: unknown): asserts value { if (!value) fail(); }
function identifier(value: unknown): string { const parsed = textValue(value, 256); requireFact(parsed.trim() === parsed); return parsed; }
function time(value: unknown): number { requireFact(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000); return value; }
function tool(value: unknown): NativeManagedPermissionTool { requireFact(value === 'delegation_targets' || value === 'delegate_task'); return value; }

export function parseHistoricalNativeParentApprovalObservation(value: unknown): HistoricalNativeParentApprovalObservation {
  const item = record(value, ['parentSessionId', 'parentTurnId', 'purpose', 'requestId', 'itemId', 'toolName', 'title', 'itemKind', 'itemStatus',
    'itemObservedAt', 'openedAt', 'offeredOption'], ['pendingSettledAt', 'selectedOptionId', 'resolutionStartedAt', 'runningAt', 'continuationSettledAt', 'continuationBoundary', 'invocationId']);
  const offered = record(item.offeredOption, ['optionId', 'label', 'decision', 'persistence', 'scopeKind']);
  const toolName = tool(item.toolName);
  requireFact(item.purpose === 'admission' || item.purpose === 'cancellation_admission');
  requireFact(item.itemStatus === 'pending' || item.itemStatus === 'in_progress');
  const boundary = item.continuationBoundary;
  requireFact(boundary === undefined || boundary === 'pending_request' || boundary === 'completed' || boundary === 'canceled' || boundary === 'failed');
  const result: HistoricalNativeParentApprovalObservation = { parentSessionId: identifier(item.parentSessionId), parentTurnId: identifier(item.parentTurnId),
    purpose: item.purpose, requestId: identifier(item.requestId), itemId: identifier(item.itemId), toolName, title: exact(item.title, `agenai_delegation__${toolName}`),
    itemKind: exact(item.itemKind, 'dynamic_tool_call'), itemStatus: item.itemStatus, itemObservedAt: time(item.itemObservedAt), openedAt: time(item.openedAt),
    offeredOption: { optionId: identifier(offered.optionId), label: exact(offered.label, 'allow once'), decision: exact(offered.decision, 'approved'),
      persistence: exact(offered.persistence, 'once'), scopeKind: exact(offered.scopeKind, 'exact_action') },
    ...(item.pendingSettledAt === undefined ? {} : { pendingSettledAt: time(item.pendingSettledAt) }),
    ...(item.selectedOptionId === undefined ? {} : { selectedOptionId: identifier(item.selectedOptionId) }),
    ...(item.resolutionStartedAt === undefined ? {} : { resolutionStartedAt: time(item.resolutionStartedAt) }),
    ...(item.runningAt === undefined ? {} : { runningAt: time(item.runningAt) }),
    ...(item.continuationSettledAt === undefined ? {} : { continuationSettledAt: time(item.continuationSettledAt) }),
    ...(boundary === undefined ? {} : { continuationBoundary: boundary }),
    ...(item.invocationId === undefined ? {} : { invocationId: identifier(item.invocationId) }) };
  requireFact(result.itemObservedAt <= result.openedAt
    && (result.pendingSettledAt === undefined || result.pendingSettledAt >= result.openedAt)
    && (result.resolutionStartedAt === undefined || result.pendingSettledAt !== undefined && result.resolutionStartedAt >= result.pendingSettledAt)
    && (result.runningAt === undefined || result.resolutionStartedAt !== undefined && result.runningAt >= result.resolutionStartedAt)
    && (result.continuationSettledAt === undefined || result.resolutionStartedAt !== undefined && result.continuationSettledAt >= result.resolutionStartedAt)
    && (result.continuationBoundary === undefined || result.continuationSettledAt !== undefined));
  return result;
}

export function parseNativeParentApprovalObservation(value: unknown): NativeParentApprovalObservation {
  const item = record(value, ['parentSessionId', 'parentTurnId', 'purpose', 'requestId', 'itemId', 'toolName', 'title', 'itemKind', 'itemStatus',
    'itemObservedAt', 'openedAt', 'requestObservedAt', 'offeredOption'],
    ['selectedOptionId', 'deliveryStartedAt', 'deliverySettledAt', 'deliveryStatus', 'requestState', 'runningAt', 'nextBoundaryAt', 'nextBoundary', 'invocationId']);
  const offered = record(item.offeredOption, ['optionId', 'label', 'decision', 'persistence', 'scopeKind']);
  const toolName = tool(item.toolName);
  requireFact(item.purpose === 'admission' || item.purpose === 'cancellation_admission');
  requireFact(item.itemStatus === 'pending' || item.itemStatus === 'in_progress');
  const boundary = item.nextBoundary, status = item.deliveryStatus, requestState = item.requestState;
  requireFact(boundary === undefined || boundary === 'pending_request' || boundary === 'completed' || boundary === 'canceled' || boundary === 'failed');
  requireFact(status === undefined || status === 'delivered' || status === 'rejected' || status === 'delivery_uncertain');
  requireFact(requestState === undefined || requestState === 'pending' || requestState === 'unavailable');
  requireFact((status === 'rejected') === (requestState !== undefined));
  const result: NativeParentApprovalObservation = { parentSessionId: identifier(item.parentSessionId), parentTurnId: identifier(item.parentTurnId),
    purpose: item.purpose, requestId: identifier(item.requestId), itemId: identifier(item.itemId), toolName, title: exact(item.title, `agenai_delegation__${toolName}`),
    itemKind: exact(item.itemKind, 'dynamic_tool_call'), itemStatus: item.itemStatus, itemObservedAt: time(item.itemObservedAt), openedAt: time(item.openedAt),
    requestObservedAt: time(item.requestObservedAt), offeredOption: { optionId: identifier(offered.optionId), label: exact(offered.label, 'allow once'),
      decision: exact(offered.decision, 'approved'), persistence: exact(offered.persistence, 'once'), scopeKind: exact(offered.scopeKind, 'exact_action') },
    ...(item.selectedOptionId === undefined ? {} : { selectedOptionId: identifier(item.selectedOptionId) }),
    ...(item.deliveryStartedAt === undefined ? {} : { deliveryStartedAt: time(item.deliveryStartedAt) }),
    ...(item.deliverySettledAt === undefined ? {} : { deliverySettledAt: time(item.deliverySettledAt) }),
    ...(status === undefined ? {} : { deliveryStatus: status }), ...(requestState === undefined ? {} : { requestState }),
    ...(item.runningAt === undefined ? {} : { runningAt: time(item.runningAt) }),
    ...(item.nextBoundaryAt === undefined ? {} : { nextBoundaryAt: time(item.nextBoundaryAt) }),
    ...(boundary === undefined ? {} : { nextBoundary: boundary }),
    ...(item.invocationId === undefined ? {} : { invocationId: identifier(item.invocationId) }) };
  requireFact(result.itemObservedAt <= result.openedAt && result.openedAt <= result.requestObservedAt
    && (result.deliveryStartedAt === undefined || result.deliveryStartedAt >= result.requestObservedAt)
    && (result.deliverySettledAt === undefined || result.deliveryStartedAt !== undefined && result.deliverySettledAt >= result.deliveryStartedAt)
    && (result.deliveryStatus !== undefined) === (result.deliverySettledAt !== undefined)
    && (result.runningAt === undefined || result.deliveryStartedAt !== undefined && result.runningAt >= result.deliveryStartedAt)
    && (result.nextBoundaryAt === undefined || result.deliveryStartedAt !== undefined && result.nextBoundaryAt >= result.deliveryStartedAt)
    && (result.nextBoundary !== undefined) === (result.nextBoundaryAt !== undefined));
  return result;
}

export function parseNativeParentPermissionProof(value: unknown): NativeParentPermissionProof {
  assertBoundedNativeEvidence(value, 65_536);
  const input = record(value, ['profile', 'artifactDigest', 'executableSha256', 'executableBytes', 'sdkDigest', 'allocationId', 'turnId', 'originalRunTurnCount',
    'requests', 'resolutionStreamsSettled', 'terminal', 'observedAssistantText', 'cleanup', 'cleanupFacts']);
  const executableSha256 = textValue(input.executableSha256, 64);
  requireFact(/^[a-f0-9]{64}$/u.test(executableSha256));
  const turnId = identifier(input.turnId);
  const requests = array(input.requests, 2, (value): NativeParentPermissionProof['requests'][number] => {
    const entry = record(value, ['at', 'turnId', 'request', 'item', 'selected', 'running', 'callback']);
    const request = parseAgentApprovalRequest(entry.request);
    requireFact(canonicalJson(request) === canonicalJson(entry.request) && request.subject.kind === 'tool');
    const selected = parseAgentRequestResolutionFor(request, entry.selected);
    requireFact(canonicalJson(selected) === canonicalJson(entry.selected) && selected.requestKind === 'approval' && selected.disposition === 'selected');
    const item = record(entry.item, ['itemId', 'itemKind', 'status', 'title', 'toolNamePresent']);
    const running = record(entry.running, ['at', 'turnId', 'state', 'resolutionIndex']);
    const callback = record(entry.callback, ['at', 'invocationId', 'toolName']);
    const toolName = tool(callback.toolName), title = `agenai_delegation__${toolName}`;
    requireFact(request.prompt === title && request.subject.title === title && request.subject.itemId === item.itemId && item.title === title
      && request.options.length === 2 && !request.expiresAt && !request.subject.description
      && request.options.every((option) => option.persistence === 'once' && option.scope.kind === 'exact_action' && !option.description
        && option.label === (option.decision === 'approved' ? 'allow once' : 'reject once')));
    const offered = request.options.filter((option) => option.decision === 'approved');
    requireFact(offered.length === 1 && offered[0]!.optionId === selected.optionId);
    return { at: time(entry.at), turnId: exact(entry.turnId, turnId), request,
      item: { itemId: identifier(item.itemId), itemKind: exact(item.itemKind, 'dynamic_tool_call'), status: exact(item.status, 'in_progress'), title: exact(item.title, title), toolNamePresent: exact(item.toolNamePresent, false) },
      selected, running: { at: time(running.at), turnId: exact(running.turnId, turnId), state: exact(running.state, 'running'), resolutionIndex: integer(running.resolutionIndex, 1, 2) },
      callback: { at: time(callback.at), invocationId: identifier(callback.invocationId), toolName } };
  });
  const terminal = record(input.terminal, ['at', 'turnId', 'outcome']);
  requireFact(time(terminal.at) <= 30_000);
  const cleanup = record(input.cleanupFacts, ['sessionClosed', 'registryClosed', 'bridgeClosed', 'allocationReleased', 'executableReleased', 'rootRemoved']);
  for (const field of Object.values(cleanup)) exact(field, true);
  requireFact(requests.length === 2 && requests[0]!.callback.toolName === 'delegation_targets' && requests[1]!.callback.toolName === 'delegate_task'
    && requests[0]!.request.requestId !== requests[1]!.request.requestId && requests[0]!.item.itemId !== requests[1]!.item.itemId
    && requests[0]!.callback.invocationId !== requests[1]!.callback.invocationId
    && requests[0]!.callback.at < requests[1]!.at);
  for (const [index, entry] of requests.entries()) requireFact(entry.running.resolutionIndex === index + 1
    && entry.at < entry.running.at && entry.running.at <= entry.callback.at && entry.callback.at < time(terminal.at));
  return { profile: exact(input.profile, 'grok-1.0.50-managed-mcp-once-v1'), artifactDigest: digest(input.artifactDigest), executableSha256,
    executableBytes: integer(input.executableBytes, 1, 268_435_456), sdkDigest: digest(input.sdkDigest), allocationId: identifier(input.allocationId), turnId,
    originalRunTurnCount: exact(input.originalRunTurnCount, 1), requests, resolutionStreamsSettled: exact(input.resolutionStreamsSettled, 2),
    terminal: { at: time(terminal.at), turnId: exact(terminal.turnId, turnId), outcome: exact(terminal.outcome, 'completed') },
    observedAssistantText: exact(input.observedAssistantText, 'NATIVE_PERMISSION_CONTINUATION_OK'), cleanup: exact(input.cleanup, 'closed'),
    cleanupFacts: { sessionClosed: true, registryClosed: true, bridgeClosed: true, allocationReleased: true, executableReleased: true, rootRemoved: true } };
}
