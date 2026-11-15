import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentApprovalOptionId, type AgentEvent, type AgentRequest } from '@agen-ai/agent-protocol';
import { AgentProviderSessionCleanupError, type AgentProviderOutput, type AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import type { NodeProviderToolCallInput, NodeProviderToolResult } from '@agen-ai/provider-tools/node';
import { CHANNEL_CAPACITY } from '../src/node/channel.js';
import { approvalSignal, openValidatedSession, outcome, readUntil, scriptedNative, scriptedTools, startText } from './support/session.js';

const APPROVE = parseAgentApprovalOptionId('approval:approve-once');
const DENY = parseAgentApprovalOptionId('approval:deny-once');
const is = (type: AgentEvent['type']) => (event: AgentEvent) => event.type === type;

/** Reads through `turn.completed` and proves the output stream then ends. */
async function completed(outputs: AsyncIterator<AgentProviderOutput>) {
  const events = await readUntil(outputs, is('turn.completed'));
  assert.equal((await outputs.next()).done, true);
  return events;
}
const ran: NodeProviderToolResult = { tool: 'bash', status: 'completed', text: 'exit 0\nhello', isError: false, changes: [],
  command: { reason: 'exited', exitCode: 0, signal: null, durationMs: 3, outputBytes: 6, truncated: false, joined: true } };

/** The broker's command path as a driver observes it: started, one exact approval, then the effect or a denial. */
function commandTools(onEffect: () => Promise<void> = async () => {}) {
  return scriptedTools(async (call: NodeProviderToolCallInput) => {
    const command = (call.input as { command: string }).command;
    call.observer.started({ kind: 'command', command });
    const decision = await call.observer.approve({ kind: 'command', command }, approvalSignal(call));
    if (decision !== 'approved') return { tool: 'bash', status: call.signal.aborted ? 'canceled' : 'denied', text: 'Command not run.', isError: true, changes: [] };
    await onEffect();
    return ran;
  });
}

function answer(execution: AgentProviderTurnExecution, request: AgentRequest, optionId: typeof APPROVE) {
  return execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId } });
}

async function pendingCommand(native: ReturnType<typeof scriptedNative>, outputs: AsyncIterator<AgentProviderOutput>, command: string) {
  const pending = readUntil(outputs, (event) => event.type === 'turn.state_changed' && event.payload.state === 'waiting_for_request');
  await native.prompted();
  const call = native.call('bash', { command });
  const opened = (await pending).find((entry) => entry.event.type === 'request.opened');
  assert.ok(opened?.event.type === 'request.opened' && opened.output.kind === 'event');
  return { call, opened, request: opened.event.payload.request };
}

test('every command asks the host with its exact text once and returns the receipt to OpenCode', async () => {
  const native = scriptedNative();
  const tools = commandTools();
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  assert.deepEqual(session.approvalPolicy, { policy: { kind: 'provider_accept_edits' }, verification: 'controlled_configuration' });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const command = 'pwd';
  const first = await pendingCommand(native, outputs, command);
  assert.deepEqual(first.opened.output.kind === 'event' && first.opened.output.requestContext?.data, { action: { kind: 'command', command } });
  assert.deepEqual(await answer(execution, first.request, APPROVE), { status: 'delivered' });
  assert.deepEqual(await first.call.reply, { text: ran.text, isError: false });

  const second = await pendingCommand(native, outputs, command);
  assert.notEqual(second.request.requestId, first.request.requestId);
  assert.deepEqual(await answer(execution, second.request, DENY), { status: 'delivered' });
  assert.deepEqual(await second.call.reply, { text: 'Command not run.', isError: true });

  native.event({ kind: 'text', stream: 'assistant', phase: 'started', key: 'msg_2:0', text: '' });
  native.event({ kind: 'text', stream: 'assistant', phase: 'delta', key: 'msg_2:0', text: 'Done.' });
  native.event({ kind: 'text', stream: 'assistant', phase: 'ended', key: 'msg_2:0', text: 'Done.' });
  native.event({ kind: 'execution_succeeded' });
  const end = await completed(outputs);
  assert.ok(end.some((entry) => entry.event.type === 'content.delta' && entry.event.payload.delta === 'Done.'));
  assert.equal(outcome(end), 'completed');
  assert.deepEqual(native.prompts, ['Do the task.']);
  await session.close({ reason: 'idle' });
  assert.deepEqual([tools.closes, native.closes], [1, 1]);
});

