// ------------------------------------------------------------------------------------------------
//                failure.ts - Bounded parent-visible projection of authoritative child failures
// ------------------------------------------------------------------------------------------------

import type { AgentError } from "@agen-ai/agent-protocol";
import { delegationDataBytes } from "../shared/identity.js";
import { DELEGATION_FAILURE_BYTES } from "../shared/limits.js";
import { fitDelegationText } from "../shared/text.js";
import type { DelegationPublicFailure } from "./types.js";

export function projectDelegationFailure(error?: AgentError): DelegationPublicFailure {
  if (!error) return { category: "unknown", code: "child_failed",
    message: "The managed child reported an unsuccessful terminal outcome.", recovery: { kind: "unknown" } };
  const hint = error.recovery;
  const recovery: DelegationPublicFailure["recovery"] = hint.kind === "retry"
    ? { kind: hint.kind, ...(hint.notBefore === undefined ? {} : { notBefore: hint.notBefore }) }
    : hint.kind === "user_action" ? { kind: hint.kind, action: hint.action } : { kind: hint.kind };
  const failure = { category: error.category, code: error.code, recovery };
  if (recovery.kind === "retry" && delegationDataBytes({ ...failure, message: "" }) > DELEGATION_FAILURE_BYTES) {
    // Omit optional timing rather than round the reported instant or lose a definitive outcome.
    failure.recovery = { kind: "retry" };
  }
  return { ...failure, message: fitDelegationText(error.message,
    (message) => delegationDataBytes({ ...failure, message }) <= DELEGATION_FAILURE_BYTES) };
}
