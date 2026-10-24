import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { AgentProtocolValidationError, createAgentOutputDefinition, type AgentJsonObject, type AgentOutputDefinition, type ValidationIssue } from "@agen-ai/agent-protocol";
import { AgentProviderContractError } from "../src/index.js";
import { AgentGenerationError, generateObject } from "../src/generation/index.js";
import { deferred, event, generationFixture, terminal, titleOutput, titleSchema, turnInput } from "./fixtures/generation/harness.js";

const generationCode = (code: AgentGenerationError["code"]) => (error: unknown) => error instanceof AgentGenerationError && error.code === code;
async function flush() { await setImmediate(); }

test("generateObject places one schema at either native scope, drains one reader, closes and leaves instance disposal to its caller", async (t) => {
  for (const scope of ["turn", "session"] as const) await t.test(scope, async () => {
    const f = await generationFixture({ scope });
    const observed: string[] = [];
    const result = await generateObject({ ...f.input, onOutput(output) { observed.push(output.kind === "event" ? output.event.type : output.kind); } });
    assert.deepEqual(result, { value: { title: "A useful title" }, sessionId: f.input.session.sessionId, turnId: f.input.turn.turnId });
    assert.deepEqual(observed, ["turn.started", "turn.completed"]);
    assert.deepEqual(f.contexts[0]?.output, scope === "session" ? { kind: "json_schema", schema: titleSchema } : undefined);
    assert.deepEqual(f.turns[0]?.output, scope === "turn" ? { kind: "json_schema", schema: titleSchema } : undefined);
    assert.deepEqual({ ...f.counts, turns: f.turns.length, resolutions: f.resolutions.length, disposed: f.disposed() },
      { opens: 1, readers: 1, closes: 1, interrupts: 0, settledReaders: 1, turns: 1, resolutions: 0, disposed: 0 });
    await f.registry.dispose(); assert.equal(f.disposed(), 1);
  });
});

test("generation preflight rejects unsupported instances, malformed schema/content, bad timeouts and cancellation before any native opening", async (t) => {
  const aborted = new AbortController();
  const reason = new DOMException("Caller canceled before generation.", "AbortError"); aborted.abort(reason);
  const scenarios = [
    { name: "unsupported", scope: "unsupported" as const, change: {}, matches: generationCode("unsupported") },
    { name: "lower provider schema ceiling", maxSchemaBytes: 40, change: {}, matches: (e: unknown) => e instanceof AgentProviderContractError && e.code === "invalid_structured_output" },
    { name: "unknown portable keyword", change: { output: { ...titleOutput, schema: { ...titleSchema, pattern: "unsupported" } } }, matches: (e: unknown) => e instanceof AgentProtocolValidationError },
    { name: "oversize content", change: { turn: { ...turnInput, parts: [{ type: "text" as const, text: "x".repeat(1_065_000) }] } }, matches: (e: unknown) => e instanceof AgentProtocolValidationError },
    { name: "zero timeout", change: { timeoutMs: 0 }, matches: (e: unknown) => e instanceof RangeError },
    { name: "infinite timeout", change: { timeoutMs: Infinity }, matches: (e: unknown) => e instanceof RangeError },
    { name: "expired turn deadline", change: { turn: { ...turnInput, deadlineAt: "2026-01-01T00:00:00.000Z" } }, matches: generationCode("timeout") },
    { name: "already aborted", change: { signal: aborted.signal }, matches: (e: unknown) => e === reason },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const f = await generationFixture({ ...("scope" in scenario ? { scope: scenario.scope } : {}),
      ...("maxSchemaBytes" in scenario ? { maxSchemaBytes: scenario.maxSchemaBytes } : {}),
    });
    await assert.rejects(generateObject({ ...f.input, ...scenario.change }), scenario.matches);
    assert.deepEqual({ ...f.counts, turns: f.turns.length, disposed: f.disposed() },
      { opens: 0, readers: 0, closes: 0, interrupts: 0, settledReaders: 0, turns: 0, disposed: 0 });
    await f.registry.dispose();
  });
});

