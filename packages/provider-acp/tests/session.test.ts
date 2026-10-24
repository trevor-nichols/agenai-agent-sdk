import assert from 'node:assert/strict';
import test from 'node:test';
import { type AgentProviderTurnInterruptionResult, type AgentProviderOutput, type AgentRequestResolutionResult } from '@agen-ai/agent-runtime';
import { collectRemaining, takeUntilRequest, createSessionPeer } from './fixtures/session-peer.js';

import { collect, events, open, selection, turnInput } from './fixtures/session-runtime.js';

const requestFrom = (outputs: readonly AgentProviderOutput[]) => {
  const opened = events(outputs).find((event) => event.type === 'request.opened');
  assert.ok(opened?.type === 'request.opened');
  return opened.payload.request;
};
const hasReason = (reason: string) => (error: unknown): boolean => error instanceof Error && 'reasonCode' in error && error.reasonCode === reason;

function signal<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('concurrent native permissions retain one prompt, FIFO requests and unrelated output while awaiting an answer', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({
    onPrompt(peer) {
      peer.batch([
        peer.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } }),
        peer.update({ sessionUpdate: 'tool_call', toolCallId: 'first', title: 'First tool', name: 'lookup', status: 'in_progress', content: [
          { type: 'content', content: { type: 'text', text: 'Known tool output' } },
        ] }),
        peer.permission(3, 'first'),
        peer.update({ sessionUpdate: 'tool_call', toolCallId: 'second', title: 'Second tool', status: 'in_progress' }),
        peer.permission('permission:2', 'second'),
        peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Overlapping.' } }),
      ]);
    },
    onResolution(peer, frame) {
      const tool = frame.id === 3 ? 'first' : 'second';
      peer.send(peer.update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed' }));
      if (frame.id === 'permission:2') {
        peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }));
        peer.complete();
      }
    },
  });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = await takeUntilRequest(iterator);
  assert.equal(events(first).filter((event) => event.type === 'request.opened').length, 1);
  const firstRequest = requestFrom(first);
  assert.equal(firstRequest.requestKind, 'approval');
  if (firstRequest.requestKind !== 'approval') throw new Error('Expected approval.');
  assert.deepEqual(firstRequest.options.map((option) => [option.decision, option.consequence]), [
    ['approved', { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } }],
    ['denied', { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } }],
  ]);
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    first.push(next.value!);
    if (next.value?.kind === 'event' && next.value.event.type === 'content.delta' && next.value.event.payload.delta === 'Overlapping.') break;
  }
  assert.equal(events(first).filter((event) => event.type === 'request.opened').length, 1);
  assert.equal(peer.frames.filter((frame) => !frame.method).length, 0);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(firstRequest) }), { status: 'delivered' });
  const second = await takeUntilRequest(iterator);
  assert.equal(events(second).filter((event) => event.type === 'request.opened').length, 1);
  const secondRequest = requestFrom(second);
  assert.notEqual(secondRequest.requestId, firstRequest.requestId);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(secondRequest) }), { status: 'delivered' });
  const final = await collectRemaining(iterator);
  const combined = events([...first, ...second, ...final]);
  assert.equal(combined.filter((event) => event.type === 'turn.started').length, 1);
  assert.equal(combined.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal(combined.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'Thinking.Overlapping.Done.');
  for (const request of [firstRequest, secondRequest]) {
    assert.equal(request.requestKind, 'approval');
    if (request.requestKind !== 'approval' || request.subject.kind === 'plan') throw new Error('Expected tool approval.');
    const itemId = request.subject.itemId;
    assert.equal(combined.filter((event) => event.type === 'item.started' && event.payload.itemId === itemId).length, 1);
    assert.equal(combined.filter((event) => event.type === 'item.completed' && event.payload.itemId === itemId).length, 1);
  }
  if (firstRequest.subject.kind === 'plan') throw new Error('Expected tool subject.');
  const firstToolId = firstRequest.subject.itemId;
  const completedTool = combined.find((event) => event.type === 'item.completed' && event.payload.itemId === firstToolId);
  assert.equal(completedTool?.type === 'item.completed' ? completedTool.payload.summary : undefined, 'Known tool output');
  assert.equal(completedTool?.type === 'item.completed' && completedTool.payload.itemKind === 'dynamic_tool_call' ? completedTool.payload.details?.toolName : undefined, 'lookup');
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => frame.result), [
    { outcome: { outcome: 'selected', optionId: '3:allow' } },
    { outcome: { outcome: 'selected', optionId: 'permission:2:allow' } },
  ]);
});

