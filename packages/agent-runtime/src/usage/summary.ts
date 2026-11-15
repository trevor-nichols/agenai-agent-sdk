// ------------------------------------------------------------------------------------------------
//                summary.ts - Explicit per-view token-usage summaries - Dependencies: ledger state
// ------------------------------------------------------------------------------------------------

import type { AgentUsageViewId } from "@agen-ai/agent-protocol";

import { combineAttribution, UNKNOWN_ATTRIBUTION } from "./attribution.js";
import { deepFreeze } from "./canonical.js";
import { addCounts, combineCounters, overlapCounts } from "./counts.js";
import { memoizedUsageSummary, usageLedgerState } from "./ledgerState.js";
import type { ScopeContribution } from "./scopeAccounting.js";
import type { AgentTokenUsageLedger, AgentTokenUsageViewSummary } from "./types.js";

/** Disjoint scopes add; overlapping scopes keep the larger known total, while new work always adds. */
function foldContributions(contributions: readonly [ScopeContribution, ...ScopeContribution[]]): ScopeContribution {
  const [first, ...rest] = contributions;
  const disjoint = contributions.every((part) => part.disjoint);
  return rest.reduce((sum, part) => ({
    total: combineCounters(sum.total, part.total, disjoint ? addCounts : overlapCounts),
    newWork: combineCounters(sum.newWork, part.newWork, addCounts),
    attribution: combineAttribution(sum.attribution, part.attribution),
    newWorkAttribution: combineAttribution(sum.newWorkAttribution, part.newWorkAttribution),
    disjoint,
  }), first);
}

/** Folds the explicitly selected view; admission already proved the fold cannot overflow. */
export function summarizeTokenUsageView(
  ledger: AgentTokenUsageLedger,
  viewId: AgentUsageViewId,
): AgentTokenUsageViewSummary | undefined {
  const state = usageLedgerState(ledger);
  const view = state.views.get(viewId);
  if (view === undefined) return undefined;
  return memoizedUsageSummary(ledger, viewId, () => {
    const contributions = view.scopeIds.map((scopeId) => {
      const scope = state.scopes.get(scopeId);
      if (scope === undefined) throw new TypeError("Usage view state references an unknown scope.");
      return scope.contribution;
    });
    const [first, ...rest] = contributions;
    if (first === undefined) throw new TypeError("Usage view state has no admitted scope.");
    const folded = foldContributions([first, ...rest]);
    return deepFreeze({
      viewId,
      authority: view.view.authority,
      scopeKind: view.scopeKind,
      scopeCount: contributions.length,
      total: { counters: folded.total, attribution: folded.attribution ?? UNKNOWN_ATTRIBUTION },
      newWork: { counters: folded.newWork, attribution: folded.newWorkAttribution ?? UNKNOWN_ATTRIBUTION },
    });
  });
}
