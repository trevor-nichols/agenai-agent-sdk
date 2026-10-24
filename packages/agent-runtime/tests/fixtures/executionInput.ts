import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";

import {
  parseAgentConfigurationRevisionId,
  parseAgentIsoDateTime,
  parseAgentItemId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentError,
  type AgentEvent,
} from "@agen-ai/agent-protocol";

import {
  createAgentEventOutput,
  parseAgentExecutionInputMessageId,
  validateAgentProviderAdapter,
  type AgentCreateSessionInput,
  type AgentExecutionInputMessage,
  type AgentExecutionInputOutcome,
  type AgentExecutionInputReceipt,
  type AgentExecutionInputSupport,
  type AgentProviderAdapter,
  type AgentProviderOutput,
  type AgentProviderResolveRequestInput,
  type AgentProviderSession,
  type AgentProviderSessionContext,
  type AgentProviderStartTurnInput,
  type AgentProviderTurnExecution,
  type AgentRequestResolutionResult,
  type MaybePromise,
} from "../../src/index.js";
import { createFakeAgentProvider } from "../../src/testing/index.js";
import { deferred } from "./hostBindings/harness.js";

export const inputSupport: Extract<AgentExecutionInputSupport, { kind: "supported" }> = {
  kind: "supported",
  delivery: "current_or_owned_continuation",
  consumptionReporting: "message_ids",
  input: { text: true, images: { kind: "unsupported" }, contentReferences: { kind: "unsupported" } },
  limits: { maxOutstandingMessages: 2, maxMessagesPerExecution: 16, maxBufferedBytes: 1_048_576 },
};

export const inputItemId = parseAgentItemId("input-assistant");
export const inputRefusal: AgentError = { category: "permission", code: "native_input_refused",
  message: "The native queue refused this message.", recovery: { kind: "none" } };

export function inputMessage(id: string, text = "Use the corrected requirement."): AgentExecutionInputMessage {
  return { messageId: parseAgentExecutionInputMessageId(id), parts: [{ type: "text", text }] };
}

export interface NativeInputSend {
  readonly input: AgentExecutionInputMessage;
  readonly receipt: ReturnType<typeof deferred<AgentExecutionInputReceipt>>;
  readonly settlement: ReturnType<typeof deferred<AgentExecutionInputOutcome>>;
  readonly accept: () => void;
  readonly consume: (placement?: "original_native_command" | "owned_native_continuation") => void;
}

type FixtureOptions = Readonly<{
  capabilities?: AgentCapabilities;
  support?: AgentExecutionInputSupport | null;
  send?: (send: NativeInputSend) => Promise<AgentExecutionInputReceipt>;
  outputs?: (source: AsyncIterable<AgentProviderOutput>) => AsyncIterable<AgentProviderOutput>;
  answer?: (input: AgentProviderResolveRequestInput) => Promise<AgentRequestResolutionResult>;
  nativeClose?: (attempt: number) => Promise<void>;
  interruption?: AgentProviderSession["interruption"];
  transformAdapter?: (adapter: AgentProviderAdapter) => AgentProviderAdapter;
}>;

export function nativeInputTurn(
  context: AgentProviderSessionContext,
  input: AgentProviderStartTurnInput,
  options: Pick<FixtureOptions, "support" | "send" | "outputs" | "answer"> = {},
) {
  const sends: NativeInputSend[] = [];
  const answers: AgentProviderResolveRequestInput[] = [];
  let ended = false;
  let controller!: ReadableStreamDefaultController<AgentProviderOutput>;
  const stream = new ReadableStream<AgentProviderOutput>({ start(value) { controller = value; } });
  const source = stream[Symbol.asyncIterator]();
  const terminalRead = deferred<void>();
  const outputs: AsyncIterable<AgentProviderOutput> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const result = await source.next();
          if (!result.done && result.value.kind === "event" && result.value.event.type === "turn.completed") terminalRead.resolve();
          return result;
        },
        return: async () => source.return ? source.return() : { done: true, value: undefined },
      };
    },
  };
  const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId: input.turnId,
    occurredAt: parseAgentIsoDateTime("2026-10-23T12:00:00.000Z") };
  const emit = (event: AgentEvent) => controller.enqueue(createAgentEventOutput(event));
  const execution: AgentProviderTurnExecution = {
    turnId: input.turnId,
    outputs: options.outputs?.(outputs) ?? outputs,
    ...(options.support === null || options.support?.kind === "unsupported" ? {} : {
      input: {
        kind: "supported" as const,
        support: options.support ?? inputSupport,
        sendMessage(message: AgentExecutionInputMessage) {
          const receipt = deferred<AgentExecutionInputReceipt>();
          const settlement = deferred<AgentExecutionInputOutcome>();
          void receipt.promise.catch(() => {});
          void settlement.promise.catch(() => {});
          const send: NativeInputSend = {
            input: message, receipt, settlement,
            accept() { receipt.resolve({ status: "accepted", messageId: message.messageId, settled: settlement.promise }); },
            consume(placement = "original_native_command") {
              settlement.resolve({ status: "consumed", messageId: message.messageId, turnId: input.turnId, placement });
            },
          };
          sends.push(send);
          return options.send?.(send) ?? receipt.promise;
        },
      },
    }),
    async resolveRequest(answer) {
      answers.push(answer);
      return options.answer?.(answer) ?? { status: "delivered" };
    },
  };
  emit({ ...base, type: "turn.started", payload: {} });
  return {
    execution, input, context, sends, answers, base, emit, terminalRead,
    end() { if (!ended) { ended = true; controller.close(); } },
    fail(reason: unknown) { if (!ended) { ended = true; controller.error(reason); } },
    close() {
      if (!ended) { ended = true; controller.close(); }
      for (const send of sends) {
        const reason = new DOMException("The native execution closed.", "AbortError");
        send.receipt.reject(reason);
        send.settlement.reject(reason);
      }
    },
  };
}

