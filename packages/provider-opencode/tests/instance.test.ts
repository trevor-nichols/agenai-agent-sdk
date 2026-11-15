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
import { parseOpenCodeConfiguration } from '../src/node/options.js';
import { scriptedTools } from './support/session.js';

const STUB = new URL('./support/native-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './native.js' && /\/src\/node\/instance\.[jt]s$/u.test(context.parentURL ?? '')) return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { materializeOpenCodeInstance } = await import('../src/node/instance.js');
const { nativeControl } = await import('./support/native-stub.js');

async function instance(t: test.TestContext, openSession: NodeProviderToolOwner['openSession']) {
  const state = await mkdtemp(join(tmpdir(), 'opencode-instance-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const disposals = { count: 0 };
  const owner: NodeProviderToolOwner = {
    platform: 'linux-x64', uid: 1000, gid: 1000, workspace: { storeDirectory: '/store', workspaceDirectory: '/store/work' },
    stateDirectory: state, nativeExecutablePath: '/opencode', assertNativeUnchanged: async () => {},
    openSession, dispose: async () => { disposals.count += 1; },
  };
  const providerKey = parseAgentProviderKey('opencode');
  const instanceId = parseAgentInstanceId('opencode-instance-test');
  const driver = defineAgentProviderDriver({
    providerKey, supportsMultipleInstances: false, parseConfiguration: parseOpenCodeConfiguration,
    createInstance: (input) => materializeOpenCodeInstance({
      providerKey, instanceId: input.instanceId, model: input.configuration.model, owner,
      options: { executablePath: '/opencode', provider: 'openai', apiKey: 'fake-key', apiBaseUrl: 'http://127.0.0.1:9', tools: {} as never, usageLimits: {} },
      onDisposed: () => {},
    }),
  });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: { model: 'gpt-test' } }] });
  const open = (workingDirectory = '/store/work') => Promise.resolve(registry.requireInstance(instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('opencode-session:1'), workingDirectory, approvalPolicy: { kind: 'provider_accept_edits' },
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('configuration:1') }, onBindingCreated: () => undefined,
  }));
  return { state, disposals, registry, open };
}

test('a failed opening whose server survives stays owned until its original cleanup joins it', { timeout: 10_000 }, async (t) => {
  Object.assign(nativeControl, { mode: 'retained', alive: true, closes: 0, openings: [] });
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  const { state, disposals, registry, open } = await instance(t, async () => tools.tools);
  const failure = await open().then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgentProviderSessionCleanupError);
  assert.deepEqual([nativeControl.closes, tools.closes], [2, 1]);
  const [retained, ...others] = await readdir(state);
  assert.match(retained ?? '', /^oc-/u);
  assert.deepEqual(others, []);

  await assert.rejects(open(), { code: 'session_active' });
  await assert.rejects(registry.dispose());
  assert.deepEqual([nativeControl.closes, disposals.count, nativeControl.openings.length], [3, 0, 1]);
  assert.deepEqual(await readdir(state), [retained]);

  nativeControl.alive = false;
  await failure.retryCleanup();
  assert.deepEqual(await readdir(state), []);
  await registry.dispose();
  assert.deepEqual([nativeControl.closes, tools.closes, disposals.count], [4, 1, 1]);
});

test('sessions open fresh one at a time and each removes its private layout when closed', async (t) => {
  Object.assign(nativeControl, { mode: 'open', alive: false, closes: 0, openings: [] });
  const tools = scriptedTools(async () => { throw new Error('unused'); });
  const editApprovals: string[] = [];
  const { state, registry, open } = await instance(t, async (options) => { editApprovals.push(options.editApproval); return tools.tools; });
  await assert.rejects(open('/elsewhere'), { code: 'invalid_session' });
  const first = await open();
  await assert.rejects(open(), { code: 'session_active' });
  assert.equal((await readdir(state)).length, 1);
  await first.close({ reason: 'idle' });
  assert.deepEqual(await readdir(state), []);
  const second = await open();
  assert.deepEqual(second.approvalPolicy, { policy: { kind: 'provider_accept_edits' }, verification: 'controlled_configuration' });
  await second.close({ reason: 'idle' });
  assert.deepEqual(editApprovals, ['automatic', 'automatic']);
  const [opening] = nativeControl.openings;
  assert.deepEqual([opening?.executable, opening?.provider, opening?.model, opening?.apiKey, opening?.apiBaseUrl, opening?.tools.length],
    ['/opencode', 'openai', 'gpt-test', 'fake-key', 'http://127.0.0.1:9', 7]);
  assert.notEqual(nativeControl.openings[0]?.layout.root, nativeControl.openings[1]?.layout.root);
  assert.deepEqual(await readdir(state), []);
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