test('large native assistant and reasoning deltas retain all text and complete their items', async () => {
  const native = scriptedNative();
  const session = await openValidatedSession({ native: native.native, tools: scriptedTools(async () => { throw new Error('No tool expected'); }).tools });
  const outputs = startText(session, 'long-text').outputs[Symbol.asyncIterator]();
  const pending = completed(outputs);
  await native.prompted();
  const text = `${'a'.repeat(3_999)}😀${'\0'.repeat(5_000)}${'界'.repeat(10_000)}`;
  for (const stream of ['assistant', 'reasoning'] as const) {
    native.event({ kind: 'text', stream, phase: 'started', key: stream, text: '' });
    native.event({ kind: 'text', stream, phase: 'delta', key: stream, text });
    native.event({ kind: 'text', stream, phase: 'ended', key: stream, text: '' });
  }
  native.event({ kind: 'execution_succeeded' });
  const events = (await pending).map((entry) => entry.event);
  for (const streamKind of ['assistant_text', 'reasoning_text']) {
    const deltas = events.filter((event) => event.type === 'content.delta' && event.payload.streamKind === streamKind);
    assert.equal(deltas.map((event) => event.type === 'content.delta' ? event.payload.delta : '').join(''), text);
  }
  assert.equal(events.filter((event) => event.type === 'item.completed').length, 2);
  assert.equal(events.find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  await session.close({ reason: 'idle' });
});

test('an automatic edit completes without a host request and reports its exact changes', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: ['a.txt'] });
    return { tool: 'write', status: 'completed', text: 'Wrote a.txt.', isError: false, changes: [{ path: 'a.txt', change: 'created' }] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const pending = readUntil(outputs, is('item.completed'));
  await native.prompted();
  const call = native.call('write', { file_path: 'a.txt', content: 'x' });
  const events = await pending;
  assert.equal(events.some((entry) => entry.event.type === 'request.opened'), false);
  assert.deepEqual((events.at(-1)?.event.payload as { details: unknown }).details, { changes: [{ path: 'a.txt', changeKind: 'created' }] });
  assert.deepEqual(await call.reply, { text: 'Wrote a.txt.', isError: false });
  assert.deepEqual(tools.calls.map((entry) => [entry.tool, entry.input]), [['write', { file_path: 'a.txt', content: 'x' }]]);
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await completed(outputs)), 'completed');
  await session.close({ reason: 'idle' });
});

test('a multi-file patch published out of path order reports its changes in protocol order', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: ['p.txt', 'a.txt'] });
    return { tool: 'patch', status: 'completed', text: 'p.txt: created\na.txt: modified', isError: false,
      changes: [{ path: 'p.txt', change: 'created' }, { path: 'a.txt', change: 'modified' }] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const pending = readUntil(outputs, is('item.completed'));
  await native.prompted();
  const call = native.call('patch', { changes: [{ file_path: 'p.txt', content: 'p' }, { file_path: 'a.txt', old_string: 'alpha', new_string: 'beta' }] });
  assert.deepEqual(await call.reply, { text: 'p.txt: created\na.txt: modified', isError: false });
  const events = await pending;
  assert.deepEqual((events.at(-1)?.event.payload as { details: unknown }).details,
    { changes: [{ path: 'a.txt', changeKind: 'modified' }, { path: 'p.txt', changeKind: 'created' }] });
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await completed(outputs)), 'completed');
  await session.close({ reason: 'idle' });
});

