// ------------------------------------------------------------------------------------------------
//                evidence.ts - Closed offline native qualification reports and acceptance
// ------------------------------------------------------------------------------------------------

import { parseAgentCapabilities, parseAgentConfigurationCatalog, parseAgentConfigurationSelectionInput } from '@agen-ai/agent-protocol';
import { parseDelegationCompletionEnvelope, parseDelegationParentScope, type DelegationAdmissionReceipt, type DelegationTargetReference } from '@agen-ai/agent-orchestration';
import { parseGrokSelection } from './contracts.js';
import { assertNativeOrdinaryResult, nativeResultDigest, parseNativeToken } from './grok.js';
import { NATIVE_QUALIFICATION_BUDGETS as B, type NativeAdmissionObservation, type NativeCleanupReceipt, type NativeDiscoveryReport,
  type NativeFailedGate, type NativeFailureReason, type NativeModeReport, type NativeOutcome,
  type NativeSessionObservation, type NativeToolObservation, type NativeTurnObservation } from './host-contracts.js';
import type { NativeConfigurationFileRecord } from './launch-contracts.js';
import type { NativeGrokMappingProof, NativeGrokRequestProjection } from './mapping-probe.js';
import { array, canonicalJson, digest, exact, integer, NativeInputError, record, textValue } from './json.js';
import { assertBoundedNativeEvidence as bounded } from './evidence-values.js';
import { parseHistoricalNativeParentApprovalObservation, parseNativeParentApprovalObservation } from './permission-contracts.js';

const reasons: readonly NativeFailureReason[] = ['artifact_unapproved', 'registry_distribution_unavailable', 'credential_isolation_unavailable',
  'source_identity_drift', 'artifact_identity_drift', 'credential_unavailable', 'authentication_failed',
  'authentication_expired', 'configuration_unknown', 'configuration_scope_unverified', 'standard_mapping_unverified',
  'mcp_tools_unexposed', 'native_extension_required', 'approval_not_authorized', 'native_protocol_incompatible', 'parent_did_not_delegate',
  'child_result_unavailable', 'parent_completion_mismatch', 'completed_before_cancellation', 'cancellation_unsupported',
  'budget_exhausted', 'dispatch_uncertain', 'cleanup_pending'];
