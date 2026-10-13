import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey,
  parseAgentSessionBinding, parseAgentSessionId, parseAgentTurnId,
  type AgentElicitationAnswer, type AgentElicitationRequest,
} from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpHostFacilities, type AcpProviderLimits } from '../src/index.js';
import { collectRemaining, takeUntilRequest, createSessionPeer, type SessionPeer } from './fixtures/session-peer.js';

import { collect, events } from './fixtures/session-runtime.js';

const providerKey = parseAgentProviderKey('advanced-fixture');
const instanceId = parseAgentInstanceId('advanced:instance');
const configuration = { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('advanced:configuration') };
const turn = (id = 'advanced:turn') => ({ turnId: parseAgentTurnId(id), interactionMode: 'default' as const, parts: [{ type: 'text' as const, text: 'Continue' }] });
function request(outputs: readonly AgentProviderOutput[]): AgentElicitationRequest {
  const event = events(outputs).find((event) => event.type === 'request.opened');
  assert.ok(event?.type === 'request.opened' && event.payload.request.requestKind === 'elicitation');
  return event.payload.request;
}
function answered(form: AgentElicitationRequest, answers: readonly AgentElicitationAnswer[]) {
  return { requestKind: 'elicitation' as const, requestId: form.requestId, disposition: 'answered' as const, answers };
}
function intent(form: AgentElicitationRequest, value: 'provide_answers' | 'decline') {
  const field = form.fields[0]!;
  assert.equal(field.kind, 'single_select');
  if (field.kind !== 'single_select') throw new Error('Expected form intent selection.');
  return answered(form, [{ fieldId: field.fieldId, kind: 'single_select', value: field.options[value === 'decline' ? 1 : 0]!.value }]);
}
function formFrame(peer: SessionPeer, schema: AcpJsonObject, id: string | number = 'form:1', scope: AcpJsonObject = { sessionId: peer.sessionId }) {
  return { jsonrpc: '2.0', id, method: 'elicitation/create', params: { mode: 'form', message: 'Choose the requested information.', requestedSchema: schema, ...scope } };
}
async function instance(peer: SessionPeer, limits?: Partial<AcpProviderLimits>, host?: AcpHostFacilities) {
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease, limits, host });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: {} }] });
  return { registry, materialized: registry.requireInstance(instanceId) };
}
async function open(peer: SessionPeer, limits?: Partial<AcpProviderLimits>, host?: AcpHostFacilities) {
  const result = await instance(peer, limits, host);
  const session = await result.materialized.adapter.createSession({ sessionId: parseAgentSessionId('advanced:session'), workingDirectory: '/fixture', configuration, onBindingCreated() {} });
  return { ...result, session };
}