test("generation snapshots its native value before observers and decoder and accepts an equivalent decoded clone", async () => {
  const schema = { type: "object", properties: {
    title: { type: "string" }, tags: { type: "array", items: { type: "string" } },
    details: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false },
  }, required: ["title", "tags", "details"], additionalProperties: false } as const;
  const closing = deferred<void>(), releaseClose = deferred<void>();
  const f = await generationFixture({ async close() { closing.resolve(); await releaseClose.promise; }, async *outputs(context, turn) {
    yield event(context, turn, "turn.started", {});
    yield terminal(context, turn, { outcome: "completed", structuredOutput: { kind: "json", value: {
      title: "A useful title", tags: ["planning"], details: { source: "first prompt" },
    } } });
  } });
  let observedTitle: unknown;
  let decoderFrozen = false;
  let decodedClone: AgentJsonObject | undefined;
  const output = createAgentOutputDefinition(schema, (value) => {
    decoderFrozen = Object.isFrozen(value);
    assert.ok(Array.isArray(value.tags)); assert.ok(typeof value.details === "object" && value.details !== null);
    assert.equal(Object.isFrozen(value.tags), true); assert.equal(Object.isFrozen(value.details), true);
    assert.equal(Reflect.set(value, "title", "Decoder replacement"), false);
    assert.equal(Reflect.set(value.tags, "0", "Decoder replacement"), false);
    assert.equal(Reflect.set(value.details, "source", "Decoder replacement"), false);
    decodedClone = structuredClone(value);
    return { success: true, data: decodedClone };
  });
  const pending = generateObject({ ...f.input, output, onOutput(output) {
    if (output.kind === "event" && output.event.type === "turn.completed" && output.event.payload.structuredOutput.kind === "json") {
      observedTitle = output.event.payload.structuredOutput.value.title;
      const value = output.event.payload.structuredOutput.value;
      Reflect.set(value, "title", "Observer replacement");
      assert.ok(typeof value.details === "object" && value.details !== null);
      Reflect.set(value.details, "source", "Observer replacement");
    }
  } });
  await closing.promise;
  assert.ok(decodedClone); assert.equal(Object.isFrozen(decodedClone), true);
  assert.ok(Array.isArray(decodedClone.tags)); assert.ok(typeof decodedClone.details === "object" && decodedClone.details !== null);
  assert.equal(Object.isFrozen(decodedClone.tags), true); assert.equal(Object.isFrozen(decodedClone.details), true);
  assert.equal(Reflect.set(decodedClone.tags, "0", "Changed during close"), false);
  assert.equal(Reflect.set(decodedClone.details, "source", "Changed during close"), false);
  releaseClose.resolve(); const result = await pending;
  assert.equal(observedTitle, "A useful title"); assert.equal(decoderFrozen, true);
  assert.deepEqual(result.value, { title: "A useful title", tags: ["planning"], details: { source: "first prompt" } });
  assert.equal(f.counts.closes, 1); await f.registry.dispose();
});