const reject = (): never => { throw new NativeInputError('qualification_evidence_invalid'); };
function requireFact(condition: unknown): asserts condition { if (!condition) reject(); }
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const count = (value: unknown, max = 512) => integer(value, 0, max);
const id = (value: unknown): string => {
  const result = textValue(value, 256); requireFact(result.trim() === result && !/[\u0080-\u009f]/u.test(result)); return result;
};
const uuid = (value: unknown): string => {
  const result = textValue(value, 36);
  requireFact(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result));
  return result;
};
const hash = (value: unknown): string => {
  const result = textValue(value, 64); requireFact(/^[a-f0-9]{64}$/u.test(result)); return result;
};
const boolean = (value: unknown): boolean => { requireFact(typeof value === 'boolean'); return value; };
const time = (value: unknown): number => {
  requireFact(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000); return value;
};
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  requireFact(typeof value === 'string' && values.includes(value as T)); return value as T;
}
function publicContract<T>(parse: (value: unknown) => T, value: unknown): T {
  const parsed = parse(value);
  requireFact(same(parsed, value)); // Unknown fields must never disappear through a public parser.
  return parsed;
}
function resultText(value: unknown): string {
  requireFact(typeof value === 'string' && Buffer.byteLength(value) <= B.maxResultBytes); return value;
}
function parseCleanup(value: unknown): NativeCleanupReceipt {
  const item = record(value, ['status', 'coordinatorClosed', 'sessionsClosed', 'registriesClosed', 'bridgesAcquired', 'bridgesReleased', 'elapsedMs']);
  return { status: choice(item.status, ['closed', 'pending']), coordinatorClosed: boolean(item.coordinatorClosed),
    sessionsClosed: boolean(item.sessionsClosed), registriesClosed: boolean(item.registriesClosed),
    bridgesAcquired: count(item.bridgesAcquired), bridgesReleased: count(item.bridgesReleased), elapsedMs: time(item.elapsedMs) };
}
function closedCleanup(cleanup: NativeCleanupReceipt): void {
  requireFact(cleanup.status === 'closed' && cleanup.coordinatorClosed && cleanup.sessionsClosed && cleanup.registriesClosed
    && cleanup.bridgesAcquired === cleanup.bridgesReleased && cleanup.elapsedMs <= B.cleanupMs);
}
function parseCommon(item: Record<string, unknown>): { outcome: NativeOutcome; reason?: NativeFailureReason; failedGates: readonly NativeFailedGate[] } {
  const outcome = choice(item.outcome, ['qualified', 'blocked', 'failed', 'uncertain', 'cleanup_pending']);
  const reason = item.reason === undefined ? undefined : choice(item.reason, reasons);
  const failedGates = array(item.failedGates, 32, (value) => {
    const gate = record(value, ['gate', 'reason']);
    return { gate: choice(gate.gate, ['opening', 'configuration', 'ordinary', 'delegation', 'scope', 'delivery', 'cancellation', 'cleanup']), reason: choice(gate.reason, reasons) };
  });
  requireFact(outcome === 'qualified' ? reason === undefined && !failedGates.length : reason !== undefined && failedGates.length > 0);
  return { outcome, ...(reason === undefined ? {} : { reason }), failedGates };
}
function parseTarget(value: unknown): DelegationTargetReference {
  const item = record(value, ['catalogId', 'catalogRevision', 'targetId', 'targetRevision', 'sourceId', 'sourceRevision']);
  return { catalogId: id(item.catalogId), catalogRevision: integer(item.catalogRevision, 1, Number.MAX_SAFE_INTEGER),
    targetId: id(item.targetId), targetRevision: integer(item.targetRevision, 1, Number.MAX_SAFE_INTEGER),
    sourceId: id(item.sourceId), sourceRevision: integer(item.sourceRevision, 1, Number.MAX_SAFE_INTEGER) };
}
function parseAdmission(value: unknown): DelegationAdmissionReceipt {
  const item = record(value, ['storeId', 'operationId', 'taskId', 'runId', 'target', 'revision', 'status', 'duplicate']);
  return { storeId: uuid(item.storeId), operationId: uuid(item.operationId), taskId: uuid(item.taskId), runId: uuid(item.runId),
    target: parseTarget(item.target), revision: integer(item.revision, 1, Number.MAX_SAFE_INTEGER),
    status: choice(item.status, ['queued', 'preparing']), duplicate: boolean(item.duplicate) };
}
function parseFile(value: unknown): NativeConfigurationFileRecord {
  const item = record(value, ['location', 'kind'], ['bytes', 'sha256']);
  const kind = choice(item.kind, ['absent', 'file', 'directory']);
  requireFact(kind === 'file' ? item.bytes !== undefined && item.sha256 !== undefined : item.bytes === undefined && item.sha256 === undefined);
  return { location: textValue(item.location, 512), kind,
    ...(kind === 'file' ? { bytes: integer(item.bytes, 0, 1_048_576), sha256: hash(item.sha256) } : {}) };
}
function parseAdmissionObservation(value: unknown): NativeAdmissionObservation {
  const item = record(value, ['assistantTextBytes', 'assistantTextDeltas', 'textCapped', 'requestCount', 'toolItems', 'response']);
  const tools = record(item.toolItems, ['search_tool', 'use_tool', 'managed_targets', 'managed_delegate', 'other']);
  const parsed: NativeAdmissionObservation = {
    assistantTextBytes: count(item.assistantTextBytes, 8_192), assistantTextDeltas: count(item.assistantTextDeltas),
    textCapped: boolean(item.textCapped), requestCount: count(item.requestCount, 64),
    toolItems: { search_tool: count(tools.search_tool, 64), use_tool: count(tools.use_tool, 64), managed_targets: count(tools.managed_targets, 64),
      managed_delegate: count(tools.managed_delegate, 64), other: count(tools.other, 64) },
    response: choice(item.response, ['admitted_true', 'other_text', 'none']) };
  requireFact(Object.values(parsed.toolItems).reduce((total, value) => total + value, 0) <= 64
    && (parsed.assistantTextBytes === 0) === (parsed.assistantTextDeltas === 0)
    && parsed.assistantTextDeltas <= parsed.assistantTextBytes
    && (parsed.response === 'none') === (parsed.assistantTextBytes === 0)
    && (parsed.response !== 'admitted_true' || parsed.assistantTextBytes >= 17)
    && (!parsed.textCapped || parsed.assistantTextBytes === 8_192 || parsed.assistantTextDeltas === 512));
  return parsed;
}
function parseTurn(value: unknown): NativeTurnObservation {
  const item = record(value, ['role', 'purpose', 'sessionId', 'turnId', 'enteredAt', 'configurationCatalogRevision', 'configurationVerifiedAt', 'settledAt', 'outcome'], ['providerStartedAt', 'terminalAt', 'resultText', 'admissionObservation']);
  const parsed: NativeTurnObservation = { role: choice(item.role, ['parent', 'child']),
    purpose: choice(item.purpose, ['ordinary', 'admission', 'child', 'completion', 'cancellation_admission', 'cancellation_child']),
    sessionId: id(item.sessionId), turnId: id(item.turnId), enteredAt: time(item.enteredAt), settledAt: time(item.settledAt),
    configurationCatalogRevision: integer(item.configurationCatalogRevision, 1, Number.MAX_SAFE_INTEGER), configurationVerifiedAt: time(item.configurationVerifiedAt),
    outcome: choice(item.outcome, ['completed', 'canceled', 'failed', 'pending_request', 'uncertain']),
    ...(item.providerStartedAt === undefined ? {} : { providerStartedAt: time(item.providerStartedAt) }),
    ...(item.terminalAt === undefined ? {} : { terminalAt: time(item.terminalAt) }),
    ...(item.resultText === undefined ? {} : { resultText: resultText(item.resultText) }),
    ...(item.admissionObservation === undefined ? {} : { admissionObservation: parseAdmissionObservation(item.admissionObservation) }) };
  requireFact(parsed.admissionObservation === undefined || parsed.role === 'parent' && (parsed.purpose === 'admission' || parsed.purpose === 'cancellation_admission'));
  requireFact(parsed.enteredAt <= parsed.settledAt && parsed.configurationVerifiedAt <= parsed.enteredAt
    && (parsed.providerStartedAt === undefined || parsed.enteredAt <= parsed.providerStartedAt && parsed.providerStartedAt <= parsed.settledAt)
    && (parsed.terminalAt === undefined || parsed.providerStartedAt !== undefined && parsed.providerStartedAt <= parsed.terminalAt
      && (parsed.purpose === 'cancellation_child' || parsed.terminalAt <= parsed.settledAt)));
  return parsed;
}
function parseSession(value: unknown): NativeSessionObservation {
  const item = record(value, ['sessionId', 'role', 'event', 'at']);
  return { sessionId: id(item.sessionId), role: choice(item.role, ['parent', 'child', 'comparison']), event: choice(item.event, ['opening', 'opened', 'closed']), at: time(item.at) };
}
function parseTool(value: unknown): NativeToolObservation {
  const item = record(value, ['invocationId', 'toolName', 'parentSessionId', 'parentTurnId', 'at', 'status'], ['admission', 'target']);
  return { invocationId: id(item.invocationId), toolName: choice(item.toolName, ['delegation_targets', 'delegate_task', 'task_status', 'task_send', 'task_cancel']),
    parentSessionId: id(item.parentSessionId), parentTurnId: id(item.parentTurnId), at: time(item.at), status: choice(item.status, ['success', 'error']),
    ...(item.admission === undefined ? {} : { admission: parseAdmission(item.admission) }),
    ...(item.target === undefined ? {} : { target: parseTarget(item.target) }) };
}

