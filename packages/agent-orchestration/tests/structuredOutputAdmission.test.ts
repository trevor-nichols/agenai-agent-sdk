import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentStructuredOutputResult } from "@agen-ai/agent-protocol";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import { DelegationValidationError } from "../src/index.js";
import { createExecutionHarness } from "./fixtures/execution/harness.js";
import { completedTurn, mapTurnOutputs } from "./fixtures/execution/provider.js";

const output = { kind: "json_schema", schema: { type: "object", properties: {}, required: [], additionalProperties: false } } as const;

test("managed spawn and every send mode reject output options before allocating execution", async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, input => completedTurn(context, input.turnId)) };
  } } });
  t.after(() => harness.close());
  const spawn = harness.spawnInput();
  for (const extension of [output, undefined]) {
    for (const input of [{ ...spawn, output: extension }, { ...spawn, input: { ...spawn.input, output: extension } }]) {
      await assert.rejects(harness.client.spawn(input), DelegationValidationError);
    }
    for (const mode of ["steer", "next_turn", "follow_up"] as const) {
      const send = { ...spawn, taskId: randomUUID(), mode };
      for (const input of [{ ...send, output: extension }, { ...send, input: { ...send.input, output: extension } }]) {
        await assert.rejects(harness.client.send(input), DelegationValidationError);
      }
    }
  }
  assert.equal(harness.grants.length, 0);
  assert.equal(harness.provider.contexts.length, 0);
  assert.equal(harness.provider.calls.turns.length, 0);
  const receipt = await harness.client.spawn(spawn);
  const settled = await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "succeeded", result: { text: "", truncated: false, references: [] } });
});

test("the managed result boundary refuses structured terminals from a host registry", async (t) => {
  const candidates: readonly AgentStructuredOutputResult[] = [
    { kind: "json", value: { title: "Private structured result" } },
    { kind: "unavailable", reason: "missing_output" },
    { kind: "not_requested" },
  ];
  for (const structuredOutput of candidates) await t.test(structuredOutput.kind, async (st) => {
    const harness = await createExecutionHarness({
      provider: { transformSession(session, context) {
        return { ...session, startTurn: mapTurnOutputs(session, input => completedTurn(context, input.turnId)) };
      } },
      host(base) {
        let selected: ReturnType<typeof base.registry.requireInstance> | undefined;
        return { registry: { ...base.registry, requireInstance(id) {
          if (selected) return selected;
          const instance = base.registry.requireInstance(id);
          selected = { ...instance, adapter: { ...instance.adapter, async createSession(input) {
            const session = await instance.adapter.createSession(input);
            return { ...session, startTurn: mapTurnOutputs(session, async function* (_turn, outputs) {
              for await (const entry of outputs) yield entry.kind === "event" && entry.event.type === "turn.completed"
                ? createAgentEventOutput({ ...entry.event, payload: { outcome: "completed", structuredOutput } }) : entry;
            }) };
          } } };
          return selected;
        } } };
      },
    });
    st.after(() => harness.close());
    const receipt = await harness.spawn();
    const settled = await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
    assert.deepEqual(settled.task.runs.items[0]?.outcome, structuredOutput.kind === "not_requested"
      ? { kind: "succeeded", result: { text: "", truncated: false, references: [] } }
      : { kind: "recovery_required", reason: "dispatch_uncertain" });
    assert.equal(harness.provider.calls.streamOwners, 1);
    assert.equal(harness.provider.calls.close, 1);
    assert.equal(harness.resourceReleases(), 1);
    assert.equal(harness.grantReleases(), 1);
  });
});

test("host resource extensions cannot bind a structured managed session", async (t) => {
  const harness = await createExecutionHarness({
    provider: { transformSession(session, context) {
      return { ...session, startTurn: mapTurnOutputs(session, input => completedTurn(context, input.turnId)) };
    } },
    host: base => ({ async acquireChildResources(input) {
      return { ...await base.acquireChildResources(input), output, session: { output }, configuration: { output } };
    } }),
  });
  t.after(() => harness.close());
  const receipt = await harness.spawn();
  const settled = await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "succeeded", result: { text: "", truncated: false, references: [] } });
  assert.equal(harness.provider.contexts.length, 1);
  assert.equal(Object.hasOwn(harness.provider.contexts[0]!, "output"), false);
  assert.equal(Object.hasOwn(harness.provider.contexts[0]!, "session"), false);
  assert.deepEqual(harness.provider.contexts[0]!.configuration, harness.target.application.configuration);
  assert.equal(Object.hasOwn(harness.provider.calls.turns[0]!, "output"), false);
});
