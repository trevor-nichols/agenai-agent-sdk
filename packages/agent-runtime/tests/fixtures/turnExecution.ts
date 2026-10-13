// ------------------------------------------------------------------------------------------------
//                turnExecution.ts - Synthetic turn outputs and exact local callback acceptance
// ------------------------------------------------------------------------------------------------

import type {
  AgentProviderOutput, AgentProviderResolveRequestInput, AgentProviderStartTurnInput,
  AgentProviderTurnExecution,
} from "../../src/index.js";

export function fixtureTurn(
  output: (input: AgentProviderStartTurnInput) => AsyncIterable<AgentProviderOutput>,
  continuation?: (input: AgentProviderResolveRequestInput) => AsyncIterable<AgentProviderOutput>,
): (input: AgentProviderStartTurnInput) => AgentProviderTurnExecution {
  return (input) => {
    let release!: () => void;
    let answered = new Promise<void>((resolve) => { release = resolve; });
    input.signal?.addEventListener("abort", () => release(), { once: true });
    let requestOpened = false;
    let terminal = false;
    let response: AsyncIterator<AgentProviderOutput> | undefined;
    let first: IteratorResult<AgentProviderOutput> | undefined;
    return {
      turnId: input.turnId,
      outputs: (async function* () {
        for await (const entry of output(input)) {
          if (entry.kind === "event") {
            if (entry.event.type === "request.opened") requestOpened = true;
            if (entry.event.type === "turn.completed") terminal = true;
          }
          yield entry;
        }
        while (continuation && requestOpened && !terminal) {
          await answered;
          if (input.signal?.aborted) throw input.signal.reason;
          requestOpened = false;
          answered = new Promise<void>((resolve) => { release = resolve; });
          const observe = (entry: AgentProviderOutput) => {
            if (entry.kind === "event" && entry.event.type === "request.opened") requestOpened = true;
            if (entry.kind === "event" && entry.event.type === "turn.completed") terminal = true;
            return entry;
          };
          if (first && !first.done) yield observe(first.value);
          if (response) for (;;) {
            const next = await response.next();
            if (next.done) break;
            yield observe(next.value);
          }
        }
      })(),
      async resolveRequest(answer) {
        if (continuation) {
          response = continuation(answer)[Symbol.asyncIterator]();
          first = await response.next();
        }
        release();
        return { status: "delivered" };
      },
    };
  };
}

const consumers = new WeakMap<AgentProviderTurnExecution, AsyncIterator<AgentProviderOutput>>();

export async function collectToRequest(execution: AgentProviderTurnExecution): Promise<readonly AgentProviderOutput[]> {
  const iterator = execution.outputs[Symbol.asyncIterator]();
  consumers.set(execution, iterator);
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return outputs;
    outputs.push(next.value);
    if (next.value.kind === "event" && next.value.event.type === "turn.state_changed"
      && next.value.event.payload.state === "waiting_for_request") return outputs;
  }
}

export async function resolveAndCollectTurn(execution: AgentProviderTurnExecution, input: AgentProviderResolveRequestInput) {
  await execution.resolveRequest(input);
  const iterator = consumers.get(execution);
  if (!iterator) throw new Error("The turn output must already have one consumer.");
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return outputs;
    outputs.push(next.value);
    if (next.value.kind === "event" && next.value.event.type === "turn.state_changed"
      && next.value.event.payload.state === "waiting_for_request") return outputs;
  }
}
