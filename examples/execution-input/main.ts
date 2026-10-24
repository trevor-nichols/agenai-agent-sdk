import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentTurnId,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderContractError, parseAgentExecutionInputMessageId, type AgentProviderSession,
} from '@agen-ai/agent-runtime';
import { startExecutionInputFlow, type ExecutionInputFlowReport } from './application.js';
import { createTeachingProvider, type Scenario } from './teaching-provider.js';
import { ExecutionInputExampleCleanupError, within } from './support.js';

const scenarios: readonly Scenario[] = [
  'accepted-consumed', 'accepted-unconfirmed', 'native-rejected', 'delivery-uncertain', 'unsupported',
];

async function runScenario(scenario: Scenario) {
  const fixture = createTeachingProvider(scenario);
  let session: AgentProviderSession | undefined;
  let flow: ReturnType<typeof startExecutionInputFlow> | undefined;
  async function cleanup(): Promise<void> {
    try {
      // Fresh cleanup authority remains available after uncertainty or an application deadline.
      await within(Promise.resolve(session?.close({ reason: 'shutdown', signal: AbortSignal.timeout(5_000) })), 'Session close');
      await within(flow?.joined ?? Promise.resolve(), 'Public output reader join');
      await within(Promise.resolve(fixture.instance.dispose()), 'Instance disposal');
    } catch (cause) { throw new ExecutionInputExampleCleanupError(cause, cleanup); }
  }
  const messageId = parseAgentExecutionInputMessageId(`execution-input:${scenario}:instruction`);
  const turnId = parseAgentTurnId(`execution-input:${scenario}:turn`);
  let report: ExecutionInputFlowReport;
  let uncertaintyFence: 'session_unusable' | null = null;
  try {
    session = await fixture.instance.adapter.createSession({
      sessionId: parseAgentSessionId(`execution-input:${scenario}:session`),
      workingDirectory: '/teaching/workspace',
      configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('teaching:configuration') },
      onBindingCreated() {},
    });
    const execution = session.startTurn({ turnId, interactionMode: 'default',
      parts: [{ type: 'text', text: 'Complete the original task.' }] });
    flow = startExecutionInputFlow(execution, {
      messageId, parts: [{ type: 'text', text: 'Include the corrected requirement in the owned task.' }],
    });
    report = await flow.result;
    assert.deepEqual(report.output, {
      events: ['turn.started', 'item.started', 'content.delta', 'content.delta', 'item.completed', 'turn.completed'],
      text: 'Original task remains owned.\nTeaching provider completed.\n', outcomes: ['completed'], terminals: 1,
    });
    switch (scenario) {
      case 'accepted-consumed':
        assert.deepEqual(report.receipt, { status: 'accepted', messageId });
        assert.deepEqual(report.settlement, { status: 'consumed', messageId, turnId, placement: 'owned_native_continuation' });
        break;
      case 'accepted-unconfirmed':
        assert.deepEqual(report.receipt, { status: 'accepted', messageId });
        assert.deepEqual(report.settlement, { status: 'unconfirmed', messageId, reason: 'provider_does_not_report_consumption' });
        break;
      case 'native-rejected':
        assert.deepEqual(report.receipt, { status: 'rejected', messageId, errorCode: 'teaching_native_refusal' });
        assert.equal(report.settlement, null);
        break;
      case 'delivery-uncertain': {
        assert.deepEqual(report.receipt, { status: 'delivery_uncertain', messageId, errorCode: 'teaching_receipt_lost' });
        assert.equal(report.settlement, null);
        // A deliberate negative proof at the real validator; the reusable application makes no retry.
        const unusableSession = session;
        assert.throws(() => unusableSession.startTurn({ turnId: parseAgentTurnId('teaching:forbidden-retry'),
          interactionMode: 'default', parts: [{ type: 'text', text: 'This must never dispatch.' }] }),
        (cause: unknown) => cause instanceof AgentProviderContractError && cause.code === 'session_unusable');
        uncertaintyFence = 'session_unusable';
        break;
      }
      case 'unsupported':
        assert.deepEqual(report.receipt, { status: 'unsupported' });
        assert.equal(report.settlement, null);
        break;
    }
    assert.equal(report.outputWhileAwaitingReceipt, scenario !== 'unsupported');
    assert.equal(report.outputWhileAwaitingSettlement,
      scenario === 'accepted-consumed' || scenario === 'accepted-unconfirmed');
    assert.deepEqual(fixture.submissions.map((message) => ({ messageId: message.messageId, parts: message.parts })),
      scenario === 'unsupported' ? [] : [{ messageId,
        parts: [{ type: 'text', text: 'Include the corrected requirement in the owned task.' }] }]);
  } finally { await cleanup(); }
  assert.deepEqual(fixture.statistics, { starts: 1, outputReaders: 1, inputCalls: scenario === 'unsupported' ? 0 : 1,
    producerJoins: 1, sessionCloses: 1, instanceDisposals: 1 });
  return { scenario, ...report, provider: { ...fixture.statistics }, uncertaintyFence, cleanup: 'joined' as const };
}

export async function runExecutionInputExample() {
  const reports = [];
  for (const scenario of scenarios) reports.push(await runScenario(scenario));
  return { example: 'execution-input' as const, evidence: 'synthetic' as const,
    nativeProviderSupport: 'none' as const, scenarios: reports };
}

export type ExecutionInputExampleSummary = Awaited<ReturnType<typeof runExecutionInputExample>>;

// Packed consumers import the helper without starting the example a second time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runExecutionInputExample()));
}