export function parseNativeDiscoveryReport(value: unknown): NativeDiscoveryReport {
  bounded(value, 524_288);
  const item = record(value, ['version', 'outcome', 'failedGates', 'noPrompt', 'elapsedMs', 'modelAcknowledged', 'reasoningAcknowledged', 'configurationStarts', 'cleanup'], ['reason', 'capabilities', 'configuration']);
  const report: NativeDiscoveryReport = { version: exact(item.version, 1), ...parseCommon(item), noPrompt: exact(item.noPrompt, true),
    elapsedMs: time(item.elapsedMs), modelAcknowledged: boolean(item.modelAcknowledged), reasoningAcknowledged: boolean(item.reasoningAcknowledged),
    configurationStarts: count(item.configurationStarts), cleanup: parseCleanup(item.cleanup),
    ...(item.capabilities === undefined ? {} : { capabilities: publicContract(parseAgentCapabilities, item.capabilities) }),
    ...(item.configuration === undefined ? {} : { configuration: publicContract(parseGrokSelection, item.configuration) }) };
  if (report.outcome === 'qualified') {
    closedCleanup(report.cleanup);
    requireFact(report.elapsedMs <= B.discoveryMs + B.cleanupMs && report.capabilities?.configuration.kind === 'selectable'
      && report.configuration?.modelId === 'grok-4.3' && report.modelAcknowledged && report.reasoningAcknowledged
      && report.configurationStarts >= 2 && report.cleanup.bridgesAcquired === 0);
  }
  return report;
}