test('session forms preserve one native waiter through intent and typed answers, ordered with a concurrent permission', { timeout: 3_000 }, async (t) => {
  const schema: AcpJsonObject = { type: 'object', title: 'Project preferences', properties: {
    note: { type: 'string', title: 'Notes', enum: ['', ' ', '😀😀'] },
    choice: { type: 'string', oneOf: [{ const: ' raw value ', title: 'First choice', description: 'Native value remains exact' }, { const: 'other', title: 'Other' }] },
    tags: { type: 'array', items: { type: 'string', enum: ['', ' ', '😀😀'] }, minItems: 1, maxItems: 3 },
    enabled: { type: 'boolean' },
  }, required: ['note', 'choice', 'tags', 'enabled'] };
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.batch([peer.permission('permission:1', 'tool'),
      peer.update({ sessionUpdate: 'tool_call', toolCallId: 'form-tool', title: 'Collect preferences', status: 'in_progress' }),
      formFrame(peer, schema, 3, { sessionId: peer.sessionId, toolCallId: 'form-tool' })]);
  }, onResolution(peer, frame) { if (frame.id === 3) peer.complete(); } });
  let hostCalls = 0;
  const { registry, session } = await open(peer, undefined, { form: () => { hostCalls++; return { action: 'decline' }; } });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turn());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const firstOutputs = await takeUntilRequest(iterator);
  const first = events(firstOutputs).find((event) => event.type === 'request.opened');
  assert.ok(first?.type === 'request.opened' && first.payload.request.requestKind === 'approval');
  const approval = first.payload.request;
  assert.deepEqual(await execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: approval.requestId, disposition: 'selected', optionId: approval.options[0]!.optionId } }), { status: 'delivered' });
  const intentOutputs = await takeUntilRequest(iterator);
  const offered = request(intentOutputs);
  assert.equal(peer.frames.filter((frame) => !frame.method && frame.id === 3).length, 0);
  assert.deepEqual(await execution.resolveRequest({ resolution: intent(offered, 'provide_answers') }), { status: 'delivered' });
  // The intent receipt settles before the next output pull or fields answer.
  const fieldOutputs = await takeUntilRequest(iterator);
  const fields = request(fieldOutputs);
  assert.notEqual(offered.requestId, fields.requestId);
  assert.equal(peer.frames.filter((frame) => !frame.method && frame.id === 3).length, 0);
  await assert.rejects(execution.resolveRequest({ resolution: intent(offered, 'provide_answers') }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'request_resolution_mismatch');
  const single = fields.fields[1]!;
  const multi = fields.fields[2]!;
  const note = fields.fields[0]!;
  assert.ok(note.kind === 'single_select' && single.kind === 'single_select' && multi.kind === 'multi_select');
  assert.deepEqual(note.options.map((option) => option.label), ['""', '" "', '😀😀']);
  assert.deepEqual(await execution.resolveRequest({ resolution: answered(fields, [
    { fieldId: fields.fields[0]!.fieldId, kind: 'single_select', value: note.options[0]!.value },
    { fieldId: fields.fields[1]!.fieldId, kind: 'single_select', value: single.options[0]!.value },
    { fieldId: fields.fields[2]!.fieldId, kind: 'multi_select', values: multi.options.map((option) => option.value) },
    { fieldId: fields.fields[3]!.fieldId, kind: 'boolean', value: false },
  ]) }), { status: 'delivered' });
  const finished = await collectRemaining(iterator);
  const combined = events([...firstOutputs, ...intentOutputs, ...fieldOutputs, ...finished]);
  assert.deepEqual(combined.flatMap((event) => event.type === 'request.opened'
    ? [[event.payload.request.requestKind, event.payload.request.requestId]] : []), [
    ['approval', approval.requestId], ['elicitation', offered.requestId], ['elicitation', fields.requestId],
  ]);
  assert.deepEqual(combined.flatMap((event) => event.type === 'turn.state_changed'
    ? [event.payload.state === 'waiting_for_request' ? event.payload.requestId : event.payload.state] : []), [
    approval.requestId, 'running', offered.requestId, 'running', fields.requestId, 'running',
  ]);
  assert.equal(combined.filter((event) => event.type === 'turn.started').length, 1);
  assert.deepEqual(combined.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => ({ id: frame.id, result: frame.result })), [
    { id: 'permission:1', result: { outcome: { outcome: 'selected', optionId: 'permission:1:allow' } } },
    { id: 3, result: { action: 'accept', content: { note: '', choice: ' raw value ', tags: ['', ' ', '😀😀'], enabled: false } } },
  ]);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(hostCalls, 0);
});

