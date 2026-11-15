import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderSessionCleanupError } from '@agen-ai/agent-runtime';
import type { NodeProviderToolCallInput, NodeProviderToolResult } from '@agen-ai/provider-tools/node';
import { WorkerFailure } from '../src/node/errors.js';
import {
  answer, APPROVE, commandTools, DENY, INIT, is, openValidatedSession, outcome, ran, readUntil, RESULT, scriptedTools, scriptedWorker, startText, toolCall,
} from './support/session.js';

test('a host-approved command carries its exact text and returns the receipt to Claude', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'host' } });
  assert.deepEqual(session.approvalPolicy, { policy: { kind: 'host' }, verification: 'controlled_configuration' });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const command = 'printf "%s" hello > out.txt && cat out.txt';
  const pending = readUntil(outputs, (event) => event.type === 'turn.state_changed' && event.payload.state === 'waiting_for_request');
  await toolCall(worker, command);
  const opened = (await pending).find((entry) => entry.event.type === 'request.opened');
  assert.ok(opened?.event.type === 'request.opened' && opened.output.kind === 'event');
  assert.deepEqual(opened.output.requestContext?.data, { action: { kind: 'command', command } });
  assert.equal(opened.event.payload.request.requestKind === 'approval' && opened.event.payload.request.subject.kind, 'command');

  assert.deepEqual(await answer(execution, opened.event.payload.request, APPROVE), { status: 'delivered' });
  const completedItem = await readUntil(outputs, is('item.completed'));
  assert.deepEqual(completedItem.at(-1)?.event.payload, { itemId: (completedItem.at(-1)?.event.payload as { itemId: string }).itemId,
    itemKind: 'command_execution', status: 'completed', title: 'Command', details: { commandSummary: command, exitCode: 0, durationMs: 3 } });
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: ran.text, isError: false });

  worker.emit({ type: 'assistant_text', complete: true, text: 'Done.' });
  worker.emit({ ...RESULT });
  const end = await readUntil(outputs, is('turn.completed'));
  assert.ok(end.some((entry) => entry.event.type === 'content.delta' && entry.event.payload.delta === 'Done.'));
  assert.equal(outcome(end), 'completed');
  assert.equal((await outputs.next()).done, true);
  await session.close({ reason: 'idle' });
  assert.deepEqual([tools.closes, worker.closes], [1, 1]);
});

test('a denied command never reaches its effect and Claude receives the refusal', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  assert.equal('approvalPolicy' in session, false);
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const pending = readUntil(outputs, is('request.opened'));
  await toolCall(worker, 'rm -rf build');
  const opened = (await pending).at(-1);
  assert.ok(opened?.event.type === 'request.opened');
  await answer(execution, opened.event.payload.request, DENY);
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Command not run.', isError: true });
  const item = await readUntil(outputs, is('item.completed'));
  assert.equal((item.at(-1)?.event.payload as { status: string }).status, 'failed');
  worker.emit({ ...RESULT });
  await readUntil(outputs, is('turn.completed'));
  await session.close({ reason: 'idle' });
});

test('a multi-file patch published out of path order reports protocol order and returns the publication receipt unchanged', async () => {
  const worker = scriptedWorker();
  const published = ['p.txt', '😀.txt', 'ﬀ.txt', 'a.txt'];
  const receipt = published.map((path) => `${path}: ${path === 'a.txt' ? 'modified' : 'created'}`).join('\n');
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: published });
    return { tool: 'patch', status: 'completed', text: receipt, isError: false,
      changes: published.map((path) => ({ path, change: path === 'a.txt' ? 'modified' as const : 'created' as const })) };
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const pending = readUntil(outputs, is('item.completed'));
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'patch', input: {}, nativeRef: 'toolu_1' });
  const events = await pending;
  assert.equal(events.some((entry) => entry.event.type === 'request.opened'), false);
  assert.deepEqual((events.at(-1)?.event.payload as { details: unknown }).details, { changes: [
    { path: 'a.txt', changeKind: 'modified' }, { path: 'p.txt', changeKind: 'created' },
    { path: 'ﬀ.txt', changeKind: 'created' }, { path: '😀.txt', changeKind: 'created' },
  ] });
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: receipt, isError: false });
  worker.emit({ ...RESULT });
  assert.equal(outcome(await readUntil(outputs, is('turn.completed'))), 'completed');
  assert.equal(tools.calls.length, 1);
  await session.close({ reason: 'idle' });
});

test('interrupting withdraws the pending approval, waits for Claude, and leaves the session usable', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const execution = startText(session, 'turn-1');
  const outputs = execution.outputs[Symbol.asyncIterator]();
  const pending = readUntil(outputs, is('request.opened'));
  await toolCall(worker, 'sleep 100');
  const opened = (await pending).at(-1);
  assert.ok(opened?.event.type === 'request.opened');
  assert.ok(session.interruption.kind === 'supported');
  const withdrawn = readUntil(outputs, is('request.unavailable'));
  assert.equal((await session.interruption.interruptTurn({ turnId: execution.turnId, reason: 'user_requested' })).status, 'accepted');
  const unavailable = (await withdrawn).at(-1)?.event;
  assert.equal(unavailable?.type === 'request.unavailable' ? unavailable.payload.reason : undefined, 'withdrawn');
  await worker.next('interrupt');
  await assert.rejects(answer(execution, opened.event.payload.request, APPROVE), { code: 'request_resolution_mismatch' });
  assert.equal(tools.calls.length, 1);
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Command not run.', isError: true });
  worker.emit({ ...RESULT, subtype: 'error_during_execution', isError: true });
  const end = await readUntil(outputs, is('turn.completed'));
  assert.equal(outcome(end), 'canceled');
  assert.equal((await outputs.next()).done, true);

  const next = startText(session, 'turn-2');
  const nextEnd = readUntil(next.outputs[Symbol.asyncIterator](), is('turn.completed'));
  await worker.next('prompt');
  worker.emit({ ...RESULT });
  assert.equal(outcome(await nextEnd), 'completed');
  await session.close({ reason: 'idle' });
});

