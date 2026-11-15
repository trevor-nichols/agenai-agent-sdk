import { AGENT_PROTOCOL_VERSION, type AgentSessionId } from '@agen-ai/agent-protocol';
import {
  AGENT_TOKEN_USAGE_COUNTERS, parseAgentTokenUsageObservation, parseAgentUsageObservedEvent,
  type AgentExactTokenCount, type AgentInexactTokenCount, type AgentTokenCount, type AgentTokenUsageCounterName,
  type AgentTokenUsageCoverage, type AgentTokenUsageObservation, type AgentTokenUsageReasons, type AgentUsageObservedEvent,
} from '@agen-ai/agent-protocol/usage';

// Wire-shaped observations as an adapter would emit them. Every value crosses the public parser.
export const exact = (value: number): AgentExactTokenCount => ({ kind: 'exact', value });
export const atLeast = (value: number, ...reasons: AgentTokenUsageReasons): AgentInexactTokenCount =>
  ({ kind: 'at_least', value, reasons });
export const unavailable = (...reasons: AgentTokenUsageReasons): AgentInexactTokenCount => ({ kind: 'unavailable', reasons });
const UNSUPPORTED: AgentInexactTokenCount = { kind: 'unavailable', reasons: ['unsupported'] };

type Values = Partial<Record<AgentTokenUsageCounterName, AgentTokenCount>>;
const counters = (values: Values) => Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name, values[name] ?? UNSUPPORTED]));
export const tokens = (inputTokens: AgentTokenCount, outputTokens: AgentTokenCount, more: Values = {}): Values =>
  ({ inputTokens, outputTokens, ...more });

const NO_ACTIVITY_COUNTS = { modelCalls: 'unsupported', turns: 'unsupported' } as const;
export const VIEWS = {
  session: { viewId: 'session-total', authority: 'authoritative', accounting: 'snapshot', countBasis: NO_ACTIVITY_COUNTS,
    population: { descendants: 'included', auxiliary: 'included' } },
  turn: { viewId: 'turn-work', authority: 'authoritative', accounting: 'delta', countBasis: NO_ACTIVITY_COUNTS,
    population: { descendants: 'excluded', auxiliary: 'excluded' } },
  calls: { viewId: 'call-detail', authority: 'detail', accounting: 'delta', countBasis: NO_ACTIVITY_COUNTS,
    population: { descendants: 'excluded', auxiliary: 'excluded' } },
} as const;

export const SESSION_SCOPE = { scopeId: 'session', kind: 'session' } as const;
export const turnScope = (turnId: string) => ({ scopeId: `turn:${turnId}`, kind: 'turn', turnId }) as const;
export const callScope = (callId: string, turnId: string) =>
  ({ scopeId: `call:${callId}`, kind: 'model_call', turnId, containedIn: `turn:${turnId}` }) as const;

type Finality = 'open' | 'final';
const COMPLETE: AgentTokenUsageCoverage = { kind: 'complete' };
const MODEL = { kind: 'model', model: { modelProvider: 'example', modelId: 'example-model' } } as const;

export function delta(observationId: string, view: typeof VIEWS.turn | typeof VIEWS.calls, scope: object, values: Values,
  finality: Finality = 'final'): AgentTokenUsageObservation {
  return parseAgentTokenUsageObservation({ observationId, view, scope, finality,
    measurement: { kind: 'delta', coverage: COMPLETE, counters: counters(values), attribution: MODEL } });
}

export type SnapshotOptions = Readonly<{
  origin: 'fresh_zero' | 'historical' | 'unknown';
  finality?: Finality;
  coverage?: AgentTokenUsageCoverage;
  unknownComparison?: readonly AgentTokenUsageCounterName[];
}>;

/** One revision of epoch 0 in the session series; stable comparison is declared per counter. */
export function snapshot(observationId: string, revision: number, values: Values, options: SnapshotOptions): AgentTokenUsageObservation {
  const comparison = Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name,
    options.unknownComparison?.includes(name) ? { kind: 'unknown' } : { kind: 'stable', populationId: `session:${name}` }]));
  return parseAgentTokenUsageObservation({
    observationId, view: VIEWS.session, scope: SESSION_SCOPE, finality: options.finality ?? 'open',
    measurement: { kind: 'snapshot', epoch: 0, revision, origin: { kind: options.origin, cause: 'initial' }, comparison,
      coverage: options.coverage ?? COMPLETE, counters: counters(values), attribution: MODEL },
  });
}

export function notMeasured(observationId: string, scope: object, reasons: AgentTokenUsageReasons): AgentTokenUsageObservation {
  return parseAgentTokenUsageObservation({ observationId, view: VIEWS.turn, scope, finality: 'final',
    measurement: { kind: 'unavailable', reasons } });
}

/** The envelope turn is the delivery path, which need not be the observation's accounting scope. */
export function observed(sessionId: AgentSessionId, deliveryTurnId: string, payload: AgentTokenUsageObservation): AgentUsageObservedEvent {
  return parseAgentUsageObservedEvent({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'usage.observed', sessionId,
    turnId: deliveryTurnId, occurredAt: '2026-11-13T12:00:00.000Z', payload });
}
