// ------------------------------------------------------------------------------------------------
//                hostBindingsValidation.test.ts - Closed schema and binding metadata contracts
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAgentSessionHostBinding,
  type AgentHostToolInputSchema,
  type AgentHostToolSchema,
} from "../src/index.js";
import {
  createHarness,
  emptySchema,
  hasContractCode,
  invoke,
  makeBinding,
  supportedBinding,
} from "./fixtures/hostBindings/harness.js";

function schemaWith(property: unknown): AgentHostToolInputSchema {
  return {
    ...emptySchema,
    properties: { value: property },
    required: ["value"],
  } as AgentHostToolInputSchema;
}

test("pure binding validation does not claim or release opening ownership", async () => {
  const host = makeBinding();
  validateAgentSessionHostBinding({ binding: host.binding, support: supportedBinding });
  validateAgentSessionHostBinding({ binding: host.binding, support: supportedBinding });
  assert.equal(host.releaseCount(), 0);
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  await session.close({ reason: "idle" });
  assert.equal(host.releaseCount(), 1);
  await harness.registry.dispose();
});

test("invalid closed schema definitions fail before native opening and release the claimed lease", async (t) => {
  let deep: unknown = { type: "boolean" };
  for (let depth = 0; depth < 8; depth += 1) {
    deep = { type: "array", maxItems: 1, items: deep };
  }
  const wide = {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 3 }, (_, index) => [
      `p${index}`, {
        type: "object", additionalProperties: false,
        properties: Object.fromEntries(Array.from({ length: 85 }, (_, key) => [key.toString(36), { type: "boolean" }])),
      },
    ])),
  };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["missing root dialect", { type: "object", properties: {}, additionalProperties: false }],
    ["unsupported dialect", { ...emptySchema, $schema: "http://json-schema.org/draft-07/schema#" }],
    ["non-object root", { $schema: emptySchema.$schema, type: "boolean" }],
    ["nested dialect", schemaWith({ type: "boolean", $schema: emptySchema.$schema })],
    ["remote reference", schemaWith({ type: "boolean", $ref: "https://example.invalid/schema" })],
    ["regex keyword", schemaWith({ type: "string", maxLength: 10, pattern: "a+" })],
    ["default keyword", schemaWith({ type: "boolean", default: true })],
    ["union keyword", schemaWith({ oneOf: [{ type: "boolean" }, { type: "null" }] })],
    ["format keyword", schemaWith({ type: "string", maxLength: 10, format: "email" })],
    ["executable schema", schemaWith({ type: "boolean", validate: () => true })],
    ["open object", { ...emptySchema, additionalProperties: true }],
    ["nested open object", schemaWith({ type: "object", properties: {}, additionalProperties: true })],
    ["unknown required key", { ...emptySchema, required: ["absent"] }],
    ["duplicate required key", { ...schemaWith({ type: "boolean" }), required: ["value", "value"] }],
    ["prototype-sensitive key", { ...emptySchema, properties: JSON.parse('{"__proto__":{"type":"boolean"}}') }],
    ["oversized property key", { ...emptySchema, properties: { ["p".repeat(129)]: { type: "boolean" } } }],
    ["excess properties", { ...emptySchema, properties: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, { type: "boolean" }])) }],
    ["unbounded array", schemaWith({ type: "array", items: { type: "boolean" } })],
    ["excess array maximum", schemaWith({ type: "array", items: { type: "boolean" }, maxItems: 101 })],
    ["fractional array bound", schemaWith({ type: "array", items: { type: "boolean" }, maxItems: 1.5 })],
    ["reversed array bounds", schemaWith({ type: "array", items: { type: "boolean" }, minItems: 2, maxItems: 1 })],
    ["unbounded string", schemaWith({ type: "string" })],
    ["excess string maximum", schemaWith({ type: "string", maxLength: 16_001 })],
    ["negative string minimum", schemaWith({ type: "string", minLength: -1, maxLength: 1 })],
    ["reversed string bounds", schemaWith({ type: "string", minLength: 2, maxLength: 1 })],
    ["duplicate enum entries", schemaWith({ type: "string", maxLength: 3, enum: ["yes", "yes"] })],
    ["enum outside bounds", schemaWith({ type: "string", maxLength: 2, enum: ["yes"] })],
    ["non-string enum", schemaWith({ type: "string", maxLength: 3, enum: [1] })],
    ["nonfinite numeric bound", schemaWith({ type: "number", maximum: Infinity })],
    ["unsafe integer bound", schemaWith({ type: "integer", maximum: Number.MAX_SAFE_INTEGER + 1 })],
    ["fractional integer bound", schemaWith({ type: "integer", minimum: 0.5 })],
    ["reversed numeric bounds", schemaWith({ type: "number", minimum: 2, maximum: 1 })],
    ["oversized schema description", schemaWith({ type: "boolean", description: "d".repeat(2_001) })],
    ["schema byte ceiling", { ...emptySchema, description: "界".repeat(2_000), properties: { a: { type: "boolean", description: "界".repeat(1_000) } } }],
    ["schema depth ceiling", schemaWith(deep)],
    ["schema node ceiling", schemaWith(wide)],
  ];
  for (const [name, schema] of cases) {
    await t.test(name, async () => {
      const harness = await createHarness();
      const host = makeBinding({ schema: schema as AgentHostToolInputSchema });
      assert.throws(
        () => validateAgentSessionHostBinding({ binding: host.binding, support: supportedBinding }),
        TypeError,
      );
      assert.equal(host.releaseCount(), 0, "Pure validation leaves ownership with the caller.");
      await assert.rejects(async () => harness.open("create", host.binding), hasContractCode("invalid_host_binding"));
      assert.equal(harness.contexts.length, 0);
      assert.equal(host.releaseCount(), 1);
      await harness.registry.dispose();
    });
  }
});

