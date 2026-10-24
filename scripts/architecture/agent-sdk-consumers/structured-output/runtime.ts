import assert from "node:assert/strict";

import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentOutputSchema,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentOutputSchema,
  type AgentStructuredOutputRequest,
  type AgentStructuredOutputResult,
  type AgentTurnCompletedPayload,
} from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput,
  createAgentStructuredOutputCandidate,
  validateAgentProviderAdapter,
  type AgentProviderCreateSessionInput,
  type AgentProviderSession,
  type AgentProviderStartTurnInput,
  type AgentProviderTurnExecution,
} from "@agen-ai/agent-runtime";
import { createFakeAgentProvider } from "@agen-ai/agent-runtime/testing";

const titleSchema = parseAgentOutputSchema({
  type: "object", properties: { title: { type: "string", minLength: 1 } },
  required: ["title"], additionalProperties: false,
});
const countSchema = parseAgentOutputSchema({
  type: "object", properties: { count: { type: "integer", minimum: 1 } },
  required: ["count"], additionalProperties: false,
});
const request = (schema: AgentOutputSchema): AgentStructuredOutputRequest => ({ kind: "json_schema", schema });

async function fixture(scope: "turn" | "session" | "unsupported") {
  const defaults = createFakeAgentProvider().capabilities;
  const structuredOutput: AgentCapabilities["turns"]["structuredOutput"] = scope === "unsupported"
    ? { kind: "unsupported" }
    : { kind: "supported", mechanism: "native", schemaProfile: "agenai.output-schema.v1", scope,
      maxSchemaBytes: 16_384, maxOutputBytes: 16_384, resume: false, branch: false };
  const capabilities = parseAgentCapabilities({
    ...defaults, configuration: { kind: "managed" }, turns: { ...defaults.turns, structuredOutput },
  });
  const fake = createFakeAgentProvider({ capabilities });
  const instance = await fake.driver.materialize(fake.definition);
  const counts = { creates: 0, starts: 0, closes: 0 };
  const inputs: AgentProviderStartTurnInput[] = [];
  const openings: AgentProviderCreateSessionInput[] = [];
  const adapter = validateAgentProviderAdapter(capabilities, {
    ...instance.adapter,
    async createSession(context) {
      counts.creates += 1;
      openings.push(context);
      const native = await instance.adapter.createSession(context);
      return {
        ...native,
        startTurn(input) {
          counts.starts += 1;
          inputs.push(input);
          const binding = input.output ?? context.output;
          let result: AgentStructuredOutputResult;
          if (!binding) result = { kind: "not_requested" };
          else if (input.turnId === "packed-mismatch") result = { kind: "json", value: { count: 9 } };
          else result = createAgentStructuredOutputCandidate({
            schema: binding.schema,
            candidate: input.turnId === "packed-invalid"
              ? { kind: "json_text", text: '{"title":' }
              : input.turnId === "packed-count"
                ? { kind: "json_value", value: { count: 7 } }
                : { kind: "json_text", text: '{"title":"Installed SDK"}' },
          });
          return {
            turnId: input.turnId,
            outputs: (async function* () {
              const envelope = { protocolVersion: 13, sessionId: context.sessionId,
                turnId: input.turnId, occurredAt: "2026-10-21T12:00:00.000Z" };
              yield createAgentEventOutput({ ...envelope, type: "turn.started", payload: {} });
              yield createAgentEventOutput({ ...envelope, type: "turn.completed",
                payload: { outcome: "completed", structuredOutput: result } });
            })(),
            async resolveRequest() { throw new Error("The installed structured-output fixture opens no requests."); },
          };
        },
        async close(input) { counts.closes += 1; await native.close(input); },
      };
    },
  });
  let sequence = 0;
  const open = async (output?: AgentStructuredOutputRequest) => adapter.createSession({
    sessionId: parseAgentSessionId(`packed-${scope}-${++sequence}`), workingDirectory: "/packed/workspace",
    configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("packed-structured") },
    onBindingCreated() {}, ...(output === undefined ? {} : { output }),
  });
  return { counts, inputs, openings, open, dispose: () => instance.dispose() };
}

function start(session: AgentProviderSession, id: string, output?: AgentStructuredOutputRequest) {
  return session.startTurn({
    turnId: parseAgentTurnId(id), interactionMode: "default",
    parts: [{ type: "text", text: "Return the requested final object." }],
    ...(output === undefined ? {} : { output }),
  });
}