test('interruption withdraws the pending request and joins the call before the turn completes', async () => {
  const native = scriptedNative();
  const tools = commandTools();
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'host' } });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const { call, request } = await pendingCommand(native, outputs, 'sleep 100');
  assert.deepEqual(session.interruption.kind === 'supported' && await session.interruption.interruptTurn({ turnId: execution.turnId, reason: 'user_requested' }), { status: 'accepted' });
  const withdrawn = await readUntil(outputs, is('request.unavailable'));
  assert.deepEqual(withdrawn.at(-1)?.event.payload, { requestId: request.requestId, reason: 'withdrawn' });
  assert.deepEqual(await call.reply, { text: 'Command not run.', isError: true });
  assert.deepEqual(native.controls, ['interrupt']);
  native.event({ kind: 'execution_interrupted' });
  assert.equal(outcome(await completed(outputs)), 'canceled');
  const next = completed(startText(session, 'turn-2').outputs[Symbol.asyncIterator]());
  await native.prompted(2);
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await next), 'completed');
  await session.close({ reason: 'idle' });
});

test('a plugin cancellation aborts only that call, which still answers once, and the turn continues', async () => {
  const native = scriptedNative();
  const tools = commandTools();
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'host' } });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const { call, request } = await pendingCommand(native, outputs, 'sleep 100');
  native.emit({ type: 'cancel', id: call.id });
  const withdrawn = await readUntil(outputs, is('request.unavailable'));
  assert.deepEqual(withdrawn.at(-1)?.event.payload, { requestId: request.requestId, reason: 'withdrawn' });
  assert.deepEqual(await call.reply, { text: 'Command not run.', isError: true });
  assert.deepEqual(native.controls, []);
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await completed(outputs)), 'completed');
  assert.equal(native.replies.length, 1);
  await session.close({ reason: 'idle' });
});

const textItem = (native: ReturnType<typeof scriptedNative>, phase: 'started' | 'ended') =>
  native.event({ kind: 'text', stream: 'assistant', phase, key: 'msg_1:0', text: '' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const unusedTools = () => scriptedTools(async () => { throw new Error('unused'); });

test('a native cancellation queued behind a paused reader keeps its call out of the broker and answers it once', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: ['a.txt'] });
    return { tool: 'write', status: 'completed', text: 'Wrote a.txt.', isError: false, changes: [{ path: 'a.txt', change: 'created' }] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const paused = readUntil(outputs, is('item.started'));
  await native.prompted();
  textItem(native, 'started');
  await paused;
  const call = native.call('write', { file_path: 'a.txt', content: 'x' });
  native.emit({ type: 'cancel', id: call.id });
  textItem(native, 'ended');
  const end = completed(outputs);
  assert.deepEqual(await call.reply, { text: 'Tool call canceled before it ran.', isError: true });
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await end), 'completed');
  assert.deepEqual([tools.calls.length, native.replies.length], [0, 1]);
  await session.close({ reason: 'idle' });
});

