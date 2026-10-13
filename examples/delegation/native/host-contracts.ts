import type { AgentCapabilities, AgentConfigurationCatalog } from '@agen-ai/agent-protocol';
import type { DelegationAdmissionReceipt, DelegationCompletionEnvelope, DelegationParentScope, DelegationTargetReference } from '@agen-ai/agent-orchestration';
import type { GrokConfigurationSelection } from './grok.js';
import type { NativeConfigurationFileRecord, NativeExecutableLease, NativeProcessAllocation } from './launch-contracts.js';
import type { NativeParentPermissionPolicy } from './permissions.js';
import type { HistoricalNativeParentApprovalObservation, NativeParentApprovalObservation } from './permission-contracts.js';

export const NATIVE_QUALIFICATION_BUDGETS = Object.freeze({
  maxTurns: 6, modeMs: 300_000, delegationMs: 180_000, ordinaryMs: 90_000, cleanupMs: 30_000,
  discoveryMs: 30_000, maxResultBytes: 8_192, maxRetainedTextBytes: 65_536,
});

export type NativeOutcome = 'qualified' | 'blocked' | 'failed' | 'uncertain' | 'cleanup_pending';
export type NativeFailureReason = 'artifact_unapproved' | 'registry_distribution_unavailable' | 'credential_isolation_unavailable'
  | 'source_identity_drift' | 'artifact_identity_drift' | 'credential_unavailable' | 'authentication_failed'
  | 'authentication_expired' | 'configuration_unknown' | 'configuration_scope_unverified' | 'standard_mapping_unverified'
  | 'mcp_tools_unexposed' | 'native_extension_required' | 'approval_not_authorized' | 'native_protocol_incompatible' | 'parent_did_not_delegate'
  | 'child_result_unavailable' | 'parent_completion_mismatch' | 'completed_before_cancellation'
  | 'cancellation_unsupported' | 'budget_exhausted' | 'dispatch_uncertain' | 'cleanup_pending';

export interface NativeFailedGate { readonly gate: 'opening' | 'configuration' | 'ordinary' | 'delegation' | 'scope' | 'delivery' | 'cancellation' | 'cleanup'; readonly reason: NativeFailureReason }
export interface NativeCleanupReceipt {
  readonly status: 'closed' | 'pending';
  readonly coordinatorClosed: boolean;
  readonly sessionsClosed: boolean;
  readonly registriesClosed: boolean;
  readonly bridgesAcquired: number;
  readonly bridgesReleased: number;
  readonly elapsedMs: number;
}

export interface NativeDiscoveryReport {
  readonly version: 1;
  readonly outcome: NativeOutcome;
  readonly reason?: NativeFailureReason;
  readonly failedGates: readonly NativeFailedGate[];
  readonly noPrompt: true;
  readonly elapsedMs: number;
  readonly capabilities?: AgentCapabilities;
  readonly configuration?: GrokConfigurationSelection;
  readonly modelAcknowledged: boolean;
  readonly reasoningAcknowledged: boolean;
  readonly configurationStarts: number;
  readonly cleanup: NativeCleanupReceipt;
}

export interface NativeGrokMapping {
  readonly mappingId: string;
  readonly mappingRevision: number;
  readonly modelId: string;
  readonly reasoning: 'low';
  readonly executionMode: 'standard';
  readonly proofDigest: string;
}

export interface DiscoverNativeConfigurationOptions {
  readonly executable: NativeExecutableLease;
  readonly allocation: NativeProcessAllocation;
  readonly choice: Readonly<{ modelId: string; reasoning: 'low' }>;
  readonly signal?: AbortSignal;
}

export interface RunNativeQualificationModeOptions {
  readonly executable: NativeExecutableLease;
  readonly allocations: Readonly<{ parent: NativeProcessAllocation; child: NativeProcessAllocation; comparison: NativeProcessAllocation }>;
  readonly selection: GrokConfigurationSelection;
  readonly mapping: NativeGrokMapping;
  readonly parentPermissionPolicy?: NativeParentPermissionPolicy;
  readonly signal?: AbortSignal;
}

