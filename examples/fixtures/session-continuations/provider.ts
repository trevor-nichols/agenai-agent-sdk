import assert from 'node:assert/strict';
import {
  parseAgentCapabilities, parseAgentProviderConversationId, parseAgentSessionFormRequest,
  parseAgentSessionPlanReviewRequest, parseAgentSessionResponseFor,
} from '@agen-ai/agent-protocol';
import {
  createAgentEventOutput, validateAgentProviderAdapter,
  type AgentNativeContinuationOutcome, type AgentPreparedSessionResponse,
  type AgentProviderOutput, type AgentProviderPreparedSessionInteraction,
  type AgentProviderSession, type AgentSessionInteractionTerminal,
} from '@agen-ai/agent-runtime';
import { deferred } from './shared.js';

const capabilities = parseAgentCapabilities({
  protocolVersion: 13, providerKey: 'example-session-continuations',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: { approval: { kind: 'unsupported' }, elicitation: { kind: 'unsupported' } },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' }, integrations: { kind: 'unsupported' },
  environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' }, versionReporting: false,
});

// Consumer-owned, effect-free teaching provider. It has no native process, network, or storage.
export function sessionContinuationProvider(kind: 'form' | 'plan_review', continuationSupport = true) {
  const transcript: string[] = [];
  const statistics = { openingEntries: 0, starts: 0, nativeAnswerEntries: 0, workStarts: 0,
    outputReaders: 0, noWorkActions: 0, callbackJoins: 0, producerJoins: 0, closes: 0 };
  const adapter = validateAgentProviderAdapter(capabilities, {
    resumption: { kind: 'unsupported' }, branching: { kind: 'unsupported' },
    authentication: { kind: 'unsupported' },
    sessionInteractions: { kind: 'supported', producerOwnership: 'exclusive',
      mappings: [{ openingOperation: 'create', requestKind: kind }],
      humanWait: ['bounded', 'until_withdrawn_or_closed'] },
    nativeContinuations: continuationSupport ? { kind: 'supported', producerOwnership: 'exclusive',
      mappings: [{ openingOperation: 'create', requestKind: kind, timing: 'after_open_return' }] } : { kind: 'unsupported' },
    createSession(context): AgentProviderSession {
      statistics.openingEntries += 1;
      const binding = { conversationId: parseAgentProviderConversationId(`session-example:${kind}:conversation`) };
      context.onBindingCreated(binding);
      assert.ok(context.interactions, 'Install the interaction handler before opening.');
      const lifetime = new AbortController();
      const terminal = deferred<AgentSessionInteractionTerminal>();
      const outcome = deferred<AgentNativeContinuationOutcome>();
      const sourceReleased = deferred<void>();
      let settled = false;
      let closed = false;
      let producer: AsyncGenerator<AgentProviderOutput, void> | undefined;
      const request = kind === 'form' ? parseAgentSessionFormRequest({
        kind: 'form', requestId: 'session-example:form', sessionId: context.sessionId,
        title: 'Choose the destination for continued work',
        fields: [{ fieldId: 'destination', kind: 'text', label: 'Destination', required: true,
          sensitivity: 'ordinary', multiline: false, maxLength: 40 }],
        choices: [{ choiceId: 'submit-destination', action: 'submit', label: 'Continue' },
          { choiceId: 'cancel-destination', action: 'cancel', label: 'Cancel' }],
      }) : parseAgentSessionPlanReviewRequest({
        kind: 'plan_review', requestId: 'session-example:review', sessionId: context.sessionId,
        title: 'Review the saved plan', plan: { planId: 'session-example:plan', revision: 'revision-one',
          title: 'Saved plan', content: { kind: 'text', format: 'markdown', text: '# Saved plan\n\nContinue the owned task.' } },
        choices: [{ choiceId: 'approve-saved-plan', action: 'approve', label: 'Approve' },
          { choiceId: 'abandon-saved-plan', action: 'abandon', label: 'Abandon' }],
      });
      function finish(value: AgentSessionInteractionTerminal): void {
        if (settled) return;
        settled = true;
        terminal.resolve(value);
        lifetime.abort();
      }
      const candidate: AgentProviderPreparedSessionInteraction = {
        kind: 'prepared', request, signal: lifetime.signal, terminal: terminal.promise,
        prepareResponse(input): AgentPreparedSessionResponse {
          const response = parseAgentSessionResponseFor(request, input.response);
          if (response.kind === 'decision') throw new Error('This fixture offers forms and plan reviews.');
          transcript.push(`prepared:${response.kind}:${response.action}`);
          const noWork = (response.kind === 'plan_review' && response.action === 'abandon')
            || (response.kind === 'form' && response.action === 'cancel');
          let phase: 'prepared' | 'dispatched' | 'canceled' = 'prepared';
          const control = {
            async dispatch() {
              assert.equal(phase, 'prepared');
              phase = 'dispatched';
              statistics.nativeAnswerEntries += 1;
              transcript.push(`dispatched:${response.kind}:${response.action}`);
              if (noWork) statistics.noWorkActions += 1;
              else {
                statistics.workStarts += 1;
                outcome.resolve({ kind: 'started' });
                sourceReleased.resolve();
              }
              if (response.kind === 'form') finish({ kind: 'answered', response: {
                kind: 'form', action: response.action, choiceId: response.choiceId,
              } });
              else if (response.kind === 'plan_review') finish({ kind: 'answered', response: {
                kind: 'plan_review', action: response.action, choiceId: response.choiceId,
                planId: response.planId, revision: response.revision,
              } });
              return { status: 'delivered' as const };
            },
            async cancel() {
              if (phase === 'canceled') return;
              assert.equal(phase, 'prepared', 'An entered answer is cleaned through session close.');
              phase = 'canceled';
              sourceReleased.resolve();
              outcome.resolve({ kind: 'not_started' });
              await producer?.return(undefined);
              transcript.push('preparation.canceled');
            },
          };
          if (noWork) return { kind: 'no_continuation', ...control };
          return { kind: 'native_continuation', ...control, outcome: outcome.promise,
            createExecution({ turnId, signal }) {
              return { turnId,
                async resolveRequest() { throw new Error('This continuation offers no turn request.'); },
                outputs: { [Symbol.asyncIterator]() {
                  statistics.outputReaders += 1;
                  transcript.push('producer.reader');
                  producer = (async function* () {
                    try {
                      await sourceReleased.promise;
                      signal.throwIfAborted();
                      const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId,
                        occurredAt: '2026-10-16T12:00:00.000Z' };
                      yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
                      yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
                        itemId: 'session-example:message', itemKind: 'assistant_message', status: 'in_progress',
                      } });
                      yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
                        itemId: 'session-example:message', streamKind: 'assistant_text', delta: 'Continued with the exact submitted destination.',
                      } });
                      yield createAgentEventOutput({ ...base, type: 'item.completed', payload: {
                        itemId: 'session-example:message', itemKind: 'assistant_message', status: 'completed',
                      } });
                      yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { structuredOutput: { kind: 'not_requested' }, outcome: 'completed' } });
                    } finally { statistics.producerJoins += 1; transcript.push('producer.joined'); }
                  })();
                  return producer;
                } },
              };
            },
          };
        },
      };
      // Retain and drain the actual producer callback; abortion alone does not join it.
      const publication = Promise.resolve(context.interactions.onRequest(candidate));
      void publication.catch(() => {});
      return { binding,
        interruption: { kind: 'unsupported' }, steering: { kind: 'unsupported' },
        configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
        managedContent: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
        collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
        startTurn() { statistics.starts += 1; throw new Error('Session responses must not create caller turns.'); },
        async close() {
          if (closed) return;
          finish({ kind: 'session_closed' });
          sourceReleased.resolve();
          await producer?.return(undefined);
          await publication.catch(() => {});
          closed = true;
          statistics.callbackJoins += 1;
          statistics.closes += 1;
          transcript.push('session.closed');
        },
      };
    },
  });
  return { adapter, statistics, transcript };
}