for (const pause of ['item.started', 'request.opened', 'waiting_event'] as const) {
  test(`confirmed cancellation at ${pause} emits terminal once and does not replay queued old content into the next turn`, { timeout: 3_000 }, async (t) => {
    let prompts = 0;
    const peer = createSessionPeer({ onPrompt(peer) {
      prompts += 1;
      if (prompts === 1) peer.batch([
        peer.update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Tool', status: 'in_progress' }),
        peer.permission('pending', 'tool'),
        peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } }),
      ]);
      else { peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW' } })); peer.complete(); }
    } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
    const outputs: AgentProviderOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      outputs.push(next.value);
      if (next.value.kind !== 'event') continue;
      if (pause === 'item.started' && next.value.event.type === 'item.started') break;
      if (pause === 'request.opened' && next.value.event.type === 'request.opened') break;
      if (pause === 'waiting_event' && next.value.event.type === 'turn.state_changed') break;
    }
    assert.equal(session.interruption.kind, 'supported');
    if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
    const result = await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' });
    assert.equal(result.status, 'canceled');
    assert.equal(Object.hasOwn(result, 'outputs'), false);
    outputs.push(...await collectRemaining(iterator));
    assert.equal(events(outputs).filter((event) => event.type === 'turn.completed').length, 1);
    const following = events(await collect(session.startTurn(turnInput('turn:2')).outputs));
    assert.equal(following.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'NEW');
    assert.deepEqual(peer.frames.find((frame) => frame.id === 'pending' && !frame.method)?.result, { outcome: { outcome: 'cancelled' } });
    assert.equal(prompts, 2);
  });
}

test('a stalled consumer does not block cancellation control or native permission cancellation', { timeout: 3_000 }, async (t) => {
  const canceledReplies = signal<void>();
  const receivedReplies = new Set<string | number | undefined>();
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.batch([
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'queued text' } }),
      peer.permission('unseen', 'tool'),
      peer.permission('unseen:2', 'tool:2'),
    ]);
  }, onResolution(_peer, frame) {
    receivedReplies.add(frame.id);
    if (receivedReplies.size === 2) canceledReplies.resolve();
  } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'event');
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  const result = await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' });
  await canceledReplies.promise;
  assert.equal(result.status, 'canceled');
  const output = events(await collectRemaining(iterator));
  assert.equal(output.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal(output.find((event) => event.type === 'turn.completed')?.payload.outcome, 'canceled');
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 1);
  assert.deepEqual(peer.frames.find((frame) => frame.id === 'unseen' && !frame.method)?.result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(peer.frames.find((frame) => frame.id === 'unseen:2' && !frame.method)?.result, { outcome: { outcome: 'cancelled' } });
});

test('one expanding source retains its byte reservation until every mapped output crosses consumer backpressure', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a'.repeat(20_000) } }));
  } });
  const { registry, session } = await open(peer, { maxQueuedBytes: 128 * 1_024 });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  await iterator.next();
  const startedItem = await iterator.next();
  assert.equal(startedItem.value?.kind === 'event' ? startedItem.value.event.type : undefined, 'item.started');
  peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b'.repeat(20_000) } }));
  await assert.rejects(async () => iterator.next(), hasReason('acp_session_queue_full'));
  assert.equal(peer.stdout.listenerCount('data'), 0);
});

for (const pause of ['pending_next', 'immediate_first_next'] as const) {
  test(`interruption with ${pause} keeps terminal ownership in the original execution`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer();
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<AgentProviderOutput>>;
    if (pause === 'pending_next') { await iterator.next(); pending = iterator.next(); }
    else pending = iterator.next();
    if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
    const interrupted = session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' });
    const first = await pending;
    const result = await interrupted;
    const output = events([...(first.done ? [] : [first.value]), ...await collectRemaining(iterator)]);
    if (pause === 'immediate_first_next') assert.equal(output[0]?.type, 'turn.started');
    assert.equal(result.status, 'canceled');
    assert.equal(Object.hasOwn(result, 'outputs'), false);
    assert.equal(output.filter((event) => event.type === 'turn.completed').length, 1);
    assert.equal(output.find((event) => event.type === 'turn.completed')?.payload.outcome, 'canceled');
  });
}

