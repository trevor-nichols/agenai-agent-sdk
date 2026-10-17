import assert from 'node:assert/strict';
import {
  parseAgentConfigurationRevisionId, parseAgentSessionId, type AgentSessionFormResponse,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderContractError, type AgentCreateSessionInput, type AgentNativeContinuation,
  type AgentSessionInteraction,
} from '@agen-ai/agent-runtime';
import { sessionContinuationProvider } from './fixtures/session-continuations/provider.js';
import { deferred, within } from './fixtures/session-continuations/shared.js';

// Only core public entrypoints are required. This fixture performs no native or network operation.
const humanWait = { kind: 'until_withdrawn_or_closed' } as const;
const limits = { responseTimeoutMs: 2_000, cleanupTimeoutMs: 2_000 };
const input = (name: string): AgentCreateSessionInput => ({
  sessionId: parseAgentSessionId(`session-continuations:${name}`), workingDirectory: process.cwd(),
  configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('session-continuations:configuration') },
  onBindingCreated() {}, signal: AbortSignal.timeout(10_000),
});

const form = sessionContinuationProvider('form');
const offer = deferred<AgentSessionInteraction>();
const consumed = deferred<void>();
void consumed.promise.catch(() => {});
const outcomes: string[] = [];
const output: string[] = [];
let continuation: AgentNativeContinuation | undefined;
let hostCallbackJoins = 0;
let parkedBeforeDispatch = false;
let requestCallbackJoins = 0;
const session = await form.adapter.createSession({ ...input('form'),
  interactions: { humanWait, limits,
    async onRequest(interaction) {
      form.transcript.push('form.offered');
      offer.resolve(interaction);
      await interaction.terminal;
      requestCallbackJoins += 1;
    },
  },
  nativeContinuations: {
    async onExecution(value) {
      continuation = value;
      const iterator = value.execution.outputs[Symbol.asyncIterator]();
      // This actual outstanding next(), established before dispatch, makes the reader ready.
      const first = iterator.next();
      parkedBeforeDispatch = form.statistics.nativeAnswerEntries === 0;
      form.transcript.push('reader.parked');
      try {
        for (let next = await first; !next.done; next = await iterator.next()) {
          if (next.value.kind !== 'event') continue;
          const event = next.value.event;
          output.push(event.type);
          form.transcript.push(`output:${event.type}`);
          if (event.type === 'turn.completed') assert.equal(event.payload.outcome, 'completed');
        }
        outcomes.push((await value.outcome).kind);
        consumed.resolve();
      } catch (cause) { consumed.reject(cause); throw cause; }
      finally { hostCallbackJoins += 1; form.transcript.push('host.reader.joined'); }
    },
  },
});
form.transcript.push('opening.returned');
let formReceipt: string;
let formDeadline: AgentSessionInteraction['deadline'];
try {
  const interaction = await within(offer.promise, 'Form presentation');
  assert.equal(interaction.request.kind, 'form');
  if (interaction.request.kind !== 'form') throw new Error('Expected a session form.');
  const request = interaction.request;
  formDeadline = interaction.deadline;
  assert.deepEqual(formDeadline, { kind: 'no_deadline' });
  assert.equal(request.expiresAt, undefined, 'No host deadline is written into the provider descriptor.');
  const submit = request.choices.find((choice) => choice.action === 'submit');
  const field = request.fields[0];
  assert.ok(submit && field?.kind === 'text');
  // A real UI presents all offered fields/choices and supplies the user's answer here.
  const response: AgentSessionFormResponse = { kind: 'form', action: 'submit', choiceId: submit.choiceId,
    answers: [{ fieldId: field.fieldId, kind: 'text', value: 'Archive' }] };
  form.transcript.push(`host.selected:form:submit:${submit.choiceId}`);
  const receipt = await within(interaction.respond(response), 'Form response');
  formReceipt = receipt.status;
  assert.equal(receipt.status, 'delivered', 'Do not replay an uncertain response.');
  form.transcript.push('answer.delivered');
  await within(consumed.promise, 'Original continuation reader');
  assert.ok(continuation);
  assert.deepEqual(await continuation.outcome, { kind: 'started' });
  assert.deepEqual(await interaction.terminal, { kind: 'answered', response: {
    kind: 'form', action: 'submit', choiceId: submit.choiceId,
  } });
} finally {
  await within(Promise.resolve(session.close({ reason: 'shutdown', signal: AbortSignal.timeout(2_000) })), 'Form cleanup', 3_000);
}

