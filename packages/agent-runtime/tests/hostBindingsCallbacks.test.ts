// ------------------------------------------------------------------------------------------------
//                hostBindingsCallbacks.test.ts - Callback envelopes, cancellation and capacity
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHostToolInvocation, AgentHostToolResult } from "../src/index.js";
import {
  createHarness,
  deferred,
  hasContractCode,
  invoke,
  makeBinding,
} from "./fixtures/hostBindings/harness.js";

test("invocation envelopes cannot select an unknown tool, malformed correlation or transport data", async (t) => {
  const harness = await createHarness();
  const host = makeBinding();
  const session = await harness.open("create", host.binding);
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown tool", { toolName: "Other" }],
    ["empty invocation ID", { invocationId: "" }],
    ["noncanonical invocation ID", { invocationId: " padded " }],
    ["control character invocation ID", { invocationId: "invocation\u0000" }],
    ["oversized invocation ID", { invocationId: "i".repeat(257) }],
    ["invalid cancellation signal", { signal: {} }],
    ["unknown envelope field", { endpoint: "https://example.invalid" }],
  ];
  for (const [name, input] of cases) {
    await t.test(name, async () => {
      await assert.rejects(invoke(harness.facade(), input as Partial<AgentHostToolInvocation>), hasContractCode("host_tool_input_invalid"));
      assert.equal(host.invocations.length, 0);
    });
  }
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("complete callback result envelopes enforce JSON, UTF-8, depth and per-node bounds", async (t) => {
  let result: unknown;
  const harness = await createHarness();
  const host = makeBinding({ invoke: () => result as AgentHostToolResult });
  const session = await harness.open("create", host.binding);
  const facade = harness.facade();
  for (const valid of [
    { kind: "success", value: { page: [true, null, 1, "text"] } },
    { kind: "error", error: { category: "permission", code: "host_denied", message: "Host policy denied the request.", recovery: { kind: "none" }, context: { operation: "inspect" } } },
  ] as const) {
    result = valid;
    assert.deepEqual(await invoke(facade), valid);
  }
  let deep: unknown = null;
  for (let depth = 0; depth < 17; depth += 1) deep = { child: deep };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown result kind", { kind: "native", value: "diagnostic" }],
    ["missing success value", { kind: "success" }],
    ["unknown envelope field", { kind: "success", value: null, native: "diagnostic" }],
    ["non-JSON result", { kind: "success", value: () => true }],
    ["undefined result", { kind: "success", value: undefined }],
    ["nonfinite result", { kind: "success", value: Infinity }],
    ["cyclic result", { kind: "success", value: cycle }],
    ["excess array items", { kind: "success", value: Array.from({ length: 101 }, () => null) }],
    ["excess object properties", { kind: "success", value: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, true])) }],
    ["prototype-sensitive result", { kind: "success", value: JSON.parse('{"constructor":true}') }],
    ["excess depth", { kind: "success", value: deep }],
    ["UTF-8 result bytes", { kind: "success", value: "界".repeat(11_000) }],
    ["malformed portable error", { kind: "error", error: { code: "failed", message: "Failure" } }],
    ["native error metadata", { kind: "error", error: { category: "unknown", code: "failed", message: "Failure", recovery: { kind: "unknown" }, nativePath: "/private/path" } }],
  ];
  for (const [name, value] of cases) {
    await t.test(name, async () => {
      result = value;
      const calls = host.invocations.length;
      await assert.rejects(invoke(facade), hasContractCode("host_tool_result_invalid"));
      assert.equal(host.invocations.length, calls + 1, "A result error must be classified after host execution.");
    });
  }
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ kind: "success", value: "" }));
  result = { kind: "success", value: "x".repeat(32_768 - envelopeBytes) };
  assert.deepEqual(await invoke(facade), result, "The complete envelope may reach the exact byte ceiling.");
  result = { kind: "success", value: "x".repeat(32_769 - envelopeBytes) };
  await assert.rejects(invoke(facade), hasContractCode("host_tool_result_invalid"));
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("thrown callback failures become portable sanitized errors and preserve later invocation admission", async () => {
  const privateDiagnostic = "secret-token /private/provider/state https://native.invalid";
  let fails = true;
  const host = makeBinding({ invoke() {
    if (fails) throw new Error(privateDiagnostic);
    return { kind: "success", value: "recovered" };
  } });
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  const result = await invoke(harness.facade());
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("Expected a portable callback error.");
  assert.equal(typeof result.error.code, "string");
  assert.equal(result.error.category, "unknown");
  assert.deepEqual(result.error.recovery, { kind: "unknown" });
  assert.equal(JSON.stringify(result).includes(privateDiagnostic), false);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  fails = false;
  assert.deepEqual(await invoke(harness.facade()), { kind: "success", value: "recovered" });
  assert.equal(host.invocations.length, 2);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("active duplicate IDs and the seventeenth callback reject before entry without retaining completed IDs", async () => {
  const pending = deferred<AgentHostToolResult>();
  const entered = deferred<void>();
  const host = makeBinding({ invoke() {
    if (host.invocations.length === 16) entered.resolve();
    return pending.promise;
  } });
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  const facade = harness.facade();
  const callbacks = Array.from({ length: 16 }, (_, index) => invoke(facade, { invocationId: `active:${index}` }));
  await entered.promise;
  await assert.rejects(invoke(facade, { invocationId: "active:0" }), hasContractCode("host_tool_input_invalid"));
  await assert.rejects(invoke(facade, { invocationId: "overflow" }), hasContractCode("host_tool_capacity_exhausted"));
  assert.equal(host.invocations.length, 16);
  pending.resolve({ kind: "success", value: null });
  await Promise.all(callbacks);
  await invoke(facade, { invocationId: "active:0" });
  assert.equal(host.invocations.length, 17);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("operation cancellation reaches the handler and retains its capacity until actual settlement", async () => {
  const pending = deferred<AgentHostToolResult>();
  const allEntered = deferred<void>();
  const host = makeBinding({ invoke() {
    if (host.invocations.length === 16) allEntered.resolve();
    return pending.promise;
  } });
  const harness = await createHarness();
  const session = await harness.open("create", host.binding);
  const controller = new AbortController();
  const canceled = invoke(harness.facade(), { invocationId: "canceling", signal: controller.signal });
  const rest = Array.from({ length: 15 }, (_, index) => invoke(harness.facade(), { invocationId: `other:${index}` }));
  await allEntered.promise;
  controller.abort(new DOMException("Tool request canceled", "AbortError"));
  assert.equal(host.invocations[0]?.signal?.aborted, true);
  assert.equal(host.invocations[1]?.signal?.aborted, false);
  await assert.rejects(invoke(harness.facade(), { invocationId: "replacement" }), hasContractCode("host_tool_capacity_exhausted"));
  assert.equal(host.releaseCount(), 0);
  pending.resolve({ kind: "success", value: null });
  await Promise.allSettled([canceled, ...rest]);
  await invoke(harness.facade(), { invocationId: "replacement" });
  assert.equal(host.invocations.length, 17);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});

test("pre-aborted invocation never enters the host callback or closes the session binding", async () => {
  const harness = await createHarness();
  const host = makeBinding();
  const session = await harness.open("create", host.binding);
  const controller = new AbortController();
  const cancellation = new DOMException("Tool request canceled", "AbortError");
  controller.abort(cancellation);
  await assert.rejects(invoke(harness.facade(), { signal: controller.signal }), (error: unknown) => error === cancellation);
  assert.equal(host.invocations.length, 0);
  assert.equal(host.releaseCount(), 0);
  await invoke(harness.facade());
  assert.equal(host.invocations.length, 1);
  await session.close({ reason: "idle" });
  await harness.registry.dispose();
});