for (const action of ['decline', 'cancel_intent', 'cancel_fields', 'accept_empty'] as const) {
  test(`form ${action} produces its exact native action without replaying the prompt`, { timeout: 3_000 }, async (t) => {
    const schema: AcpJsonObject = action === 'accept_empty' ? { type: 'object', properties: {} } : { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] };
    const peer = createSessionPeer({ onPrompt(peer) { peer.send(formFrame(peer, schema)); }, onResolution(peer) { peer.complete(); } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turn());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    let form = request(await takeUntilRequest(iterator));
    if (action === 'decline' || action === 'accept_empty') assert.deepEqual(await execution.resolveRequest({ resolution: intent(form, action === 'decline' ? 'decline' : 'provide_answers') }), { status: 'delivered' });
    else {
      if (action === 'cancel_fields') {
        assert.deepEqual(await execution.resolveRequest({ resolution: intent(form, 'provide_answers') }), { status: 'delivered' });
        form = request(await takeUntilRequest(iterator));
      }
      assert.deepEqual(await execution.resolveRequest({ resolution: { requestKind: 'elicitation', requestId: form.requestId, disposition: 'canceled' } }), { status: 'delivered' });
    }
    const outputs = await collectRemaining(iterator);
    assert.equal(events(outputs).filter((event) => event.type === 'turn.completed').length, 1);
    assert.deepEqual(peer.frames.find((frame) => !frame.method)?.result,
      action === 'decline' ? { action: 'decline' } : action === 'accept_empty' ? { action: 'accept', content: {} } : { action: 'cancel' });
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

const unsupportedFields: Readonly<Record<string, AcpJsonObject>> = {
  numeric: { type: 'number', minimum: 0 },
  free_text: { type: 'string', maxLength: 2 },
  minimum_length: { type: 'string', minLength: 2 },
  pattern: { type: 'string', pattern: '^safe$' },
  format: { type: 'string', format: 'email' },
  default: { type: 'boolean', default: true },
  minimum_selections: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 2 },
  unknown_constraint: { type: 'string', additionalConstraint: true },
};
for (const [constraint, field] of Object.entries(unsupportedFields)) {
  test(`unsupported form ${constraint} rejects the complete schema before any canonical request is opened`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ onPrompt(peer) { peer.send(formFrame(peer, { type: 'object', properties: { supported: { type: 'boolean' }, unsupported: field } })); },
      onResolution(peer, frame) { assert.equal(frame.error?.code, -32602); peer.complete(); } });
    let hostCalls = 0;
    const invalidNativeConstraint = ['pattern', 'format', 'unknown_constraint'].includes(constraint);
    const { registry, session } = await open(peer, undefined, invalidNativeConstraint ? { form: () => { hostCalls++; return { action: 'decline' }; } } : undefined);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const outputs = events(await collect(session.startTurn(turn()).outputs));
    assert.equal(outputs.some((event) => event.type === 'request.opened'), false);
    assert.equal(outputs.at(-1)?.type, 'turn.completed');
    assert.equal(peer.frames.filter((frame) => !frame.method).length, 1);
    assert.equal(hostCalls, 0);
  });
}

test('explicit session host forms preserve native empty, whitespace, codepoint and numeric answers under exact prompt authority', { timeout: 3_000 }, async (t) => {
  const values = ['', ' ', '😀😀'];
  const schema: AcpJsonObject = { type: 'object', properties: {
    text: { type: 'string', maxLength: 2 }, count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
  }, required: ['text', 'count'] };
  let prompt = 0;
  let callbacks = 0;
  const peer = createSessionPeer({ onSetup(peer, frame) { peer.batch([
    { jsonrpc: '2.0', id: frame.id, result: { sessionId: peer.sessionId } }, formFrame(peer, schema, 'idle-form'),
  ]); }, onPrompt(peer) { peer.send(formFrame(peer, schema, `native-form:${prompt++}`)); }, onResolution(peer, frame) {
    if (frame.id === 'idle-form') assert.equal(frame.error?.code, -32600);
    else peer.complete();
  } });
  const { registry, session } = await open(peer, undefined, { form(input) {
    assert.deepEqual(input.scope, { kind: 'session', sessionId: parseAgentSessionId('advanced:session'), workingDirectory: '/fixture' });
    assert.deepEqual(input.requestedSchema, schema);
    assert.equal(input.signal.aborted, false);
    return { action: 'accept', content: { text: values[callbacks++]!, count: 2 } };
  } });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  for (const [index, value] of values.entries()) {
    const outputs = events(await collect(session.startTurn(turn(`native-ui:${index}`)).outputs));
    assert.equal(outputs.some((event) => event.type === 'request.opened'), false);
    assert.equal(outputs.at(-1)?.type, 'turn.completed');
    assert.deepEqual(peer.frames.find((frame) => frame.id === `native-form:${index}`)?.result, { action: 'accept', content: { text: value, count: 2 } });
  }
  assert.equal(callbacks, values.length);
  assert.equal(peer.frames.filter((frame) => frame.id === 'idle-form').length, 1);
});