for (const [receipt, reusable] of [['confirmed', true], ['reported nothing to interrupt', true], ['failed', false]] as const) {
  test(`a native interrupt receipt that ${receipt} settles before the canceled turn ends and before any later prompt`, async () => {
    const pending = Promise.withResolvers<boolean>();
    const native = scriptedNative({ interrupt: () => pending.promise });
    const session = await openValidatedSession({ native: native.native, tools: unusedTools().tools });
    const execution = startText(session, 'turn-1');
    const end = completed(execution.outputs[Symbol.asyncIterator]());
    await native.prompted();
    assert.ok(session.interruption.kind === 'supported');
    assert.deepEqual(await session.interruption.interruptTurn({ turnId: execution.turnId, reason: 'user_requested' }), { status: 'accepted' });
    native.event({ kind: 'execution_succeeded' });
    assert.equal(await Promise.race([end.then(() => 'ended'), settle().then(() => 'pending')]), 'pending');
    if (receipt === 'failed') pending.reject(new Error('The OpenCode interrupt request failed.'));
    else pending.resolve(receipt === 'confirmed');
    assert.equal(outcome(await end), 'canceled');
    const next = startText(session, 'turn-2').outputs[Symbol.asyncIterator]();
    if (reusable) {
      const second = completed(next);
      await native.prompted(2);
      native.event({ kind: 'execution_succeeded' });
      assert.equal(outcome(await second), 'completed');
    } else {
      await assert.rejects(next.next(), /no longer usable \(interrupt_uncertain\)/u);
      assert.equal(native.prompts.length, 1);
    }
    assert.deepEqual(native.controls, ['interrupt']);
    await session.close({ reason: 'shutdown' });
  });
}

for (const [name, signal, code] of [
  ['event-source loss', { type: 'failed', reason: 'The native event stream ended.' }, 'opencode_native_failed'],
  ['configuration drift', { type: 'event', event: { kind: 'drift', type: 'config.updated' } }, 'opencode_native_drift'],
  ['a native permission request', { type: 'event', event: { kind: 'permission_asked', requestID: 'per_1' } }, 'opencode_native_permission'],
] as const) {
  for (const timing of ['queued behind success while the reader is paused', 'during the final saved-grant check'] as const) {
    test(`${name} ${timing} fails the turn and fences the session`, async () => {
      const check = Promise.withResolvers<number>();
      const checking = Promise.withResolvers<void>();
      const duringCheck = timing === 'during the final saved-grant check';
      const native = scriptedNative({ savedGrants: () => { checking.resolve(); return duringCheck ? check.promise : 0; } });
      const session = await openValidatedSession({ native: native.native, tools: unusedTools().tools });
      const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
      const paused = readUntil(outputs, is('item.started'));
      await native.prompted();
      textItem(native, 'started');
      await paused;
      textItem(native, 'ended');
      native.event({ kind: 'execution_succeeded' });
      if (!duringCheck) native.emit(signal);
      const end = completed(outputs);
      if (duringCheck) {
        await checking.promise;
        native.emit(signal);
        check.resolve(0);
      }
      const events = await end;
      assert.equal(outcome(events), 'failed');
      assert.equal((events.at(-1)?.event.payload as { error: { code: string } }).error.code, code);
      if (signal.type === 'event' && signal.event.kind === 'permission_asked') assert.ok(native.controls.includes('reject:per_1'));
      await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
      assert.equal(native.prompts.length, 1);
      await session.close({ reason: 'shutdown' });
    });
  }
}