export function parseNativeModeReport(value: unknown): NativeModeReport {
  bounded(value, 1_048_576);
  const item = record(value, ['version', 'outcome', 'failedGates', 'budgets', 'usage', 'turns', 'sessions', 'tools', 'admissions', 'configurationStarts', 'childConfigurations', 'cancellation', 'cleanup'],
    ['reason', 'parentConfiguration', 'parentScope', 'scope', 'dispatchGate', 'child', 'delivery', 'parentPermissionProofDigest', 'approvals']);
  const budgets = record(item.budgets, Object.keys(B));
  requireFact(same(budgets, B));
  const usage = record(item.usage, ['turns', 'elapsedMs'], ['delegationElapsedMs']);
  const cancellation = record(item.cancellation, ['status'], ['taskId', 'runId', 'providerStartedAt', 'requestedAt']);
  const fields: Omit<NativeModeReport, 'version' | 'approvals'> = { ...parseCommon(item), budgets: B,
    usage: { turns: count(usage.turns), elapsedMs: time(usage.elapsedMs), ...(usage.delegationElapsedMs === undefined ? {} : { delegationElapsedMs: time(usage.delegationElapsedMs) }) },
    turns: array(item.turns, 512, parseTurn), sessions: array(item.sessions, 512, parseSession), tools: array(item.tools, 64, parseTool), admissions: array(item.admissions, 64, parseAdmission),
    configurationStarts: count(item.configurationStarts), childConfigurations: array(item.childConfigurations, 2, (value) => publicContract(parseAgentConfigurationCatalog, value)),
    cancellation: { status: choice(cancellation.status, ['confirmed', 'completed_before_cancellation', 'unsupported', 'uncertain', 'not_started']),
      ...(cancellation.taskId === undefined ? {} : { taskId: uuid(cancellation.taskId) }), ...(cancellation.runId === undefined ? {} : { runId: uuid(cancellation.runId) }),
      ...(cancellation.providerStartedAt === undefined ? {} : { providerStartedAt: time(cancellation.providerStartedAt) }),
      ...(cancellation.requestedAt === undefined ? {} : { requestedAt: time(cancellation.requestedAt) }) }, cleanup: parseCleanup(item.cleanup),
    ...(item.parentConfiguration === undefined ? {} : { parentConfiguration: publicContract(parseAgentConfigurationCatalog, item.parentConfiguration) }),
    ...(item.parentScope === undefined ? {} : { parentScope: publicContract(parseDelegationParentScope, item.parentScope) }),
    ...(item.parentPermissionProofDigest === undefined ? {} : { parentPermissionProofDigest: digest(item.parentPermissionProofDigest) }) };
  const report: NativeModeReport = item.version === 1
    ? { ...fields, version: 1, ...(item.approvals === undefined ? {} : { approvals: array(item.approvals, 4, parseHistoricalNativeParentApprovalObservation) }) }
    : { ...fields, version: exact(item.version, 2), ...(item.approvals === undefined ? {} : { approvals: array(item.approvals, 4, parseNativeParentApprovalObservation) }) };
  if (item.scope !== undefined) {
    const scope = record(item.scope, ['verified', 'parentBeforeChild', 'parentAfterChild', 'comparisonBeforeChild', 'comparisonAfterChild',
      'parentFilesBeforeChild', 'parentFilesAfterChild', 'comparisonFilesBeforeChild', 'comparisonFilesAfterChild']);
    Object.assign(report, { scope: { verified: boolean(scope.verified),
      ...Object.fromEntries(['parentBeforeChild', 'parentAfterChild', 'comparisonBeforeChild', 'comparisonAfterChild'].map((key) => [key, publicContract(parseAgentConfigurationCatalog, scope[key])])),
      ...Object.fromEntries(['parentFilesBeforeChild', 'parentFilesAfterChild', 'comparisonFilesBeforeChild', 'comparisonFilesAfterChild'].map((key) => [key, array(scope[key], 128, parseFile)])) } });
  }
  if (item.dispatchGate !== undefined) {
    const gate = record(item.dispatchGate, ['parentTurnId', 'parentSettledAt', 'releasedAt', 'childProviderStartedAt', 'verified']);
    Object.assign(report, { dispatchGate: { parentTurnId: id(gate.parentTurnId), parentSettledAt: time(gate.parentSettledAt),
      releasedAt: time(gate.releasedAt), childProviderStartedAt: time(gate.childProviderStartedAt), verified: boolean(gate.verified) } });
  }
  if (item.child !== undefined) {
    const child = record(item.child, ['taskId', 'runId', 'sessionId', 'turnId', 'token', 'resultDigest']);
    const token = textValue(child.token, 32); requireFact(/^[A-Za-z0-9_-]{1,32}$/u.test(token));
    Object.assign(report, { child: { taskId: uuid(child.taskId), runId: uuid(child.runId), sessionId: id(child.sessionId), turnId: id(child.turnId), token, resultDigest: digest(child.resultDigest) } });
  }
  if (item.delivery !== undefined) {
    const delivery = record(item.delivery, ['inboxId', 'parentSessionId', 'parentTurnId', 'acceptedAt', 'dispatchedAt', 'acknowledgedAt', 'envelope', 'token', 'verified']);
    const token = textValue(delivery.token, 32); requireFact(/^[A-Za-z0-9_-]{1,32}$/u.test(token));
    Object.assign(report, { delivery: { inboxId: uuid(delivery.inboxId), parentSessionId: id(delivery.parentSessionId), parentTurnId: id(delivery.parentTurnId),
      acceptedAt: time(delivery.acceptedAt), dispatchedAt: time(delivery.dispatchedAt), acknowledgedAt: time(delivery.acknowledgedAt),
      envelope: publicContract(parseDelegationCompletionEnvelope, delivery.envelope), token, verified: boolean(delivery.verified) } });
  }
  const textBytes = report.turns.reduce((total, turn) => total + Buffer.byteLength(turn.resultText ?? ''), 0)
    + (report.delivery?.envelope.outcome.kind === 'succeeded' ? Buffer.byteLength(report.delivery.envelope.outcome.result.text) : 0);
  requireFact(textBytes <= B.maxRetainedTextBytes && report.usage.turns === report.turns.length && report.sessions.length + report.turns.length <= 512);
  return report;
}

