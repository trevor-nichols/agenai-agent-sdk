// ------------------------------------------------------------------------------------------------
//                catalog.test.ts - Certified catalog identity and bounded-data contracts
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentConfigurationRevisionId } from "@agen-ai/agent-protocol";
import { DelegationValidationError, parseDelegationTargetCatalog } from "../src/index.js";
import { makeCatalog, makeTarget } from "./fixtures.js";

test("catalog parsing preserves exact certified combinations, application revisions and open reasoning identities", () => {
  const target = makeTarget("ultra", {
    reasoning: { kind: "certified", value: "provider-future-ultra" },
    options: [{ key: "model-specific-option", optionId: "native-ultra" }],
    limitations: ["x".repeat(2_000)],
    application: {
      configuration: {
        kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:42"), catalogRevision: 42,
        selections: [{ key: "model", fieldRevision: 17, value: { fieldKind: "single_select", optionId: "native-model" } }],
      },
      beforeFirstTurn: [{ key: "reasoning", expectedCatalogRevision: 43, expectedFieldRevision: 18, value: { fieldKind: "single_select", optionId: "native-ultra" } }],
    },
  });
  assert.deepEqual(parseDelegationTargetCatalog(makeCatalog([target])), makeCatalog([target]));
  const managed = makeTarget("fixed-model", { application: {
    configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("fixed:1") }, beforeFirstTurn: [],
  } });
  assert.equal(parseDelegationTargetCatalog(makeCatalog([managed])).targets[0]?.application.configuration.kind, "managed");
});

test("catalog parsing rejects inconsistent identities, unsupported mappings and malformed portable configurations", async (t) => {
  const target = makeTarget("one");
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ["duplicate target", makeCatalog([target, target])],
    ["wrong catalog identity", makeCatalog([{ ...target, reference: { ...target.reference, catalogId: "other" } }])],
    ["stale catalog revision", makeCatalog([{ ...target, reference: { ...target.reference, catalogRevision: 2 } }])],
    ["conflicting source revision", makeCatalog([target, makeTarget("two", { reference: { ...target.reference, targetId: "two", sourceRevision: 2 } })])],
    ["duplicate option key", makeCatalog([{ ...target, options: [{ key: "mode", optionId: "a" }, { key: "mode", optionId: "b" }] }])],
    ["unknown model", makeCatalog([{ ...target, modelId: "" }])],
    ["unknown speed lacks limitation", makeCatalog([{ ...target, executionMode: { kind: "unknown" } }])],
    ["unknown semantics carries value", makeCatalog([{ ...target, reasoning: { kind: "unknown", value: "max" } } as never])],
    ["unsupported semantic mode", makeCatalog([{ ...target, executionMode: { kind: "certified", value: "turbo" } } as never])],
    ["managed field application", makeCatalog([{ ...target, application: {
      configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("managed") },
      beforeFirstTurn: [{ key: "model", expectedCatalogRevision: 1, expectedFieldRevision: 1, value: { fieldKind: "single_select", optionId: "native" } }],
    } }])],
    ["configuration revision", makeCatalog([{ ...target, application: { ...target.application, configuration: { kind: "selected", revision: "revision", catalogRevision: 0, selections: [] } } } as never])],
    ["duplicate configured fields", makeCatalog([{ ...target, application: { ...target.application, configuration: {
      kind: "selected", revision: parseAgentConfigurationRevisionId("revision"), catalogRevision: 1,
      selections: [{ key: "model", fieldRevision: 1, value: { fieldKind: "boolean", value: true } }, { key: "model", fieldRevision: 1, value: { fieldKind: "boolean", value: false } }],
    } } }])],
    ["noncanonical identity", makeCatalog([{ ...target, reference: { ...target.reference, targetId: " padded " } }])],
    ["control character", makeCatalog([{ ...target, modelId: "native\u0085model" }])],
    ["unsafe revision", { ...makeCatalog([target]), revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown target property", makeCatalog([{ ...target, launchCommand: "untrusted" } as never])],
  ];
  for (const [name, input] of invalid) {
    await t.test(name, () => assert.throws(() => parseDelegationTargetCatalog(input), DelegationValidationError));
  }
});

test("catalog entry, target and UTF-8 document limits remain independent", async (t) => {
  await t.test("one thousand short targets are accepted", () => {
    const parsed = parseDelegationTargetCatalog(makeCatalog(Array.from({ length: 1_000 }, (_, index) => makeTarget(`target:${index}`))));
    assert.equal(parsed.targets.length, 1_000);
  });
  await t.test("too many targets", () => {
    assert.throws(() => parseDelegationTargetCatalog(makeCatalog(Array.from({ length: 1_001 }, (_, index) => makeTarget(`target:${index}`)))), DelegationValidationError);
  });
  await t.test("target aggregate exceeds individually valid fields", () => {
    const large = makeTarget("large", { options: Array.from({ length: 80 }, (_, index) => ({ key: `key:${index}`.padEnd(256, "x"), optionId: "x".repeat(256) })) });
    assert.throws(() => parseDelegationTargetCatalog(makeCatalog([large])), (error: unknown) => {
      assert.ok(error instanceof DelegationValidationError);
      assert.match(error.issues[0]!.message, /32 KiB/u);
      return true;
    });
  });
  await t.test("document uses serialized UTF-8 rather than character count", () => {
    const targets = Array.from({ length: 100 }, (_, index) => makeTarget(`target:${index}`, { limitations: ["界".repeat(2_000), "界".repeat(2_000)] }));
    const input = makeCatalog(targets);
    assert.ok(JSON.stringify(input).length < 1_048_576);
    assert.throws(() => parseDelegationTargetCatalog(input), (error: unknown) => {
      assert.ok(error instanceof DelegationValidationError);
      assert.equal(error.issues[0]?.code, "byte_limit");
      return true;
    });
  });
});

test("catalog parsers capture only inert data and never evaluate accessors", async (t) => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const symbol = { ...makeCatalog([]), [Symbol("hidden")]: true };
  const sparse = new Array(1);
  const invalid = [cycle, symbol, { ...makeCatalog([]), targets: sparse }, { ...makeCatalog([]), revision: NaN },
    { ...makeCatalog([]), targets: [() => undefined] }, JSON.parse('{"catalogId":"catalog","revision":1,"targets":[],"__proto__":{}}') as unknown,
    new Date(), Object.create({ catalogId: "catalog" }) as unknown];
  for (const [index, input] of invalid.entries()) {
    await t.test(`non-data input ${index}`, () => assert.throws(() => parseDelegationTargetCatalog(input), DelegationValidationError));
  }
  let reads = 0;
  const target = { ...makeTarget("getter") };
  Object.defineProperty(target, "label", { enumerable: true, get() { reads += 1; return "getter"; } });
  assert.throws(() => parseDelegationTargetCatalog(makeCatalog([target])), DelegationValidationError);
  assert.equal(reads, 0);
});

test("parsed catalogs are deeply frozen snapshots detached from host-owned input", () => {
  const options = [{ key: "reasoning", optionId: "max" }];
  const targets = [makeTarget("one", { options })];
  const parsed = parseDelegationTargetCatalog(makeCatalog(targets));
  options[0]!.optionId = "low";
  targets.length = 0;
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0]?.options[0]?.optionId, "max");
  assert.equal(Reflect.set(parsed.targets[0]!.reference, "sourceRevision", 2), false);
  assert.equal(Reflect.set(parsed.targets[0]!.options[0]!, "optionId", "low"), false);
});