test("decoder rejection, throw, invalid values and replacement retain useful local diagnostics and fail locally without another model turn", async (t) => {
  const applicationFailure = new AgentGenerationError("unsupported", "The local decoder cannot handle this value.");
  const definitions: readonly { name: string; output: AgentOutputDefinition<unknown>; issues?: readonly ValidationIssue[]; cause?: unknown }[] = [
    { name: "validation rejection", output: createAgentOutputDefinition(titleSchema, () => ({ success: false, issues: [{ code: "business_rule", message: "This title is reserved.", path: ["title"] }] })),
      issues: [{ code: "business_rule", message: "This title is reserved.", path: ["title"] }] },
    { name: "throw", output: createAgentOutputDefinition(titleSchema, () => { throw new Error("Decoder failed."); }) },
    { name: "application generation error", output: createAgentOutputDefinition(titleSchema, () => { throw applicationFailure; }), cause: applicationFailure },
    { name: "non JSON", output: createAgentOutputDefinition(titleSchema, () => ({ success: true, data: { title: () => "not data" } })),
      issues: [{ code: "invalid_json_data", path: ["title"], message: "Only plain JSON data is accepted." }] },
    { name: "schema mismatch", output: createAgentOutputDefinition(titleSchema, () => ({ success: true, data: { title: 42 } })),
      issues: [{ code: "schema_mismatch", path: ["title"], message: "Value does not have the declared JSON type." }] },
    { name: "changed JSON", output: createAgentOutputDefinition(titleSchema, () => ({ success: true, data: { title: "Different valid title" } })),
      issues: [{ code: "decoded_value_changed", path: [], message: "Object decoder changed the generated JSON value." }] },
  ];
  for (const scenario of definitions) await t.test(scenario.name, async () => {
    const f = await generationFixture();
    await assert.rejects(generateObject({ ...f.input, output: scenario.output }), (error) => {
      assert.ok(error instanceof AgentGenerationError); assert.equal(error.code, "decoding_failed");
      if (scenario.cause !== undefined) assert.equal(error.cause, scenario.cause);
      if (scenario.issues !== undefined) {
        assert.deepEqual(error.issues, scenario.issues);
        assert.equal(Object.isFrozen(error.issues), true);
        for (const issue of error.issues ?? []) {
          assert.equal(Object.isFrozen(issue), true); assert.equal(Object.isFrozen(issue.path), true);
        }
      }
      return true;
    });
    assert.deepEqual([f.counts.opens, f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes, f.disposed()], [1, 1, 1, 1, 1, 0]);
    await f.registry.dispose();
  });
});

test("observer failure stops generation, quiesces the same execution and preserves the local failure without replay", async () => {
  const failure = new Error("Output destination rejected acknowledgement.");
  const f = await generationFixture({ async *outputs(context, turn, closed) { yield event(context, turn, "turn.started", {}); await closed; yield terminal(context, turn); } });
  await assert.rejects(generateObject({ ...f.input, onOutput() { throw failure; } }), (error) => {
    assert.ok(error instanceof AgentGenerationError); assert.equal(error.code, "observer_failed"); assert.equal(error.cause, failure); return true;
  });
  assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes, f.disposed()], [1, 1, 1, 1, 0]);
  await f.registry.dispose();
});

test("an unavailable or non-completed native result never becomes an object-generation success", async (t) => {
  for (const payload of [
    { outcome: "completed", structuredOutput: { kind: "unavailable", reason: "missing_output" } },
    { outcome: "completed", structuredOutput: { kind: "json", value: { title: 42 } } },
    { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } },
  ] as const) await t.test(JSON.stringify(payload), async () => {
    const f = await generationFixture({ async *outputs(context, turn) { yield event(context, turn, "turn.started", {}); yield terminal(context, turn, payload); } });
    await assert.rejects(generateObject(f.input), generationCode("generation_failed"));
    assert.deepEqual([f.turns.length, f.counts.settledReaders, f.counts.closes], [1, 1, 1]); await f.registry.dispose();
  });
});

test("generation waits after a terminal value until the original output stream actually settles", async () => {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const f = await generationFixture({ async *outputs(context, turn) { yield event(context, turn, "turn.started", {}); yield terminal(context, turn); await settled; } });
  let returned = false;
  const pending = generateObject(f.input).then((value) => { returned = true; return value; });
  await f.started; await flush();
  assert.equal(returned, false); assert.equal(f.counts.closes, 0);
  finish(); assert.deepEqual((await pending).value, { title: "A useful title" });
  assert.deepEqual([f.counts.settledReaders, f.counts.closes], [1, 1]); await f.registry.dispose();
});
