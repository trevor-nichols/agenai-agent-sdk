// ------------------------------------------------------------------------------------------------
//                matching.ts - Exact conjunction matching with unknown semantic facts
// ------------------------------------------------------------------------------------------------

import type { DelegationTarget } from "../catalog/types.js";
import type { DelegationExclusion } from "./types.js";

export function matchDelegationExclusion(
  target: DelegationTarget,
  exclusion: DelegationExclusion,
  options: ReadonlyMap<string, string>,
): "excluded" | "unmatched" | "unverifiable" {
  if ((exclusion.providerKey !== undefined && exclusion.providerKey !== target.providerKey)
    || (exclusion.modelId !== undefined && exclusion.modelId !== target.modelId)
    || (exclusion.catalogId !== undefined && exclusion.catalogId !== target.reference.catalogId)
    || (exclusion.targetId !== undefined && exclusion.targetId !== target.reference.targetId)
    || exclusion.options?.some((option) => options.get(option.key) !== option.optionId)) {
    return "unmatched";
  }
  let unknown = false;
  if (exclusion.reasoning !== undefined) {
    if (target.reasoning.kind === "unknown") unknown = true;
    else if (target.reasoning.value !== exclusion.reasoning) return "unmatched";
  }
  if (exclusion.executionMode !== undefined) {
    if (target.executionMode.kind === "unknown") unknown = true;
    else if (target.executionMode.value !== exclusion.executionMode) return "unmatched";
  }
  return unknown ? "unverifiable" : "excluded";
}