test('an already received successful prompt cannot be reported as a confirmed cancellation', { timeout: 3_000 }, async (t) => {
  const received = signal<void>();
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed before interruption.' } }));
    peer.complete(); received.resolve();
  } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  const first = await iterator.next();
  await received.promise;
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  const result = await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'acp_native_turn_settled');
  assert.equal(result.error?.category, 'invalid_request');
  assert.deepEqual(result.error?.recovery, { kind: 'none' });
  const remaining: AgentProviderOutput[] = first.done ? [] : [first.value];
  for (;;) { const next = await iterator.next(); if (next.done) break; remaining.push(next.value); }
  assert.equal(events(remaining).filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'Completed before interruption.');
  assert.equal(events(remaining).find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 0);
  const following = events(await collect(session.startTurn(turnInput('turn:2')).outputs));
  assert.equal(following.find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 2);
});

for (const failure of [
  { nativeCode: -32000, category: 'authentication', code: 'authentication_required' },
  { nativeCode: -32602, category: 'invalid_request', code: 'invalid_request' },
  { nativeCode: -32603, category: 'provider', code: 'provider_internal_error' },
  { nativeCode: -32700, category: 'protocol', code: 'provider_protocol_error' },
  { nativeCode: -32600, category: 'protocol', code: 'provider_protocol_error' },
  { nativeCode: -32601, category: 'protocol', code: 'provider_protocol_error' },
  { nativeCode: -32002, category: 'unknown', code: 'provider_request_failed' },
  { nativeCode: -32800, category: 'unknown', code: 'provider_request_failed' },
  { nativeCode: -32003, category: 'unknown', code: 'provider_request_failed' },
] as const) {
  test(`generic ACP prompt error ${failure.nativeCode} uses only standard meaning and omits native diagnostics`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ onPrompt(peer, frame) {
      peer.send({ jsonrpc: '2.0', id: frame.id, error: {
        code: failure.nativeCode, message: 'native credential detail: quota exhausted',
        data: { error: 'quota_exhausted', status: 429, retryAfter: 5, account: 'private-account', diagnostic: 'x'.repeat(110_000) },
      } });
    } });
    const { registry, session } = await open(peer, { maxQueuedBytes: 128 * 1_024 });
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const outputs = events(await collect(session.startTurn(turnInput()).outputs));
    const terminals = outputs.filter((event) => event.type === 'turn.completed');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.payload.outcome, 'failed');
    assert.equal(terminals[0]?.payload.error?.category, failure.category);
    assert.equal(terminals[0]?.payload.error?.code, failure.code);
    assert.deepEqual(terminals[0]?.payload.error?.recovery, failure.category === 'authentication'
      ? { kind: 'user_action', action: 'authenticate' } : { kind: 'unknown' });
    assert.equal(terminals[0]?.payload.error?.context, undefined);
    assert.equal(JSON.stringify(outputs).includes('native credential detail'), false);
    assert.equal(JSON.stringify(outputs).includes('private-account'), false);
    assert.equal(JSON.stringify(outputs).includes('retryAfter'), false);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

test('native response metadata is discarded before reserving the terminal under consumer backpressure', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer, frame) {
    peer.send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn', _meta: { privateDiagnostic: 'x'.repeat(110_000) } } });
  } });
  const { registry, session } = await open(peer, { maxQueuedBytes: 128 * 1_024 });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.kind === 'event' ? first.value.event.type : undefined, 'turn.started');
  const next = await iterator.next();
  assert.equal(next.value?.kind === 'event' ? next.value.event.type : undefined, 'turn.completed');
  if (next.value?.kind === 'event' && next.value.event.type === 'turn.completed') {
    assert.deepEqual(next.value.event.payload, { outcome: 'completed', structuredOutput: { kind: 'not_requested' } });
  }
  assert.equal((await iterator.next()).done, true);
});

