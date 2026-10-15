// ------------------------------------------------------------------------------------------------
//                live-request-output.ts - One output reader with independently owned request handling
// ------------------------------------------------------------------------------------------------

import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentIsoDateTime,
  parseAgentProviderConversationId,
  parseAgentRequest,
  parseAgentRequestResolutionFor,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentElicitationRequest,
} from '@agen-ai/agent-protocol';
import {
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentProviderOutput,
  type AgentProviderSession,
} from '@agen-ai/agent-runtime';

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const progressObserved = gate();
const receiptObserved = gate();
const transcript: string[] = [];
const statistics = { starts: 0, outputReaders: 0, acceptedAnswers: 0, closes: 0,
  producerJoined: false, handlerJoined: false };
const lifetime = new AbortController();
const releaseWaits = () => { progressObserved.release(); receiptObserved.release(); };
lifetime.signal.addEventListener('abort', releaseWaits, { once: true });
const watchdog = setTimeout(() => lifetime.abort(new Error(
  `Live request example exceeded 10 seconds. Observed: ${JSON.stringify(transcript)}`,
)), 10_000);
const independentProgress = 'Independent work completed while the request remained open.';
const answerText = 'Archive';

// This provider is a deterministic teaching fixture. It performs no native or network operation.
const capabilities = parseAgentCapabilities({
  protocolVersion: 11,
  providerKey: 'example-live-request',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: {
    approval: { kind: 'unsupported' },
    elicitation: { kind: 'supported', fieldKinds: ['text'], maxFields: 1, sensitiveFields: false },
  },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' },
  operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' },
  integrations: { kind: 'unsupported' },
  environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' },
  generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' },
  versionReporting: false,
});
const adapter = validateAgentProviderAdapter(capabilities, {
  resumption: { kind: 'unsupported' },
  branching: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' },
  createSession(context): AgentProviderSession {
    const binding = { conversationId: parseAgentProviderConversationId('live-request:conversation') };
    context.onBindingCreated(binding);
    const providerLifetime = new AbortController();
    let producer: AsyncGenerator<AgentProviderOutput, void> | undefined;
    return {
      binding,
      interruption: { kind: 'unsupported' },
      steering: { kind: 'unsupported' },
      configuration: { kind: 'managed' },
      operations: { kind: 'unsupported' },
      managedContent: { kind: 'unsupported' },
      environment: { kind: 'unsupported' },
      collaboration: { kind: 'unsupported' },
      generatedResources: { kind: 'unsupported' },
      startTurn(input) {
        statistics.starts += 1;
        const signal = AbortSignal.any([providerLifetime.signal, ...(input.signal ? [input.signal] : [])]);
        const request = parseAgentRequest({
          requestKind: 'elicitation', requestId: 'live-request:destination', prompt: 'Choose a destination.',
          fields: [{ fieldId: 'destination', label: 'Destination', kind: 'text', required: true,
            sensitivity: 'ordinary', multiline: false, maxLength: 40 }],
        });
        let accepted = false;
        const base = { protocolVersion: 11 as const, sessionId: context.sessionId, turnId: input.turnId,
          occurredAt: parseAgentIsoDateTime('2026-10-12T12:00:00.000Z') };
        async function* outputs(): AsyncGenerator<AgentProviderOutput, void> {
          signal.throwIfAborted();
          yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
          yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
            itemId: 'live-request:message', itemKind: 'assistant_message', status: 'in_progress',
          } });
          yield createAgentEventOutput({ ...base, type: 'request.opened', payload: { request } });
          yield createAgentEventOutput({ ...base, type: 'turn.state_changed', payload: {
            state: 'waiting_for_request', requestId: request.requestId,
          } });
          yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
            itemId: 'live-request:message', streamKind: 'assistant_text', delta: independentProgress,
          } });
          // No later output is available until the host has received the delivery receipt.
          await receiptObserved.promise;
          signal.throwIfAborted();
          if (!accepted) throw new Error('The original output reader resumed without an accepted answer.');
          yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
            itemId: 'live-request:message', streamKind: 'assistant_text', delta: `Continuing with ${answerText}.`,
          } });
          yield createAgentEventOutput({ ...base, type: 'item.completed', payload: {
            itemId: 'live-request:message', itemKind: 'assistant_message', status: 'completed',
          } });
          yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { outcome: 'completed' } });
        }
        return {
          turnId: input.turnId,
          outputs: { [Symbol.asyncIterator]() { statistics.outputReaders += 1; producer = outputs(); return producer; } },
          async resolveRequest(response) {
            signal.throwIfAborted();
            response.signal?.throwIfAborted();
            const resolution = parseAgentRequestResolutionFor(request, response.resolution);
            if (accepted) throw new Error('The provider received the same request answer twice.');
            if (resolution.requestKind !== 'elicitation' || resolution.disposition !== 'answered') {
              throw new Error('The synthetic provider expected its exact elicitation answer.');
            }
            const answer = resolution.answers[0];
            if (resolution.answers.length !== 1 || answer?.fieldId !== 'destination'
              || answer.kind !== 'text' || answer.value !== answerText) {
              throw new Error('The synthetic provider did not receive the exact canonical field and value.');
            }
            accepted = true;
            statistics.acceptedAnswers += 1;
            transcript.push(`provider.accepted:${resolution.requestId}:${answer.fieldId}=${answer.value}`);
            // Delivery means this provider-owned canonical handler accepted the answer.
            return { status: 'delivered' };
          },
        };
      },
      async close(input) {
        providerLifetime.abort();
        releaseWaits();
        await producer?.return(undefined);
        statistics.producerJoined = producer !== undefined;
        input.signal?.throwIfAborted();
        statistics.closes += 1;
        transcript.push('session.closed');
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
//                Host: one reader, one separately owned answer task, bounded joined cleanup
// ------------------------------------------------------------------------------------------------

try {
  const session = await adapter.createSession({
    sessionId: parseAgentSessionId('live-request:session'), workingDirectory: process.cwd(),
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('live-request:configuration') },
    onBindingCreated() {}, signal: lifetime.signal,
  });
  let answerTask: Promise<void> | undefined;
  let answerFailure: { error: unknown } | undefined;
  try {
    let completed = false;
    const execution = session.startTurn({
      turnId: parseAgentTurnId('live-request:turn'), interactionMode: 'default',
      parts: [{ type: 'text', text: 'Keep showing independent work while waiting for my destination.' }],
      signal: lifetime.signal,
    });
    async function answerRequest(request: AgentElicitationRequest): Promise<void> {
      // Replace this gate with an abort-aware UI/human decision. The reader keeps pulling.
      await progressObserved.promise;
      lifetime.signal.throwIfAborted();
      const field = request.fields[0];
      if (request.fields.length !== 1 || field?.kind !== 'text') throw new Error('Expected one text field.');
      transcript.push(`answer.submitted:${request.requestId}`);
      const receipt = await execution.resolveRequest({
        resolution: { requestKind: 'elicitation', requestId: request.requestId, disposition: 'answered',
          answers: [{ fieldId: field.fieldId, kind: 'text', value: answerText }] },
        signal: lifetime.signal,
      });
      if (receipt.status !== 'delivered') throw new Error(`The answer was ${receipt.status}; do not replay it.`);
      transcript.push(`answer.delivered:${request.requestId}`);
      receiptObserved.release();
    }
    for await (const output of execution.outputs) {
      if (output.kind !== 'event') continue;
      const event = output.event;
      if (event.type === 'turn.started') transcript.push('turn.started');
      if (event.type === 'request.opened') {
        const request = event.payload.request;
        if (request.requestKind !== 'elicitation' || answerTask) throw new Error('Expected exactly one elicitation.');
        transcript.push(`request.opened:${request.requestId}`);
        // Track the task; awaiting it here would block the progress that releases its decision.
        answerTask = answerRequest(request).catch((error: unknown) => {
          answerFailure = { error };
          lifetime.abort(error);
        });
      }
      if (event.type === 'turn.state_changed') transcript.push(`turn.${event.payload.state}`);
      if (event.type === 'content.delta') {
        transcript.push(`output:${event.payload.delta}`);
        if (event.payload.delta === independentProgress) progressObserved.release();
      }
      if (event.type === 'turn.completed') {
        transcript.push(`turn.completed:${event.payload.outcome}`);
        if (event.payload.outcome !== 'completed') throw new Error('The original turn did not complete.');
        completed = true;
      }
    }
    await answerTask;
    if (answerFailure) throw answerFailure.error;
    if (!completed) throw new Error('The original reader ended before true terminality.');
  } catch (error) {
    throw answerFailure?.error ?? error;
  } finally {
    lifetime.abort();
    try { await session.close({ reason: 'shutdown', signal: AbortSignal.timeout(2_000) }); }
    finally {
      await answerTask;
      statistics.handlerJoined = answerTask !== undefined;
      transcript.push('handler.joined');
    }
  }
  console.log(JSON.stringify({ example: 'live-request-output', evidence: 'synthetic', transcript,
    ...statistics, cleanup: 'joined' }));
} catch (error) {
  console.error(`Live request example failed. Observed: ${JSON.stringify(transcript)}`);
  throw error;
} finally {
  clearTimeout(watchdog);
  lifetime.abort();
  lifetime.signal.removeEventListener('abort', releaseWaits);
}
