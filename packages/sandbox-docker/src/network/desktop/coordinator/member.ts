// ------------------------------------------------------------------------------------------------
//                member.ts - Private original-member lifecycle and journal integration ports
// ------------------------------------------------------------------------------------------------

import type { SandboxOperationError, SandboxPolicy, SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../policy/config.js';
import type { DockerApi } from '../../../resources/api.js';
import type { ResourceInspection } from '../../../resources/inspect.js';
import type { DesktopRouteCensus } from '../acquisition.js';
import type { DesktopVmObserverClient } from '../client.js';
import type { CoordinatorEvent } from './journal/plans.js';
import type { CoordinatorSnapshot, MemberProjection, ResourceAction, ResourceRole, WorkOwnership } from './journal/schema.js';

export interface DesktopCoordinatorMemberAllocation {
  readonly slot: number;
  readonly subnet: string;
  readonly gateway: string;
}

export interface DesktopCoordinatorMemberOwner {
  readonly api: DockerApi;
  readonly config: DockerSandboxConfig;
  readonly policy: SandboxPolicy;
  record(): SandboxRecoveryRecord;
  retain(record: SandboxRecoveryRecord): void;
  persist(record: SandboxRecoveryRecord): Promise<void>;
  returned(role: ResourceRole, id: string): void;
  creating(role: ResourceRole, actual: Promise<unknown>): void;
  enrolled(member: DesktopCoordinatorMember): void;
  remove(role: ResourceRole): Promise<void>;
  failed(error: SandboxOperationError): void;
}

export interface DesktopCoordinatorCreateOperation {
  readonly input: unknown;
  dispatch(resource: SandboxRecoveryResource): Promise<Readonly<{ id: string; warning?: boolean }>>;
  validate?(inspection: ResourceInspection): void;
}

export interface DesktopCoordinatorStartOperation {
  readonly ready?: Promise<void>;
  beginReadiness?(): void;
  validate(inspection: ResourceInspection): void;
}

export type DesktopCoordinatorControlledRole = Extract<ResourceRole, 'route_observer' | 'filesystem' | 'egress_broker' | 'egress_relay'>;
export type DesktopCoordinatorStartedRole = DesktopCoordinatorControlledRole | 'compute';

export interface DesktopCoordinatorMember {
  readonly allocation: DesktopCoordinatorMemberAllocation;
  readonly census: DesktopRouteCensus;
  checkpoint(record: SandboxRecoveryRecord): Promise<void>;
  create(role: ResourceRole, signal: AbortSignal | undefined, operation: DesktopCoordinatorCreateOperation): Promise<ResourceInspection>;
  start(role: DesktopCoordinatorStartedRole, signal: AbortSignal | undefined, operation: DesktopCoordinatorStartOperation): Promise<ResourceInspection>;
  observer(id: string, client: DesktopVmObserverClient): void;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  closeAdmission(): void;
  infrastructureFailed(error: SandboxOperationError): void;
  controlFailed(role: DesktopCoordinatorControlledRole, error: SandboxOperationError): void;
  controlClose(role: DesktopCoordinatorControlledRole, close: () => Promise<unknown>): Promise<void>;
  delete(role: ResourceRole): Promise<void>;
  beginStop(): Promise<void>;
  stopped(record: SandboxRecoveryRecord): Promise<void>;
  retire(record: SandboxRecoveryRecord): Promise<void>;
  workEnter(scope: keyof WorkOwnership, token: string): Promise<void>;
  workJoin(scope: keyof WorkOwnership, token: string): Promise<void>;
}

export interface DesktopCoordinatorEffectObservation {
  readonly receiptDigest: string;
  readonly inspectionDigest: string;
  readonly projection?: MemberProjection;
}

/** Implemented only by the canonical coordinator owner; no package export exposes this port. */
export interface DesktopCoordinatorMemberJournal {
  readonly memberId: string;
  readonly allocation: DesktopCoordinatorMemberAllocation;
  readonly census: DesktopRouteCensus;
  snapshot(): CoordinatorSnapshot;
  apply(event: CoordinatorEvent, boundary: 'member' | 'transition' | 'settlement'): Promise<void>;
  trackCleanup<Value>(perform: () => Promise<Value>): Promise<Value>;
  run<Value>(kind: 'ordinary' | 'cleanup', perform: () => Promise<Value>, signal?: AbortSignal): Promise<Value>;
  runCleanup<Value>(canonical: () => Promise<Value>, conservative: () => Promise<Value>): Promise<Value>;
  assertAuthority(kind: 'growth' | 'cleanup', signal?: AbortSignal): Promise<void>;
  before(role: ResourceRole, action: ResourceAction, signal?: AbortSignal): Promise<string>;
  after(role: ResourceRole, action: ResourceAction, inspection: ResourceInspection | undefined): Promise<DesktopCoordinatorEffectObservation>;
  observer(id: string, client: DesktopVmObserverClient): void;
  closeAdmission(): void;
  controlFailed(role: DesktopCoordinatorControlledRole, error: SandboxOperationError): void;
  fence(cause: unknown): void;
  isFenced(): boolean;
  stopped(): Promise<void>;
}
