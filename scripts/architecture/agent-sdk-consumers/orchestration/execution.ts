// ------------------------------------------------------------------------------------------------
//                execution.ts - Installed managed execution and ownership contract proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseAgentCapabilities } from "@agen-ai/agent-protocol";
import { createAgentProviderRegistry, validateAgentHostToolResult } from "@agen-ai/agent-runtime";
import { createFakeAgentProvider } from "@agen-ai/agent-runtime/testing";
import {
  createDelegationCoordinator,
  createDelegationHostBinding,
  createInMemoryDelegationStore,
  DelegationOperationError,
  parseDelegationPolicySnapshot,
  parseDelegationTargetCatalog,
  type DelegationHost,
  type DelegationParentScope,
} from "@agen-ai/agent-orchestration";
import { startDelegationMcpBridge } from "@agen-ai/agent-orchestration/mcp";
import { delegationSubordinateId } from "@agen-ai/agent-orchestration/store-adapter";

const baseline = createFakeAgentProvider();
const fake = createFakeAgentProvider({
  capabilities: parseAgentCapabilities({
    ...baseline.capabilities,
    requests: { ...baseline.capabilities.requests, approval: { kind: "unsupported" } },
  }),
});
const registry = await createAgentProviderRegistry({
  drivers: [fake.driver], definitions: [fake.definition],
});
const scope: DelegationParentScope = { parentId: "packed-parent", scopeId: "packed-scope", revision: 1 };
const catalog = parseDelegationTargetCatalog({
  catalogId: "packed-execution", revision: 1,
  targets: [{
    reference: { catalogId: "packed-execution", catalogRevision: 1, targetId: "standard",
      targetRevision: 1, sourceId: "packed-authority", sourceRevision: 1 },
    instanceId: fake.definition.instanceId, providerKey: fake.definition.providerKey,
    modelId: "fake-model", label: "Deterministic public fixture", options: [],
    reasoning: { kind: "certified", value: "max" },
    executionMode: { kind: "certified", value: "standard" },
    certification: { mappingId: "packed-mapping", mappingRevision: 1 },
    availability: { kind: "available" }, limitations: [],
    application: { configuration: { kind: "selected", revision: "packed-config", catalogRevision: 1, selections: [] }, beforeFirstTurn: [] },
  }],
});
const target = catalog.targets[0];
assert.ok(target);
let policy = parseDelegationPolicySnapshot({ revision: 1 });
let resourceReleases = 0;
let grantReleases = 0;
const host: DelegationHost = {
  registry,
  currentPolicy: () => ({ scope, catalog, policy }),
  assertResultAccess: () => undefined,
  assertControl: () => undefined,
  assertRequestAccess: () => undefined,
  acquireExecution: () => ({
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    release: () => { grantReleases += 1; },
  }),
  acquireChildResources: () => ({
    workingDirectory: { policy: "isolated", authorizedRef: "fixture-directory", path: process.cwd() },
    release: () => { resourceReleases += 1; },
  }),
  verifyAppliedConfiguration: ({ target: applied }) => ({
    target: applied.reference, configuration: applied.application.configuration,
  }),
  onRequest: () => { throw new Error("This fixture exposes no request capability."); },
};
const store = createInMemoryDelegationStore();
const coordinator = await createDelegationCoordinator({ host, store, limits: store.limits });
const client = await coordinator.bindParent({ scope });
try {
  assert.deepEqual((await client.targets()).targets, []);
  assert.equal(await createDelegationHostBinding({ client }), undefined);
  const input = { operationId: delegationSubordinateId(randomUUID(), "packed-spawn"), target: target.reference,
    expectedPolicyRevision: 1, input: { parts: [{ type: "text" as const, text: "Return a deterministic result." }] } };
  await assert.rejects(client.spawn(input), DelegationOperationError);
  assert.equal(fake.snapshot().createdSessionIds.length, 0);

  policy = parseDelegationPolicySnapshot({ revision: 2, user: { enabled: true } });
  const admittedInput = { ...input, expectedPolicyRevision: 2 };
  const binding = await createDelegationHostBinding({ client });
  assert.ok(binding);
  const bridge = await startDelegationMcpBridge({ binding });
  let requestId = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const response = await fetch(bridge.server.url, {
      method: "POST",
      headers: { ...bridge.server.headers, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const envelope: unknown = await response.json();
    assert.ok(envelope && typeof envelope === "object" && "result" in envelope);
    return envelope.result;
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await request("tools/call", { name, arguments: args });
    assert.ok(result && typeof result === "object" && "structuredContent" in result);
    return validateAgentHostToolResult(result.structuredContent);
  }
  let admitted: { taskId: string; runId: string };
  try {
    await request("initialize", { protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "packed-delegation-proof", version: "1.0.0" } });
    const discovery = await request("tools/list", {});
    assert.ok(discovery && typeof discovery === "object" && "tools" in discovery && Array.isArray(discovery.tools));
    assert.ok(discovery.tools.some((tool: unknown) => tool && typeof tool === "object" && "name" in tool && tool.name === "delegate_task"));
    const envelope = await callTool("delegate_task", {
      operationId: input.operationId, target: input.target, expectedPolicyRevision: 2,
      prompt: "Return a deterministic result.",
    });
    assert.equal(envelope.kind, "success");
    assert.ok(envelope.kind === "success" && envelope.value && typeof envelope.value === "object" && !Array.isArray(envelope.value));
    assert.ok("taskId" in envelope.value && typeof envelope.value.taskId === "string");
    assert.ok("runId" in envelope.value && typeof envelope.value.runId === "string");
    admitted = { taskId: envelope.value.taskId, runId: envelope.value.runId };
    const status = await callTool("task_status", { taskId: admitted.taskId, waitMs: 5_000 });
    assert.equal(status.kind, "success");
  } finally {
    await bridge.release();
    await binding.release();
  }
  const duplicate = await client.spawn(admittedInput);
  assert.equal(duplicate.runId, admitted.runId);
  assert.equal(duplicate.duplicate, true);
  const settled = await client.wait({ taskId: admitted.taskId, timeoutMs: 5_000 });
  assert.equal(settled.status, "settled");
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
  assert.equal(Object.hasOwn(settled.task.runs.items[0] ?? {}, "input"), false);
  assert.equal(fake.snapshot().turnIds.length, 1);
  assert.equal(fake.snapshot().createdSessionIds.length, 1);
} finally {
  const shutdown = await coordinator.dispose({ mode: "cancel", timeoutMs: 5_000 });
  assert.equal(shutdown.status, "closed");
  await registry.dispose();
}
assert.equal(resourceReleases, 1);
assert.equal(grantReleases, 1);
assert.equal(Object.values(fake.snapshot().closeCounts).reduce((sum, count) => sum + count, 0), 1);
process.stdout.write("External packed managed delegation execution consumer passed.\n");
