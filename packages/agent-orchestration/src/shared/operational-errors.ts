// ------------------------------------------------------------------------------------------------
//                operational-errors.ts - Bounded public delegation operation failures
// ------------------------------------------------------------------------------------------------

export type DelegationErrorCode =
  | "delegation_disabled" | "policy_denied" | "target_unavailable" | "stale_target"
  | "unsupported_operation" | "capacity_exceeded" | "operation_conflict" | "stale_revision"
  | "owner_lost" | "request_unavailable" | "delivery_uncertain" | "recovery_required" | "store_failed";

export class DelegationOperationError extends Error {
  constructor(readonly code: DelegationErrorCode, message: string) {
    super(message);
    this.name = "DelegationOperationError";
  }
}

export function failDelegation(code: DelegationErrorCode, message: string): never {
  throw new DelegationOperationError(code, message);
}