test('abandoning a turn closes the session only after its native interrupt settles', async () => {
  const pending = Promise.withResolvers<boolean>();
  const native = scriptedNative({ interrupt: () => pending.promise });
  let releases = 0;
  const session = await openValidatedSession({ native: native.native, tools: unusedTools().tools, release: async () => { releases += 1; } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const paused = readUntil(outputs, is('item.started'));
  await native.prompted();
  textItem(native, 'started');
  await paused;
  const returned = Promise.resolve(outputs.return?.(undefined));
  assert.equal(await Promise.race([returned.then(() => 'closed'), settle().then(() => 'pending')]), 'pending');
  assert.deepEqual(native.controls, ['interrupt']);
  assert.equal(releases, 0);
  pending.resolve(true);
  await returned;
  assert.equal(releases, 1);
});

test('observations past the bound while the reader is paused fail the turn and refuse later calls once', async () => {
  const native = scriptedNative();
  const tools = unusedTools();
  const session = await openValidatedSession({ native: native.native, tools: tools.tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const paused = readUntil(outputs, is('item.started'));
  await native.prompted();
  textItem(native, 'started');
  await paused;
  for (let index = 0; index <= CHANNEL_CAPACITY; index += 1) native.event({ kind: 'text', stream: 'assistant', phase: 'delta', key: 'msg_1:0', text: 'x' });
  assert.deepEqual(native.controls, ['interrupt']);
  assert.deepEqual(await native.call('read', { file_path: 'a.txt' }).reply, { text: 'Tool call refused: the turn is ending.', isError: true });
  const end = await completed(outputs);
  assert.equal((end.at(-1)?.event.payload as { error: { code: string } }).error.code, 'opencode_turn_output_overflow');
  assert.deepEqual([tools.calls.length, native.replies.length], [0, 1]);
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
  await session.close({ reason: 'shutdown' });
});

test('losing the native event source fails the turn after the entered effect settles and fences the session', async () => {
  const native = scriptedNative();
  let finish: (() => void) | undefined;
  const effect = new Promise<void>((resolve) => { finish = resolve; });
  const tools = commandTools(() => effect);
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'host' } });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const { call, request } = await pendingCommand(native, outputs, 'make');
  await answer(execution, request, APPROVE);
  native.emit({ type: 'failed', reason: 'The native event stream ended.' });
  const settled = completed(outputs);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.replies.length, 0);
  finish?.();
  const end = await settled;
  assert.deepEqual(await call.reply, { text: ran.text, isError: false });
  const completedIndex = end.findIndex((entry) => entry.event.type === 'item.completed');
  assert.ok(completedIndex >= 0 && completedIndex < end.length - 1);
  assert.equal(outcome(end), 'failed');
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
  await session.close({ reason: 'shutdown' });
  assert.deepEqual([tools.closes, native.closes], [1, 1]);
});

for (const [name, event, control] of [
  ['a native permission request is rejected once', { kind: 'permission_asked', requestID: 'per_1' }, 'reject:per_1'],
  ['a native form is canceled', { kind: 'form_created', formID: 'frm_1' }, 'cancel-form:frm_1'],
  ['configuration drift', { kind: 'drift', type: 'config.updated' }, undefined],
  ['a tool outside the owned set', { kind: 'tool_input', callID: 'toolu_x', name: 'shell' }, undefined],
  ['a provider-executed tool', { kind: 'tool_called', callID: 'toolu_x', executed: true }, undefined],
] as const) {
  test(`${name} fails the turn, interrupts OpenCode and fences the session`, async () => {
    const native = scriptedNative();
    const tools = scriptedTools(async () => { throw new Error('unused'); });
    const session = await openValidatedSession({ native: native.native, tools: tools.tools });
    const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
    const end = completed(outputs);
    await native.prompted();
    native.event(event);
    assert.equal(outcome(await end), 'failed');
    assert.deepEqual(native.controls, control ? [control, 'interrupt'] : ['interrupt']);
    assert.equal(tools.calls.length, 0);
    await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
    await session.close({ reason: 'shutdown' });
  });
}

test('repeated calls are refused and a foreign session call stops further effects in the active turn', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'read', path: 'a.txt' });
    return { tool: 'read', status: 'completed', text: 'x', isError: false, changes: [] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const end = completed(outputs);
  await native.prompted();
  assert.deepEqual(await native.call('read', { file_path: 'a.txt' }, { callID: 'toolu_same' }).reply, { text: 'x', isError: false });
  assert.match((await native.call('read', { file_path: 'a.txt' }, { callID: 'toolu_same' }).reply).text, /already dispatched/u);
  assert.match((await native.call('read', { file_path: 'a.txt' }, { sessionID: 'ses_other' }).reply).text, /another session/u);
  assert.equal((await native.call('write', { file_path: 'later.txt', content: 'must not run' }).reply).isError, true);
  assert.equal(tools.calls.length, 1);
  native.event({ kind: 'execution_succeeded' });
  const events = await end;
  assert.equal(outcome(events), 'failed');
  assert.equal((events.at(-1)?.event.payload as { error: { code: string } }).error.code, 'opencode_foreign_tool_call');
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /foreign_tool_call/u);
  await session.close({ reason: 'shutdown' });
});

