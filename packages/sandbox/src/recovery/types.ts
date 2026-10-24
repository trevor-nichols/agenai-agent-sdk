// ------------------------------------------------------------------------------------------------
//                types.ts - Fixed recovery evidence, persistence and cleanup-only reconciliation
// ------------------------------------------------------------------------------------------------

import type { SandboxId, SandboxNamespace } from '../policy/types.js';

export type SandboxRecoveryPhase = 'reserved' | 'starting' | 'running' | 'stopping' | 'stopped' | 'destroying' | 'destroyed' | 'uncertain';

export type SandboxResourceIdentity =
  | Readonly<{ kind: 'planned' }>
  | Readonly<{ kind: 'creating' }>
  | Readonly<{ kind: 'identified'; id: string; fingerprint: string }>;

export interface SandboxRecoveryResource {
  readonly role: 'compute' | 'storage' | 'export' | 'network';
  readonly name: string;
  readonly identity: SandboxResourceIdentity;
}

export type SandboxRecoveryAuthority =
  | Readonly<{ kind: 'unverified' }>
  | Readonly<{ kind: 'verified'; backendIdentity: string }>;

export interface SandboxRecoveryRecord {
  readonly format: 'agenai.sandbox-recovery.v2';
  readonly backendId: string;
  readonly backendRevision: string;
  readonly namespace: SandboxNamespace;
  readonly operationId: string;
  readonly sandboxId: SandboxId;
  readonly imageDigest: string;
  readonly policyDigest: string;
  /** Exact backend configuration identity, independent of the requested policy digest. */
  readonly configurationDigest: string;
  readonly phase: SandboxRecoveryPhase;
  readonly authority: SandboxRecoveryAuthority;
  readonly resources: readonly SandboxRecoveryResource[];
}

export type SandboxRecoveryPolicy =
  | Readonly<{ kind: 'in_process' }>
  | Readonly<{ kind: 'persisted'; persist(record: SandboxRecoveryRecord): Promise<void> }>;

export interface SandboxCleanupOwner {
  readonly recoveryRecord: SandboxRecoveryRecord;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export type SandboxReconciliation =
  | Readonly<{ kind: 'matched' | 'uncertain'; owner: SandboxCleanupOwner }>
  | Readonly<{ kind: 'conflict'; reason: string }>
  | Readonly<{ kind: 'absent'; record: SandboxRecoveryRecord }>;
