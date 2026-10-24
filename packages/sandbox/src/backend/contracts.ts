// ------------------------------------------------------------------------------------------------
//                contracts.ts - Finite inert backend driver and acquired sandbox ports
// ------------------------------------------------------------------------------------------------

import type { OperationOptions } from '../contracts.js';
import type { SandboxGuestPath, SandboxInputTreeEntry, SandboxInputTreeSelection, SandboxExportConsumer, SandboxTransferBudget, SandboxTransferSummary } from '../files/types.js';
import type { SandboxEffectivePolicy, SandboxId, SandboxProcessId, SandboxRequest, SandboxSupport, SandboxTransferBuffers } from '../policy/types.js';
import type { SandboxProcessSpec, SandboxProcessStreams } from '../process/types.js';
import type { SandboxReconciliation, SandboxRecoveryRecord } from '../recovery/types.js';
import type { SandboxDriverSpillStore } from './spill.js';

export interface SandboxDriverTransferOptions {
  readonly signal: AbortSignal;
  readonly quotas: SandboxTransferBudget;
  readonly buffers: SandboxTransferBuffers;
}

export interface SandboxDriverStartOptions extends OperationOptions {
  checkpoint(record: SandboxRecoveryRecord): Promise<void>;
}

export interface SandboxDriverProcessReservation {
  readonly id: SandboxProcessId;
  start(options?: OperationOptions): Promise<SandboxProcessStreams>;
}

export interface SandboxDriverReady {
  readonly effective: SandboxEffectivePolicy;
  readonly workspace: SandboxGuestPath;
  openSpill(options?: OperationOptions): Promise<SandboxDriverSpillStore>;
  importTree(entries: AsyncIterable<SandboxInputTreeEntry>, options: SandboxDriverTransferOptions): Promise<SandboxTransferSummary>;
  reserveProcess(spec: SandboxProcessSpec): SandboxDriverProcessReservation;
  exportTree(selection: SandboxInputTreeSelection, consume: SandboxExportConsumer, options: SandboxDriverTransferOptions): Promise<SandboxTransferSummary>;
}

export interface SandboxDriverReservation {
  readonly id: SandboxId;
  readonly recoveryRecord: SandboxRecoveryRecord;
  start(options: SandboxDriverStartOptions): Promise<SandboxDriverReady>;
  /** Cleanup must remain possible after persistence has failed. */
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxBackendDriver {
  readonly support: SandboxSupport;
  /** Synchronous and inert: reserve identities without acquiring resources. */
  reserve(request: SandboxRequest): SandboxDriverReservation;
  reconcile(record: SandboxRecoveryRecord, options?: OperationOptions): Promise<SandboxReconciliation>;
}