test('unknown tool-associated host forms reject without invoking host authority or fabricating a canonical request', { timeout: 3_000 }, async (t) => {
  let callbacks = 0;
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(formFrame(peer, { type: 'object', properties: { value: { type: 'number' } } }, 'unknown-tool-form',
    { sessionId: peer.sessionId, toolCallId: 'never-observed' })); }, onResolution(peer, frame) { assert.equal(frame.error?.code, -32602); peer.complete(); } });
  const { registry, session } = await open(peer, undefined, { form() { callbacks++; return { action: 'decline' }; } });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const output = events(await collect(session.startTurn(turn()).outputs));
  assert.equal(output.some((event) => event.type === 'request.opened'), false);
  assert.equal(output.at(-1)?.type, 'turn.completed');
  assert.equal(callbacks, 0);
});

for (const mode of ['form', 'url'] as const) {
  test(`canceling a prompt aborts its explicit host ${mode} interaction and releases its native waiter`, { timeout: 3_000 }, async (t) => {
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolve) => { interactionStarted = resolve; });
    let reverseAnswered!: () => void;
    const answered = new Promise<void>((resolve) => { reverseAnswered = resolve; });
    let interactionSignal: AbortSignal | undefined;
    let releases = 0;
    const peer = createSessionPeer({ onPrompt(peer) { peer.send(mode === 'form'
      ? formFrame(peer, { type: 'object', properties: { value: { type: 'string' } } })
      : { jsonrpc: '2.0', id: 'host-url', method: 'elicitation/create', params: { mode: 'url', sessionId: peer.sessionId,
        message: 'Open the authorized page.', elicitationId: 'prompt-url', url: 'https://example.com/interaction' } });
    }, onResolution(peer, frame) { assert.deepEqual(frame.result, { action: 'cancel' }); reverseAnswered(); } });
    const host: AcpHostFacilities = mode === 'form' ? { form(input) {
      interactionSignal = input.signal;
      interactionStarted();
      return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    } } : { url(input) {
      interactionSignal = input.signal;
      interactionStarted();
      return { decision: new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })), release() { releases++; } };
    } };
    const { registry, session } = await open(peer, undefined, host);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const stream = collect(session.startTurn(turn()).outputs);
    await started;
    assert.equal(session.interruption.kind, 'supported');
    if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
    const stopped = await session.interruption.interruptTurn({ turnId: turn().turnId, reason: 'user_requested' });
    const output = await stream;
    await answered;
    assert.equal(stopped.status, 'canceled');
    assert.equal(events(stopped.outputs ?? []).filter((event) => event.type === 'turn.completed').length, 0);
    assert.equal(events(output).filter((event) => event.type === 'turn.completed').length, 1);
    assert.equal(events(output).some((event) => event.type === 'request.opened'), false);
    assert.equal(interactionSignal?.aborted, true);
    assert.equal(releases, mode === 'url' ? 1 : 0);
  });
}

test('closing a direct provider session aborts its host UI, releases the active stream and tolerates callback reentry', { timeout: 3_000 }, async (t) => {
  let started!: () => void;
  const interaction = new Promise<void>((resolve) => { started = resolve; });
  let reentered: Promise<void> | undefined;
  let releases = 0;
  const peer = createSessionPeer({ owned: true, onRelease() { releases++; }, onPrompt(peer) {
    peer.send(formFrame(peer, { type: 'object', properties: { value: { type: 'string' } } }));
  } });
  const materialized = await createAcpProviderDriver({ providerKey, createConnection: () => peer.lease, host: { form(input) {
    started();
    return new Promise((_, reject) => input.signal.addEventListener('abort', () => {
      reentered = Promise.resolve(session.close({ reason: 'shutdown' }));
      reject(input.signal.reason);
    }, { once: true }));
  } } }).materialize({ providerKey, instanceId, driverConfiguration: {} });
  t.after(async () => { await materialized.dispose(); peer.dispose(); });
  const session = await materialized.adapter.createSession({ sessionId: parseAgentSessionId('close:session'), workingDirectory: '/fixture', configuration, onBindingCreated() {} });
  const stream = collect(session.startTurn(turn()).outputs);
  const failed = assert.rejects(stream, (error: unknown) => error instanceof Error && 'reasonCode' in error && error.reasonCode === 'acp_session_closed');
  await interaction;
  await session.close({ reason: 'shutdown' });
  assert.ok(reentered);
  await reentered;
  await failed;
  assert.equal(releases, 1);
  assert.equal(peer.stdout.destroyed, true);
});

