import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAgentTurnId, type AgentEvent } from '@agen-ai/agent-protocol';
import { nodeProviderToolDefinitions } from '@agen-ai/provider-tools/node';
import { WorkerFailure } from '../dist/node/errors.js';
import type { WorkerEvent } from '../dist/node/process.js';
import { toolCallBytes } from '../dist/node/toolInput.js';
import { answer, APPROVE, commandTools, openValidatedSession, scriptedTools, startText } from './support/session.js';
import { launch } from './support/worker.js';

test('tool input accounting matches JSON UTF-8 escaping at the exact admission boundary', () => {
  const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join('');
  for (const input of [{ text, optional: undefined }, { '\u0000"\\': ['界😀\ud800x\udfff', null, true, false, -0, 1e30] }]) {
    const bytes = Buffer.byteLength(`${JSON.stringify(input)}\n`);
    assert.equal(toolCallBytes(input, bytes), bytes);
    assert.throws(() => toolCallBytes(input, bytes - 1), /byte budget/u);
  }
});

function collect() {
  const events: WorkerEvent[] = [];
  const waiters: Array<{ type: WorkerEvent['type']; resolve: (event: WorkerEvent) => void }> = [];
  return {
    events,
    listener(event: WorkerEvent) {
      events.push(event);
      for (const waiter of waiters.filter((candidate) => candidate.type === event.type)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    },
    next<Type extends WorkerEvent['type']>(type: Type): Promise<Extract<WorkerEvent, { type: Type }>> {
      const found = events.find((event) => event.type === type);
      if (found) return Promise.resolve(found as Extract<WorkerEvent, { type: Type }>);
      return new Promise((resolve) => { waiters.push({ type, resolve: resolve as (event: WorkerEvent) => void }); });
    },
  };
}

test('the worker proves the exact owned server, relays one owned call and closes with a receipt', async () => {
  const run = await launch('turn');
  try {
    const { worker, tools } = await run.started;
    assert.deepEqual([...tools].sort(), nodeProviderToolDefinitions().map((definition) => `mcp__agenai__${definition.name}`).sort());
    const seen = collect();
    worker.listen(seen.listener);
    worker.send({ type: 'prompt', text: 'go' });
    const call = await seen.next('tool_call');
    assert.deepEqual(call, { type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'echo hi' }, nativeRef: 'toolu_1' });
    worker.send({ type: 'tool_result', callId: 'call-1', text: 'hi', isError: false });
    assert.deepEqual(await seen.next('assistant_text'), { type: 'assistant_text', complete: true, text: 'tool said: hi' });
    assert.deepEqual(await seen.next('result'), {
      type: 'result', subtype: 'success', isError: false, denials: [], resultIndex: null, usage: null, modelUsage: null,
    });
    await worker.close();
    assert.deepEqual(seen.events.at(-1), { type: 'closed', children: [] });
    assert.equal(seen.events.some((event) => event.type === 'failed' || event.type === 'transport_failed'), false);
  } finally { await run.cleanup(); }
});

const counts = (input: number, cacheRead: number, cache5m: number, cache1h: number, output: number) =>
  ({ input, cacheRead, cacheCreation: cache5m + cache1h, cache5m, cache1h, output });