test("binding metadata limits reject malformed tools and guidance before native opening", async (t) => {
  const tool = makeBinding().binding.tools[0]!;
  const cases: ReadonlyArray<readonly [string, object, string?]> = [
    ["no tools", { tools: [] }],
    ["too many tools", { tools: Array.from({ length: 33 }, (_, index) => ({ ...tool, name: `Tool${index}` })) }],
    ["duplicate names", { tools: [tool, { ...tool }] }],
    ["invalid tool name", { tools: [{ ...tool, name: "inspect.state" }] }],
    ["oversized tool name", { tools: [{ ...tool, name: "T".repeat(65) }] }],
    ["empty description", { tools: [{ ...tool, description: "" }] }],
    ["oversized description", { tools: [{ ...tool, description: "d".repeat(2_001) }] }],
    ["empty instructions", { instructions: { placement: "developer", text: "" } }],
    ["oversized instruction text", { instructions: { placement: "developer", text: "t".repeat(16_001) } }],
    ["instruction UTF-8 ceiling", { instructions: { placement: "developer", text: "界".repeat(6_000) } }],
    ["metadata byte ceiling", { tools: Array.from({ length: 32 }, (_, index) => ({
      ...tool, name: `Tool${index}`, description: "d".repeat(2_000),
      inputSchema: { ...emptySchema, description: "s".repeat(200) },
    })) }],
    ["unknown binding metadata", { endpoint: "https://example.invalid" }],
  ];
  for (const [name, metadata, code = "invalid_host_binding"] of cases) {
    await t.test(name, async () => {
      const harness = await createHarness();
      const host = makeBinding();
      Object.assign(host.binding, metadata);
      await assert.rejects(async () => harness.open("create", host.binding), hasContractCode(code));
      assert.equal(harness.contexts.length, 0);
      assert.equal(host.releaseCount(), 1);
      await harness.registry.dispose();
    });
  }
});

