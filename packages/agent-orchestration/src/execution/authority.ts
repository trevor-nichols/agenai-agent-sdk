// ------------------------------------------------------------------------------------------------
//                authority.ts - Current policy and immutable ancestor ceiling checks
// ------------------------------------------------------------------------------------------------

import type { DelegationTarget, DelegationTargetReference } from "../catalog/types.js";
import { resolveDelegationPolicy } from "../policy/resolve.js";
import { delegationCanonicalJson } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import { createDelegationPolicyCeiling, parseDelegationParentScope } from "../tasks/parse.js";
import type { DelegationParentScope, DelegationPolicyCeiling } from "../tasks/types.js";
import type { CoordinatorState, LiveRun, ParentBinding } from "./state.js";

export function sameTarget(left: DelegationTargetReference, right: DelegationTargetReference): boolean {
  return delegationCanonicalJson(left) === delegationCanonicalJson(right);
}

function current(state: CoordinatorState, scope: DelegationParentScope) {
  const snapshot = state.options.host.currentPolicy(scope);
  const actual = parseDelegationParentScope(snapshot.scope);
  if (actual.parentId !== scope.parentId || actual.scopeId !== scope.scopeId || actual.revision !== scope.revision) {
    failDelegation("stale_revision", "The parent scope grant is no longer current.");
  }
  return resolveDelegationPolicy({ catalog: snapshot.catalog, policy: snapshot.policy });
}

export async function readCeiling(state: CoordinatorState, ceilingId: string): Promise<DelegationPolicyCeiling> {
  const targets: DelegationTargetReference[] = [];
  let origin: DelegationParentScope | undefined;
  let cursor: string | undefined;
  do {
    const page = await state.options.store.read({ kind: "ceiling", ceilingId, ...(cursor === undefined ? {} : { cursor }), limit: state.options.limits.maxPageRecords });
    if (page.kind !== "ceiling" || !page.origin) return failDelegation("owner_lost", "The originating policy ceiling is unavailable.");
    origin = page.origin;
    targets.push(...page.page.items);
    if (targets.length > 1_000) failDelegation("capacity_exceeded", "The originating policy ceiling exceeds its bound.");
    cursor = page.page.cursor;
  } while (cursor !== undefined);
  if (!origin) return failDelegation("owner_lost", "The originating policy ceiling is unavailable.");
  const ceiling = createDelegationPolicyCeiling({ origin, targets });
  if (ceiling.ceilingId !== ceilingId) failDelegation("owner_lost", "The stored policy ceiling is inconsistent.");
  return ceiling;
}

export async function bindingCeiling(state: CoordinatorState, binding: ParentBinding): Promise<DelegationPolicyCeiling | undefined> {
  if (binding.ceiling) return binding.ceiling;
  if (!binding.ancestor) return undefined;
  const [{ task }, run] = await Promise.all([state.task(binding.ancestor.taskId), state.run(binding.ancestor.taskId, binding.ancestor.runId)]);
  if (task.parent.scopeId !== binding.scope.scopeId || run.ownerEpoch !== state.owner.epoch
    || !["preparing", "running", "waiting"].includes(run.phase) || !state.live.has(run.runId)) {
    failDelegation("owner_lost", "The descendant binding does not belong to a live owned ancestor run.");
  }
  return readCeiling(state, task.policyCeilingRef);
}

export async function effectiveChoices(state: CoordinatorState, binding: ParentBinding) {
  const inherited = await bindingCeiling(state, binding);
  const resolved = current(state, binding.scope);
  const origin = inherited === undefined ? resolved : current(state, inherited.origin);
  const inheritedKeys = inherited === undefined ? undefined : new Set(inherited.targets.map(delegationCanonicalJson));
  const originKeys = new Set(origin.allowedTargets.map((target) => delegationCanonicalJson(target.reference)));
  const targets = resolved.allowedTargets.filter((target) => originKeys.has(delegationCanonicalJson(target.reference))
    && (inheritedKeys === undefined || inheritedKeys.has(delegationCanonicalJson(target.reference))));
  const ceiling = inherited ?? createDelegationPolicyCeiling({ origin: binding.scope, targets: targets.map((target) => target.reference) });
  return { resolved, targets, ceiling, originPolicyRevision: origin.policyRevision, enabled: resolved.enabled && origin.enabled };
}

export function admittedTarget(choices: Awaited<ReturnType<typeof effectiveChoices>>, reference: DelegationTargetReference, revision: number): DelegationTarget {
  if (choices.resolved.policyRevision !== revision) failDelegation("stale_revision", "The selected managed policy revision is stale.");
  if (!choices.resolved.enabled) failDelegation("delegation_disabled", "Managed delegation is disabled.");
  const decision = choices.resolved.decisions.find((entry) => entry.reference.targetId === reference.targetId && entry.reference.catalogId === reference.catalogId);
  if (!decision || !sameTarget(decision.reference, reference)) failDelegation("stale_target", "The exact selected target or source revision is stale.");
  const target = choices.targets.find((entry) => sameTarget(entry.reference, reference));
  if (!target) {
    if (decision.reasons.some((reason) => reason.code === "target_unavailable")) failDelegation("target_unavailable", "The selected target is unavailable.");
    failDelegation("policy_denied", "Current policy or the originating ceiling denies this target.");
  }
  return target;
}

export function assertRunDispatch(state: CoordinatorState, live: LiveRun, policyRevision: number, originPolicyRevision: number): void {
  if ((state.closing && !state.draining) || state.failed || state.released) failDelegation("owner_lost", "The coordinator is closed to new execution input.");
  if (live.lifetime.signal.aborted) failDelegation("recovery_required", "The run no longer accepts execution input.");
  const resolved = current(state, live.scope);
  const origin = current(state, live.ceiling.origin);
  if (resolved.policyRevision !== policyRevision || origin.policyRevision !== originPolicyRevision) {
    failDelegation("stale_revision", "Managed policy changed before provider execution.");
  }
  if (!resolved.enabled || !origin.enabled) failDelegation("delegation_disabled", "Managed delegation is disabled.");
  const exact = (target: DelegationTarget) => sameTarget(target.reference, live.target.reference);
  if (!live.ceiling.targets.some((reference) => sameTarget(reference, live.target.reference))
    || !resolved.allowedTargets.some(exact) || !origin.allowedTargets.some(exact)) {
    failDelegation("policy_denied", "Current policy or the originating ceiling no longer permits the exact target.");
  }
  live.execution?.assertCurrent();
}
