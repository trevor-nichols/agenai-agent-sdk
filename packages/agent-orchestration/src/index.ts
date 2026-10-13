// ------------------------------------------------------------------------------------------------
//                index.ts - Optional provider-neutral managed delegation API
// ------------------------------------------------------------------------------------------------

export type {
  DelegationExecutionMode,
  DelegationReasoning,
  DelegationSemanticFact,
  DelegationTarget,
  DelegationTargetCatalog,
  DelegationTargetOption,
  DelegationTargetReference,
} from "./catalog/types.js";
export { parseDelegationTargetCatalog } from "./catalog/parse.js";
export type {
  DelegationDeveloperPolicy,
  DelegationExclusion,
  DelegationPolicyOutcome,
  DelegationPolicySnapshot,
  DelegationTargetDecision,
  DelegationTargetIdentity,
  DelegationUserPolicy,
  DelegationUserSelection,
  ResolvedDelegationPolicy,
} from "./policy/types.js";
export { parseDelegationPolicySnapshot } from "./policy/parse.js";
export { resolveDelegationPolicy } from "./policy/resolve.js";
export { DelegationValidationError, type DelegationValidationIssue } from "./shared/errors.js";
export {
  DelegationOperationError,
  type DelegationErrorCode,
} from "./shared/operational-errors.js";
export {
  DEFAULT_DELEGATION_LIMITS,
  parseDelegationLimits,
  type DelegationLimits,
} from "./shared/limits.js";
export type {
  CreateDelegationCoordinatorOptions,
  DelegationAdmissionReceipt,
  DelegationBindingSnapshot,
  DelegationCancelReceipt,
  DelegationClient,
  DelegationCoordinator,
  DelegationRecoveryPage,
  DelegationRequestReceipt,
  DelegationResolveHostRequestInput,
  DelegationSendReceipt,
  DelegationSendTaskInput,
  DelegationShutdownReceipt,
  DelegationSpawnTaskInput,
  DelegationTargetPage,
  DelegationWaitReceipt,
} from "./coordinator/types.js";
export { createDelegationCoordinator } from "./coordinator/create.js";
export type {
  DelegationInboxAcceptance,
  DelegationInboxInspection,
  DelegationParentDeliveryPort,
} from "./delivery/types.js";
export {
  parseDelegationInboxAcceptance,
  parseDelegationInboxInspection,
} from "./delivery/parse.js";
export type {
  DelegationAppliedConfiguration,
  DelegationChildResources,
  DelegationContinuation,
  DelegationExecutionLease,
  DelegationHost,
  DelegationHostPolicy,
  DelegationHostRequest,
  DelegationHostRequestHandle,
} from "./host/types.js";
export type {
  DelegationCommitReceipt,
  DelegationCriticalSlot,
  DelegationDeliveryResult,
  DelegationMutationFence,
  DelegationOperationDisposition,
  DelegationOperationKind,
  DelegationOperationRecord,
  DelegationRunAdmission,
  DelegationStore,
  DelegationStoreCapacity,
  DelegationStoreCommand,
  DelegationStoreReadInput,
  DelegationStoreReadPage,
  DelegationStoreScanInput,
  DelegationStoreScanPage,
} from "./store/types.js";
export { createInMemoryDelegationStore } from "./store/memory.js";
export type {
  DelegationCompletionEnvelope,
  DelegationCompletionPolicy,
  DelegationDeliveryCommitRecord,
  DelegationHistoricalRequest,
  DelegationNotificationRecord,
  DelegationObservationGap,
  DelegationObservedTaskObservation,
  DelegationOwnerToken,
  DelegationPage,
  DelegationParentScope,
  DelegationPersistence,
  DelegationPolicyCeiling,
  DelegationPublicFailure,
  DelegationResultReference,
  DelegationResultSummary,
  DelegationRunOutcome,
  DelegationRunPhase,
  DelegationRunRecord,
  DelegationRunSummary,
  DelegationTaskObservation,
  DelegationTaskRecord,
  DelegationTaskState,
  DelegationTaskView,
} from "./tasks/types.js";
export {
  createDelegationPolicyCeiling,
  parseDelegationCompletionEnvelope,
  parseDelegationHistoricalRequest,
  parseDelegationNotificationRecord,
  parseDelegationOwnerToken,
  parseDelegationParentScope,
  parseDelegationPolicyCeiling,
  parseDelegationResultReference,
  parseDelegationRunOutcome,
  parseDelegationRunRecord,
  parseDelegationTaskObservation,
  parseDelegationTaskRecord,
} from "./tasks/parse.js";
export { createDelegationHostBinding } from "./tools/create.js";
export type {
  CreateDelegationHostBindingOptions,
  DelegationToolTarget,
  DelegationToolTargetPage,
  DelegationToolRunSummary,
  DelegationToolTaskStatus,
} from "./tools/types.js";
