import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentTurnId } from '@agen-ai/agent-protocol';
import type { NodeProviderToolResult } from '@agen-ai/provider-tools/node';
import { WorkerFailure } from '../src/node/errors.js';
import type { WorkerEvent } from '../src/node/process.js';
import {
  answer, APPROVE, commandTools, INIT, is, openValidatedSession, outcome, OWNED, readUntil, RESULT, scriptedTools, scriptedWorker, startText,
  toolCall,
} from './support/session.js';

const exited = () => new WorkerFailure('transport', 'The Claude worker exited.');

// Each observation reaches the session while its reader is paused on a pending approval, so only admission can act on it.
for (const [name, observation, code] of [
  ['a tool outside the owned set', { ...INIT, tools: [...OWNED, 'WebFetch'] }, 'claude_residual_tools'],
  ['another permission mode', { ...INIT, permissionMode: 'acceptEdits' }, 'claude_configuration_drift'],
  ['another Claude Code version', { ...INIT, claudeCodeVersion: '2.1.323' }, 'claude_configuration_drift'],
  ['another model', { ...INIT, model: 'claude-other' }, 'claude_configuration_drift'],
  ['a permission-mode change to plan', { type: 'status', permissionMode: 'plan' }, 'claude_configuration_drift'],
  ['a refusal fallback to another model', { type: 'model_fallback', model: 'claude-other' }, 'claude_configuration_drift'],
  ['a worker failure report', { type: 'failed', stage: 'runtime', message: 'Claude Code exited.' }, 'claude_worker_failed'],
  ['worker transport loss', { type: 'transport_failed', error: exited() }, 'claude_worker_failed'],
] as const) {
  test(`${name} behind a paused reader withdraws the pending approval, refuses its late answer and later calls, and retires the session`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-authority-'));
    const marker = join(root, 'marker');
    try {
      const worker = scriptedWorker();
      const tools = commandTools(() => writeFile(marker, 'ran\n'));
      const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
      const execution = startText(session, 'turn-1');
      const outputs = execution.outputs[Symbol.asyncIterator]();
      const pending = readUntil(outputs, is('request.opened'));
      await toolCall(worker, 'touch marker');
      const opened = (await pending).at(-1);
      assert.ok(opened?.event.type === 'request.opened');

      worker.emit(observation as WorkerEvent);
      worker.emit({ type: 'tool_call', callId: 'call-2', tool: 'bash', input: { command: 'touch later' }, nativeRef: 'toolu_2' });
      assert.deepEqual(await answer(execution, opened.event.payload.request, APPROVE), { status: 'rejected', requestState: 'unavailable',
        error: { category: 'invalid_request', code: 'request_unavailable', message: 'The approval request is no longer pending.', recovery: { kind: 'unknown' } } });
      const results = [await worker.next('tool_result'), await worker.next('tool_result')].sort((left, right) => left.callId.localeCompare(right.callId));
      assert.deepEqual(results, [
        { type: 'tool_result', callId: 'call-1', text: 'Command not run.', isError: true },
        { type: 'tool_result', callId: 'call-2', text: 'Tool call refused: the turn is ending.', isError: true },
      ]);
      assert.equal(tools.calls.length, 1);
      await assert.rejects(access(marker), { code: 'ENOENT' });
      if (code !== 'claude_worker_failed') assert.ok(worker.sent.some((message) => message.type === 'interrupt'));

      const end = await readUntil(outputs, is('turn.completed'));
      assert.deepEqual(end.find((entry) => entry.event.type === 'request.unavailable')?.event.payload,
        { requestId: opened.event.payload.request.requestId, reason: 'withdrawn' });
      assert.equal((end.find((entry) => entry.event.type === 'item.completed')?.event.payload as { status: string }).status, 'canceled');
      const completed = end.at(-1)?.event;
      assert.ok(completed?.type === 'turn.completed' && completed.payload.outcome === 'failed');
      assert.equal(completed.payload.error?.code, code);
      assert.equal((await outputs.next()).done, true);
      await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
      await session.close({ reason: 'error' });
      assert.deepEqual([tools.closes, worker.closes], [1, 1]);
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a worker loss observed while the turn settles after Claude\'s result still fails that turn', async () => {
  const worker = scriptedWorker();
  let finish: ((result: NodeProviderToolResult) => void) | undefined;
  const tools = scriptedTools((call) => {
    call.observer.started({ kind: 'read', path: 'a.txt' });
    return new Promise((resolve) => { finish = resolve; });
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const started = readUntil(outputs, is('item.started'));
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'read', input: { file_path: 'a.txt' }, nativeRef: 'toolu_1' });
  await started;
  worker.emit({ ...RESULT });
  const ending = readUntil(outputs, is('turn.completed'));
  await new Promise((resolve) => setImmediate(resolve));
  worker.emit({ type: 'transport_failed', error: exited() });
  finish?.({ tool: 'read', status: 'canceled', text: 'Read canceled.', isError: true, changes: [] });
  const end = await ending;
  assert.equal((end.find((entry) => entry.event.type === 'item.completed')?.event.payload as { status: string }).status, 'canceled');
  const completed = end.at(-1)?.event;
  assert.ok(completed?.type === 'turn.completed' && completed.payload.outcome === 'failed');
  assert.equal(completed.payload.error?.code, 'claude_worker_failed');
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Read canceled.', isError: true });
  assert.equal((await outputs.next()).done, true);
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable/u);
  await session.close({ reason: 'error' });
  assert.deepEqual([tools.closes, worker.closes], [1, 1]);
});

test('a repeated native tool-use reference is refused before it reaches the broker', async () => {
  const worker = scriptedWorker();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'read', path: 'a.txt' });
    return { tool: 'read', status: 'completed', text: 'alpha', isError: false, changes: [] };
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const ending = readUntil(outputs, is('turn.completed'));
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'read', input: { file_path: 'a.txt' }, nativeRef: 'toolu_same' });
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'alpha', isError: false });
  worker.emit({ type: 'tool_call', callId: 'call-2', tool: 'read', input: { file_path: 'a.txt' }, nativeRef: 'toolu_same' });
  const repeated = await worker.next('tool_result');
  assert.deepEqual([repeated.callId, repeated.isError], ['call-2', true]);
  assert.match(repeated.text, /already dispatched/u);
  worker.emit({ ...RESULT });
  assert.equal(outcome(await ending), 'completed');
  assert.equal(tools.calls.length, 1);
  await session.close({ reason: 'idle' });
});