function assertHistoricalNativeApprovals(report: Extract<NativeModeReport, { version: 1 }>,
  admission: NativeTurnObservation, cancelAdmission: NativeTurnObservation): void {
  const approvals = report.approvals ?? [];
  requireFact(!approvals.length || report.parentPermissionProofDigest !== undefined);
  requireFact(new Set(approvals.map((approval) => approval.requestId)).size === approvals.length
    && new Set(approvals.map((approval) => approval.itemId)).size === approvals.length
    && new Set(approvals.map((approval) => `${approval.purpose}:${approval.toolName}`)).size === approvals.length);
  for (const approval of approvals) {
    const turn = approval.purpose === 'admission' ? admission : cancelAdmission;
    const callback = report.tools.find((tool) => tool.invocationId === approval.invocationId);
    requireFact(approval.parentSessionId === turn.sessionId && approval.parentTurnId === turn.turnId
      && approval.itemObservedAt >= turn.providerStartedAt! && approval.pendingSettledAt !== undefined && approval.selectedOptionId === approval.offeredOption.optionId
      && approval.resolutionStartedAt !== undefined && approval.runningAt !== undefined && approval.continuationSettledAt !== undefined
      && callback?.status === 'success' && callback.parentSessionId === turn.sessionId && callback.parentTurnId === turn.turnId && callback.toolName === approval.toolName
      && approval.resolutionStartedAt <= callback.at && approval.runningAt <= callback.at && callback.at <= approval.continuationSettledAt
      && approval.continuationSettledAt <= turn.settledAt);
    if (approval.toolName === 'delegate_task') requireFact(report.tools.some((tool) => tool.toolName === 'delegation_targets' && tool.status === 'success'
      && tool.parentSessionId === turn.sessionId && tool.parentTurnId === turn.turnId && tool.at < approval.openedAt));
    const later = approvals.filter((entry) => entry.purpose === approval.purpose && entry.openedAt > approval.openedAt);
    if (later.length) requireFact(later.length === 1 && approval.continuationBoundary === 'pending_request'
      && later[0]!.openedAt <= approval.continuationSettledAt && later[0]!.resolutionStartedAt !== undefined
      && later[0]!.resolutionStartedAt >= approval.continuationSettledAt);
    else requireFact(approval.continuationBoundary === 'completed' && approval.continuationSettledAt >= turn.terminalAt!);
  }
}

function assertCurrentNativeApprovals(report: Extract<NativeModeReport, { version: 2 }>,
  admission: NativeTurnObservation, cancelAdmission: NativeTurnObservation): void {
  const approvals = report.approvals ?? [];
  requireFact(!approvals.length || report.parentPermissionProofDigest !== undefined);
  requireFact(new Set(approvals.map((approval) => approval.requestId)).size === approvals.length
    && new Set(approvals.map((approval) => approval.itemId)).size === approvals.length
    && new Set(approvals.map((approval) => `${approval.purpose}:${approval.toolName}`)).size === approvals.length);
  for (const approval of approvals) {
    const turn = approval.purpose === 'admission' ? admission : cancelAdmission;
    const callback = report.tools.find((tool) => tool.invocationId === approval.invocationId);
    requireFact(approval.parentSessionId === turn.sessionId && approval.parentTurnId === turn.turnId
      && approval.itemObservedAt >= turn.providerStartedAt! && approval.selectedOptionId === approval.offeredOption.optionId
      && approval.deliveryStartedAt !== undefined && approval.deliverySettledAt !== undefined && approval.deliveryStatus === 'delivered'
      && approval.runningAt !== undefined && approval.nextBoundaryAt !== undefined
      && callback?.status === 'success' && callback.parentSessionId === turn.sessionId && callback.parentTurnId === turn.turnId && callback.toolName === approval.toolName
      && approval.deliveryStartedAt <= callback.at && approval.runningAt <= callback.at && callback.at <= approval.nextBoundaryAt
      && approval.deliverySettledAt <= approval.nextBoundaryAt && approval.nextBoundaryAt <= turn.settledAt);
    if (approval.toolName === 'delegate_task') requireFact(report.tools.some((tool) => tool.toolName === 'delegation_targets' && tool.status === 'success'
      && tool.parentSessionId === turn.sessionId && tool.parentTurnId === turn.turnId && tool.at < approval.openedAt));
    const later = approvals.filter((entry) => entry.purpose === approval.purpose && entry.openedAt > approval.openedAt);
    if (later.length) requireFact(later.length === 1 && approval.nextBoundary === 'pending_request'
      && approval.nextBoundaryAt === later[0]!.openedAt && later[0]!.deliveryStartedAt !== undefined
      && approval.deliverySettledAt <= later[0]!.deliveryStartedAt);
    else requireFact(approval.nextBoundary === 'completed' && approval.nextBoundaryAt === turn.terminalAt!);
  }
}