async function terminal(execution: AgentProviderTurnExecution, proveSingleReader = false): Promise<AgentTurnCompletedPayload> {
  const iterator = execution.outputs[Symbol.asyncIterator]();
  if (proveSingleReader) assert.throws(() => execution.outputs[Symbol.asyncIterator](), { code: "concurrent_turn" });
  let completed: AgentTurnCompletedPayload | undefined;
  for (let pulls = 0; pulls < 3; pulls += 1) {
    const next = await iterator.next();
    if (next.done) {
      assert.ok(completed, "The packed execution must settle after a terminal event.");
      return completed;
    }
    assert.equal(next.value.kind, "event");
    if (next.value.kind === "event" && next.value.event.type === "turn.completed") completed = next.value.event.payload;
  }
  throw new Error("The bounded packed execution did not settle.");
}

export async function runStructuredOutputRuntimeConsumer(): Promise<{
  turnScopeTurns: number;
  sessionScopeTurns: number;
  rejectedBeforeDispatch: number;
  invalidCandidates: number;
  schemaMismatches: number;
  nativeStarts: number;
  nativeCloses: number;
}> {
  const turn = await fixture("turn");
  const bound = await fixture("session");
  const unsupported = await fixture("unsupported");
  let turnSession: AgentProviderSession | undefined;
  let boundSession: AgentProviderSession | undefined;
  let rejectedBeforeDispatch = 0;
  try {
    await assert.rejects(() => turn.open(request(titleSchema)), { code: "structured_output_scope_mismatch" });
    await assert.rejects(() => unsupported.open(request(titleSchema)), { code: "structured_output_unsupported" });
    assert.deepEqual([turn.counts.creates, unsupported.counts.creates, turn.counts.starts, unsupported.counts.starts], [0, 0, 0, 0]);
    rejectedBeforeDispatch += 2;

    turnSession = await turn.open();
    const first = start(turnSession, "packed-title", request(titleSchema));
    assert.equal(turn.counts.starts, 0, "Reserving a packed execution must remain lazy.");
    assert.deepEqual(await terminal(first, true), {
      outcome: "completed", structuredOutput: { kind: "json", value: { title: "Installed SDK" } },
    });
    assert.deepEqual(await terminal(start(turnSession, "packed-count", request(countSchema))), {
      outcome: "completed", structuredOutput: { kind: "json", value: { count: 7 } },
    });
    assert.deepEqual(await terminal(start(turnSession, "packed-plain")), {
      outcome: "completed", structuredOutput: { kind: "not_requested" },
    });
    assert.deepEqual(turn.inputs.map((input) => input.output?.schema), [titleSchema, countSchema, undefined]);

    assert.deepEqual(await terminal(start(turnSession, "packed-invalid", request(titleSchema))), {
      outcome: "completed", structuredOutput: { kind: "unavailable", reason: "invalid_json" },
    });
    const mismatch = await terminal(start(turnSession, "packed-mismatch", request(titleSchema)));
    assert.equal(mismatch.outcome, "completed");
    assert.equal(mismatch.structuredOutput.kind, "unavailable");
    if (mismatch.structuredOutput.kind !== "unavailable") throw new Error("Expected the runtime to reject the native wrong-shape value.");
    assert.equal(mismatch.structuredOutput.reason, "schema_mismatch");
    assert.deepEqual(mismatch.structuredOutput.issues?.map((issue) => issue.path.join(".")).sort(), ["count", "title"]);

    boundSession = await bound.open(request(titleSchema));
    for (const id of ["packed-bound-first", "packed-bound-second"]) {
      assert.deepEqual(await terminal(start(boundSession, id)), {
        outcome: "completed", structuredOutput: { kind: "json", value: { title: "Installed SDK" } },
      });
    }
    assert.deepEqual(bound.openings[0]?.output, request(titleSchema));
    assert.deepEqual(bound.inputs.map((input) => input.output), [undefined, undefined]);
    const activeBoundSession = boundSession;
    assert.throws(() => start(activeBoundSession, "packed-bound-override", request(titleSchema)), { code: "structured_output_scope_mismatch" });
    assert.equal(bound.counts.starts, 2);
    rejectedBeforeDispatch += 1;

    await turnSession.close({ reason: "idle" });
    await boundSession.close({ reason: "idle" });
    await turnSession.close({ reason: "idle" });
    await boundSession.close({ reason: "idle" });
    assert.deepEqual([turn.counts.closes, bound.counts.closes, unsupported.counts.closes], [1, 1, 0]);
    assert.deepEqual([turn.counts.starts, bound.counts.starts, unsupported.counts.starts], [5, 2, 0]);
    return { turnScopeTurns: turn.counts.starts, sessionScopeTurns: bound.counts.starts, rejectedBeforeDispatch, invalidCandidates: 1,
      schemaMismatches: 1, nativeStarts: turn.counts.starts + bound.counts.starts, nativeCloses: turn.counts.closes + bound.counts.closes };
  } finally {
    await turnSession?.close({ reason: "shutdown" });
    await boundSession?.close({ reason: "shutdown" });
    await turn.dispose();
    await bound.dispose();
    await unsupported.dispose();
  }
}
