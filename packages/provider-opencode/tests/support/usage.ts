// ------------------------------------------------------------------------------------------------
//                usage.ts - Hand-written token-usage expectations and native usage scripts for OpenCode tests
// ------------------------------------------------------------------------------------------------

import type test from 'node:test';
import type { AgentEvent, AgentTokenUsageObservation } from '@agen-ai/agent-protocol';
import { AgentProviderContractError, type AgentProviderSession } from '@agen-ai/agent-runtime';
import { loopbackNative, tokens } from './native-http.js';
import { openValidatedSession, scriptedTools, startText } from './session.js';

export const ANTHROPIC = Object.freeze({ provider: 'anthropic' as const, id: 'claude-sonnet-4-5' });
export const OPENAI = Object.freeze({ provider: 'openai' as const, id: 'gpt-5' });
type Model = Readonly<{ provider: 'anthropic' | 'openai'; id: string }>;
type Count = Readonly<Record<string, unknown>>;

const UNSUPPORTED = { kind: 'unavailable', reasons: ['unsupported'] };
export const exact = (value: number) => ({ kind: 'exact', value });
export const atLeast = (value: number, ...reasons: string[]) => ({ kind: 'at_least', value, reasons });
export const missing = (...reasons: string[]) => ({ kind: 'unavailable', reasons });
export const COMPLETE = { kind: 'complete' };
export const partial = (...reasons: string[]) => ({ kind: 'partial', reasons });
/** Anthropic Messages reports input, cache reads, cache writes and output; reasoning is a native zero default. */
export const anthropicCounts = (input: Count, cacheRead: Count, cacheCreation: Count, output: Count) => ({
  inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, cacheCreationFiveMinuteInputTokens: UNSUPPORTED,
  cacheCreationOneHourInputTokens: UNSUPPORTED, outputTokens: output, reasoningOutputTokens: UNSUPPORTED, modelCalls: UNSUPPORTED, turns: UNSUPPORTED,
});
/** OpenAI Responses reports input, cache reads, output and reasoning; cache writes are a native zero default. */
export const openaiCounts = (input: Count, cacheRead: Count, output: Count, reasoning: Count) => ({
  inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: UNSUPPORTED, cacheCreationFiveMinuteInputTokens: UNSUPPORTED,
  cacheCreationOneHourInputTokens: UNSUPPORTED, outputTokens: output, reasoningOutputTokens: reasoning, modelCalls: UNSUPPORTED, turns: UNSUPPORTED,
});
export const snapshot = (revision: number, coverage: object, counters: object) => ({
  kind: 'snapshot', epoch: 0, revision, origin: { kind: 'fresh_zero', cause: 'initial' }, coverage, counters, attribution: { kind: 'unknown' },
});
export const step = (coverage: object, counters: object, model: Model = ANTHROPIC) => ({
  kind: 'delta', coverage, counters, attribution: { kind: 'model', model: { modelProvider: model.provider, modelId: model.id } },
});

export const usageOf = (events: readonly AgentEvent[]) => events.flatMap((event) => event.type === 'usage.observed' ? [event.payload] : []);
/** View, scope and finality with the measurement; snapshot comparison identity is checked on its own. */
export function measured(events: readonly AgentEvent[]) {
  return usageOf(events).map((observation: AgentTokenUsageObservation) => {
    const { measurement, scope } = observation;
    const shown = measurement.kind === 'snapshot' ? (({ comparison: _comparison, ...rest }) => rest)(measurement) : measurement;
    return [observation.view.viewId, scope.kind === 'turn' ? `turn:${scope.turnId}` : scope.kind, observation.finality, shown];
  });
}

export const contractError = (code: string) => (error: unknown) => error instanceof AgentProviderContractError && error.code === code;

export async function openUsageSession(t: test.TestContext, model: Model = ANTHROPIC) {
  const loop = await loopbackNative(t);
  const session = await openValidatedSession({ native: loop.native, tools: scriptedTools(() => Promise.reject(new Error('unused'))).tools, model });
  t.after(() => session.close({ reason: 'idle' }));
  const native = {
    started: () => loop.send('session.execution.started', {}),
    stepStarted: (id: string, on: Model = model) => loop.send('session.step.started', {
      assistantMessageID: id, agent: 'build', model: { id: on.id, providerID: on.provider }, started: 1,
    }),
    stepEnded: (id: string, value: ReturnType<typeof tokens>) => loop.send('session.step.ended', { assistantMessageID: id, finish: 'stop', cost: 0, tokens: value }),
    stepFailed: (id: string, value?: ReturnType<typeof tokens>) => loop.send('session.step.failed', {
      assistantMessageID: id, error: { type: 'provider', message: 'declined' }, ...(value ? { cost: 0, tokens: value } : {}),
    }),
    step(id: string, value: ReturnType<typeof tokens>) { this.stepStarted(id); this.stepEnded(id, value); },
    total: (value: ReturnType<typeof tokens>) => loop.send('session.usage.updated', { cost: 0, tokens: value }),
    succeeded: () => loop.send('session.execution.succeeded', {}),
    failed: () => loop.send('session.execution.failed', { error: { type: 'provider', message: 'declined' } }),
    interrupted: () => loop.send('session.execution.interrupted', {}),
  };
  return { loop, session, native };
}

/** Reads one whole validated turn. */
export async function readTurn(session: AgentProviderSession, turnId: string, seen?: (event: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const output of startText(session, turnId).outputs) {
    if (output.kind !== 'event') continue;
    events.push(output.event);
    seen?.(output.event);
  }
  return events;
}

export const types = (events: readonly AgentEvent[]) => events.map((event) => event.type);
export const completion = (events: readonly AgentEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'turn.completed' ? last.payload.outcome : undefined;
};
export { tokens };
