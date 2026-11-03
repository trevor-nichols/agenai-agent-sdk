// ------------------------------------------------------------------------------------------------
//                contracts.ts - Private original-generation cleanup authority and member recovery
// ------------------------------------------------------------------------------------------------

import type { SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../../policy/config.js';
import type { DockerApi } from '../../../../resources/api.js';
import type { CoordinatorEvent } from '../journal/plans.js';
import type { CoordinatorSnapshot, ResourceRole } from '../journal/schema.js';

export interface DesktopCoordinatorCleanupJournal {
  readonly api: DockerApi;
  snapshot(): CoordinatorSnapshot;
  apply(event: CoordinatorEvent, boundary: 'member' | 'transition' | 'settlement'): Promise<void>;
  assertAuthority(signal?: AbortSignal): Promise<void>;
  run<Value>(perform: () => Promise<Value>): Promise<Value>;
  readonly settleCreatingAbsence?: (input: Readonly<{ memberId: string; role: ResourceRole; record: SandboxRecoveryRecord }>) => Promise<boolean>;
}

export interface DesktopCoordinatorRecoveryMembers {
  readonly members: readonly SandboxRecoveryRecord[];
  reconcile(configuration: DockerSandboxConfig, record: SandboxRecoveryRecord, signal?: AbortSignal): Promise<SandboxReconciliation>;
}
