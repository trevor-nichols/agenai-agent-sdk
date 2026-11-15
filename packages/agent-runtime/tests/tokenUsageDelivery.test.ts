// ------------------------------------------------------------------------------------------------
//                tokenUsageDelivery.test.ts - Operation, configuration, collaboration and pending delivery
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentCollaborationId,
  parseAgentIsoDateTime,
  parseAgentOperationId,
  parseAgentOperationInvocationId,
  parseAgentProviderKey,
  parseAgentTurnId,
  type AgentCollaborationNode,
  type AgentTokenUsageObservation,
  type AgentUsageScopeId,
} from "@agen-ai/agent-protocol";

import {
  AGENT_TOKEN_USAGE_PENDING_LIMITS,
  AgentProviderContractError,
  AgentProviderDelegatedOperationError,
  createAgentEventOutput,
  createTokenUsagePendingBuffer,
  type AgentProviderOutput,
} from "../src/index.js";
import {
  atLeast, counters, SESSION, SESSION_SCOPE, SESSION_VIEW, snapshot, tokens, typedEvent,
} from "./fixtures/tokenUsage.js";
import { collectOutputs, emitter, openUsageSession, turn } from "./fixtures/tokenUsageSession.js";

const hasCode = (code: string) => (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
const delegatedCode = (code: string) => (error: unknown) =>
  error instanceof AgentProviderDelegatedOperationError && hasCode(code)(error.cause);
const sessionSnapshot = (id: string, revision: number, input: number) =>
  snapshot(id, revision, tokens(input, 1), { view: SESSION_VIEW, scope: SESSION_SCOPE });
const observation = (id: string, revision: number, input = 10) =>
  typedEvent(sessionSnapshot(id, revision, input)).payload;
const createdAt = "2026-11-13T00:00:00.000Z";

// ------------------------------------------------------------------------------------------------
//                Operation and Configuration Paths
// ------------------------------------------------------------------------------------------------

test("operation observation callbacks deliver usage into the same session ledger as later turns", async (t) => {
  const observationTurnId = parseAgentTurnId("operation:observation");
  const fixture = await openUsageSession({
    script: async function* (emit, input) {
      yield emit.started();
      yield emit.usage(sessionSnapshot("s-0", 0, 10));
      if (input.turnId === "turn-conflict") yield emit.usage(sessionSnapshot("s-1", 0, 99));
      yield emit.completed();
    },
    session: (session, context) => ({
      operations: session.operations.kind !== "supported" ? session.operations : {
        ...session.operations,
        async invokeOperation(input) {
          input.onProviderExecutionStarted?.();
          await input.onOutput?.(emitter(context.sessionId, input.observationTurnId).usage(sessionSnapshot("s-0", 0, 10)));
          return { invocationId: input.invocation.invocationId, status: "completed" as const };
        },
      },
    }),
  });
  t.after(() => fixture.dispose());
  assert.equal(fixture.session.operations.kind, "supported");
  if (fixture.session.operations.kind !== "supported") return;
  const delivered: AgentProviderOutput[] = [];
  const result = await fixture.session.operations.invokeOperation({
    invocation: { invocationId: parseAgentOperationInvocationId("operation:usage"), operationId: parseAgentOperationId("fake.session.reset"), expectedRevision: 1, values: [] },
    observationTurnId,
    onOutput(output) { delivered.push(output); },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(delivered.map((output) => output.kind === "event" && [output.event.type, output.event.turnId]), [["usage.observed", observationTurnId]]);

  await collectOutputs(fixture.session.startTurn(turn("turn-replay")).outputs);
  await assert.rejects(collectOutputs(fixture.session.startTurn(turn("turn-conflict")).outputs), hasCode("usage_identity_conflict"));
});

test("configuration results have no observation turn and cannot carry usage", async (t) => {
  const fixture = await openUsageSession({
    session: (session, context) => ({
      configuration: session.configuration.kind !== "selectable" ? session.configuration : {
        ...session.configuration,
        async applyConfigurationSelection(input) {
          input.onProviderExecutionStarted?.();
          return { status: "completed" as const, outputs: [emitter(context.sessionId, parseAgentTurnId("configuration")).usage(sessionSnapshot("s-0", 0, 10))] };
        },
      },
    }),
  });
  t.after(() => fixture.dispose());
  assert.equal(fixture.session.configuration.kind, "selectable");
  if (fixture.session.configuration.kind !== "selectable") return;
  await assert.rejects(Promise.resolve(fixture.session.configuration.applyConfigurationSelection({
    selection: { key: "model", expectedCatalogRevision: 1, expectedFieldRevision: 1, value: { fieldKind: "single_select", optionId: "fake-model-2" } },
  })), delegatedCode("invalid_operation_result"));
});

// ------------------------------------------------------------------------------------------------
//                Collaboration References
// ------------------------------------------------------------------------------------------------

const spawn = {
  collaborationId: parseAgentCollaborationId("collaboration:usage"), role: "reviewer" as const,
  title: "Review", objective: "Review usage.", createdAt: parseAgentIsoDateTime(createdAt),
};

test("collaboration usage may reference only a scope this session already admitted", async (t) => {
  const reference = { kind: "reference", scopeId: SESSION_SCOPE.scopeId as AgentUsageScopeId } as const;
  const withReference = (node: AgentCollaborationNode) => ({ ...node, usage: reference });
  const unadmitted = await openUsageSession({
    session: (session) => ({
      collaboration: session.collaboration.kind !== "supported" ? session.collaboration : {
        ...session.collaboration,
        async spawnCollaboration(input) {
          return withReference(await (session.collaboration as Extract<typeof session.collaboration, { kind: "supported" }>).spawnCollaboration(input));
        },
      },
    }),
  });
  t.after(() => unadmitted.dispose());
  assert.equal(unadmitted.session.collaboration.kind, "supported");
  if (unadmitted.session.collaboration.kind !== "supported") return;
  await assert.rejects(Promise.resolve(unadmitted.session.collaboration.spawnCollaboration({ spawn })), delegatedCode("output_collaboration_mismatch"));

  const spawned: { node?: AgentCollaborationNode } = {};
  const admitted = await openUsageSession({ script: async function* (emit, input) {
    yield emit.started();
    yield emit.usage(sessionSnapshot("s-0", 0, 10));
    const node = spawned.node;
    assert.ok(node);
    const updatedAt = input.turnId === "turn-reference" ? "2026-11-13T00:01:00.000Z" : "2026-11-13T00:02:00.000Z";
    const usage = input.turnId === "turn-reference" ? reference : { kind: "reference", scopeId: "usage-scope:other" };
    yield createAgentEventOutput({ ...emit.started().event, type: "collaboration.updated", payload: { node: { ...node, usage, updatedAt } } } as never);
    yield emit.completed();
  } });
  t.after(() => admitted.dispose());
  if (admitted.session.collaboration.kind !== "supported") return;
  spawned.node = await admitted.session.collaboration.spawnCollaboration({ spawn });
  assert.deepEqual(spawned.node.usage, { kind: "unavailable" });
  const outputs = await collectOutputs(admitted.session.startTurn(turn("turn-reference")).outputs);
  const updated = outputs.find((output) => output.kind === "event" && output.event.type === "collaboration.updated");
  assert.ok(updated?.kind === "event" && updated.event.type === "collaboration.updated");
  assert.deepEqual(updated.event.payload.node.usage, reference);
  await assert.rejects(collectOutputs(admitted.session.startTurn(turn("turn-unknown-reference")).outputs), hasCode("output_collaboration_mismatch"));
});

// ------------------------------------------------------------------------------------------------
//                Pending Retention and Close
// ------------------------------------------------------------------------------------------------

test("pending usage drains in arrival order without coalescing onto the delivery turn", () => {
  const buffer = createTokenUsagePendingBuffer({ providerKey: parseAgentProviderKey("fake-provider") });
  const delivery = { sessionId: SESSION, turnId: parseAgentTurnId("turn-delivery"), occurredAt: createdAt };
  assert.deepEqual(buffer.drain(delivery), []);
  const retained = [observation("open-0", 0, 10), observation("open-1", 1, 20), observation("open-2", 2, 30)];
  for (const entry of retained) buffer.retain(entry);
  assert.equal(buffer.size, 3);
  const events = buffer.drain(delivery);
  assert.deepEqual(events.map((event) => [event.turnId, event.payload]), retained.map((entry) => ["turn-delivery", entry]));
  assert.ok(Object.isFrozen(events) && events.every((event) => Object.isFrozen(event)));
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.drain(delivery), []);
});

test("pending usage is bounded by count and bytes and stays failed after overflow", () => {
  const providerKey = parseAgentProviderKey("fake-provider");
  const delivery = { sessionId: SESSION, turnId: parseAgentTurnId("turn-delivery"), occurredAt: createdAt };
  const counted = createTokenUsagePendingBuffer({ providerKey });
  for (let index = 0; index < AGENT_TOKEN_USAGE_PENDING_LIMITS.observations; index += 1) counted.retain(observation(`o-${index}`, index));
  assert.throws(() => counted.retain(observation("overflow", 64)), hasCode("usage_capacity_exceeded"));
  assert.throws(() => counted.drain(delivery), hasCode("usage_capacity_exceeded"));
  assert.throws(() => counted.retain(observation("after", 65)), hasCode("usage_capacity_exceeded"));

  const lower = atLeast(1, "not_reported");
  const wide = (index: number): AgentTokenUsageObservation => typedEvent(snapshot(`w-${index}-`.padEnd(128, "x"), index,
    tokens(atLeast(8, "not_reported"), atLeast(8, "not_reported")), {
      view: SESSION_VIEW, scope: SESSION_SCOPE, coverage: { kind: "partial", reasons: ["not_reported"] },
      attribution: { kind: "mixed", rowCoverage: "partial", rows: Array.from({ length: 8 }, (_, row) => ({
        model: { modelProvider: `p${row}-`.padEnd(64, "x"), modelId: `m${row}-`.padEnd(128, "x") }, counters: counters(tokens(lower, lower)),
      })) },
    })).payload;
  const sized = createTokenUsagePendingBuffer({ providerKey });
  let retained = 0;
  for (;;) {
    try { sized.retain(wide(retained)); retained += 1; } catch (error) {
      assert.ok(hasCode("usage_capacity_exceeded")(error));
      break;
    }
  }
  assert.ok(retained > 0 && retained < AGENT_TOKEN_USAGE_PENDING_LIMITS.observations, String(retained));

  const malformed = createTokenUsagePendingBuffer({ providerKey });
  assert.throws(() => malformed.retain({ ...observation("bad", 0), finality: "settled" } as never), hasCode("usage_invalid"));
});

test("opening and closing without an output path publishes nothing", async (t) => {
  let turns = 0;
  const fixture = await openUsageSession({ script: async function* (emit) {
    turns += 1;
    yield emit.usage(sessionSnapshot("never", 0, 10));
  } });
  t.after(() => fixture.dispose());
  assert.equal(await fixture.session.close({ reason: "idle" }), undefined);
  assert.equal(turns, 0);
  assert.equal(fixture.nativeCloses(), 1);
});