test('Claude result usage crosses the worker as bounded counters, keeping invalid and over-capacity reports distinguishable', async (t) => {
  const expected = {
    'usage-two-turn': { resultIndex: 0, usage: counts(10, 100, 1000, 0, 1), modelUsage: { entries: 1, models: [{ model: 'usage-two-turn', ...counts(10, 100, 1000, 0, 1) }] } },
    'usage-unsplit': { resultIndex: 0, usage: { ...counts(10, 100, 0, 0, 1), cacheCreation: 1000, cache5m: null, cache1h: null },
      modelUsage: { entries: 1, models: [{ model: 'usage-unsplit', ...counts(10, 100, 600, 0, 1), cacheCreation: 1000, cache1h: null }] } },
    'usage-invalid': { resultIndex: 0, usage: { ...counts(10, 100, 1000, 0, 1), input: 'invalid' },
      modelUsage: { entries: 1, models: [{ model: 'usage-invalid', ...counts(10, 100, 1000, 0, 1) }] } },
    'usage-models': { resultIndex: 0, usage: counts(10, 0, 0, 0, 1),
      modelUsage: { entries: 9, models: Array.from({ length: 8 }, (_, index) => ({ model: `model-${index}`, ...counts(1, 0, 0, 0, 1) })) } },
  };
  for (const [script, fields] of Object.entries(expected)) {
    const run = await launch(script);
    t.after(run.cleanup);
    const { worker } = await run.started;
    t.after(() => worker.close());
    const seen = collect();
    worker.listen(seen.listener);
    worker.send({ type: 'prompt', text: 'go' });
    assert.deepEqual(await seen.next('result'), { type: 'result', subtype: 'success', isError: false, denials: [], ...fields });
  }
});