export function assertQualifiedNativeMode(value: NativeModeReport): void {
  const report = parseNativeModeReport(value);
  requireFact(report.outcome === 'qualified' && report.failedGates.length === 0 && report.reason === undefined);
  closedCleanup(report.cleanup);
  requireFact(report.cleanup.bridgesAcquired >= 1 && report.usage.turns <= B.maxTurns
    && report.usage.elapsedMs <= B.modeMs && report.usage.delegationElapsedMs !== undefined
    && report.usage.delegationElapsedMs <= B.delegationMs && report.usage.delegationElapsedMs <= report.usage.elapsedMs);
  const turnFor = (purpose: NativeTurnObservation['purpose']): NativeTurnObservation => {
    const found = report.turns.filter((turn) => turn.purpose === purpose); requireFact(found.length === 1); return found[0]!;
  };
  const ordinary = turnFor('ordinary'), admission = turnFor('admission'), childTurn = turnFor('child'),
    completion = turnFor('completion'), cancelAdmission = turnFor('cancellation_admission'), cancelTurn = turnFor('cancellation_child');
  requireFact(new Set(report.turns.map((turn) => turn.turnId)).size === report.turns.length);
  for (const turn of report.turns) {
    requireFact(turn.providerStartedAt !== undefined && turn.terminalAt !== undefined && turn.settledAt <= B.modeMs
      && Math.max(turn.settledAt, turn.terminalAt) <= report.usage.elapsedMs && report.parentConfiguration !== undefined
      && turn.configurationCatalogRevision === report.parentConfiguration.revision
      && turn.outcome === (turn.purpose === 'cancellation_child' ? 'canceled' : 'completed')
      && turn.role === (turn.purpose === 'child' || turn.purpose === 'cancellation_child' ? 'child' : 'parent'));
  }
  for (const turn of [ordinary, admission, completion, cancelAdmission]) requireFact(turn.sessionId === ordinary.sessionId && turn.settledAt - turn.enteredAt <= B.ordinaryMs);
  requireFact(ordinary.settledAt <= admission.enteredAt && admission.settledAt < childTurn.providerStartedAt!
    && childTurn.settledAt <= completion.enteredAt && completion.settledAt <= cancelAdmission.enteredAt
    && cancelAdmission.settledAt < cancelTurn.providerStartedAt! && childTurn.sessionId !== ordinary.sessionId && cancelTurn.sessionId !== ordinary.sessionId);
  requireFact(ordinary.resultText !== undefined); assertNativeOrdinaryResult(ordinary.resultText);
  const child = report.child, delivery = report.delivery, gate = report.dispatchGate, scope = report.scope;
  requireFact(child && delivery && gate && scope && gate.verified && scope.verified && delivery.verified);
  requireFact(child.sessionId === childTurn.sessionId && child.turnId === childTurn.turnId && childTurn.resultText !== undefined
    && parseNativeToken(childTurn.resultText) === child.token && nativeResultDigest(childTurn.resultText) === child.resultDigest);
  requireFact(gate.parentTurnId === admission.turnId && gate.parentSettledAt === admission.settledAt
    && gate.parentSettledAt <= gate.releasedAt && gate.releasedAt <= gate.childProviderStartedAt && gate.childProviderStartedAt === childTurn.providerStartedAt);
  requireFact(same(scope.parentBeforeChild, scope.parentAfterChild) && same(scope.comparisonBeforeChild, scope.comparisonAfterChild)
    && same(scope.parentFilesBeforeChild, scope.parentFilesAfterChild) && same(scope.comparisonFilesBeforeChild, scope.comparisonFilesAfterChild)
    && report.parentConfiguration !== undefined && same(report.parentConfiguration, scope.parentBeforeChild)
    && report.childConfigurations.length === 2 && report.childConfigurations.every((catalog) => same(catalog, report.parentConfiguration)) && report.configurationStarts >= 3);
  for (const [label, selectedLabel] of [['Model', 'grok-4.3'], ['Reasoning Effort', 'Low']] as const) {
    const fields = report.parentConfiguration!.fields.filter((field) => field.label === label), field = fields[0];
    requireFact(fields.length === 1 && field?.fieldKind === 'single_select' && field.scope === 'session'
      && field.applicationTiming === 'immediate' && field.mutable
      && field.options.filter((option) => option.optionId === field.currentValue && option.label === selectedLabel).length === 1);
  }
  for (const files of [scope.parentFilesBeforeChild, scope.comparisonFilesBeforeChild]) requireFact(files.length > 1
    && files.some((file) => file.location === 'GROK_HOME/config.toml' && file.kind === 'file')
    && new Set(files.map((file) => file.location)).size === files.length);
  requireFact(report.admissions.length === 2 && new Set(report.admissions.map((item) => item.taskId)).size === 2
    && new Set(report.admissions.map((item) => item.runId)).size === 2 && report.admissions.every((item) => !item.duplicate));
  const admitted = report.admissions.find((item) => item.taskId === child.taskId && item.runId === child.runId);
  const canceled = report.admissions.find((item) => item.taskId === report.cancellation.taskId && item.runId === report.cancellation.runId);
  requireFact(admitted && canceled && admitted !== canceled && admitted.storeId === canceled.storeId && same(admitted.target, canceled.target));
  requireFact(new Set(report.tools.map((tool) => tool.invocationId)).size === report.tools.length);
  requireFact(report.tools.filter((tool) => tool.toolName === 'delegate_task' && tool.status === 'success').length === 2);
  for (const tool of report.tools) {
    const parentTurn = report.turns.find((turn) => turn.role === 'parent' && turn.sessionId === tool.parentSessionId && turn.turnId === tool.parentTurnId);
    requireFact(parentTurn && tool.at >= parentTurn.providerStartedAt! && tool.at <= parentTurn.settledAt);
    requireFact(tool.toolName === 'delegate_task' || tool.admission === undefined);
  }
  for (const [entry, parentTurn] of [[admitted, admission], [canceled, cancelAdmission]] as const) {
    const tools = report.tools.filter((tool) => tool.status === 'success' && tool.parentSessionId === parentTurn.sessionId
      && tool.parentTurnId === parentTurn.turnId && tool.at >= parentTurn.providerStartedAt! && tool.at <= parentTurn.settledAt);
    const targets = tools.filter((tool) => tool.toolName === 'delegation_targets');
    const spawn = tools.filter((tool) => tool.toolName === 'delegate_task' && tool.admission && same(tool.admission, entry) && same(tool.target, entry.target));
    requireFact(targets.length >= 1 && spawn.length === 1
      && targets.some((tool) => tool.at <= spawn[0]!.at && tool.target !== undefined && same(tool.target, entry.target)));
  }
  if (report.version === 1) assertHistoricalNativeApprovals(report, admission, cancelAdmission);
  else assertCurrentNativeApprovals(report, admission, cancelAdmission);
  const envelope = delivery.envelope;
  requireFact(envelope.storeId === admitted.storeId && envelope.taskId === child.taskId && envelope.runId === child.runId
    && report.parentScope !== undefined && same(envelope.parent, report.parentScope)
    && envelope.policy === 'automatic' && envelope.outcome.kind === 'succeeded' && !envelope.outcome.result.truncated
    && !envelope.outcome.result.references.length && envelope.outcome.result.text === childTurn.resultText
    && delivery.token === child.token && delivery.parentSessionId === ordinary.sessionId && delivery.parentTurnId === completion.turnId
    && delivery.acceptedAt >= childTurn.terminalAt! && delivery.acceptedAt <= delivery.dispatchedAt && delivery.dispatchedAt <= completion.enteredAt
    && delivery.acknowledgedAt >= completion.settledAt && delivery.acknowledgedAt <= report.usage.elapsedMs
    && completion.resultText !== undefined && parseNativeToken(completion.resultText) === child.token);
  requireFact(report.cancellation.status === 'confirmed' && report.cancellation.providerStartedAt === cancelTurn.providerStartedAt
    && report.cancellation.requestedAt !== undefined && report.cancellation.requestedAt > cancelTurn.providerStartedAt!
    && report.cancellation.requestedAt <= cancelTurn.terminalAt!);
  const active = new Map<string, { role: NativeSessionObservation['role']; state: 'opening' | 'opened'; openedAt?: number }>();
  const closed = new Map<string, { role: NativeSessionObservation['role']; openedAt: number; closedAt: number }>();
  let previousAt = 0;
  for (const event of report.sessions) {
    requireFact(event.at >= previousAt && event.at <= report.usage.elapsedMs + report.cleanup.elapsedMs); previousAt = event.at;
    const current = active.get(event.sessionId);
    if (event.event === 'opening') {
      requireFact(!current && !closed.has(event.sessionId)); active.set(event.sessionId, { role: event.role, state: 'opening' });
      requireFact(active.size <= 2);
    } else if (event.event === 'opened') {
      requireFact(current?.role === event.role && current.state === 'opening'); active.set(event.sessionId, { role: event.role, state: 'opened', openedAt: event.at });
    } else {
      requireFact(current?.role === event.role && current.state === 'opened' && current.openedAt !== undefined);
      closed.set(event.sessionId, { role: event.role, openedAt: current.openedAt, closedAt: event.at }); active.delete(event.sessionId);
    }
  }
  requireFact(active.size === 0 && [...closed.values()].filter((session) => session.role === 'comparison').length >= 2);
  const comparisons = [...closed.values()].filter((session) => session.role === 'comparison');
  requireFact(comparisons.some((session) => session.closedAt < childTurn.providerStartedAt!)
    && comparisons.some((session) => session.openedAt > childTurn.terminalAt!));
  for (const turn of report.turns) {
    const session = closed.get(turn.sessionId);
    requireFact(session?.role === turn.role && session.openedAt <= turn.enteredAt && session.closedAt >= Math.max(turn.settledAt, turn.terminalAt!));
  }
}