test('optional fields remain omitted and invalid blank choices fail before consuming the canonical pending request', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(formFrame(peer, { type: 'object', properties: { choice: { type: 'string', enum: ['first', 'second'] } } })); },
    onResolution(peer) { peer.complete(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turn());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = request(await takeUntilRequest(iterator));
  assert.deepEqual(await execution.resolveRequest({ resolution: intent(first, 'provide_answers') }), { status: 'delivered' });
  const fields = request(await takeUntilRequest(iterator));
  await assert.rejects(execution.resolveRequest({ resolution: answered(fields, [{ fieldId: fields.fields[0]!.fieldId, kind: 'single_select' }]) }));
  assert.equal(peer.frames.filter((frame) => !frame.method).length, 0);
  assert.deepEqual(await execution.resolveRequest({ resolution: answered(fields, []) }), { status: 'delivered' });
  await collectRemaining(iterator);
  assert.deepEqual(peer.frames.find((frame) => !frame.method)?.result, { action: 'accept', content: {} });
});

test('a required native array allowing an empty answer is rejected before canonical constraints can strengthen it', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(formFrame(peer, { type: 'object', properties: { values: { type: 'array', items: { type: 'string', enum: ['a'] } } }, required: ['values'] })); },
    onResolution(peer, frame) { assert.equal(frame.error?.code, -32602); peer.complete(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const output = events(await collect(session.startTurn(turn()).outputs));
  assert.equal(output.some((event) => event.type === 'request.opened'), false);
  assert.equal(output.at(-1)?.type, 'turn.completed');
});

test('interruption cancels the form waiter at its second canonical stage and drains concurrent permissions', { timeout: 3_000 }, async (t) => {
  let canceled = 0;
  let onCanceled!: () => void;
  const canceledReplies = new Promise<void>((resolve) => { onCanceled = resolve; });
  const peer = createSessionPeer({ onPrompt(peer) { peer.batch([
    formFrame(peer, { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] }), peer.permission('later-permission', 'later-tool'),
  ]); }, onResolution() { if (++canceled === 2) onCanceled(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turn());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = request(await takeUntilRequest(iterator));
  assert.deepEqual(await execution.resolveRequest({ resolution: intent(first, 'provide_answers') }), { status: 'delivered' });
  const second = request(await takeUntilRequest(iterator));
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(session.interruption.kind, 'supported');
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  const stopped = await session.interruption.interruptTurn({ turnId: turn().turnId, reason: 'user_requested' });
  const output = await collectRemaining(iterator);
  await canceledReplies;
  assert.equal(stopped.status, 'canceled');
  assert.equal(events(stopped.outputs ?? []).filter((event) => event.type === 'turn.completed').length, 0);
  assert.equal(events(output).filter((event) => event.type === 'turn.completed').length, 1);
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => frame.result), [{ action: 'cancel' }, { outcome: { outcome: 'cancelled' } }]);
});

