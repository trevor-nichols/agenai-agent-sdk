import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeProviderToolDefinitions } from '@agen-ai/provider-tools/node';
import { OWNED_TOOLS } from '../src/node/config.js';
import { openPluginEndpoint, type EndpointSignal } from '../src/node/endpoint.js';
import plugin from '../src/node/plugin.js';
import { pluginContext } from './support/plugin.js';

const TOKEN = 't'.repeat(43);
const NONCE = 'n'.repeat(43);

async function endpoint(t: test.TestContext, nonce = NONCE) {
  const opened = await openPluginEndpoint({ token: TOKEN, nonce, tools: OWNED_TOOLS });
  t.after(() => opened.close());
  return opened;
}

const options = (port: number, overrides: Record<string, unknown> = {}) =>
  ({ port, token: TOKEN, nonce: NONCE, provider: 'anthropic', tools: nodeProviderToolDefinitions(), ...overrides });
const context = (id: string, signal = new AbortController().signal) => ({ sessionID: 'ses_1', messageID: 'msg_1', id, signal });

test('setup replaces the complete native inventory with the seven owned tools before acknowledging readiness', async (t) => {
  const broker = await endpoint(t);
  const native = pluginContext(options(broker.port));
  await plugin.setup(native.ctx as never);
  await broker.ready;
  assert.deepEqual([...native.tools.keys()].sort(), [...OWNED_TOOLS].sort());
  assert.deepEqual([...native.providers], ['anthropic']);
  assert.deepEqual([native.servers.size, native.skills.size], [0, 0]);
  for (const rules of native.agents.values()) {
    assert.deepEqual(rules, [{ action: '*', resource: '*', effect: 'deny' }, { action: 'agenai.tool', resource: '*', effect: 'allow' }]);
  }
  assert.throws(() => native.hooks.get('execute.before')?.({ tool: 'shell' }), /AgenAI-owned/u);
  native.hooks.get('execute.before')?.({ tool: 'agenai_bash' });
  const asked = { action: 'external_directory', effect: 'ask' };
  native.hooks.get('evaluate')?.(asked);
  assert.equal(asked.effect, 'deny');
  const retry: { decision?: unknown } = {};
  native.hooks.get('retry')?.(retry);
  assert.deepEqual(retry.decision, { retry: false });
  assert.throws(() => native.hooks.get('experimental.ws.handshake')?.({}), /HTTP/u);
});

test('a native tool that survives replacement refuses readiness', async (t) => {
  const broker = await endpoint(t);
  const native = pluginContext(options(broker.port), { pinned: ['question'] });
  await assert.rejects(plugin.setup(native.ctx as never), /refused setup: inventory/u);
  await assert.rejects(broker.ready, /refused setup \(inventory\)/u);
});

test('another runtime version refuses readiness', async (t) => {
  const broker = await endpoint(t);
  await assert.rejects(plugin.setup(pluginContext(options(broker.port), { version: '2.2.8' }).ctx as never), /refused setup: version/u);
  await assert.rejects(broker.ready, /refused setup \(version\)/u);
});

test('an acknowledgement without this session\'s nonce or token is not readiness', async (t) => {
  const stale = await endpoint(t, 'x'.repeat(43));
  await plugin.setup(pluginContext(options(stale.port)).ctx as never);
  await assert.rejects(stale.ready, /exact owned inventory/u);
  const forged = await endpoint(t);
  await plugin.setup(pluginContext(options(forged.port, { token: 'f'.repeat(43) })).ctx as never);
  await assert.rejects(forged.ready, /unauthenticated/u);
});

