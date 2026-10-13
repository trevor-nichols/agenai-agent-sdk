// ------------------------------------------------------------------------------------------------
//                index.ts - Public pure delegation store adapter contract
// ------------------------------------------------------------------------------------------------

export { planDelegationStoreCommit } from "./plan.js";
export type {
  DelegationStoreCommitCurrent, DelegationStoreCommitPlan, DelegationStoreRowMutation,
} from "./types.js";
export { delegationCanonicalJson, delegationDataBytes, delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
export { parseDelegationStoreCommand, parseDelegationStoreReadInput, parseDelegationStoreScanInput } from "../store/parse.js";
export { delegationCursorPrefix, parseDelegationPageCursor, summarizeDelegationRun } from "../store/pages.js";
export {
  DELEGATION_CRITICAL_SLOT_BYTES, DELEGATION_CRITICAL_SLOTS,
  DELEGATION_FINAL_RESERVATION_BYTES, DELEGATION_RUN_RESERVATION_BYTES,
} from "../shared/limits.js";