export async function executionInputFixture(options: FixtureOptions = {}) {
  const fake = createFakeAgentProvider(options.capabilities === undefined ? {} : { capabilities: options.capabilities });
  const instance = await fake.driver.materialize(fake.definition);
  const native = instance.adapter;
  assert.equal(native.resumption.kind, "supported");
  assert.equal(native.branching.kind, "through_turn");
  if (native.resumption.kind !== "supported" || native.branching.kind !== "through_turn") throw new Error("The input fixture requires restoration support.");
  const resumption = native.resumption;
  const branching = native.branching;
  const contexts: AgentProviderSessionContext[] = [];
  const turns: ReturnType<typeof nativeInputTurn>[] = [];
  const sessions: AgentProviderSession[] = [];
  let closes = 0;
  let sequence = 0;
  const wrap = (session: AgentProviderSession, context: AgentProviderSessionContext): AgentProviderSession => {
    contexts.push(context);
    const owned: ReturnType<typeof nativeInputTurn>[] = [];
    return { ...session,
      startTurn(input) {
        const turn = nativeInputTurn(context, input, options);
        turns.push(turn); owned.push(turn);
        return turn.execution;
      },
      ...(options.interruption === undefined ? {} : { interruption: options.interruption }),
      async close(input) {
        closes += 1;
        await options.nativeClose?.(closes);
        for (const turn of owned) turn.close();
        await session.close(input);
      },
    };
  };
  const raw: AgentProviderAdapter = {
    ...native,
    ...(options.support === null ? {} : { executionInput: options.support ?? inputSupport }),
    async createSession(input) { return wrap(await native.createSession(input), input); },
    resumption: { kind: "supported", async resumeSession(input) { return wrap(await resumption.resumeSession(input), input); } },
    branching: { kind: "through_turn", async branchSession(input) { return wrap(await branching.branchSession(input), input); } },
  };
  const adapter = validateAgentProviderAdapter(instance.capabilities, options.transformAdapter?.(raw) ?? raw);
  const openInput = (overrides: Partial<AgentCreateSessionInput> = {}): AgentCreateSessionInput => ({
    sessionId: parseAgentSessionId(`input-session:${++sequence}`), workingDirectory: "/fixture/workspace",
    configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("input-configuration"), catalogRevision: 1, selections: [] },
    onBindingCreated() {}, ...overrides,
  });
  const remember = async (opening: MaybePromise<AgentProviderSession>) => {
    const session = await opening; sessions.push(session); return session;
  };
  return {
    adapter, contexts, turns, openInput, closes: () => closes,
    open(overrides: Partial<AgentCreateSessionInput> = {}) { return remember(adapter.createSession(openInput(overrides))); },
    resume(source: AgentProviderSession) {
      if (adapter.resumption.kind !== "supported") throw new Error("Missing resume port.");
      return remember(adapter.resumption.resumeSession({ ...openInput(), binding: source.binding }));
    },
    branch(source: AgentProviderSession) {
      if (adapter.branching.kind !== "through_turn") throw new Error("Missing branch port.");
      assert.ok(source.binding.historyAnchor);
      return remember(adapter.branching.branchSession({ ...openInput(), source: {
        sessionId: contexts[0]!.sessionId, binding: source.binding,
        throughTurn: { turnId: parseAgentTurnId("source-turn"), historyAnchor: source.binding.historyAnchor },
      } }));
    },
    async enter(session: AgentProviderSession, id = "input-turn", overrides: Partial<AgentProviderStartTurnInput> = {}) {
      const execution = session.startTurn({ turnId: parseAgentTurnId(id), interactionMode: "default",
        parts: [{ type: "text", text: "Complete the original task." }], ...overrides });
      const iterator = execution.outputs[Symbol.asyncIterator]();
      const first = await iterator.next();
      const turn = turns.at(-1);
      assert.ok(turn);
      assert.deepEqual(first, { done: false, value: createAgentEventOutput({ ...turn.base, type: "turn.started", payload: {} }) });
      const input = execution.input;
      if (input?.kind !== "supported") throw new Error("Expected a supported public input port.");
      return { execution, iterator, native: turn, input };
    },
    async dispose() {
      for (const session of sessions) await session.close({ reason: "idle" });
      await instance.dispose();
    },
  };
}

export async function finishInputTurn(
  turn: EnteredInputTurn,
  outputRequested = false,
) {
  turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: {
    outcome: "completed", structuredOutput: outputRequested ? { kind: "json", value: {} } : { kind: "not_requested" },
  } });
  turn.native.end();
  assert.deepEqual(await turn.iterator.next(), { done: false, value: createAgentEventOutput({ ...turn.native.base,
    type: "turn.completed", payload: { outcome: "completed", structuredOutput: outputRequested ? { kind: "json", value: {} } : { kind: "not_requested" } } }) });
  assert.deepEqual(await turn.iterator.next(), { done: true, value: undefined });
}

export type EnteredInputTurn = Awaited<ReturnType<Awaited<ReturnType<typeof executionInputFixture>>["enter"]>>;

export function acceptedInputReceipt(receipt: AgentExecutionInputReceipt) {
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("Expected native acceptance.");
  return receipt;
}

export async function inputTurnEvent(turn: EnteredInputTurn, entry: AgentEvent) {
  turn.native.emit(entry);
  assert.deepEqual(await turn.iterator.next(), { done: false, value: createAgentEventOutput(entry) });
}