test('a worker transport failure fails the turn and the session admits no later turn', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  const ending = readUntil(startText(session, 'turn-1').outputs[Symbol.asyncIterator](), is('turn.completed'));
  await worker.next('prompt');
  worker.emit({ type: 'transport_failed', error: new WorkerFailure('transport', 'The Claude worker transport failed.') });
  const end = await ending;
  const completed = end.at(-1)?.event;
  assert.ok(completed?.type === 'turn.completed' && completed.payload.outcome === 'failed');
  assert.equal(completed.payload.error?.category, 'transport');
  assert.throws(() => startText(session, 'turn-2'));
  await session.close({ reason: 'error' });
});

test('an action too large for exact approval context is refused without a request', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const diagnostic = readUntil(outputs, is('item.completed'));
  await toolCall(worker, `echo ${'"'.repeat(9_000)}`);
  const events = await diagnostic;
  assert.equal(events.some((entry) => entry.event.type === 'request.opened'), false);
  assert.ok(events.some((entry) => entry.event.type === 'provider.diagnostic'));
  assert.equal((await worker.next('tool_result')).isError, true);
  worker.emit({ ...RESULT });
  await readUntil(outputs, is('turn.completed'));
  await session.close({ reason: 'idle' });
});

test('output overflow behind a paused reader aborts effects, joins the entered call and still settles the turn and close', { timeout: 10_000 }, async () => {
  const worker = scriptedWorker();
  let entered: NodeProviderToolCallInput | undefined;
  let finish: ((result: NodeProviderToolResult) => void) | undefined;
  const tools = scriptedTools((call) => {
    entered = call;
    call.observer.started({ kind: 'command', command: 'sleep 9' });
    return new Promise((resolve) => { finish = resolve; });
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const first = readUntil(outputs, (event) => event.type === 'content.delta');
  await worker.next('prompt');
  worker.emit({ type: 'assistant_text', complete: true, text: 'first' });
  await first;
  const started = readUntil(outputs, is('item.started'));
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'sleep 9' }, nativeRef: 'toolu_1' });
  await started;

  for (let index = 0; index < 1_026; index += 1) worker.emit({ type: 'assistant_text', complete: true, text: `chunk ${index}` });
  worker.emit({ type: 'tool_call', callId: 'call-2', tool: 'bash', input: { command: 'touch late' }, nativeRef: 'toolu_2' });
  worker.emit({ ...RESULT });
  assert.equal(entered?.signal.aborted, true);
  await worker.next('interrupt');
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-2', text: 'Tool call refused: the turn is ending.', isError: true });
  assert.equal(tools.calls.length, 1);

  const drained = readUntil(outputs, is('turn.completed'));
  await new Promise((resolve) => setImmediate(resolve));
  finish?.({ tool: 'bash', status: 'canceled', text: 'Command canceled.', isError: true, changes: [] });
  const events = await drained;
  const completed = events.at(-1)?.event;
  assert.ok(completed?.type === 'turn.completed');
  assert.equal(completed.payload.outcome, 'failed');
  assert.equal(completed.payload.error?.code, 'claude_turn_output_overflow');
  assert.ok(events.filter((entry) => entry.event.type === 'content.delta').length <= 1_024);
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Command canceled.', isError: true });
  assert.equal((await outputs.next()).done, true);
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable \(turn_output_overflow\)/u);
  await session.close({ reason: 'error' });
  assert.deepEqual([tools.closes, worker.closes], [1, 1]);
});

test('a close whose worker group survives keeps the retry owner until it joins', async () => {
  const worker = scriptedWorker();
  const tools = commandTools();
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  worker.failClose(1);
  const failure = await Promise.resolve(session.close({ reason: 'shutdown' })).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgentProviderSessionCleanupError);
  await failure.retryCleanup();
  assert.equal(worker.closes, 2);
  await session.close({ reason: 'shutdown' });
  assert.equal(worker.closes, 2);
});

test('each owned call settles one item, and a refusal the tools decide is a bounded diagnostic without the model input', { timeout: 5000 }, async () => {
  const worker = scriptedWorker();
  const tools = scriptedTools(async (call: NodeProviderToolCallInput): Promise<NodeProviderToolResult> => {
    const path = (call.input as { file_path: string }).file_path;
    if (path.startsWith('/')) return { tool: 'write', status: 'refused', refusal: 'outside_workspace', text: `Edit refused (${path}).`, isError: true, changes: [] };
    call.observer.started({ kind: 'edit', paths: [path] });
    return { tool: 'write', status: 'denied', refusal: 'restricted', text: 'Edit refused by the session file restrictions.', isError: true, changes: [] };
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const end = readUntil(outputs, is('turn.completed'));
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'write', input: { file_path: '/etc/outside-secret', content: 'x' }, nativeRef: 'toolu_1' });
  assert.equal((await worker.next('tool_result')).isError, true);
  worker.emit({ type: 'tool_call', callId: 'call-2', tool: 'write', input: { file_path: 'secret.txt', content: 'x' }, nativeRef: 'toolu_2' });
  assert.equal((await worker.next('tool_result')).isError, true);
  worker.emit({ ...RESULT });
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
