// ------------------------------------------------------------------------------------------------
//                contracts.ts - Public sandbox ownership and operation contracts
// ------------------------------------------------------------------------------------------------

import type { SandboxGuestPath, SandboxTreeSource, SandboxTreeSelection, SandboxExportConsumer, SandboxTransferOptions, SandboxTransferSummary } from './files/types.js';
import type { SandboxFiles } from './live/types.js';
import type { SandboxEffectivePolicy, SandboxId, SandboxRequestInput, SandboxSupport } from './policy/types.js';
import type { SandboxProcessReservation, SandboxProcessInput } from './process/types.js';
import type { SandboxCleanupOwner, SandboxReconciliation, SandboxRecoveryPolicy, SandboxRecoveryRecord } from './recovery/types.js';

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export type SandboxState =
  | Readonly<{ kind: 'reserved' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'destroying' | 'destroyed' }>
  | Readonly<{ kind: 'failed' | 'uncertain'; operation: 'start' | 'import' | 'process' | 'export' | 'files' | 'stop' | 'destroy' }>;

export interface SandboxBackend {
  readonly support: SandboxSupport;
  reserve(request: SandboxRequestInput, recovery: SandboxRecoveryPolicy): SandboxReservation;
  reconcile(record: SandboxRecoveryRecord, options?: OperationOptions): Promise<SandboxReconciliation>;
}

export interface SandboxReservation extends SandboxCleanupOwner {
  readonly id: SandboxId;
  readonly state: SandboxState;
  start(options?: OperationOptions): Promise<Sandbox>;
}

export interface Sandbox extends SandboxCleanupOwner {
  readonly id: SandboxId;
  readonly state: SandboxState;
  readonly effective: SandboxEffectivePolicy;
  readonly workspace: SandboxGuestPath;
  readonly files: SandboxFiles;
  importTree(entries: SandboxTreeSource, options?: SandboxTransferOptions): Promise<SandboxTransferSummary>;
  reserveProcess(spec: SandboxProcessInput): SandboxProcessReservation;
  exportTree(selection: SandboxTreeSelection, consume: SandboxExportConsumer, options?: SandboxTransferOptions): Promise<SandboxTransferSummary>;
}

export interface SandboxRunOptions extends OperationOptions {
  readonly recovery: SandboxRecoveryPolicy;
}

export type { SandboxRecoveryRecord };