test('replacement plans and tool diffs map structured observations without quota, compaction or final Review authority', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) { peer.batch([
    peer.update({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 12, currency: 'USD' } }),
    peer.update({ sessionUpdate: 'plan', entries: [{ content: 'First', priority: 'high', status: 'in_progress' }, { content: 'Second', priority: 'low', status: 'pending' }] }),
    peer.update({ sessionUpdate: 'usage_update', used: 40, size: 1000 }),
    peer.update({ sessionUpdate: 'plan', entries: [{ content: 'Second', priority: 'medium', status: 'completed' }] }),
    peer.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit files', status: 'in_progress', content: [
      { type: 'diff', path: '/fixture/new.txt', oldText: null, newText: 'new content' },
      { type: 'diff', path: '/fixture/empty.txt', oldText: 'previous', newText: '' },
    ] }),
    peer.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' }),
  ]); peer.complete(); } });
  const { registry, session, materialized } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const observed = events(await collect(session.startTurn(turn()).outputs));
  const plans = observed.filter((event) => event.type === 'turn.plan.updated');
  assert.deepEqual(plans.map((event) => event.payload.steps.map((step) => [step.text, step.status, step.priority])), [
    [['First', 'in_progress', 'high'], ['Second', 'pending', 'low']], [['Second', 'completed', 'medium']],
  ]);
  assert.notEqual(plans[0]!.payload.steps[0]!.stepId, plans[1]!.payload.steps[0]!.stepId);
  const file = observed.find((event) => event.type === 'item.completed' && event.payload.itemKind === 'file_change');
  assert.ok(file?.type === 'item.completed' && file.payload.itemKind === 'file_change');
  assert.deepEqual(file.payload.details?.changes, [{ path: 'empty.txt', changeKind: 'modified' }, { path: 'new.txt', changeKind: 'created' }]);
  assert.equal(observed.filter((event) => event.type === 'item.started' && event.payload.itemKind === 'file_change').length, 1);
  assert.ok(observed.some((event) => event.type === 'content.delta' && event.payload.streamKind === 'file_change_output' && event.payload.delta.includes('new content')));
  assert.equal(observed.some((event) => ['context.usage.updated', 'artifact.referenced', 'turn.diff.updated', 'turn.plan.proposed'].includes(event.type)), false);
  assert.equal(observed.some((event) => event.type === 'item.started' && ['review', 'context_compaction'].includes(event.payload.itemKind)), false);
  assert.equal(materialized.accountQuota.kind, 'unsupported');
  assert.equal(observed.at(-1)?.type, 'turn.completed');
});

test('a prompt ending before native tool completion reports unknown tool and file status without fabricated success', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(peer.update({ sessionUpdate: 'tool_call', toolCallId: 'pending', title: 'Proposed edit', status: 'pending',
    content: [{ type: 'diff', path: '/fixture/proposed.txt', oldText: null, newText: 'proposal' }] })); peer.complete(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const observed = events(await collect(session.startTurn(turn()).outputs));
  for (const kind of ['dynamic_tool_call', 'file_change']) {
    assert.ok(observed.some((event) => event.type === 'item.updated' && event.payload.itemKind === kind && event.payload.status === 'unknown'));
    assert.equal(observed.some((event) => event.type === 'item.completed' && event.payload.itemKind === kind), false);
  }
  assert.equal(observed.at(-1)?.type, 'turn.completed');
});

