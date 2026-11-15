// ------------------------------------------------------------------------------------------------
//                session.ts - Session-owned token-usage admission - Dependencies: ledger
// ------------------------------------------------------------------------------------------------

import type {
  AgentProviderKey,
  AgentSessionId,
  AgentTurnId,
  AgentUsageObservedEvent,
  AgentUsageScopeId,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import {
  admitValidatedTokenUsageEvent,
  createTokenUsageLedger,
  tokenUsageLedgerHasScope,
} from "./ledger.js";
import { summarizeTokenUsageView } from "./summary.js";
import { AGENT_TOKEN_USAGE_LEDGER_LIMITS } from "./types.js";

/** One ledger per runtime session; rejections become contract failures before delivery. */
export function createSessionTokenUsageAccounting(providerKey: AgentProviderKey, sessionId: AgentSessionId) {
  let ledger = createTokenUsageLedger({ sessionId });
  const enteredTurns = new Set<AgentTurnId>();
  return {
    requireTurnEntry(turnId: AgentTurnId): void {
      if (enteredTurns.has(turnId)) throwAgentProviderContractError(providerKey, "usage_scope_mismatch",
        "Token usage requires distinct SDK turn identities within a session generation.");
      if (enteredTurns.size >= AGENT_TOKEN_USAGE_LEDGER_LIMITS.retainedObservations) {
        throwAgentProviderContractError(providerKey, "usage_capacity_exceeded", "Entered usage turn identity capacity is exhausted.");
      }
    },
    enterTurn(turnId: AgentTurnId): void { enteredTurns.add(turnId); },
    admit(event: AgentUsageObservedEvent): void {
      const { scope, view } = event.payload;
      if ("turnId" in scope && scope.turnId !== undefined && !enteredTurns.has(scope.turnId)) {
        throwAgentProviderContractError(providerKey, "usage_scope_mismatch", "Accounting scope references an SDK turn that never entered execution.");
      }
      const admission = admitValidatedTokenUsageEvent(ledger, event);
      if (admission.status === "rejected") throwAgentProviderContractError(providerKey, admission.code, admission.message);
      const turns = summarizeTokenUsageView(admission.ledger, view.viewId)?.newWork.counters.turns;
      if (turns !== undefined && turns.kind !== "unavailable" && turns.value > enteredTurns.size) {
        throwAgentProviderContractError(providerKey, "usage_scope_mismatch", "Known new-work turn count exceeds entered SDK turns.");
      }
      ledger = admission.ledger;
    },
    hasScope: (scopeId: AgentUsageScopeId): boolean => tokenUsageLedgerHasScope(ledger, scopeId),
  };
}
export type SessionTokenUsageAccounting = ReturnType<typeof createSessionTokenUsageAccounting>;
