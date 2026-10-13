// ------------------------------------------------------------------------------------------------
//                provider.ts - Observable local augmentation of the existing runtime fake
// ------------------------------------------------------------------------------------------------

import { parseAgentIsoDateTime, type AgentTurnId } from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput,
  type AgentProviderAdapter,
  type AgentProviderDriver,
  type AgentProviderOutput,
  type AgentProviderSession,
  type AgentProviderStartTurnInput,
  type AgentProviderTurnExecution,
  type AgentProviderSessionContext,
  type MaybePromise,
} from "@agen-ai/agent-runtime";
import { createFakeAgentProvider, type FakeAgentProviderOptions } from "@agen-ai/agent-runtime/testing";

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function eventBase(context: AgentProviderSessionContext, turnId: AgentTurnId) {
  return {
    protocolVersion: 10 as const,
    sessionId: context.sessionId,
    turnId,
    occurredAt: parseAgentIsoDateTime("2026-10-10T12:00:00.000Z"),
  };
}

export async function* completedTurn(context: AgentProviderSessionContext, turnId: AgentTurnId): AsyncIterable<AgentProviderOutput> {
  const base = eventBase(context, turnId);
  yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
  yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
}

export function mapTurnOutputs(session: AgentProviderSession,
  transform: (input: AgentProviderStartTurnInput, outputs: AsyncIterable<AgentProviderOutput>) => AsyncIterable<AgentProviderOutput>): AgentProviderSession["startTurn"] {
  return (input) => {
    const execution = session.startTurn(input);
    return { ...execution, outputs: transform(input, execution.outputs) };
  };
}

export interface ProviderHooks {
  readonly fakeOptions?: FakeAgentProviderOptions;
  readonly beforeReadiness?: () => MaybePromise<void>;
  readonly beforeOpen?: (context: AgentProviderSessionContext) => MaybePromise<void>;
  readonly transformSession?: (session: AgentProviderSession, context: AgentProviderSessionContext) => AgentProviderSession;
  readonly transformAdapter?: (adapter: AgentProviderAdapter) => AgentProviderAdapter;
}

export function createExecutionProvider(hooks: ProviderHooks = {}) {
  const fake = createFakeAgentProvider(hooks.fakeOptions);
  const contexts: AgentProviderSessionContext[] = [];
  const sessions: AgentProviderSession[] = [];
  const calls = {
    turns: [] as AgentProviderStartTurnInput[],
    resolutions: [] as Parameters<AgentProviderTurnExecution["resolveRequest"]>[0][],
    close: 0,
    streamOwners: 0,
    streamPulls: 0,
  };
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      const adapt = (session: AgentProviderSession, context: AgentProviderSessionContext) => {
        const selected = hooks.transformSession?.(session, context) ?? session;
        const wrap = (source: AsyncIterable<AgentProviderOutput>): AsyncIterable<AgentProviderOutput> => ({
          [Symbol.asyncIterator]() {
            calls.streamOwners += 1;
            const iterator = source[Symbol.asyncIterator]();
            return {
              next() {
                calls.streamPulls += 1;
                return iterator.next();
              },
              ...(iterator.return === undefined ? {} : { return: () => iterator.return!() }),
              ...(iterator.throw === undefined ? {} : { throw: (error: unknown) => iterator.throw!(error) }),
            };
          },
        });
        const candidate: AgentProviderSession = {
          ...selected,
          startTurn(input) {
            calls.turns.push(input);
            const execution = selected.startTurn(input);
            return { ...execution, outputs: wrap(execution.outputs), resolveRequest(response) {
              calls.resolutions.push(response);
              return execution.resolveRequest(response);
            } };
          },
          close(input) {
            calls.close += 1;
            return selected.close(input);
          },
        };
        sessions.push(candidate);
        return candidate;
      };
      const adapter = instance.adapter;
      const resumption = adapter.resumption;
      const branching = adapter.branching;
      const wrapped: AgentProviderAdapter = {
        ...adapter,
        async createSession(input) {
          contexts.push(input);
          await hooks.beforeOpen?.(input);
          return adapt(await adapter.createSession(input), input);
        },
        resumption: resumption.kind === "unsupported" ? resumption : {
          kind: "supported" as const,
          async resumeSession(input: Parameters<typeof resumption.resumeSession>[0]) {
            contexts.push(input);
            await hooks.beforeOpen?.(input);
            return adapt(await resumption.resumeSession(input), input);
          },
        },
        branching: branching.kind === "unsupported" ? branching : {
          kind: "through_turn" as const,
          async branchSession(input: Parameters<typeof branching.branchSession>[0]) {
            contexts.push(input);
            await hooks.beforeOpen?.(input);
            return adapt(await branching.branchSession(input), input);
          },
        },
      };
      return { ...instance, adapter: hooks.transformAdapter?.(wrapped) ?? wrapped,
        async checkReadiness(input) {
          await hooks.beforeReadiness?.();
          return instance.checkReadiness(input);
        },
      };
    },
  };
  return { fake, driver, definition: fake.definition, contexts, sessions, calls };
}
