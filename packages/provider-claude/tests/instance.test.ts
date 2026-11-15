import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { AgentProviderSessionCleanupError, createAgentProviderRegistry, defineAgentProviderDriver } from '@agen-ai/agent-runtime';
import { NodeProviderCleanupError } from '@agen-ai/provider-tools';
import type { NodeProviderToolOwner } from '@agen-ai/provider-tools/node';
import { parseClaudeConfiguration } from '../src/node/options.js';
import { OWNED, scriptedTools } from './support/session.js';

const STUB = new URL('./support/process-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './process.js' && /\/src\/node\/instance\.[jt]s$/u.test(context.parentURL ?? '')) return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { materializeClaudeInstance } = await import('../src/node/instance.js');
const { workerControl } = await import('./support/process-stub.js');

async function instance(t: test.TestContext, openSession: NodeProviderToolOwner['openSession']) {
  const state = await mkdtemp(join(tmpdir(), 'claude-instance-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const disposals = { count: 0 };
  const owner: NodeProviderToolOwner = {
    platform: 'linux-x64', uid: 1000, gid: 1000, workspace: { storeDirectory: '/store', workspaceDirectory: '/store/work' },
    stateDirectory: state, nativeExecutablePath: '/claude', assertNativeUnchanged: async () => {},
    openSession, dispose: async () => { disposals.count += 1; },
  };
  const providerKey = parseAgentProviderKey('claude');
  const instanceId = parseAgentInstanceId('claude-instance-test');
  const driver = defineAgentProviderDriver({
    providerKey, supportsMultipleInstances: false, parseConfiguration: parseClaudeConfiguration,
    createInstance: (input) => materializeClaudeInstance({
      providerKey, instanceId: input.instanceId, model: input.configuration.model, sdkEntry: 'file:///unused-sdk.mjs', owner,
      options: { executablePath: '/claude', apiKey: 'fake-key', apiBaseUrl: 'http://127.0.0.1:9', tools: {} as never, usageLimits: {} }, onDisposed: () => {},
    }),
  });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: { model: 'claude-test' } }] });
  const open = (id = 1) => Promise.resolve(registry.requireInstance(instanceId).adapter.createSession({
    sessionId: parseAgentSessionId(`claude-session:${id}`), workingDirectory: '/store/work',
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('configuration:1') }, onBindingCreated: () => undefined,
  }));
  return { state, disposals, registry, open };
}

test('a failed opening whose worker survives stays owned by the instance until its original cleanup joins it', { timeout: 10_000 }, async (t) => {
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  const { state, disposals, registry, open } = await instance(t, async () => tools.tools);
  const failure = await open().then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgentProviderSessionCleanupError);
  assert.equal(workerControl.closes, 1);
  assert.equal(tools.closes, 1);
  const [retained, ...others] = await readdir(state);
  assert.match(retained ?? '', /^claude-session-/u);
  assert.deepEqual(others, []);

  await assert.rejects(open(), { code: 'session_active' });
  await assert.rejects(registry.dispose());
  assert.deepEqual([workerControl.closes, disposals.count], [2, 0]);
  assert.deepEqual(await readdir(state), [retained]);

  workerControl.alive = false;
  await failure.retryCleanup();
  assert.equal(workerControl.closes, 3);
  assert.deepEqual(await readdir(state), []);
  await registry.dispose();
  await failure.retryCleanup();
  assert.deepEqual([workerControl.closes, tools.closes, disposals.count], [3, 1, 1]);
});

test('the instance admits one live session, refuses a concurrent or second opening, and opens fresh after a close', async (t) => {
  Object.assign(workerControl, { alive: false, closes: 0, tools: OWNED });
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  const { state, registry, open } = await instance(t, async () => tools.tools);
  const [first, concurrent] = await Promise.allSettled([open(1), open(2)]);
  assert.equal(first.status, 'fulfilled');
  assert.ok(concurrent.status === 'rejected' && (concurrent.reason as { code?: string }).code === 'session_active');
  await assert.rejects(open(3), { code: 'session_active' });
  await first.value.close({ reason: 'idle' });
  assert.deepEqual(await readdir(state), []);
  const second = await open(4);
  assert.notEqual(second, first.value);
  await assert.rejects(open(5), { code: 'session_active' });
  await second.close({ reason: 'idle' });
  assert.deepEqual([workerControl.closes, tools.closes], [2, 2]);
  await registry.dispose();
});

test('a tool session whose helper could not be joined reaches the caller as a session cleanup failure with the owner retry', async (t) => {
  let retries = 0;
  const retryCleanup = async () => { retries += 1; };
  const { open, registry } = await instance(t, async () => {
    throw new NodeProviderCleanupError({ message: 'helper retained', cause: new Error('not ready'), cleanupError: new Error('unjoined'), retryCleanup });
  });
  const failure = await open().then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgentProviderSessionCleanupError);
  await failure.retryCleanup();
  assert.equal(retries, 1);
  await registry.dispose();
});