// Offered abandonment is a real answer with no continuation. It creates no reader or caller turn.
const abandon = sessionContinuationProvider('plan_review');
const planOffer = deferred<AgentSessionInteraction>();
let unexpectedContinuations = 0;
const planSession = await abandon.adapter.createSession({ ...input('abandon'),
  interactions: { humanWait, limits, async onRequest(interaction) {
    planOffer.resolve(interaction);
    await interaction.terminal;
    requestCallbackJoins += 1;
  } },
  nativeContinuations: { onExecution() { unexpectedContinuations += 1; throw new Error('Abandonment starts no work.'); } },
});
let abandonReceipt: string;
try {
  const interaction = await within(planOffer.promise, 'Plan presentation');
  assert.equal(interaction.request.kind, 'plan_review');
  if (interaction.request.kind !== 'plan_review') throw new Error('Expected the saved review.');
  const request = interaction.request;
  assert.deepEqual(interaction.deadline, { kind: 'no_deadline' });
  const choice = request.choices.find((offered) => offered.action === 'abandon');
  assert.ok(choice);
  abandon.transcript.push(`host.selected:plan_review:abandon:${choice.choiceId}`);
  const receipt = await within(interaction.respond({ kind: 'plan_review', action: 'abandon',
    choiceId: choice.choiceId, planId: request.plan.planId, revision: request.plan.revision }), 'Abandon response');
  abandonReceipt = receipt.status;
  assert.equal(receipt.status, 'delivered');
  assert.deepEqual(await interaction.terminal, { kind: 'answered', response: {
    kind: 'plan_review', action: 'abandon', choiceId: choice.choiceId,
    planId: request.plan.planId, revision: request.plan.revision,
  } });
} finally {
  await within(Promise.resolve(planSession.close({ reason: 'shutdown', signal: AbortSignal.timeout(2_000) })), 'Abandon cleanup', 3_000);
}

// Refusal is distinct from an entered answer. Exact support and both host ports are required.
const refusals = [];
for (const name of ['unsupported', 'missing-interactions', 'missing-continuation-handler'] as const) {
  const fixture = sessionContinuationProvider('form', name !== 'unsupported');
  let presentations = 0;
  let executions = 0;
  await assert.rejects(async () => fixture.adapter.createSession({ ...input(name),
    ...(name === 'missing-interactions' ? {} : { interactions: { humanWait, limits,
      onRequest() { presentations += 1; } } }),
    ...(name === 'missing-continuation-handler' ? {} : { nativeContinuations: { onExecution() { executions += 1; } } }),
  }), (cause: unknown) => cause instanceof AgentProviderContractError && cause.code === 'native_continuations_unsupported');
  assert.equal(fixture.statistics.openingEntries, name === 'missing-continuation-handler' ? 1 : 0);
  assert.deepEqual([fixture.statistics.nativeAnswerEntries, fixture.statistics.workStarts, presentations, executions], [0, 0, 0, 0]);
  refusals.push({ name, code: 'native_continuations_unsupported', presentations, executions, ...fixture.statistics });
}
assert.equal(parkedBeforeDispatch, true);
assert.ok(form.transcript.indexOf('reader.parked') < form.transcript.indexOf('dispatched:form:submit'));
assert.equal(form.statistics.outputReaders, 1);
assert.equal(hostCallbackJoins, 1);
assert.equal(requestCallbackJoins, 2);
assert.equal(unexpectedContinuations, 0);
assert.deepEqual(outcomes, ['started']);
console.log(JSON.stringify({ example: 'session-continuations', evidence: 'synthetic', humanWait: humanWait.kind,
  deadlines: [formDeadline, { kind: 'no_deadline' }], responseTimeoutMs: limits.responseTimeoutMs,
  cleanupTimeoutMs: limits.cleanupTimeoutMs, parkedBeforeDispatch, receipts: [formReceipt, abandonReceipt], outcomes,
  starts: form.statistics.starts + abandon.statistics.starts, continuations: hostCallbackJoins,
  outputReaders: form.statistics.outputReaders, nativeAnswerEntries: form.statistics.nativeAnswerEntries + abandon.statistics.nativeAnswerEntries,
  workStarts: form.statistics.workStarts + abandon.statistics.workStarts, noWorkActions: abandon.statistics.noWorkActions,
  callbacksJoined: requestCallbackJoins === 2 && hostCallbackJoins === 1
    && form.statistics.callbackJoins === 1 && abandon.statistics.callbackJoins === 1,
  producersJoined: form.statistics.producerJoins === 1 && abandon.statistics.outputReaders === 0,
  closes: form.statistics.closes + abandon.statistics.closes, refusals, output,
  transcript: form.transcript, abandonmentTranscript: abandon.transcript, cleanup: 'joined' }));