test("the provider receives frozen detached metadata with the authorized schema and instruction placement", async () => {
  const schema = schemaWith({ type: "string", minLength: 1, maxLength: 2, enum: ["ok"] });
  const host = makeBinding({ schema });
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  const facade = harness.facade();
  assert.notEqual(facade, host.binding);
  assert.deepEqual(facade.instructions, host.binding.instructions);
  assert.deepEqual(structuredClone(facade.tools), host.binding.tools);
  for (const object of [facade, facade.tools, facade.tools[0], facade.tools[0]!.inputSchema,
    facade.tools[0]!.inputSchema.properties, facade.tools[0]!.inputSchema.properties.value, facade.instructions]) {
    assert.equal(Object.isFrozen(object), true);
  }
  Object.assign(schema.properties.value!, { enum: ["no"] });
  Object.assign(host.binding.tools[0]!, { name: "Changed" });
  Object.assign(host.binding.instructions!, { text: "Changed after opening" });
  assert.equal(facade.tools[0]!.name, "Inspect");
  assert.equal(facade.instructions?.text, "Use tools within host policy.");
  await invoke(facade, { arguments: { value: "ok" } });
  await assert.rejects(invoke(facade, { arguments: { value: "no" } }), hasContractCode("host_tool_input_invalid"));
  assert.equal(host.invocations.length, 1);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("schema interpretation enforces every nested type, bound and closed object before callback entry", async (t) => {
  const schema: AgentHostToolInputSchema = {
    ...emptySchema,
    properties: {
      text: { type: "string", minLength: 2, maxLength: 2, enum: ["🙂a", "ok"] },
      list: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 0, maximum: 3 } },
      details: { type: "object", properties: { enabled: { type: "boolean" }, nil: { type: "null" } }, required: ["enabled", "nil"], additionalProperties: false },
      ratio: { type: "number", minimum: -1.5, maximum: 1.5 },
    },
    required: ["text", "list", "details", "ratio"],
  };
  const harness = await createHarness();
  const host = makeBinding({ schema });
  const session = await harness.open("create", host.binding);
  const facade = harness.facade();
  const valid = { text: "🙂a", list: [0, 3], details: { enabled: false, nil: null }, ratio: 1.5 };
  await invoke(facade, { arguments: valid });
  assert.deepEqual(host.invocations[0]?.arguments, valid);
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["root extra property", { ...valid, authority: "forged" }],
    ["missing required property", { text: "ok", list: [1], details: valid.details }],
    ["nested extra property", { ...valid, details: { ...valid.details, authority: true } }],
    ["nested missing property", { ...valid, details: { enabled: true } }],
    ["string minimum", { ...valid, text: "🙂" }],
    ["string maximum", { ...valid, text: "🙂🙂🙂" }],
    ["string enum", { ...valid, text: "no" }],
    ["array minimum", { ...valid, list: [] }],
    ["array maximum", { ...valid, list: [0, 1, 2] }],
    ["integer type", { ...valid, list: [0.5] }],
    ["unsafe integer", { ...valid, list: [Number.MAX_SAFE_INTEGER + 1] }],
    ["integer minimum", { ...valid, list: [-1] }],
    ["integer maximum", { ...valid, list: [4] }],
    ["number minimum", { ...valid, ratio: -1.6 }],
    ["number maximum", { ...valid, ratio: 1.6 }],
    ["nonfinite number", { ...valid, ratio: NaN }],
    ["number coercion", { ...valid, ratio: "1" }],
    ["boolean coercion", { ...valid, details: { enabled: 0, nil: null } }],
    ["null type", { ...valid, details: { enabled: true, nil: false } }],
    ["nonobject root", []],
    ["non-JSON value", { ...valid, ratio: undefined }],
    ["prototype-sensitive argument", JSON.parse('{"__proto__":true}')],
  ];
  for (const [name, argumentsValue] of cases) {
    await t.test(name, async () => {
      await assert.rejects(invoke(facade, { arguments: argumentsValue as never }), hasContractCode("host_tool_input_invalid"));
      assert.equal(host.invocations.length, 1, "Rejected input must never enter the host callback.");
    });
  }
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("serialized argument bounds hold across individually valid schema values", async () => {
  const property: AgentHostToolSchema = { type: "string", maxLength: 16_000 };
  const host = makeBinding({ schema: {
    ...emptySchema, properties: { first: property, second: property, third: property },
  } });
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  await invoke(harness.facade(), { arguments: { first: "a".repeat(16_000), second: "b".repeat(16_000) } });
  await assert.rejects(invoke(harness.facade(), { arguments: {
    first: "a".repeat(16_000), second: "b".repeat(16_000), third: "c".repeat(1_000),
  } }), hasContractCode("host_tool_input_invalid"));
  assert.equal(host.invocations.length, 1);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});