test('owned tools forward native identities, return results and send cancellation', async (t) => {
  const broker = await endpoint(t);
  const native = pluginContext(options(broker.port));
  await plugin.setup(native.ctx as never);
  await broker.ready;
  const signals: EndpointSignal[] = [];
  const fourth = Promise.withResolvers<void>();
  broker.listen((signal) => {
    signals.push(signal);
    if (signals.length === 4) fourth.resolve();
    if (signal.type !== 'call') return;
    if (signal.call.tool === 'read') broker.reply(signal.call.id, { text: 'contents', isError: false });
    if (signal.call.tool === 'bash') broker.reply(signal.call.id, { text: 'Command denied.', isError: true });
  });
  assert.deepEqual(await native.run('agenai_read', { file_path: 'a.txt' }, { file_path: 'a.txt' }, context('toolu_1')), { content: 'contents' });
  await assert.rejects(native.run('agenai_bash', { command: 'pwd' }, { command: 'pwd' }, context('toolu_2')), /^Error: Command denied\.$/u);
  const abort = new AbortController();
  const write = { file_path: 'a.txt', content: 'x' };
  const pending = native.run('agenai_write', write, write, context('toolu_3', abort.signal));
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await fourth.promise;
  assert.deepEqual(signals.map((signal) => signal.type === 'call' ? [signal.call.tool, signal.call.callID, signal.call.sessionID] : [signal.type]), [
    ['read', 'toolu_1', 'ses_1'], ['bash', 'toolu_2', 'ses_1'], ['write', 'toolu_3', 'ses_1'], ['cancel'],
  ]);
  broker.reply(3, { text: 'Canceled.', isError: true });
  await assert.rejects(pending, /Canceled/u);
});

// OpenCode decodes against the declared schema and drops undeclared fields before `execute`; the broker must judge the original.
test('owned tools forward the complete input OpenCode observed before decoding, and nothing without it', async (t) => {
  const broker = await endpoint(t);
  const native = pluginContext(options(broker.port));
  await plugin.setup(native.ctx as never);
  await broker.ready;
  const received: unknown[] = [];
  broker.listen((signal) => {
    if (signal.type !== 'call') return;
    received.push(signal.call.input);
    broker.reply(signal.call.id, { text: 'Tool call refused: invalid input.', isError: true });
  });
  const calls = [
    ['read', { file_path: '.env', bogus: true }, { file_path: '.env' }],
    ['write', { file_path: 'w.txt', content: 'w', mode: 'append' }, { file_path: 'w.txt', content: 'w' }],
    ['bash', { command: 'pwd', description: 'where' }, { command: 'pwd' }],
    ['patch', { changes: [{ file_path: 'a.txt', content: 'x', rename_to: 'b.txt' }] }, { changes: [{ file_path: 'a.txt', content: 'x' }] }],
    ['patch', { changes: [{ file_path: 'a.txt', content: 'x' }], dry_run: true }, { changes: [{ file_path: 'a.txt', content: 'x' }] }],
  ] as const;
  for (const [index, [tool, raw, decoded]] of calls.entries()) {
    await assert.rejects(native.run(`agenai_${tool}`, raw, decoded, context(`toolu_${index}`)), /invalid input/u);
  }
  assert.deepEqual(received, calls.map(([, raw]) => raw));
  await assert.rejects(native.tools.get('agenai_read')!.execute!({ file_path: 'a.txt' }, context('toolu_unseen')), /complete input/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, calls.length);
});

test('an output bound reaches every model request kind as its maxTokens, and never raises a smaller one', async (t) => {
  const broker = await endpoint(t);
  const native = pluginContext(options(broker.port, { maxOutputTokens: 4_096 }));
  await plugin.setup(native.ctx as never);
  await broker.ready;
  for (const kind of ['context', 'compaction', 'generate', 'title']) {
    const seen = [{ maxTokens: 32_000 }, {}, { maxTokens: 1_000, temperature: 0 }].map((requested) => {
      const event: { options?: Record<string, unknown> } = { options: requested };
      native.hooks.get(kind)?.(event);
      return event.options;
    });
    assert.deepEqual(seen, [{ maxTokens: 4_096 }, { maxTokens: 4_096 }, { maxTokens: 1_000, temperature: 0 }], kind);
  }
});

test('without an output bound no request options are touched, and an invalid bound refuses setup', async (t) => {
  const unbounded = pluginContext(options((await endpoint(t)).port));
  await plugin.setup(unbounded.ctx as never);
  assert.deepEqual(['context', 'compaction', 'generate', 'title'].filter((kind) => unbounded.hooks.has(kind)), []);
  for (const maxOutputTokens of [0, 1.5, 256_001, '4096']) {
    const broker = await endpoint(t);
    await assert.rejects(plugin.setup(pluginContext(options(broker.port, { maxOutputTokens })).ctx as never), /refused setup: setup/u);
  }
});
