// ------------------------------------------------------------------------------------------------
//                mcpValidation.test.ts - Raw binding validation and sanitized wire errors
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationHostBinding } from "../src/index.js";
import { waitFor } from "./fixtures/execution/harness.js";
import { deferred } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";
import { assertToolError, createToolHarness, toolValue } from "./fixtures/tools/harness.js";
import { connectMcp, connectMcpClient } from "./fixtures/tools/mcp.js";

test("an arbitrary public binding cannot bypass MCP argument/result validation or expose thrown diagnostics", async (t) => {
  const harness = await createToolHarness();
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  let invocations = 0;
  let invalidResult = false;
  const connection = await connectMcp({ ...binding, invoke() {
    invocations += 1;
    if (invalidResult) return { kind: "success", value: "private-oversized-result".repeat(2_000) };
    throw new Error("private-native-stack-and-secret");
  } });
  t.after(async () => { await connection.close(); await binding.release(); await harness.close(); });
  assertToolError(await connection.call("delegation_targets", { parentId: "another-parent" }), "invalid_tool_input");
  assert.equal(invocations, 0);
  const thrown = await connection.call("delegation_targets", {});
  assertToolError(thrown, "host_tool_failed");
  assert.equal(JSON.stringify(thrown).includes("private-native-stack-and-secret"), false);
  invalidResult = true;
  const oversized = await connection.call("delegation_targets", {});
  assertToolError(oversized, "host_tool_failed");
  assert.equal(JSON.stringify(oversized).includes("private-oversized-result"), false);
  assert.equal(invocations, 2);
  assert.equal(harness.provider.calls.turns.length, 0);
});

test("rejected cancellation messages cannot abort an active tool callback", { timeout: 10_000 }, async (t) => {
  const harness = await createToolHarness();
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  let entered = deferred<AbortSignal>();
  let aborted = 0;
  const connection = await connectMcp({ ...binding, async invoke(input) {
    assert.ok(input.signal);
    const signal = input.signal;
    entered.resolve(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted += 1;
    return { kind: "error", error: { code: "operation_aborted", message: "The callback was canceled.", category: "unknown", recovery: { kind: "unknown" } } };
  } });
  t.after(async () => { await connection.close(); await binding.release(); await harness.close(); });
  const headers = { ...connection.bridge.server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const variants: readonly { name: string; jsonrpc: string; headers: Readonly<Record<string, string>>; status: number }[] = [
    { name: "malformed JSON-RPC version", jsonrpc: "invalid", headers: {}, status: 400 },
    { name: "unsupported protocol version", jsonrpc: "2.0", headers: { "MCP-Protocol-Version": "invalid" }, status: 400 },
    { name: "unsupported Content-Type", jsonrpc: "2.0", headers: { "Content-Type": "text/plain" }, status: 415 },
  ];
  const observed: { name: string; status: number; signalAborted: boolean; callbacksAborted: number }[] = [];
  for (const [index, variant] of variants.entries()) {
    entered = deferred<AbortSignal>();
    const requestId = 17 + index;
    const active = fetch(connection.bridge.server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: requestId,
      method: "tools/call", params: { name: "delegation_targets", arguments: {} },
    }) }).then((response) => response.text(), () => undefined);
    const signal = await entered.promise;
    const rejected = await fetch(connection.bridge.server.url, { method: "POST", headers: { ...headers, ...variant.headers },
      body: JSON.stringify({ jsonrpc: variant.jsonrpc, method: "notifications/cancelled", params: { requestId } }),
    });
    await rejected.arrayBuffer();
    observed.push({ name: variant.name, status: rejected.status, signalAborted: signal.aborted, callbacksAborted: aborted });
    await connection.client.notification({ method: "notifications/cancelled", params: { requestId } });
    await waitFor(() => aborted === index + 1, "A subsequent valid SDK cancellation must still reach the original callback.");
    await active;
  }
  assert.deepEqual(observed, variants.map((variant, index) => ({ name: variant.name, status: variant.status,
    signalAborted: false, callbacksAborted: index })), "Rejected messages must leave their original callbacks live until valid SDK cancellation.");
});

test("disconnected calls that ignore abort retain bounded callback capacity and cleanup ownership", { timeout: 10_000 }, async (t) => {
  const harness = await createToolHarness();
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const finish = deferred<void>();
  let invoked = 0;
  let settled = 0;
  let releases = 0;
  const connection = await connectMcp({ ...binding, async invoke() {
    invoked += 1;
    try { await finish.promise; return { kind: "success", value: { done: true } }; }
    finally { settled += 1; }
  }, async release() { releases += 1; await binding.release(); } }, { shutdownTimeoutMs: 50 });
  const cleanup: { probe?: Awaited<ReturnType<typeof connectMcpClient>> } = {};
  t.after(async () => { finish.resolve(); await cleanup.probe?.close(); await connection.close(); await binding.release(); await harness.close(); });
  const pending = Array.from({ length: 16 }, () => connection.client.callTool({ name: "delegation_targets", arguments: {} })
    .then(() => "returned", () => "disconnected"));
  await waitFor(() => invoked === 16, "All admitted callback slots must actually be occupied.");
  await connection.client.close();
  await Promise.all(pending);
  await waitFor(async () => { try { cleanup.probe = await connectMcpClient(connection.bridge.server); return true; } catch { return false; } },
    "Disconnected HTTP requests must leave the authenticated endpoint available.");
  assert.ok(cleanup.probe);
  await cleanup.probe.client.listTools();
  assert.equal(settled, 0);
  assertToolError(await cleanup.probe.call("delegation_targets", {}), "host_tool_capacity_exhausted");
  assert.equal(invoked, 16, "Disconnecting a request must not erase its live callback reservation.");
  await assert.rejects(connection.bridge.release(), hasCode("recovery_required"));
  assert.equal(releases, 0);
  finish.resolve();
  await waitFor(() => settled === 16, "Every retained callback must actually quiesce before release retry.");
  await connection.bridge.release();
  assert.equal(releases, 0);
  assert.equal(harness.provider.calls.turns.length, 0);
});

test("SDK cancellation reaches a cooperative callback while every invocation slot is occupied", { timeout: 10_000 }, async (t) => {
  const harness = await createToolHarness();
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  let invoked = 0;
  let aborted = 0;
  const connection = await connectMcp({ ...binding, async invoke(input) {
    invoked += 1;
    if (invoked > 16) return { kind: "success", value: { admitted: true } };
    assert.ok(input.signal);
    await new Promise<void>((resolve) => {
      if (input.signal!.aborted) resolve();
      else input.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted += 1;
    return { kind: "error", error: { code: "operation_aborted", message: "The callback was canceled.", category: "unknown", recovery: { kind: "unknown" } } };
  } });
  t.after(async () => { await connection.close(); await binding.release(); await harness.close(); });
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const pending = controllers.map((controller) => connection.client.callTool({ name: "delegation_targets", arguments: {} }, undefined,
    { signal: controller.signal }).then(() => "returned", () => "canceled"));
  await waitFor(() => invoked === 16, "The callback limit must actually be full before cancellation.");
  controllers[0]!.abort();
  await pending[0];
  await waitFor(() => aborted === 1, "Cancellation must reach the callback even while ordinary invocation capacity is full.");
  toolValue(await connection.call("delegation_targets", {}));
  assert.equal(invoked, 17);
  assert.equal(aborted, 1, "The other admitted callbacks must remain live.");
  await connection.bridge.release();
  await Promise.all(pending);
});