test('an approval the broker expires is reported expired, runs nothing, and the turn continues', async () => {
  const worker = scriptedWorker();
  const tools = scriptedTools(async (call) => {
    const command = (call.input as { command: string }).command;
    call.observer.started({ kind: 'command', command });
    const expiry = new AbortController();
    const decision = call.observer.approve({ kind: 'command', command }, expiry.signal);
    expiry.abort('expired');
    assert.equal(await decision, 'denied');
    return { tool: 'bash', status: 'expired', text: 'Command not run.', isError: true, changes: [] };
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const withdrawn = readUntil(outputs, is('request.unavailable'));
  await toolCall(worker, 'touch marker');
  const events = await withdrawn;
  const opened = events.find((entry) => entry.event.type === 'request.opened')?.event;
  assert.ok(opened?.type === 'request.opened');
  assert.deepEqual(events.at(-1)?.event.payload, { requestId: opened.payload.request.requestId, reason: 'expired' });
  assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Command not run.', isError: true });
  worker.emit({ ...RESULT });
  assert.equal(outcome(await readUntil(outputs, is('turn.completed'))), 'completed');
  await session.close({ reason: 'idle' });
});

for (const timeoutMs of [200, 30 * 24 * 60 * 60 * 1000]) {
  test(`a ${timeoutMs} ms turn deadline waits before withdrawing approval, interrupting Claude and expiring`, async (t) => {
    const worker = scriptedWorker();
    const tools = commandTools();
    const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
    t.after(() => session.close({ reason: 'shutdown' }));
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    const execution = session.startTurn({ turnId: parseAgentTurnId('turn-1'), interactionMode: 'default', parts: [{ type: 'text', text: 'Do the task.' }],
      deadlineAt: new Date(now + timeoutMs).toISOString() });
    const outputs = execution.outputs[Symbol.asyncIterator]();
    const pending = readUntil(outputs, is('request.opened'));
    await toolCall(worker, 'sleep 100');
    const opened = (await pending).at(-1);
    assert.ok(opened?.event.type === 'request.opened');
    for (const elapsed of new Set([1, Math.min(2_147_483_647, timeoutMs - 1), timeoutMs - 1])) {
      t.mock.timers.tick(elapsed - (Date.now() - now));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(worker.sent.filter((message) => message.type === 'interrupt'), []);
    }
    t.mock.timers.tick(1);
    const withdrawn = await readUntil(outputs, is('request.unavailable'));
    assert.deepEqual(withdrawn.at(-1)?.event.payload, { requestId: opened.event.payload.request.requestId, reason: 'withdrawn' });
    await worker.next('interrupt');
    assert.deepEqual(await worker.next('tool_result'), { type: 'tool_result', callId: 'call-1', text: 'Command not run.', isError: true });
    worker.emit({ ...RESULT, subtype: 'error_during_execution', isError: true });
    assert.equal(outcome(await readUntil(outputs, is('turn.completed'))), 'expired');
    await session.close({ reason: 'idle' });
  });
}

test('a fenced publication reports its known changes and the fence once, and nothing is retried', async () => {
  const worker = scriptedWorker();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: ['b.txt', 'a.txt'] });
    return tools.calls.length === 1
      ? { tool: 'patch', status: 'failed', text: 'b.txt: created\na.txt: publication unknown; the session is fenced', isError: true,
        changes: [{ path: 'b.txt', change: 'created' }], fence: 'publication_unknown' }
      : { tool: 'write', status: 'refused', text: 'Tool call refused: the session is fenced (publication_unknown).', isError: true, changes: [], fence: 'publication_unknown' };
  });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const ending = readUntil(outputs, is('turn.completed'));
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'patch', input: {}, nativeRef: 'toolu_1' });
  assert.equal((await worker.next('tool_result')).text, 'b.txt: created\na.txt: publication unknown; the session is fenced');
  worker.emit({ type: 'tool_call', callId: 'call-2', tool: 'write', input: {}, nativeRef: 'toolu_2' });
  assert.match((await worker.next('tool_result')).text, /fenced/u);
  worker.emit({ ...RESULT });
  const events = await ending;
  const items = events.flatMap((entry) => entry.event.type === 'item.completed' ? [entry.event.payload as { status: string; details?: unknown }] : []);
  assert.deepEqual(items.map((item) => [item.status, item.details]), [
    ['failed', { changes: [{ path: 'b.txt', changeKind: 'created' }] }], ['failed', undefined],
  ]);
  assert.equal(events.filter((entry) => entry.event.type === 'runtime.warning').length, 1);
  assert.equal(tools.calls.length, 2);
  await session.close({ reason: 'idle' });
});