test('base64 image prompts preserve exact bytes, MIME and order, while URL and local images reject before dispatch', { timeout: 3_000 }, async (t) => {
  const image = { type: 'base64' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE8sAAAAASUVORK5CYII=',
    mediaType: 'image/png' as const, byteSize: 68, widthPixels: 1, heightPixels: 1 };
  const peer = createSessionPeer({ agentCapabilities: { promptCapabilities: { image: true } }, onPrompt(peer) { peer.complete(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  await collect(session.startTurn({ ...turn(), parts: [{ type: 'text', text: 'Before' }, { type: 'image', source: image }, { type: 'text', text: 'After' }] }).outputs);
  assert.deepEqual(peer.frames.find((frame) => frame.method === 'session/prompt')?.params?.prompt,
    [{ type: 'text', text: 'Before' }, { type: 'image', data: image.data, mimeType: 'image/png' }, { type: 'text', text: 'After' }]);
  await collect(session.startTurn({ ...turn('image-only'), parts: [{ type: 'image', source: image }] }).outputs);
  const metadata = { mediaType: image.mediaType, byteSize: image.byteSize, widthPixels: 1, heightPixels: 1 };
  for (const source of [{ ...metadata, type: 'url' as const, url: 'https://example.com/picture.png' },
    { ...metadata, type: 'local_file' as const, path: '/fixture/picture.png', sha256: 'a'.repeat(64) }]) {
    let delegated = false;
    await assert.rejects(async () => collect(session.startTurn({ ...turn(`unsupported:${source.type}`), parts: [{ type: 'image', source }], onProviderExecutionStarted: () => { delegated = true; } }).outputs));
    assert.equal(delegated, false);
  }
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 2);
});

for (const method of ['session/resume', 'session/load'] as const) {
  test(`${method} restores the exact binding and suppresses bounded historical replay before live output`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ agentCapabilities: method === 'session/resume' ? { loadSession: true, sessionCapabilities: { resume: {} } } : { loadSession: true },
      onSetup(peer, frame) {
        if (method === 'session/load') peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HISTORICAL' } }));
        peer.send({ jsonrpc: '2.0', id: frame.id, result: {} });
      }, onPrompt(peer) { peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE' } })); peer.complete(); } });
    const { registry, materialized } = await instance(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    assert.equal(materialized.adapter.resumption.kind, 'supported');
    if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected resume support.');
    const binding = parseAgentSessionBinding({ conversationId: peer.sessionId });
    const session = await materialized.adapter.resumption.resumeSession({ sessionId: parseAgentSessionId('resumed:session'), workingDirectory: '/fixture', configuration, binding });
    assert.deepEqual(session.binding, binding);
    const output = events(await collect(session.startTurn(turn()).outputs));
    assert.equal(output.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'LIVE');
    assert.equal(peer.frames.filter((frame) => frame.method === method).length, 1);
    assert.equal(peer.frames.some((frame) => frame.method === 'session/new'), false);
  });
}

for (const failure of ['wrong_session', 'late_replay', 'message_budget', 'byte_budget', 'timeout'] as const) {
  test(`load replay ${failure} refuses rematerialization without emitting or replaying a prompt`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ agentCapabilities: { loadSession: true }, onSetup(peer, frame) {
      const historical = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: failure === 'byte_budget' ? 'x'.repeat(50_000) : 'HISTORY' } };
      if (failure === 'wrong_session') peer.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'different', update: historical } });
      else if (failure === 'late_replay') peer.batch([{ jsonrpc: '2.0', id: frame.id, result: {} }, peer.update(historical)]);
      else if (failure === 'message_budget' || failure === 'byte_budget') peer.batch(Array.from({ length: failure === 'byte_budget' ? 3 : 5 }, () => peer.update(historical)));
    } });
    const limits = failure === 'message_budget' ? { maxQueuedMessages: 4, maxPendingRequests: 1 }
      : failure === 'byte_budget' ? { maxQueuedBytes: 128 * 1_024 } : failure === 'timeout' ? { initializationTimeoutMs: 20 } : undefined;
    const { registry, materialized } = await instance(peer, limits);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected load support.');
    await assert.rejects(async () => {
      if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected resume support.');
      await materialized.adapter.resumption.resumeSession({ sessionId: parseAgentSessionId(`load:${failure}`), workingDirectory: '/fixture', configuration,
      binding: parseAgentSessionBinding({ conversationId: peer.sessionId }) });
    });
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/load').length, 1);
    assert.equal(peer.frames.some((frame) => frame.method === 'session/new' || frame.method === 'session/prompt'), false);
  });
}

for (const kind of ['permission', 'form'] as const) {
  test(`load replay rejects reverse ${kind} before resuming its exact live session`, { timeout: 3_000 }, async (t) => {
    let loadId: string | number | undefined;
    const peer = createSessionPeer({ agentCapabilities: { loadSession: true }, onSetup(peer, frame) {
      loadId = frame.id;
      peer.send(kind === 'permission' ? peer.permission('replay-question', 'historical-tool')
        : formFrame(peer, { type: 'object', properties: { value: { type: 'boolean' } } }, 'replay-question'));
    }, onResolution(peer, frame) {
      assert.equal(frame.error?.code, -32600);
      peer.send({ jsonrpc: '2.0', id: loadId, result: {} });
    }, onPrompt(peer) { peer.complete(); } });
    const { registry, materialized } = await instance(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected load support.');
    const session = await materialized.adapter.resumption.resumeSession({ sessionId: parseAgentSessionId(`replay:${kind}`), workingDirectory: '/fixture', configuration,
      binding: parseAgentSessionBinding({ conversationId: peer.sessionId }) });
    const output = events(await collect(session.startTurn(turn()).outputs));
    assert.equal(output.some((event) => event.type === 'request.opened'), false);
    assert.equal(output.at(-1)?.type, 'turn.completed');
  });
}

test('resume rejects an unqualified history anchor before session mutation', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ agentCapabilities: { sessionCapabilities: { resume: {} } } });
  const { registry, materialized } = await instance(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected resume support.');
  await assert.rejects(async () => {
      if (materialized.adapter.resumption.kind !== 'supported') throw new Error('Expected resume support.');
      await materialized.adapter.resumption.resumeSession({ sessionId: parseAgentSessionId('anchor:session'), workingDirectory: '/fixture', configuration,
    binding: parseAgentSessionBinding({ conversationId: peer.sessionId, historyAnchor: 'unqualified:anchor' }) });
  });
  assert.equal(peer.frames.some((frame) => frame.method?.startsWith('session/')), false);
});

