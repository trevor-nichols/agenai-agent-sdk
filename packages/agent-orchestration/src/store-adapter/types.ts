// ------------------------------------------------------------------------------------------------
//                types.ts - Bounded delegation domain contracts
// ------------------------------------------------------------------------------------------------

import type { DelegationLimits } from "../shared/limits.js";
import type {
  DelegationCommitReceipt, DelegationOperationRecord, DelegationStoreCapacity,
} from "../store/types.js";
import type {
  DelegationNotificationRecord, DelegationOwnerToken, DelegationPolicyCeiling,
  DelegationRunRecord, DelegationTaskObservation, DelegationTaskRecord,
} from "../tasks/types.js";

export interface DelegationStoreCommitCurrent {
  readonly storeId: string;
  readonly owner?: DelegationOwnerToken;
  readonly limits: DelegationLimits;
  readonly capacity: DelegationStoreCapacity;
  readonly task?: DelegationTaskRecord;
  readonly runs: readonly DelegationRunRecord[];
  readonly operation?: DelegationOperationRecord;
  readonly criticalOperations: readonly DelegationOperationRecord[];
  readonly notification?: DelegationNotificationRecord;
  readonly ceiling?: DelegationPolicyCeiling;
  readonly observation?: DelegationTaskObservation;
  readonly omissionObservation?: DelegationTaskObservation;
  readonly runIdExists?: boolean;
}

export type DelegationStoreRowMutation =
  | Readonly<{ kind: "task"; value: DelegationTaskRecord }>
  | Readonly<{ kind: "run"; value: DelegationRunRecord }>
  | Readonly<{ kind: "operation"; value: DelegationOperationRecord }>
  | Readonly<{ kind: "observation"; value: DelegationTaskObservation }>
  | Readonly<{ kind: "notification"; value: DelegationNotificationRecord }>
  | Readonly<{ kind: "ceiling"; value: DelegationPolicyCeiling }>
  | Readonly<{ kind: "capacity"; value: DelegationStoreCapacity }>;

export interface DelegationStoreCommitPlan {
  readonly mutations: readonly DelegationStoreRowMutation[];
  readonly receipt: DelegationCommitReceipt;
}