test('a saved native grant after a turn fails that turn', async () => {
  const native = scriptedNative({ savedGrants: () => 1 });
  const session = await openValidatedSession({ native: native.native, tools: scriptedTools(async () => { throw new Error('unused'); }).tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const ending = completed(outputs);
  await native.prompted();
  native.event({ kind: 'execution_succeeded' });
  const end = await ending;
  assert.equal(outcome(end), 'failed');
  assert.equal((end.at(-1)?.event.payload as { error: { code: string } }).error.code, 'opencode_saved_grants');
  await session.close({ reason: 'shutdown' });
});

test('a call outside any turn is refused and fences the session', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools });
  assert.deepEqual(await native.call('bash', { command: 'pwd' }).reply, { text: 'Tool call refused: no turn is active.', isError: true });
  assert.equal(tools.calls.length, 0);
  await assert.rejects(startText(session, 'turn-1').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
  await session.close({ reason: 'shutdown' });
});

test('close keeps both owners until each is joined and releases state only after both', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  let releases = 0;
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, release: async () => { releases += 1; } });
  tools.failClose(1);
  native.failClose(1);
  const failure = await Promise.resolve(session.close({ reason: 'shutdown' })).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgentProviderSessionCleanupError);
  assert.deepEqual([tools.closes, native.closes, releases], [1, 1, 0]);
  await failure.retryCleanup();
  assert.deepEqual([tools.closes, native.closes, releases], [2, 2, 1]);
  await session.close({ reason: 'shutdown' });
  assert.deepEqual([tools.closes, native.closes, releases], [2, 2, 1]);
});

test('each owned call settles one item, and a refusal the tools decide is a bounded diagnostic without the model input', { timeout: 5000 }, async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call: NodeProviderToolCallInput): Promise<NodeProviderToolResult> => {
    const path = (call.input as { file_path: string }).file_path;
    if (path.startsWith('/')) return { tool: 'write', status: 'refused', refusal: 'outside_workspace', text: `Edit refused (${path}).`, isError: true, changes: [] };
    call.observer.started({ kind: 'edit', paths: [path] });
    return { tool: 'write', status: 'denied', refusal: 'restricted', text: 'Edit refused by the session file restrictions.', isError: true, changes: [] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const end = completed(outputs);
  await native.prompted();
  assert.equal((await native.call('write', { file_path: '/etc/outside-secret', content: 'x' }).reply).isError, true);
  assert.equal((await native.call('write', { file_path: 'secret.txt', content: 'x' }).reply).isError, true);
  native.event({ kind: 'execution_succeeded' });
  const events = (await end).map((entry) => entry.event);
  const items = events.filter((event) => event.type === 'item.completed').map((event) => {
    const { itemId: _itemId, ...item } = event.payload as { itemId: string };
    return item;
  });
  assert.deepEqual(items, [
    { itemKind: 'file_change', status: 'failed', title: 'Edit file', summary: 'Refused: the path is outside the workspace.' },
    { itemKind: 'file_change', status: 'failed', title: 'Edit file', summary: 'Refused by the session file restrictions.' },
  ]);
  assert.equal(events.filter((event) => event.type === 'item.started').length, 2);
  assert.deepEqual(events.filter((event) => event.type === 'provider.diagnostic').map((event) => event.payload), [
    { code: 'owned_tool_refused', message: 'Refused: the path is outside the workspace.', context: { operation: 'write', status: 'outside_workspace' } },
    { code: 'owned_tool_refused', message: 'Refused by the session file restrictions.', context: { operation: 'write', status: 'restricted' } },
  ]);
  assert.equal(JSON.stringify(events).includes('outside-secret'), false);
  await session.close({ reason: 'idle' });
});
