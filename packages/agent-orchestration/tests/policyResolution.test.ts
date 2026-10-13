// ------------------------------------------------------------------------------------------------
//                policyResolution.test.ts - Public effective-choice and denial semantics
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentProviderKey } from "@agen-ai/agent-protocol";
import {
  DelegationValidationError,
  parseDelegationPolicySnapshot,
  resolveDelegationPolicy,
  type DelegationExclusion,
  type DelegationTarget,
} from "../src/index.js";
import { enabledPolicy, explicitSelection, makeCatalog, makeTarget, providerKey } from "./fixtures.js";

function allowedIds(result: ReturnType<typeof resolveDelegationPolicy>): string[] {
  return result.allowedTargets.map((target) => target.reference.targetId);
}

test("either disabled flag blocks every choice while preserving inspectable user selection", () => {
  const catalog = makeCatalog([makeTarget("max")]);
  for (const policy of [parseDelegationPolicySnapshot({ revision: 1 }),
    parseDelegationPolicySnapshot({ revision: 2, developer: { enabled: false }, user: { enabled: true } })]) {
    const result = resolveDelegationPolicy({ catalog, policy });
    assert.equal(result.enabled, false);
    assert.deepEqual(allowedIds(result), []);
    assert.equal(result.decisions[0]?.outcome, "denied");
    assert.equal(result.decisions[0]?.reasons[0]?.code, "delegation_disabled");
    assert.equal(result.decisions[0]?.selected, policy.user.enabled);
  }
});

test("enabled omitted selection admits certified standard at every reasoning identity and leaves fast and unknown unselected", () => {
  const targets = ["low", "max", "xhigh", "ultra", "future-native-level"].map((value) => makeTarget(value, { reasoning: { kind: "certified", value } }));
  targets.push(makeTarget("unknown-reasoning", { reasoning: { kind: "unknown" } }),
    makeTarget("fast", { executionMode: { kind: "certified", value: "fast" } }),
    makeTarget("unknown-mode", { executionMode: { kind: "unknown" }, limitations: ["Native execution speed cannot be certified."] }));
  const result = resolveDelegationPolicy({ catalog: makeCatalog(targets), policy: enabledPolicy() });
  assert.deepEqual(allowedIds(result), ["low", "max", "xhigh", "ultra", "future-native-level", "unknown-reasoning"]);
  assert.equal(result.decisions.find((decision) => decision.reference.targetId === "fast")?.reasons[0]?.code, "user_unselected");
  assert.equal(result.decisions.find((decision) => decision.reference.targetId === "unknown-mode")?.reasons[0]?.code, "unknown_mode_unselected");
});

test("explicit empty or missing selections never fall back and exact selections do not grow", () => {
  const catalog = makeCatalog([makeTarget("first"), makeTarget("new")]);
  const empty = resolveDelegationPolicy({ catalog, policy: enabledPolicy([], explicitSelection()) });
  assert.deepEqual(allowedIds(empty), []);
  assert.ok(empty.decisions.every((decision) => decision.reasons[0]?.code === "user_unselected"));
  const missing = resolveDelegationPolicy({ catalog, policy: enabledPolicy([], explicitSelection("retired")) });
  assert.deepEqual(allowedIds(missing), []);
  assert.deepEqual(missing.missingSelections, [{ catalogId: "catalog", targetId: "retired" }]);
  const exact = resolveDelegationPolicy({ catalog, policy: enabledPolicy([], explicitSelection("first")) });
  assert.deepEqual(allowedIds(exact), ["first"]);
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog, policy: enabledPolicy() })), ["first", "new"]);
});

test("fast and unknown mode require user opt-in and remain subordinate to developer exclusions", () => {
  const catalog = makeCatalog([
    makeTarget("standard"),
    makeTarget("fast", { executionMode: { kind: "certified", value: "fast" } }),
    makeTarget("unknown", { executionMode: { kind: "unknown" }, limitations: ["Speed is unknown."] }),
  ]);
  const fastOptIn = enabledPolicy([], { kind: "all_available", includeFast: true, unknownModeTargets: [] });
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog, policy: fastOptIn })), ["standard", "fast"]);
  const exactUnknown = enabledPolicy([], { kind: "all_available", includeFast: false, unknownModeTargets: [{ catalogId: "catalog", targetId: "unknown" }] });
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog, policy: exactUnknown })), ["standard", "unknown"]);
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog, policy: enabledPolicy([], explicitSelection("fast", "unknown")) })), ["fast", "unknown"]);
  const restricted = resolveDelegationPolicy({ catalog, policy: enabledPolicy([{ exclusionId: "deny-fast", executionMode: "fast" }], explicitSelection("fast", "unknown")) });
  assert.deepEqual(allowedIds(restricted), []);
  assert.equal(restricted.decisions[1]?.outcome, "denied");
  assert.equal(restricted.decisions[2]?.outcome, "unverifiable");
  assert.equal(restricted.decisions[2]?.selected, true);
});

