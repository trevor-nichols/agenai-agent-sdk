// ------------------------------------------------------------------------------------------------
//                policyParsing.test.ts - Policy defaults, exact predicates and bounded selections
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { DelegationValidationError, parseDelegationPolicySnapshot } from "../src/index.js";
import { providerKey } from "./fixtures.js";

test("revision-only policy defaults disabled with an empty permissive developer ceiling", () => {
  assert.deepEqual(parseDelegationPolicySnapshot({ revision: 7 }), {
    revision: 7, developer: { enabled: true, exclusions: [] }, user: { enabled: false },
  });
  const enabled = parseDelegationPolicySnapshot({ revision: 8, developer: {}, user: { enabled: true } });
  assert.deepEqual(enabled, { revision: 8, developer: { enabled: true, exclusions: [] }, user: {
    enabled: true, selection: { kind: "all_available", includeFast: false, unknownModeTargets: [] },
  } });
  assert.equal(Object.isFrozen(enabled.developer.exclusions), true);
  if (enabled.user.enabled) assert.equal(Object.isFrozen(enabled.user.selection), true);
});

test("policy parsing rejects ambiguous, unscoped or duplicate exclusion and selection data", async (t) => {
  const identities = [{ catalogId: "catalog", targetId: "one" }, { catalogId: "catalog", targetId: "one" }];
  const exclusions: ReadonlyArray<readonly [string, unknown]> = [
    ["criterion omitted", [{ exclusionId: "empty" }]],
    ["model unscoped", [{ exclusionId: "model", modelId: "native-model" }]],
    ["option unscoped", [{ exclusionId: "option", options: [{ key: "mode", optionId: "fast" }] }]],
    ["target missing catalog", [{ exclusionId: "target", targetId: "one" }]],
    ["catalog missing target", [{ exclusionId: "catalog", catalogId: "catalog" }]],
    ["empty options", [{ exclusionId: "empty-options", providerKey, options: [] }]],
    ["duplicate options", [{ exclusionId: "duplicate", providerKey, options: [{ key: "mode", optionId: "a" }, { key: "mode", optionId: "b" }] }]],
    ["duplicate exclusions", [{ exclusionId: "same", reasoning: "max" }, { exclusionId: "same", reasoning: "low" }]],
    ["reasoning exceeds bound", [{ exclusionId: "long", reasoning: "x".repeat(129) }]],
    ["noncanonical reasoning", [{ exclusionId: "control", reasoning: "high\u009F" }]],
    ["executable predicate", [{ exclusionId: "callback", test: () => true }]],
  ];
  for (const [name, input] of exclusions) {
    await t.test(name, () => assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, developer: { exclusions: input } }), DelegationValidationError));
  }
  for (const selection of [{ kind: "explicit", targets: identities }, { kind: "all_available", includeFast: false, unknownModeTargets: identities }]) {
    await t.test(`duplicate ${selection.kind} identities`, () => {
      assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, user: { enabled: true, selection } }), DelegationValidationError);
    });
  }
  assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, user: { enabled: false, selection: { kind: "explicit", targets: [] } } }), DelegationValidationError);
  assert.throws(() => parseDelegationPolicySnapshot({ revision: 0 }), DelegationValidationError);
});

test("selection identities stay exact even when delimiters occur in opaque strings", () => {
  const targets = [{ catalogId: "a:b", targetId: "c" }, { catalogId: "a", targetId: "b:c" }];
  const parsed = parseDelegationPolicySnapshot({ revision: 1, user: { enabled: true, selection: { kind: "explicit", targets } } });
  assert.equal(parsed.user.enabled && parsed.user.selection?.kind === "explicit" && parsed.user.selection.targets.length, 2);
});

test("policy entry and aggregate UTF-8 limits reject oversized host policy", async (t) => {
  await t.test("selection entry ceiling", () => {
    const targets = Array.from({ length: 1_001 }, (_, index) => ({ catalogId: "catalog", targetId: `target:${index}` }));
    assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, user: { enabled: true, selection: { kind: "explicit", targets } } }), DelegationValidationError);
  });
  await t.test("exclusion entry ceiling", () => {
    const exclusions = Array.from({ length: 1_001 }, (_, index) => ({ exclusionId: `exclusion:${index}`, reasoning: "low" }));
    assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, developer: { exclusions } }), DelegationValidationError);
  });
  await t.test("aggregate bytes", () => {
    const exclusions = Array.from({ length: 30 }, (_, index) => ({
      exclusionId: `exclusion:${index}`, providerKey,
      options: Array.from({ length: 100 }, (_, option) => ({ key: `key:${option}`.padEnd(256, "x"), optionId: "x".repeat(256) })),
    }));
    assert.throws(() => parseDelegationPolicySnapshot({ revision: 1, developer: { exclusions } }), (error: unknown) => {
      assert.ok(error instanceof DelegationValidationError);
      assert.equal(error.issues[0]?.code, "byte_limit");
      return true;
    });
  });
});