export function parseNativeMappingProof(value: unknown): NativeGrokMappingProof {
  bounded(value, 262_144);
  const item = record(value, ['format', 'scope', 'native', 'allocationId', 'fixture', 'environmentOverrides', 'credential', 'inferenceOrigin', 'realModelInference',
    'modelsRequests', 'nonInference404Responses', 'requests', 'inferenceRequestLimit', 'explicitSdkTurns', 'selections', 'providerExecutionStarted',
    'terminalCompleted', 'fixtureResponseMatched', 'observedResultText', 'standardMapping', 'documentation', 'productionBackendBillingCertified', 'cleanup'], ['failureCode']);
  const native = record(item.native, ['bytes', 'sha256']);
  const fixture = record(item.fixture, ['id', 'object', 'context_length', 'capabilities', 'aliases']);
  const capabilities = record(fixture.capabilities, ['reasoning_effort', 'default_reasoning_effort']);
  requireFact(same(capabilities.reasoning_effort, ['none', 'low', 'medium', 'high', 'xhigh']) && same(fixture.aliases, ['grok-4.3-latest'])
    && same(item.environmentOverrides, ['GROK_XAI_API_BASE_URL', 'XAI_API_KEY']) && item.failureCode === undefined);
  const requests = array(item.requests, 4, (value): NativeGrokRequestProjection => {
    const request = record(value, ['endpoint', 'requestKeys'], ['model', 'reasoning_effort', 'reasoning', 'service_tier']);
    const keys = array(request.requestKeys, 128, (value) => { const key = textValue(value, 64); requireFact(/^[a-zA-Z0-9_]+$/u.test(key)); return key; });
    requireFact(keys.every((key, index) => index === 0 || keys[index - 1]! < key));
    for (const key of ['model', 'reasoning_effort', 'reasoning', 'service_tier']) requireFact(keys.includes(key) === Object.hasOwn(request, key));
    const reasoning = request.reasoning === undefined ? undefined : record(request.reasoning, [], ['effort']);
    requireFact(request.model === 'grok-4.3' && (request.reasoning_effort === 'low' || reasoning?.effort === 'low')
      && (request.reasoning_effort === undefined || request.reasoning_effort === 'low')
      && (reasoning === undefined || reasoning.effort === 'low') && (request.service_tier === undefined || request.service_tier === 'default'));
    return { endpoint: choice(request.endpoint, ['chat_completions', 'responses']), requestKeys: keys, model: 'grok-4.3',
      ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: 'low' }), ...(reasoning === undefined ? {} : { reasoning: { effort: 'low' } }),
      ...(request.service_tier === undefined ? {} : { service_tier: 'default' }) };
  });
  const selections = array(item.selections, 2, (value) => publicContract(parseAgentConfigurationSelectionInput, value));
  requireFact(requests.length > 0 && selections.length === 2 && new Set(selections.map((value) => value.key)).size === 2
    && selections.every((value) => value.value.fieldKind === 'single_select'));
  const modelsRequests = integer(item.modelsRequests, 1, 8), nonInference404Responses = count(item.nonInference404Responses, 8);
  requireFact(modelsRequests + nonInference404Responses + requests.length <= 8);
  return { format: exact(item.format, 'grok-native-loopback-request-v1'), scope: exact(item.scope, 'pinned_native_request_builder_with_fake_api_key'),
    native: { bytes: integer(native.bytes, 1, 268_435_456), sha256: hash(native.sha256) }, allocationId: uuid(item.allocationId),
    fixture: { id: exact(fixture.id, 'grok-4.3'), object: exact(fixture.object, 'model'), context_length: exact(fixture.context_length, 1_000_000),
      capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_effort: exact(capabilities.default_reasoning_effort, 'low') }, aliases: ['grok-4.3-latest'] },
    environmentOverrides: ['GROK_XAI_API_BASE_URL', 'XAI_API_KEY'], credential: exact(item.credential, 'constant_fake_key_no_account_authority'),
    inferenceOrigin: exact(item.inferenceOrigin, 'explicit_loopback_fixture'), realModelInference: exact(item.realModelInference, false),
    modelsRequests, nonInference404Responses, requests, inferenceRequestLimit: exact(item.inferenceRequestLimit, 4), explicitSdkTurns: exact(item.explicitSdkTurns, 1),
    selections, providerExecutionStarted: exact(item.providerExecutionStarted, true), terminalCompleted: exact(item.terminalCompleted, true),
    fixtureResponseMatched: exact(item.fixtureResponseMatched, true), observedResultText: exact(item.observedResultText, 'NATIVE_LOOPBACK_MAPPING_OK'),
    standardMapping: exact(item.standardMapping, 'verified_request_default'),
    documentation: exact(item.documentation, 'https://docs.x.ai/developers/advanced-api-usage/priority-processing'),
    productionBackendBillingCertified: exact(item.productionBackendBillingCertified, false), cleanup: exact(item.cleanup, 'closed') };
}
