import {
  parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentTurnId, type AgentSessionId,
} from '@agen-ai/agent-protocol';
import { parseAgentUsageObservedEvent, type AgentUsageObservedEvent } from '@agen-ai/agent-protocol/usage';
import type { AgentProviderSession, AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import {
  admitTokenUsageEvent, createTokenUsageLedger, summarizeTokenUsageView, type AgentTokenUsageLedger,
} from '@agen-ai/agent-runtime/usage';
import { createReportingProvider } from './provider.js';

/** Reads the sole validated turn output and records its usage without changing the native outcome. */
async function readTurn(execution: AgentProviderTurnExecution, start: AgentTokenUsageLedger) {
  let ledger = start;
  let outcome: string | undefined;
  const eventTypes: string[] = [];
  const usage: AgentUsageObservedEvent[] = [];
  for await (const output of execution.outputs) {
    if (output.kind !== 'event') continue;
    eventTypes.push(output.event.type);
    if (output.event.type === 'turn.completed') outcome = output.event.payload.outcome;
    if (output.event.type !== 'usage.observed') continue;
    const admission = admitTokenUsageEvent(ledger, output.event);
    if (admission.status === 'rejected') throw new Error(`${admission.code}: ${admission.message}`);
    ledger = admission.ledger;
    usage.push(output.event);
  }
  return { outcome, eventTypes, usage, ledger };
}

/** An application may persist delivered events as JSON and rebuild the same ledger later. */
function rebuild(sessionId: AgentSessionId, stored: string): AgentTokenUsageLedger {
  const events: unknown[] = JSON.parse(stored);
  return events.reduce<AgentTokenUsageLedger>((ledger, value) => {
    const admission = admitTokenUsageEvent(ledger, parseAgentUsageObservedEvent(value));
    if (admission.status === 'rejected') throw new Error(`${admission.code}: ${admission.message}`);
    return admission.ledger;
  }, createTokenUsageLedger({ sessionId }));
}

export async function runLifecycleScenario() {
  const provider = createReportingProvider();
  const sessionId = parseAgentSessionId('usage-example:lifecycle');
  let session: AgentProviderSession | undefined;
  try {
    session = await provider.adapter.createSession({
      sessionId, workingDirectory: '/usage-example',
      configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('usage-example:configuration') },
      onBindingCreated() {},
    });
    const turn = await readTurn(session.startTurn({ turnId: parseAgentTurnId('turn-1'), interactionMode: 'default',
      parts: [{ type: 'text', text: 'Report whatever usage the native result carries.' }] }), createTokenUsageLedger({ sessionId }));
    const [event] = turn.usage;
    if (event === undefined) throw new Error('The declared provider delivered no usage observation.');
    const view = summarizeTokenUsageView(turn.ledger, event.payload.view.viewId);
    const rebuilt = summarizeTokenUsageView(rebuild(sessionId, JSON.stringify(turn.usage)), event.payload.view.viewId);
    await session.close({ reason: 'idle' });
    return {
      scenario: 'unavailable_on_success', outcome: turn.outcome, eventTypes: turn.eventTypes,
      deliveryTurn: event.turnId, accountingScope: event.payload.scope.scopeId, measurement: event.payload.measurement,
      total: view === undefined ? 'no_summary' : {
        inputTokens: view.total.counters.inputTokens, outputTokens: view.total.counters.outputTokens,
      },
      rebuiltFromJson: JSON.stringify(rebuilt) === JSON.stringify(view) ? 'identical' : 'different',
      starts: provider.statistics.starts, sessionCloses: provider.statistics.sessionCloses,
    };
  } finally {
    await session?.close({ reason: 'shutdown' });
  }
}