for (const settlement of ['remote_error', 'peer_exit'] as const) {
  test(`${settlement} after delivered tool and text output preserves the actual native terminal authority`, { timeout: 3_000 }, async (t) => {
    let promptId: string | number | undefined;
    const peer = createSessionPeer({ owned: true, onPrompt(peer, frame) {
      promptId = frame.id;
      peer.batch([
        peer.update({ sessionUpdate: 'tool_call', toolCallId: 'effect', title: 'Completed effect', status: 'completed' }),
        peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial output' } }),
      ]);
    } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
    const outputs: AgentProviderOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      outputs.push(next.value!);
      if (next.value?.kind === 'event' && next.value.event.type === 'content.delta') break;
    }
    assert.equal(events(outputs).some((event) => event.type === 'item.completed' && event.payload.itemKind === 'dynamic_tool_call'), true);
    if (settlement === 'remote_error') {
      peer.send({ jsonrpc: '2.0', id: promptId, error: { code: -32003, message: 'private vendor failure' } });
      for (;;) { const next = await iterator.next(); if (next.done) break; outputs.push(next.value); }
      const terminals = events(outputs).filter((event) => event.type === 'turn.completed');
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.payload.outcome, 'failed');
      assert.deepEqual(terminals[0]?.payload.error?.recovery, { kind: 'unknown' });
    } else {
      peer.stdout.end();
      await assert.rejects(async () => iterator.next());
      assert.equal(events(outputs).some((event) => event.type === 'turn.completed'), false);
      await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
      assert.equal(peer.stdout.listenerCount('data'), 0);
    }
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

for (const pending of [false, true]) {
  test(`remote rejection ${pending ? 'with a pending permission retires' : 'after permission continuation settles'} without replay or duplicate replies`, { timeout: 3_000 }, async (t) => {
    let promptId: string | number | undefined;
    const peer = createSessionPeer({ onPrompt(peer, frame) {
      promptId = frame.id;
      peer.send(peer.permission('failure:permission', 'effect'));
    }, onResolution(peer) {
      if (!pending) peer.send({ jsonrpc: '2.0', id: promptId, error: { code: -32603, message: 'private native failure' } });
    } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const waiting = await takeUntilRequest(iterator);
    assert.equal(events(waiting).some((event) => event.type === 'turn.completed'), false);
    const resolution = selection(requestFrom(waiting));
    if (pending) {
      peer.send({ jsonrpc: '2.0', id: promptId, error: { code: -32603, message: 'private native failure' } });
      await assert.rejects(async () => iterator.next());
      await assert.rejects(async () => execution.resolveRequest({ resolution }));
      await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
      const replies = peer.frames.filter((frame) => frame.id === 'failure:permission' && !frame.method);
      assert.ok(replies.length <= 1);
      for (const reply of replies) assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
      assert.equal(peer.stdout.listenerCount('data'), 0);
    } else {
      assert.deepEqual(await execution.resolveRequest({ resolution }), { status: 'delivered' });
      const continued = events(await collectRemaining(iterator));
      assert.equal(continued.filter((event) => event.type === 'turn.completed').length, 1);
      assert.equal(continued.find((event) => event.type === 'turn.completed')?.payload.outcome, 'failed');
      await assert.rejects(async () => execution.resolveRequest({ resolution }));
      assert.deepEqual(peer.frames.find((frame) => frame.id === 'failure:permission' && !frame.method)?.result, { outcome: { outcome: 'selected', optionId: 'failure:permission:allow' } });
      assert.equal(peer.frames.filter((frame) => frame.id === 'failure:permission' && !frame.method).length, 1);
    }
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

for (const cancellation of ['signal', 'deadline'] as const) {
  test(cancellation === 'signal' ? 'signal abort retires the entered handle and close quiesces its prompt' : 'deadline cancellation keeps the original prompt until its native canceled acknowledgement', { timeout: 3_000 }, async (t) => {
    const prompted = signal<void>();
    const peer = createSessionPeer({ onPrompt() { prompted.resolve(); } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const controller = new AbortController();
    const iterator = session.startTurn({ ...turnInput(), ...(cancellation === 'signal'
      ? { signal: controller.signal } : { deadlineAt: new Date(Date.now() + 100).toISOString() }) }).outputs[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (cancellation === 'signal') {
      await prompted.promise;
      controller.abort();
      await assert.rejects(iterator.next(), { name: 'AbortError' });
      await session.close({ reason: 'shutdown' });
    } else {
      const outputs = [...(first.done ? [] : [first.value]), ...await collectRemaining(iterator)];
      assert.equal(events(outputs).find((event) => event.type === 'turn.completed')?.payload.outcome, 'expired');
    }
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    if (cancellation === 'deadline') assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 1);
    else assert.equal(peer.stdout.listenerCount('data'), 0);
  });
}

for (const budget of ['count', 'bytes'] as const) {
  test(`a coalesced output burst exhausts the ${budget} budget by closing the materialization rather than accumulating unbounded output`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ onPrompt(peer) {
      peer.batch(Array.from({ length: budget === 'count' ? 20 : 1 }, () => peer.update({
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: budget === 'count' ? 'small' : 'x'.repeat(90_000) },
      })));
    } });
    const { registry, session } = await open(peer, { maxQueuedMessages: 8, maxPendingRequests: 2, maxQueuedBytes: 128 * 1_024 });
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    await assert.rejects(async () => collect(session.startTurn(turnInput()).outputs), hasReason('acp_session_queue_full'));
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(peer.stdout.listenerCount('data'), 0);
  });
}

test('an unconfirmed cancellation retires the session without terminal success or prompt replay', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ confirmCancel: false });
  const { registry, session } = await open(peer, { cancellationTimeoutMs: 20 });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  await iterator.next();
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  await assert.rejects(async () => session.interruption.kind === 'supported'
    ? session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' }) : undefined, hasReason('acp_cancel_uncertain'));
  await assert.rejects(async () => iterator.next());
  await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
});

for (const first of ['resolution', 'interruption'] as const) {
  test(`${first} wins the permission-resolution/cancellation race without answering twice or replaying the prompt`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ onPrompt(peer) { peer.send(peer.permission('racing', 'tool')); } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const waiting = await takeUntilRequest(iterator);
    const resolution = selection(requestFrom(waiting));
    if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
    const interrupt = async () => session.interruption.kind === 'supported'
      ? session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' })
      : Promise.reject(new Error('Expected interruption.'));
    let response: Promise<AgentRequestResolutionResult>;
    let interruption: Promise<AgentProviderTurnInterruptionResult>;
    if (first === 'resolution') { response = execution.resolveRequest({ resolution }); interruption = interrupt(); }
    else { interruption = interrupt(); response = execution.resolveRequest({ resolution }); }
    const [continued, interrupted] = await Promise.allSettled([response, interruption]);
    assert.equal(interrupted.status, 'fulfilled');
    assert.equal(interrupted.value.status, 'canceled');
    if (first === 'resolution') {
      assert.equal(continued.status, 'fulfilled');
      if (continued.status === 'fulfilled') assert.deepEqual(continued.value, { status: 'delivered' });
    } else {
      assert.equal(continued.status, 'rejected');
      if (continued.status === 'rejected') assert.equal(continued.reason.code, 'request_resolution_mismatch');
    }
    const delivered = await collectRemaining(iterator);
    assert.equal(events([...delivered, ...(interrupted.value.outputs ?? [])]).filter((event) => event.type === 'turn.completed').length, 1);
    const responses = peer.frames.filter((frame) => frame.id === 'racing' && !frame.method);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0]?.result, first === 'resolution'
      ? { outcome: { outcome: 'selected', optionId: 'racing:allow' } }
      : { outcome: { outcome: 'cancelled' } });
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

test('pre-aborted public turn rejects before candidate execution observation or a native prompt', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer();
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const controller = new AbortController(); controller.abort();
  let started = 0;
  await assert.rejects(async () => collect(session.startTurn({ ...turnInput(), signal: controller.signal, onProviderExecutionStarted: () => { started += 1; } }).outputs), { name: 'AbortError' });
  assert.equal(started, 0);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 0);
});

for (const failure of ['malformed', 'peer_exit', 'unconfirmed cancellation'] as const) {
  test(`${failure} after native prompt delegation retires rather than replaying an uncertain prompt`, { timeout: 3_000 }, async (t) => {
    const peer = createSessionPeer({ confirmCancel: failure !== 'unconfirmed cancellation', onPrompt(peer) {
      if (failure === 'malformed') peer.raw('{malformed\n');
      if (failure === 'peer_exit') peer.stdout.end();
    } });
    const { registry, session } = await open(peer, { cancellationTimeoutMs: 20 });
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    let started = 0;
    await assert.rejects(async () => collect(session.startTurn({ ...turnInput(),
      deadlineAt: new Date(Date.now() + 20).toISOString(), onProviderExecutionStarted: () => { started += 1; } }).outputs),
    hasReason(failure === 'unconfirmed cancellation' ? 'acp_cancel_uncertain'
      : failure === 'malformed' ? 'acp_json_invalid' : 'acp_provider_peer_closed'));
    assert.equal(started, 1);
    await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(peer.stdout.listenerCount('data'), 0);
  });
}