test("an unknown-mode opt-in does not become an ambient fast opt-in after recertification", () => {
  const policy = enabledPolicy([], { kind: "all_available", includeFast: false, unknownModeTargets: [{ catalogId: "catalog", targetId: "same" }] });
  const unknown = makeTarget("same", { executionMode: { kind: "unknown" }, limitations: ["Speed is unknown."] });
  const standard = makeTarget("same");
  const fast = makeTarget("same", { executionMode: { kind: "certified", value: "fast" } });
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog: makeCatalog([unknown]), policy })), ["same"]);
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog: makeCatalog([standard]), policy })), ["same"]);
  assert.deepEqual(allowedIds(resolveDelegationPolicy({ catalog: makeCatalog([fast]), policy })), []);
});

test("exclusion conjunctions use exact provider/model/options with tri-state semantic matching", async (t) => {
  const unknown = makeTarget("one", { reasoning: { kind: "unknown" }, executionMode: { kind: "unknown" }, limitations: ["Reasoning and speed are unknown."], options: [{ key: "native-mode", optionId: "exact" }] });
  const cases: ReadonlyArray<readonly [string, DelegationExclusion, "allowed" | "denied" | "unverifiable"]> = [
    ["exact provider", { exclusionId: "provider", providerKey }, "denied"],
    ["unrelated provider with unknown reasoning", { exclusionId: "other", providerKey: parseAgentProviderKey("other-harness"), reasoning: "max" }, "allowed"],
    ["unrelated model with unknown mode", { exclusionId: "model", providerKey, modelId: "other-model", executionMode: "fast" }, "allowed"],
    ["relevant unknown reasoning", { exclusionId: "reasoning", providerKey, modelId: "model-a", reasoning: "max" }, "unverifiable"],
    ["relevant unknown mode", { exclusionId: "mode", executionMode: "fast" }, "unverifiable"],
    ["matching exact tuple", { exclusionId: "tuple", providerKey, modelId: "model-a", options: [{ key: "native-mode", optionId: "exact" }] }, "denied"],
    ["option value mismatch", { exclusionId: "tuple", providerKey, options: [{ key: "native-mode", optionId: "other" }], reasoning: "max" }, "allowed"],
    ["omitted option is known mismatch", { exclusionId: "omitted", providerKey, options: [{ key: "absent", optionId: "exact" }], executionMode: "fast" }, "allowed"],
    ["exact target", { exclusionId: "target", catalogId: "catalog", targetId: "one" }, "denied"],
    ["other catalog", { exclusionId: "target", catalogId: "other", targetId: "one", reasoning: "max" }, "allowed"],
  ];
  for (const [name, exclusion, outcome] of cases) {
    await t.test(name, () => {
      const result = resolveDelegationPolicy({ catalog: makeCatalog([unknown]), policy: enabledPolicy([exclusion], explicitSelection("one")) });
      assert.equal(result.decisions[0]?.outcome, outcome);
      assert.equal(result.allowedTargets.length, outcome === "allowed" ? 1 : 0);
    });
  }
  await t.test("known mode inequality defeats an earlier unknown reasoning criterion", () => {
    const result = resolveDelegationPolicy({ catalog: makeCatalog([makeTarget("one", { reasoning: { kind: "unknown" } })]),
      policy: enabledPolicy([{ exclusionId: "both", reasoning: "max", executionMode: "fast" }]) });
    assert.deepEqual(allowedIds(result), ["one"]);
  });
});

test("model-specific exact exclusions preserve other valid combinations without creating new ones", () => {
  const targets = [
    makeTarget("a-low", { modelId: "model-a", reasoning: { kind: "certified", value: "low" }, options: [{ key: "budget", optionId: "native-low" }] }),
    makeTarget("a-max", { modelId: "model-a", options: [{ key: "budget", optionId: "native-max" }] }),
    makeTarget("b-low", { modelId: "model-b", reasoning: { kind: "certified", value: "low" }, options: [{ key: "budget", optionId: "native-low" }] }),
  ];
  const result = resolveDelegationPolicy({ catalog: makeCatalog(targets), policy: enabledPolicy([
    { exclusionId: "a-low", providerKey, modelId: "model-a", reasoning: "low", options: [{ key: "budget", optionId: "native-low" }] },
  ]) });
  assert.deepEqual(allowedIds(result), ["a-max", "b-low"]);
  assert.deepEqual(result.allowedTargets.map((target) => target.options), [[{ key: "budget", optionId: "native-max" }], [{ key: "budget", optionId: "native-low" }]]);
});