export type NativeTurnPurpose = 'ordinary' | 'admission' | 'child' | 'completion' | 'cancellation_admission' | 'cancellation_child';
/** Public display observations only; a response or tool label never proves admission or native readiness. */
export interface NativeAdmissionObservation {
  readonly assistantTextBytes: number;
  readonly assistantTextDeltas: number;
  readonly textCapped: boolean;
  readonly requestCount: number;
  readonly toolItems: Readonly<{ search_tool: number; use_tool: number; managed_targets: number; managed_delegate: number; other: number }>;
  readonly response: 'admitted_true' | 'other_text' | 'none';
}
export interface NativeTurnObservation {
  readonly role: 'parent' | 'child';
  readonly purpose: NativeTurnPurpose;
  readonly sessionId: string;
  readonly turnId: string;
  readonly enteredAt: number;
  readonly configurationCatalogRevision: number;
  readonly configurationVerifiedAt: number;
  readonly providerStartedAt?: number;
  readonly terminalAt?: number;
  readonly settledAt: number;
  readonly outcome: 'completed' | 'canceled' | 'failed' | 'pending_request' | 'uncertain';
  /** Present only after the expected harmless JSON result has been validated. */
  readonly resultText?: string;
  readonly admissionObservation?: NativeAdmissionObservation;
}

export interface NativeToolObservation {
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly invocationId: string;
  readonly toolName: 'delegation_targets' | 'delegate_task' | 'task_status' | 'task_send' | 'task_cancel';
  readonly at: number;
  readonly status: 'success' | 'error';
  readonly admission?: DelegationAdmissionReceipt;
  readonly target?: DelegationTargetReference;
}

export interface NativeConfigurationScopeProof {
  readonly verified: boolean;
  readonly parentBeforeChild: AgentConfigurationCatalog;
  readonly parentAfterChild: AgentConfigurationCatalog;
  readonly comparisonBeforeChild: AgentConfigurationCatalog;
  readonly comparisonAfterChild: AgentConfigurationCatalog;
  readonly parentFilesBeforeChild: readonly NativeConfigurationFileRecord[];
  readonly parentFilesAfterChild: readonly NativeConfigurationFileRecord[];
  readonly comparisonFilesBeforeChild: readonly NativeConfigurationFileRecord[];
  readonly comparisonFilesAfterChild: readonly NativeConfigurationFileRecord[];
}

export interface NativeSessionObservation {
  readonly sessionId: string;
  readonly role: 'parent' | 'child' | 'comparison';
  readonly event: 'opening' | 'opened' | 'closed';
  readonly at: number;
}

interface NativeModeReportFields {
  readonly outcome: NativeOutcome;
  readonly reason?: NativeFailureReason;
  readonly failedGates: readonly NativeFailedGate[];
  readonly budgets: typeof NATIVE_QUALIFICATION_BUDGETS;
  readonly usage: Readonly<{ turns: number; elapsedMs: number; delegationElapsedMs?: number }>;
  readonly turns: readonly NativeTurnObservation[];
  readonly sessions: readonly NativeSessionObservation[];
  readonly tools: readonly NativeToolObservation[];
  readonly admissions: readonly DelegationAdmissionReceipt[];
  readonly parentPermissionProofDigest?: string;
  readonly parentScope?: DelegationParentScope;
  readonly configurationStarts: number;
  readonly parentConfiguration?: AgentConfigurationCatalog;
  readonly childConfigurations: readonly AgentConfigurationCatalog[];
  readonly scope?: NativeConfigurationScopeProof;
  readonly dispatchGate?: Readonly<{ parentTurnId: string; parentSettledAt: number; releasedAt: number; childProviderStartedAt: number; verified: boolean }>;
  readonly child?: Readonly<{ taskId: string; runId: string; sessionId: string; turnId: string; token: string; resultDigest: string }>;
  readonly delivery?: Readonly<{ parentSessionId: string; parentTurnId: string; inboxId: string; acceptedAt: number; dispatchedAt: number; acknowledgedAt: number; envelope: DelegationCompletionEnvelope; token: string; verified: boolean }>;
  readonly cancellation: Readonly<{ status: 'confirmed' | 'completed_before_cancellation' | 'unsupported' | 'uncertain' | 'not_started'; taskId?: string; runId?: string; providerStartedAt?: number; requestedAt?: number }>;
  readonly cleanup: NativeCleanupReceipt;
}

export type NativeModeReport = NativeModeReportFields & (
  | Readonly<{ version: 1; approvals?: readonly HistoricalNativeParentApprovalObservation[] }>
  | Readonly<{ version: 2; approvals?: readonly NativeParentApprovalObservation[] }>
);

/** Only report is serializable. Keep a failed cleanup capability and its owners in this process. */
export interface NativeDiscoveryResult { readonly report: NativeDiscoveryReport; readonly retryCleanup?: () => Promise<void> }
export interface NativeModeResult { readonly report: NativeModeReport; readonly retryCleanup?: () => Promise<void> }

export class NativeQualificationError extends Error {
  constructor(readonly reason: NativeFailureReason) { super(`Native qualification gate: ${reason}.`); this.name = 'NativeQualificationError'; }
}
