// ------------------------------------------------------------------------------------------------
//                resolve.ts - Pure inspectable target eligibility
// ------------------------------------------------------------------------------------------------

import { parseDelegationTargetCatalog } from "../catalog/parse.js";
import type { DelegationTarget, DelegationTargetCatalog } from "../catalog/types.js";
import { captureDelegationRecord } from "../shared/bounds.js";
import { invalidDelegationData } from "../shared/errors.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { matchDelegationExclusion } from "./matching.js";
import { parseDelegationPolicySnapshot } from "./parse.js";
import { targetIdentityKey } from "./schemas.js";
import type {
  DelegationPolicySnapshot,
  DelegationTargetDecision,
  DelegationUserSelection,
  ResolvedDelegationPolicy,
} from "./types.js";

type Reason = DelegationTargetDecision["reasons"][number];

function selectedTarget(target: DelegationTarget, selection: DelegationUserSelection): boolean {
  const key = targetIdentityKey(target.reference);
  if (selection.kind === "explicit") return selection.targets.some((identity) => targetIdentityKey(identity) === key);
  if (target.executionMode.kind === "unknown") {
    return selection.unknownModeTargets.some((identity) => targetIdentityKey(identity) === key);
  }
  return target.executionMode.value === "standard" || selection.includeFast;
}

export function resolveDelegationPolicy(input: Readonly<{
  catalog: DelegationTargetCatalog;
  policy: DelegationPolicySnapshot;
}>): ResolvedDelegationPolicy {
  const envelope = captureDelegationRecord(input);
  if (Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, "catalog") || !Object.hasOwn(envelope, "policy")) {
    invalidDelegationData("invalid_data", [], "Policy resolution requires exactly catalog and policy data.");
  }
  const catalog = parseDelegationTargetCatalog(envelope.catalog);
  const policy = parseDelegationPolicySnapshot(envelope.policy);
  const enabled = policy.developer.enabled && policy.user.enabled;
  const selection = policy.user.enabled ? policy.user.selection : undefined;
  const allowedTargets: DelegationTarget[] = [];
  const decisions = catalog.targets.map((target): DelegationTargetDecision => {
    const selected = selection !== undefined && selectedTarget(target, selection);
    const reasons: Reason[] = [];
    if (!enabled) reasons.push({ code: "delegation_disabled", message: "Managed delegation is disabled by current policy." });
    if (target.availability.kind === "unavailable") {
      reasons.push({ code: "target_unavailable", message: target.availability.reason });
    }
    const options = new Map(target.options.map((option) => [option.key, option.optionId]));
    const excluded: Reason[] = [];
    const unverifiable: Reason[] = [];
    for (const exclusion of policy.developer.exclusions) {
      const match = matchDelegationExclusion(target, exclusion, options);
      if (match === "excluded" && excluded.length < 10) {
        excluded.push({ code: "developer_excluded", exclusionId: exclusion.exclusionId, message: "A developer exclusion denies this target." });
      } else if (match === "unverifiable" && unverifiable.length < 10) {
        unverifiable.push({ code: "developer_unverifiable", exclusionId: exclusion.exclusionId, message: "Unknown target semantics cannot prove compliance with a developer exclusion." });
      }
    }
    reasons.push(...excluded, ...unverifiable);
    if (selection !== undefined && !selected) {
      reasons.push(selection.kind === "all_available" && target.executionMode.kind === "unknown"
        ? { code: "unknown_mode_unselected", message: "Unknown execution mode requires selection of this exact target." }
        : { code: "user_unselected", message: "The end user has not selected this target." });
    }
    const firstReason = reasons[0];
    const outcome = firstReason === undefined ? "allowed"
      : firstReason.code === "developer_unverifiable" ? "unverifiable" : "denied";
    if (outcome === "allowed") allowedTargets.push(target);
    return { reference: target.reference, selected, outcome, reasons: reasons.slice(0, 10) };
  });
  const offered = new Set(catalog.targets.map((target) => targetIdentityKey(target.reference)));
  const requested = selection === undefined ? [] : selection.kind === "explicit" ? selection.targets : selection.unknownModeTargets;
  return freezeDelegationData({
    enabled, policyRevision: policy.revision,
    catalogId: catalog.catalogId, catalogRevision: catalog.revision,
    decisions, allowedTargets,
    missingSelections: requested.filter((identity) => !offered.has(targetIdentityKey(identity))),
  });
}