test('admitted Unicode prompts and escaped tool results complete through the real worker', { timeout: 10_000 }, async (t) => {
  const run = await launch('wire');
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const result = '\0'.repeat(50_000);
  const tools = scriptedTools(async (call) => {
    call.observer.started({ kind: 'command', command: 'echo hi' });
    return { tool: 'bash', status: 'completed', text: result, isError: false, changes: [] };
  });
  const session = await openValidatedSession({ worker, tools: tools.tools, model: 'wire' });
  const texts = ['界'.repeat(50_000), '\0'.repeat(50_000)];
  const execution = session.startTurn({ turnId: parseAgentTurnId('turn-wire'), interactionMode: 'default',
    parts: texts.map((text) => ({ type: 'text', text })) });
  const events: AgentEvent[] = [];
  for await (const output of execution.outputs) if (output.kind === 'event') events.push(output.event);
  assert.equal(events.find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  const receivedDigest = createHash('sha256').update(texts.join('\n\n')).update(result).digest('hex');
  assert.ok(events.some((event) => event.type === 'content.delta' && event.payload.delta === receivedDigest));
  assert.equal(tools.calls.length, 1);
  await session.close({ reason: 'idle' });
});

test('a long native text block arrives intact as one completed assistant item', { timeout: 10_000 }, async (t) => {
  const run = await launch('text');
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const session = await openValidatedSession({ worker, tools: scriptedTools(async () => { throw new Error('No tool expected'); }).tools, model: 'text' });
  const parts = [`${'a'.repeat(3_999)}😀${'\0'.repeat(5_000)}`, '界'.repeat(35_000), '界'.repeat(35_000)];
  const text = parts.join('\n\n');
  const events: AgentEvent[] = [];
  const execution = session.startTurn({ turnId: parseAgentTurnId('long-text'), interactionMode: 'default', parts: parts.map((text) => ({ type: 'text', text })) });
  for await (const output of execution.outputs) if (output.kind === 'event') events.push(output.event);
  const deltas = events.filter((event) => event.type === 'content.delta');
  assert.equal(deltas.map((event) => event.payload.delta).join(''), text);
  assert.ok(deltas.every((event) => event.payload.delta.isWellFormed()));
  assert.equal(events.filter((event) => event.type === 'item.started').length, 1);
  assert.equal(events.filter((event) => event.type === 'item.completed').length, 1);
  assert.equal(events.at(-1)?.type, 'turn.completed');
  assert.equal(events.find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  await session.close({ reason: 'idle' });
});

test('large owned inputs arrive intact and an oversize patch refuses without poisoning the next call', { timeout: 30_000 }, async (t) => {
  const run = await launch('tool-input');
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const tools = scriptedTools(async (call) => {
    assert.ok(call.tool === 'write' || call.tool === 'edit');
    const input = call.input as { file_path: string; content?: string; old_string?: string; new_string?: string };
    const strings = [input.content, input.old_string, input.new_string].filter((value): value is string => value !== undefined);
    return { tool: call.tool, status: 'completed', text: strings.map((value) => createHash('sha256').update(value).digest('hex')).join(','),
      isError: false, changes: [] };
  });
  const session = await openValidatedSession({ worker, tools: tools.tools, model: 'tool-input' });
  const events: AgentEvent[] = [];
  for await (const output of startText(session, 'large-input').outputs) if (output.kind === 'event') events.push(output.event);
  assert.equal(events.find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  const results = JSON.parse(events.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join('')) as
    Array<{ content: Array<{ text: string }>; isError: boolean }>;
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  assert.deepEqual(results.map((result) => result.isError), [false, false, false, true, false]);
  assert.deepEqual(results.filter((result) => !result.isError).map((result) => result.content[0]?.text), [
    digest('x'.repeat(1_048_576)), digest('\0'.repeat(8_388_608)),
    [digest('\0'.repeat(8_388_608)), digest('\x01'.repeat(8_388_608))].join(','), digest('still usable'),
  ]);
  assert.match(results[3]!.content[0]!.text, /input.*byte.*budget/u);
  assert.deepEqual(tools.calls.map((call) => call.tool), ['write', 'write', 'edit', 'write']);
  await session.close({ reason: 'idle' });
});

test('pending tool calls share one byte budget and settlement releases capacity', { timeout: 30_000 }, async (t) => {
  const run = await launch('tool-budget');
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const seen = collect();
  const calls: string[] = [];
  const texts: string[] = [];
  worker.listen((event) => {
    seen.listener(event);
    if (event.type === 'tool_call') {
      calls.push(event.callId);
      if (calls.length === 2) worker.send({ type: 'tool_result', callId: event.callId, text: 'retry completed', isError: false });
    }
    if (event.type === 'assistant_text') {
      texts.push(event.text);
      if (texts.length === 1) worker.send({ type: 'tool_result', callId: calls[0]!, text: 'first completed', isError: false });
    }
  });
  worker.send({ type: 'prompt', text: 'go' });
  assert.equal((await seen.next('result')).isError, false);
  assert.deepEqual(calls, ['call-1', 'call-3']);
  assert.deepEqual(JSON.parse(texts[0]!), { content: [{ type: 'text', text: 'Owned tool input exceeds the pending byte budget. Split large patches into smaller calls.' }], isError: true });
  assert.deepEqual(JSON.parse(texts[1]!), [
    { content: [{ type: 'text', text: 'first completed' }], isError: false },
    { content: [{ type: 'text', text: 'retry completed' }], isError: false },
  ]);
});

test('a local encoding failure emits one transport failure and fences further sends', { timeout: 10_000 }, async (t) => {
  const run = await launch('turn');
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const seen = collect();
  worker.listen(seen.listener);
  assert.throws(() => worker.send({ type: 'prompt', text: '\0'.repeat(1_048_576) }), WorkerFailure);
  assert.equal(seen.events.filter((event) => event.type === 'transport_failed').length, 1);
  assert.throws(() => worker.send({ type: 'prompt', text: 'again' }), WorkerFailure);
  assert.equal(seen.events.filter((event) => event.type === 'transport_failed').length, 1);
});

// The configured model doubles as the script name; every script then calls the owned bash tool and approves it.
for (const [script, drift] of [['model-drift', true], ['plan-status', true], ['model-fallback', true], ['status-default', false]] as const) {
  test(`the worker carries Claude's ${script} observation to the session, which ${drift ? 'fails the turn before the command enters' : 'runs the approved command'}`, async () => {
    const run = await launch(script);
    try {
      const { worker } = await run.started;
      const marker = join(run.directory, 'marker');
      const tools = commandTools(() => writeFile(marker, 'ran\n'));
      const session = await openValidatedSession({ worker, tools: tools.tools, model: script });
      const execution = startText(session, 'turn-1');
      let completed: Extract<AgentEvent, { type: 'turn.completed' }> | undefined;
      for await (const output of execution.outputs) {
        if (output.kind !== 'event') continue;
        if (output.event.type === 'request.opened') await answer(execution, output.event.payload.request, APPROVE);
        if (output.event.type === 'turn.completed') completed = output.event;
      }
      await session.close({ reason: drift ? 'error' : 'idle' });
      assert.equal(completed?.payload.outcome, drift ? 'failed' : 'completed');
      assert.equal(completed?.payload.error?.code, drift ? 'claude_configuration_drift' : undefined);
      assert.equal(tools.calls.length, drift ? 0 : 1);
      if (drift) await assert.rejects(access(marker), { code: 'ENOENT' });
      else assert.equal(await readFile(marker, 'utf8'), 'ran\n');
      assert.equal(tools.closes, 1);
    } finally { await run.cleanup(); }
  });
}

for (const [budget, outcome] of [[undefined, 'completed'], [0.25, 'failed']] as const) {
  test(`a session ${budget ? 'with' : 'without'} a cost budget gives the SDK query ${budget ? 'that budget, and its spending ends the turn as an execution limit' : 'none'}`, async () => {
    const run = await launch('budget', budget === undefined ? {} : { maxBudgetUsd: budget });
    try {
      const { worker } = await run.started;
      const tools = commandTools();
      const session = await openValidatedSession({ worker, tools: tools.tools, model: 'budget' });
      const events: AgentEvent[] = [];
      for await (const output of startText(session, 'turn-1').outputs) if (output.kind === 'event') events.push(output.event);
      await session.close({ reason: 'idle' });
      const completed = events.find((event) => event.type === 'turn.completed');
      assert.ok(events.some((event) => event.type === 'content.delta' && event.payload.delta === `budget ${budget ?? 'none'}`));
      assert.equal(completed?.payload.outcome, outcome);
      assert.deepEqual(completed?.payload.outcome === 'failed' && [completed.payload.error.category, completed.payload.error.code],
        budget === undefined ? false : ['execution_limit', 'claude_max_budget_usd']);
    } finally { await run.cleanup(); }
  });
}

test('a worker without exactly the owned connected server never becomes ready', async () => {
  const run = await launch('no-server');
  try {
    await assert.rejects(run.started, (error: unknown) => error instanceof WorkerFailure && error.stage === 'startup'
      && /Owned tool server is not exactly connected/u.test(error.message));
  } finally { await run.cleanup(); }
});

test('a worker that dies mid-turn is reported once as a transport failure', async () => {
  const run = await launch('crash');
  try {
    const { worker } = await run.started;
    const seen = collect();
    worker.listen(seen.listener);
    worker.send({ type: 'prompt', text: 'go' });
    const failure = await seen.next('transport_failed');
    assert.ok(failure.error instanceof WorkerFailure && failure.error.stage === 'transport');
    assert.throws(() => worker.send({ type: 'prompt', text: 'again' }), WorkerFailure);
    await worker.close();
  } finally { await run.cleanup(); }
});

test('an oversize worker line fails the transport instead of being buffered', async () => {
  const run = await launch('oversize');
  try {
    const { worker } = await run.started;
    const seen = collect();
    worker.listen(seen.listener);
    worker.send({ type: 'prompt', text: 'go' });
    const failure = await seen.next('transport_failed');
    assert.match(String((failure.error.cause as Error | undefined)?.message), /byte bound/u);
    await worker.close();
  } finally { await run.cleanup(); }
});

test('closing joins descendants left in the worker process group', async () => {
  const run = await launch('orphan');
  try {
    const { worker } = await run.started;
    worker.listen(() => {});
    let pid = Number.NaN;
    for (let attempt = 0; attempt < 100 && !Number.isInteger(pid); attempt += 1) {
      pid = Number.parseInt(await readFile(join(run.temporary, 'orphan.pid'), 'utf8').catch(() => ''), 10);
      if (!Number.isInteger(pid)) await delay(20);
    }
    assert.ok(Number.isInteger(pid));
    await worker.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await run.cleanup(); }
});
