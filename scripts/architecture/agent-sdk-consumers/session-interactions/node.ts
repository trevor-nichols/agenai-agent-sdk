import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionDecisionChoiceId, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderRegistry, type AgentProviderSession, type AgentSessionInteraction } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { createControlledPeerOwner } from './controlled-owner.js';
import { proveRegistryStartupCleanup } from './registry-cleanup.js';

const consumerRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot);
const entrypoints: Record<string, string> = {};
for (const name of ['@agen-ai/agent-protocol', '@agen-ai/agent-runtime', '@agen-ai/provider-acp/node']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep));
  assert.ok(!resolved.startsWith(privateRoot + sep));
  entrypoints[name] = resolved;
}
interface Frame { readonly id?: string | number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown }
interface Entry { readonly pid?: number; readonly args?: readonly string[]; readonly direction?: string; readonly frame?: Frame }
const scenarios = [];
for (const mode of ['answer', 'pending'] as const) {
  const root = await mkdtemp(join(tmpdir(), 'agenai-packed-session-node-'));
  const executable = join(root, 'peer.mjs');
  const log = join(root, 'peer.jsonl');
  const node = await realpath(process.execPath);
  assert.doesNotMatch(node, /\s/u);
  await writeFile(executable, `#!${node}\n${await readFile(join(consumerRoot, 'session-interaction-peer.mjs'), 'utf8')}`);
  await chmod(executable, 0o700);
  await writeFile(log, '');
  const entries = async (): Promise<Entry[]> => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry);
  const instanceId = parseAgentInstanceId(`packed-node-${mode}`);
  const launch = { executable, args: ['agent', '--no-leader', 'stdio'], cwd: root, shutdownTimeoutMs: 1_000,
    env: { PACKED_INTERACTION_MODE: mode, PACKED_INTERACTION_LOG: log } };
  const owner = createControlledPeerOwner(launch);
  const driver = createNodeAcpProviderDriver({ providerKey: 'packed-node-interactions', sessionInteractions: { mapping: 'grok-folder-trust-v1' },
    executionBoundary: owner.boundary, launch, limits: { initializationTimeoutMs: 3_000 },
  });
  let registry: AgentProviderRegistry | undefined;
  let session: AgentProviderSession | undefined;
  let handle: AgentSessionInteraction | undefined;
  let callbacks = 0;
  let publish!: () => void;
  const publication = new Promise<void>((resolve) => { publish = resolve; });
  let complete = false;
  let publicationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }] });
    session = await registry.requireInstance(instanceId).adapter.createSession({ sessionId: parseAgentSessionId(`packed-logical-${mode}`),
      workingDirectory: root, configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('packed-node:configuration') }, onBindingCreated() {},
      signal: AbortSignal.timeout(3_000), interactions: { onRequest(value) { callbacks += 1; handle = value; publish(); } },
    });
    try {
      await Promise.race([publication, new Promise<never>((_resolve, reject) => {
        publicationTimer = setTimeout(() => reject(new Error('Controlled peer did not publish its session decision.')), 3_000);
      })]);
    } finally { if (publicationTimer) clearTimeout(publicationTimer); }
    assert.ok(handle);
    assert.deepEqual(handle.request.target, { kind: 'workspace', path: `${root}/configuration` });
    assert.notEqual(handle.request.requestId, 'packed-native-question');
    if (mode === 'answer') {
      const choiceId = parseAgentSessionDecisionChoiceId('grant');
      assert.deepEqual(await handle.respond({ choiceId }), { status: 'delivered' });
      assert.deepEqual(await handle.terminal, { kind: 'answered', choiceId });
      const deadline = Date.now() + 3_000;
      while (!(await entries()).some((entry) => entry.direction === 'inbound' && entry.frame?.id === 'packed-native-question')) {
        if (Date.now() >= deadline) throw new Error('Controlled peer did not observe its correlated reply.');
        await delay(5);
      }
    }
    await session.close({ reason: 'shutdown' });
    const start = (await entries())[0];
    assert.ok(start?.pid);
    assert.throws(() => process.kill(start.pid!, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(-start.pid!, 0), { code: 'ESRCH' });
    assert.deepEqual(owner.observations(), { reservations: 1, starts: 1, joinedReleases: 1 });
    if (mode === 'pending') {
      assert.deepEqual(await handle.terminal, { kind: 'session_closed' });
      const late = await handle.respond({ choiceId: parseAgentSessionDecisionChoiceId('decline') });
      assert.equal(late.status, 'rejected');
      if (late.status !== 'rejected') throw new Error('A closed session must refuse late answers.');
      assert.deepEqual([late.requestState, late.error.code], ['unavailable', 'session_interaction_unavailable']);
    }
    await registry.dispose();
    const trace = await entries();
    assert.deepEqual(start.args, ['agent', '--no-leader', 'stdio']);
    const inbound = trace.flatMap((entry) => entry.direction === 'inbound' && entry.frame ? [entry.frame] : []);
    const initialize = inbound.find((frame) => frame.method === 'initialize');
    assert.deepEqual((initialize?.params?.clientCapabilities as Record<string, unknown>)?._meta, { 'x.ai/folderTrust': { interactive: true } });
    const replies = inbound.filter((frame) => frame.id === 'packed-native-question' && frame.result !== undefined);
    assert.deepEqual(replies, mode === 'answer' ? [{ jsonrpc: '2.0', id: 'packed-native-question', result: { outcome: 'trust' } }] : []);
    const prompts = inbound.filter((frame) => frame.method === 'session/prompt').length;
    assert.deepEqual([callbacks, prompts], [1, 0]);
    scenarios.push({ scenario: mode, callbacks, nativeReplies: replies.length, nativePromptFrames: prompts, sdkTurns: 0, childAndGroupGone: true, effect: 'not_performed' });
    complete = true;
  } finally {
    if (publicationTimer) clearTimeout(publicationTimer);
    try { await session?.close({ reason: 'shutdown' }); }
    finally { await registry?.dispose(); }
    if (complete) await rm(root, { recursive: true });
  }
}
const startupCleanup = await proveRegistryStartupCleanup(await realpath(process.execPath), consumerRoot);
process.stdout.write(JSON.stringify({ proof: 'packed-controlled-node-session-interactions', evidence: 'synthetic',
  executionBoundary: 'controlled-single-child', entrypoints, scenarios, startupCleanup }) + '\n');
