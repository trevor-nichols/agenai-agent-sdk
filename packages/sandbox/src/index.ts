// ------------------------------------------------------------------------------------------------
//                index.ts - Inert public sandbox contracts, parsers and scoped ownership helper
// ------------------------------------------------------------------------------------------------

export type { OperationOptions, SandboxState, SandboxBackend, SandboxReservation, Sandbox, SandboxRunOptions } from './contracts.js';
export type { SandboxNamespace, SandboxId, SandboxProcessId, SandboxResources, SandboxTemporaryStorage, SandboxHttpsDestination, SandboxNetworkPolicy, SandboxNetworkAllowlistSupport, SandboxWorkspaceDiskQuota, SandboxExecutionPolicy, SandboxDeadlines, SandboxPolicyInput, SandboxPolicy, SandboxRequestInput, SandboxRequest, SandboxTransferBuffers, SandboxStreamLimits, SandboxSupport, SandboxEffectivePolicy } from './policy/types.js';
export type { SandboxGuestPath, SandboxRelativePath, SandboxSymlinkTarget, SandboxSymlinkPolicy, SandboxTransferSymlinkSupport, SandboxByteSource, SandboxTreeEntry, SandboxTreeSource, SandboxInputTreeEntry, SandboxExportEntry, SandboxExportConsumer, SandboxTreeSelection, SandboxInputTreeSelection, SandboxCapturedTreeSelection, SandboxTransferQuotaName, SandboxTransferQuotas, SandboxTransferBudget, SandboxTransferOptions, SandboxTransferSummary } from './files/types.js';
export type { SandboxProcessInput, SandboxProcessSpec, SandboxProcessExit, SandboxProcessStreams, SandboxProcessReservation } from './process/types.js';
export type { SandboxRecoveryPhase, SandboxResourceIdentity, SandboxRecoveryResource, SandboxRecoveryAuthority, SandboxRecoveryRecord, SandboxRecoveryPolicy, SandboxCleanupOwner, SandboxReconciliation } from './recovery/types.js';
export type { SandboxOperationErrorCode } from './errors.js';
export { SandboxValidationError, SandboxUnsupportedError, SandboxStateError, SandboxOperationError, SandboxCleanupError, SandboxStartError, SandboxRunError } from './errors.js';
export { SANDBOX_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS, SANDBOX_DEFAULT_STREAM_LIMITS } from './policy/limits.js';
export { parseSandboxNamespace, parseSandboxId, parseSandboxProcessId, parseSandboxPolicy, parseSandboxRequest, parseSandboxSupport, parseSandboxEffectivePolicy } from './policy/parse.js';
export { parseSandboxRelativePath, parseSandboxGuestPath, parseSandboxSymlinkTarget } from './files/paths.js';
export { fileFromBytes } from './files/bytes.js';
export { parseSandboxProcessSpec, parseSandboxProcessExit } from './process/parse.js';
export { parseSandboxRecoveryRecord, parseSandboxRecoveryPolicy } from './recovery/parse.js';
export { withSandbox } from './withSandbox.js';
export type { SandboxFileAccess, SandboxFileSupport, SandboxLivePath, SandboxFileEntry, SandboxFileRejection, SandboxFileCancellation,
  SandboxFileObservation, SandboxFileStatResult, SandboxFileListResult, SandboxFileReadResult, SandboxFileWriteResult, SandboxFileQuotas,
  SandboxFileOptions, SandboxFileWriteOptions, SandboxFileListConsumer, SandboxFileReadConsumer, SandboxReadOnlyFiles, SandboxReadWriteFiles, SandboxFiles } from './live/types.js';