test("reason precedence is deterministic and explanations are bounded while definitive exclusions win", () => {
  const target = makeTarget("unknown", { reasoning: { kind: "unknown" } });
  const exclusions: DelegationExclusion[] = [
    ...Array.from({ length: 20 }, (_, index) => ({ exclusionId: `unknown:${index}`, reasoning: "max" })),
    { exclusionId: "certain", providerKey },
  ];
  const denied = resolveDelegationPolicy({ catalog: makeCatalog([target]), policy: enabledPolicy(exclusions, explicitSelection("unknown")) });
  assert.equal(denied.decisions[0]?.outcome, "denied");
  assert.equal(denied.decisions[0]?.reasons[0]?.exclusionId, "certain");
  assert.equal(denied.decisions[0]?.reasons.length, 10);
  assert.equal(denied.decisions[0]?.reasons[1]?.exclusionId, "unknown:0");
  const unavailable = resolveDelegationPolicy({ catalog: makeCatalog([{ ...target, availability: { kind: "unavailable", code: "account_unavailable", reason: "Current host authorization is unavailable." } }]), policy: enabledPolicy(exclusions) });
  assert.equal(unavailable.decisions[0]?.reasons[0]?.code, "target_unavailable");
  assert.equal(unavailable.decisions[0]?.outcome, "denied");
  const disabled = resolveDelegationPolicy({ catalog: makeCatalog([target]), policy: parseDelegationPolicySnapshot({ revision: 2, developer: { enabled: false, exclusions }, user: { enabled: true } }) });
  assert.equal(disabled.decisions[0]?.reasons[0]?.code, "delegation_disabled");
});

test("current source and policy revisions remain observable while stale catalog references are rejected", () => {
  const prior = makeTarget("stable");
  const policy = enabledPolicy([], explicitSelection("stable"));
  const first = resolveDelegationPolicy({ catalog: makeCatalog([prior]), policy });
  const replacement: DelegationTarget = { ...prior, reference: { ...prior.reference, catalogRevision: 2, targetRevision: 2, sourceId: "replacement-source", sourceRevision: 9 } };
  const current = { catalogId: "catalog", revision: 2, targets: [replacement] };
  const resolved = resolveDelegationPolicy({ catalog: current, policy: { ...policy, revision: 3 } });
  assert.deepEqual(allowedIds(resolved), ["stable"]);
  assert.notDeepEqual(resolved.allowedTargets[0]?.reference, first.allowedTargets[0]?.reference);
  assert.equal(resolved.policyRevision, 3);
  assert.equal(resolved.catalogRevision, 2);
  assert.equal(resolved.decisions[0]?.reference.sourceId, "replacement-source");
  assert.equal(resolved.decisions[0]?.reference.sourceRevision, 9);
  assert.throws(() => resolveDelegationPolicy({ catalog: { ...current, targets: [prior] }, policy }), DelegationValidationError);
  const disabled = resolveDelegationPolicy({ catalog: current, policy: parseDelegationPolicySnapshot({ revision: 4, user: { enabled: false } }) });
  assert.deepEqual(allowedIds(disabled), []);
});

test("resolution returns detached frozen UI and admission data in catalog order", () => {
  const targets = [makeTarget("z-last-lexically"), makeTarget("a-first-lexically")];
  const result = resolveDelegationPolicy({ catalog: makeCatalog(targets), policy: enabledPolicy() });
  targets.reverse();
  assert.deepEqual(allowedIds(result), ["z-last-lexically", "a-first-lexically"]);
  assert.deepEqual(result.decisions.map((decision) => decision.reference.targetId), allowedIds(result));
  assert.ok(result.decisions.every((decision) => decision.selected && decision.outcome === "allowed" && decision.reasons.length === 0));
  assert.equal(Reflect.set(result.allowedTargets[0]!.reference, "sourceRevision", 99), false);
  assert.equal(Reflect.set(result.decisions[0]!, "outcome", "denied"), false);
  assert.equal(Object.isFrozen(result.allowedTargets), true);
});
