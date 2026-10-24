import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  parseAgentConfigurationRevisionId,
  parseAgentSessionId,
  parseAgentTurnId,
} from "@agen-ai/agent-protocol";
import {
  AgentProviderContractError,
  parseAgentExecutionInputMessageId,
  validateAgentProviderAdapter,
  type AgentExecutionInput,
  type AgentExecutionInputSupport,
  type AgentProviderAdapter,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";

const support: Extract<AgentExecutionInputSupport, { kind: "supported" }> = {
  kind: "supported",
  delivery: "current_or_owned_continuation",
  consumptionReporting: "message_ids",
  input: { text: true, images: { kind: "unsupported" }, contentReferences: { kind: "unsupported" } },
  limits: { maxOutstandingMessages: 2, maxMessagesPerExecution: 16, maxBufferedBytes: 1_048_576 },
};
const turnId = parseAgentTurnId("execution:one");

function contractFailure(code: "invalid_adapter" | "capability_port_mismatch" | "invalid_operation_result") {
  return (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
}

test("message IDs retain exact canonical identity and reject unbounded or ambiguous input", () => {
  assert.equal(parseAgentExecutionInputMessageId("message:α-1"), "message:α-1");
  assert.equal(parseAgentExecutionInputMessageId("x".repeat(AGENT_PROTOCOL_ID_MAX_LENGTH)).length, AGENT_PROTOCOL_ID_MAX_LENGTH);
  for (const invalid of [undefined, null, 1, "", " update", "update ", "up\ndate", "x".repeat(AGENT_PROTOCOL_ID_MAX_LENGTH + 1)]) {
    assert.throws(() => parseAgentExecutionInputMessageId(invalid), TypeError);
  }
});

test("adapter discovery snapshots text-only support and rejects invalid advertised contracts", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const advertised = structuredClone(support);
  const adapter = validateAgentProviderAdapter(instance.capabilities, { ...instance.adapter, executionInput: advertised });
  Reflect.set(advertised.limits, "maxOutstandingMessages", 1);
  assert.deepEqual(adapter.executionInput, support);
  assert.equal(Object.isFrozen(adapter.executionInput), true);
  if (adapter.executionInput?.kind !== "supported") assert.fail("Expected the declared supported descriptor.");
  assert.equal(Object.isFrozen(adapter.executionInput.input.images), true);
  assert.equal(Object.isFrozen(adapter.executionInput.limits), true);

  const invalidDescriptors: readonly unknown[] = [
    null, { kind: "unsupported", sendMessage() {} },
    { ...support, delivery: "current_only" },
    { ...support, consumptionReporting: "assumed" },
    { ...support, input: { ...support.input, images: { kind: "supported" } } },
    { ...support, input: { ...support.input, contentReferences: { kind: "supported" } } },
    { ...support, limits: { ...support.limits, maxOutstandingMessages: 0 } },
    { ...support, limits: { ...support.limits, maxOutstandingMessages: 3 } },
    { ...support, limits: { ...support.limits, maxMessagesPerExecution: 17 } },
    { ...support, limits: { ...support.limits, maxMessagesPerExecution: 1 } },
    { ...support, limits: { ...support.limits, maxBufferedBytes: 1_048_577 } },
    { ...support, limits: { ...support.limits, maxBufferedBytes: 1.5 } },
    { ...support, limits: { ...support.limits, maxBufferedBytes: Number.NaN } },
    { ...support, extra: true },
  ];
  for (const executionInput of invalidDescriptors) {
    const candidate: AgentProviderAdapter = { ...instance.adapter };
    Reflect.set(candidate, "executionInput", executionInput);
    assert.throws(() => validateAgentProviderAdapter(instance.capabilities, candidate), contractFailure("invalid_adapter"));
  }
  await instance.dispose();
});

test("execution entry admits matching ports and rejects undeclared, missing, malformed and drifted ports", async () => {
  const port: AgentExecutionInput = { kind: "supported", support,
    async sendMessage() { throw new Error("Contract validation must precede send entry."); } };
  const scenarios: readonly Readonly<{ declaration?: AgentExecutionInputSupport; port?: unknown; valid?: true }>[] = [
    { declaration: support, port, valid: true },
    { valid: true },
    { port },
    { declaration: { kind: "unsupported" }, port },
    { declaration: support },
    { declaration: support, port: { kind: "unsupported" } },
    { declaration: support, port: { ...port, sendMessage: undefined } },
    { declaration: support, port: { ...port, support: { ...support, consumptionReporting: "unavailable" } } },
    { declaration: support, port: { ...port, support: { ...support,
      limits: { ...support.limits, maxOutstandingMessages: 1 } } } },
  ];
  for (const scenario of scenarios) {
    const fake = createFakeAgentProvider();
    const instance = await fake.driver.materialize(fake.definition);
    const adapter = validateAgentProviderAdapter(instance.capabilities, {
      ...instance.adapter,
      ...(scenario.declaration === undefined ? {} : { executionInput: scenario.declaration }),
      async createSession(input) {
        const session = await instance.adapter.createSession(input);
        return { ...session, startTurn(turnInput) {
          const execution = { ...session.startTurn(turnInput) };
          if (Object.hasOwn(scenario, "port")) Reflect.set(execution, "input", scenario.port);
          return execution;
        } };
      },
    });
    const session = await adapter.createSession({ sessionId: parseAgentSessionId("input-contract"),
      workingDirectory: "/tmp/input-contract", configuration: { kind: "selected", catalogRevision: 1, selections: [],
        revision: parseAgentConfigurationRevisionId("input-contract") }, onBindingCreated() {} });
    const execution = session.startTurn({ turnId, interactionMode: "default", parts: [{ type: "text", text: "Original task" }] });
    const iterator = execution.outputs[Symbol.asyncIterator]();
    if (scenario.valid) {
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.deepEqual(first.value, { kind: "event", event: { protocolVersion: 13, type: "turn.started",
        sessionId: "input-contract", turnId: "execution:one", occurredAt: "2026-08-04T00:00:00.000Z",
        payload: { message: "Fake provider turn started." } } });
    } else await assert.rejects(iterator.next(), contractFailure("capability_port_mismatch"));
    await session.close({ reason: "contract_rejected" });
    await instance.dispose();
  }
});
