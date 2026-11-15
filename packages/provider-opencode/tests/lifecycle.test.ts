import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentTurnId, type AgentEvent } from '@agen-ai/agent-protocol';
import { approvalSignal, openValidatedSession, outcome, readUntil, scriptedNative, scriptedTools, startText } from './support/session.js';

const is = (type: AgentEvent['type']) => (event: AgentEvent) => event.type === type;

test('an approval the broker expires is reported expired, runs nothing, and the turn continues', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    const command = (call.input as { command: string }).command;
    call.observer.started({ kind: 'command', command });
    const expiry = new AbortController();
    const decision = call.observer.approve({ kind: 'command', command }, expiry.signal);
    expiry.abort('expired');
    assert.equal(await decision, 'denied');
    return { tool: 'bash', status: 'expired', text: 'Command not run.', isError: true, changes: [] };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools });
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const withdrawn = readUntil(outputs, is('request.unavailable'));
  await native.prompted();
  const call = native.call('bash', { command: 'touch marker' });
  const events = await withdrawn;
  const opened = events.find((entry) => entry.event.type === 'request.opened')?.event;
  assert.ok(opened?.type === 'request.opened');
  assert.deepEqual(events.at(-1)?.event.payload, { requestId: opened.payload.request.requestId, reason: 'expired' });
  assert.deepEqual(await call.reply, { text: 'Command not run.', isError: true });
  native.event({ kind: 'execution_succeeded' });
  assert.equal(outcome(await readUntil(outputs, is('turn.completed'))), 'completed');
  await session.close({ reason: 'idle' });
});

for (const timeoutMs of [200, 30 * 24 * 60 * 60 * 1000]) {
  test(`a ${timeoutMs} ms turn deadline waits before withdrawing approval, interrupting OpenCode and expiring`, async (t) => {
    const native = scriptedNative();
    const tools = scriptedTools(async (call) => {
      const command = (call.input as { command: string }).command;
      call.observer.started({ kind: 'command', command });
      await call.observer.approve({ kind: 'command', command }, approvalSignal(call));
      return { tool: 'bash', status: 'canceled', text: 'Command not run.', isError: true, changes: [] };
    });
    const session = await openValidatedSession({ native: native.native, tools: tools.tools });
    t.after(() => session.close({ reason: 'shutdown' }));
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    const outputs = session.startTurn({ turnId: parseAgentTurnId('turn-1'), interactionMode: 'default', parts: [{ type: 'text', text: 'Do the task.' }],
      deadlineAt: new Date(now + timeoutMs).toISOString() }).outputs[Symbol.asyncIterator]();
    const pending = readUntil(outputs, is('request.opened'));
    await native.prompted();
    const call = native.call('bash', { command: 'sleep 100' });
    const opened = (await pending).at(-1);
    assert.ok(opened?.event.type === 'request.opened');
    for (const elapsed of new Set([1, Math.min(2_147_483_647, timeoutMs - 1), timeoutMs - 1])) {
      t.mock.timers.tick(elapsed - (Date.now() - now));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(native.controls, []);
    }
    t.mock.timers.tick(1);
    const withdrawn = await readUntil(outputs, is('request.unavailable'));
    assert.deepEqual(withdrawn.at(-1)?.event.payload, { requestId: opened.event.payload.request.requestId, reason: 'withdrawn' });
    assert.deepEqual(await call.reply, { text: 'Command not run.', isError: true });
    assert.deepEqual(native.controls, ['interrupt']);
    native.event({ kind: 'execution_interrupted' });
    assert.equal(outcome(await readUntil(outputs, is('turn.completed'))), 'expired');
    await session.close({ reason: 'idle' });
  });
}

test('a fenced publication reports its known changes and the fence once, and nothing is retried', async () => {
  const native = scriptedNative();
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'edit', paths: ['b.txt', 'a.txt'] });
    return tools.calls.length === 1
      ? { tool: 'patch', status: 'failed', text: 'b.txt: created\na.txt: publication unknown; the session is fenced', isError: true,
        changes: [{ path: 'b.txt', change: 'created' }], fence: 'publication_unknown' }
      : { tool: 'write', status: 'refused', text: 'Tool call refused: the session is fenced (publication_unknown).', isError: true, changes: [], fence: 'publication_unknown' };
  });
  const session = await openValidatedSession({ native: native.native, tools: tools.tools, approvalPolicy: { kind: 'provider_accept_edits' } });
  const ending = readUntil(startText(session, 'turn-1').outputs[Symbol.asyncIterator](), is('turn.completed'));
  await native.prompted();
  assert.deepEqual(await native.call('patch', { changes: [] }).reply, { text: 'b.txt: created\na.txt: publication unknown; the session is fenced', isError: true });
  assert.match((await native.call('write', { file_path: 'c.txt', content: 'c' }).reply).text, /fenced/u);
  native.event({ kind: 'execution_succeeded' });
  const events = await ending;
  const items = events.flatMap((entry) => entry.event.type === 'item.completed' ? [entry.event.payload as { status: string; details?: unknown }] : []);
  assert.deepEqual(items.map((item) => [item.status, item.details]), [
    ['failed', { changes: [{ path: 'b.txt', changeKind: 'created' }] }], ['failed', undefined],
  ]);
  assert.equal(events.filter((entry) => entry.event.type === 'runtime.warning').length, 1);
  assert.equal(tools.calls.length, 2);
  await session.close({ reason: 'idle' });
});