for (const method of ['session/new', 'session/load'] as const) {
  test(`request-scoped form during ${method} receives exact session authority and expires before the next wire frame`, { timeout: 3_000 }, async (t) => {
    let setupId: string | number | undefined;
    let interactions = 0;
    const peer = createSessionPeer({ agentCapabilities: method === 'session/load' ? { loadSession: true } : {}, onSetup(peer, frame) {
      setupId = frame.id;
      peer.send(formFrame(peer, { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['count'] }, 'setup-form', { requestId: setupId! }));
    }, onResolution(peer, frame) {
      if (frame.id === 'setup-form') {
        assert.deepEqual(frame.result, { action: 'accept', content: { count: 2 } });
        peer.batch([{ jsonrpc: '2.0', id: setupId, result: method === 'session/new' ? { sessionId: peer.sessionId } : {} },
          formFrame(peer, { type: 'object', properties: {} }, 'late-form', { requestId: setupId! })]);
      } else { assert.equal(frame.id, 'late-form'); assert.equal(frame.error?.code, -32602); }
    }, onPrompt(peer) { peer.complete(); } });
    const sessionId = parseAgentSessionId(`scope:${method}`);
    const { registry, materialized } = await instance(peer, undefined, { form(input) {
      interactions += 1;
      assert.deepEqual(input.scope, { kind: 'session', sessionId, workingDirectory: '/fixture' });
      assert.equal(input.signal.aborted, false);
      return { action: 'accept', content: { count: 2 } };
    } });
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const session = method === 'session/new' ? await materialized.adapter.createSession({ sessionId, workingDirectory: '/fixture', configuration, onBindingCreated() {} })
      : materialized.adapter.resumption.kind === 'supported' ? await materialized.adapter.resumption.resumeSession({ sessionId, workingDirectory: '/fixture', configuration,
        binding: parseAgentSessionBinding({ conversationId: peer.sessionId }) }) : undefined;
    assert.ok(session);
    await collect(session.startTurn(turn()).outputs);
    assert.equal(interactions, 1);
    assert.equal(peer.frames.filter((frame) => frame.id === 'late-form').length, 1);
  });
}

for (const container of ['message_image', 'tool_image', 'tool_terminal'] as const) {
  test(`${container} refuses unsupported output without synthesizing an artifact or successful turn`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ onPrompt(peer) {
      peer.send(peer.update(container === 'message_image'
        ? { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }
        : { sessionUpdate: 'tool_call', toolCallId: 'media-tool', title: 'Media output', status: 'in_progress', content: [container === 'tool_image'
          ? { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }
          : { type: 'terminal', terminalId: 'unqualified-terminal' }] }));
      peer.complete();
    } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const outputs: AgentProviderOutput[] = [];
    await assert.rejects((async () => { for await (const output of session.startTurn(turn()).outputs) outputs.push(output); })(),
      (error: unknown) => error instanceof Error && 'reasonCode' in error && error.reasonCode === 'acp_output_content_unsupported');
    assert.equal(events(outputs).some((event) => event.type === 'artifact.referenced' || event.type === 'turn.completed'), false);
  });
}
