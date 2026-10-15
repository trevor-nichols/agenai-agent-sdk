import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentConfigurationRevisionId, parseAgentSessionDecisionChoiceId, parseAgentSessionDecisionRequest,
  parseAgentSessionId,
} from '@agen-ai/agent-protocol';
import {
  AGENT_HOST_TOOL_SCHEMA_DIALECT, createAgentProviderRegistry, createAgentProviderSessionCleanupError,
  AgentProviderSessionCleanupError, isAgentProviderSessionCleanupErrorFor, type AgentSessionInteraction,
  type AgentSessionInteractionTerminal, type AgentSessionHostBinding,
} from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';

const consumerRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot);
const entrypoints: Record<string, string> = {};
for (const name of ['@agen-ai/validation', '@agen-ai/agent-protocol', '@agen-ai/agent-runtime', '@agen-ai/agent-runtime/testing']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep));
  assert.ok(!resolved.startsWith(privateRoot + sep));
  entrypoints[name] = resolved;
}
for (const name of ['@agen-ai/provider-acp', '@agen-ai/acp-transport', '@agen-ai/acp-registry', '@agen-ai/agent-orchestration']) {
  assert.throws(() => import.meta.resolve(name), { code: 'ERR_MODULE_NOT_FOUND' }, `${name} must not be installed in the core-only consumer.`);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const choiceId = parseAgentSessionDecisionChoiceId('decline');
const scenarios = [];
for (const mode of ['pending-close', 'returned-cleanup', 'opening-cleanup'] as const) {
  const fake = createFakeAgentProvider({ providerKey: `packed-core-${mode}`, instanceId: `packed-core-${mode}:primary` });
  const hostFinished = deferred<void>();
  const producerFinished = deferred<void>();
  const retryEntered = deferred<void>();
  const terminal = deferred<AgentSessionInteractionTerminal>();
  const lifetime = new AbortController();
  const nativeFailure = new Error('The controlled producer is not quiescent yet.');
  let openings = 0;
  let answers = 0;
  let nativeCloses = 0;
  let hostReleases = 0;
  let callbacks = 0;
  let callbackCompleted = false;
  let handle: AgentSessionInteraction | undefined;
  const hostBinding: AgentSessionHostBinding = {
    bindingId: `packed-core-${mode}`, tools: [{ name: 'Inspect', description: 'Inspect controlled host state.', inputSchema: {
      $schema: AGENT_HOST_TOOL_SCHEMA_DIALECT, type: 'object', properties: {}, additionalProperties: false,
    } }], invoke: () => ({ kind: 'success', value: null }), release() { hostReleases += 1; },
  };
  const driver = { ...fake.driver, async materialize(definition: Parameters<typeof fake.driver.materialize>[0]) {
    const instance = await fake.driver.materialize(definition);
    const adapter = instance.adapter;
    return { ...instance, adapter: { ...adapter, hostBinding: { kind: 'supported' as const, toolTransport: 'callback' as const,
      instructionPlacements: ['tool_context'] as const }, sessionInteractions: { kind: 'supported' as const,
      openingOperations: ['create'] as const, requestKinds: ['decision'] as const, producerOwnership: 'exclusive' as const },
      async createSession(input: Parameters<typeof adapter.createSession>[0]) {
        openings += 1;
        const candidate = await adapter.createSession(input);
        assert.ok(input.interactions);
        const callback = Promise.resolve(input.interactions.onRequest({
          request: parseAgentSessionDecisionRequest({ kind: 'decision', requestId: 'packed-decision', sessionId: input.sessionId,
            title: 'Keep configuration gated?', target: { kind: 'workspace', path: '/packed-core/configuration' },
            expiresAt: new Date(Date.now() + 60_000).toISOString(), choices: [{ choiceId, label: 'Keep gated',
              description: 'Keep controlled configuration gated.', consequence: { kind: 'decline', configuration: 'remains_gated' } }] }),
          signal: lifetime.signal, terminal: terminal.promise,
          async respond() { answers += 1; throw new Error('Cleanup must not select a choice.'); },
        }));
        void callback.catch(() => {});
        const quiesce = async () => {
          nativeCloses += 1;
          lifetime.abort();
          terminal.resolve({ kind: 'session_closed' });
          if (mode !== 'pending-close') { retryEntered.resolve(); await producerFinished.promise; }
          await callback;
          await candidate.close({ reason: 'shutdown' });
        };
        if (mode === 'opening-cleanup') throw createAgentProviderSessionCleanupError({ providerKey: fake.definition.providerKey,
          openingInput: input, errors: [nativeFailure], retryCleanup: quiesce });
        return { ...candidate, async close() {
          if (mode === 'returned-cleanup' && nativeCloses === 0) { nativeCloses += 1; lifetime.abort(); terminal.resolve({ kind: 'session_closed' }); throw nativeFailure; }
          await quiesce();
        } };
      },
    } };
  } };
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] });
  const adapter = registry.requireInstance(fake.definition.instanceId).adapter;
  const input = { sessionId: parseAgentSessionId(`packed-${mode}`), workingDirectory: '/packed-core', hostBinding,
    configuration: { kind: 'selected' as const, revision: parseAgentConfigurationRevisionId('configuration:1'), catalogRevision: 1, selections: [] },
    onBindingCreated() {}, interactions: { limits: { cleanupTimeoutMs: 1_000 }, async onRequest(value: AgentSessionInteraction) {
      callbacks += 1;
      handle = value;
      if (mode === 'pending-close') await new Promise<void>((resolve) => value.signal.addEventListener('abort', () => resolve(), { once: true }));
      else await hostFinished.promise;
      callbackCompleted = true;
    } },
  };
  let retained: AgentProviderSessionCleanupError | undefined;
  let session: Awaited<ReturnType<typeof adapter.createSession>> | undefined;
  try {
    if (mode === 'opening-cleanup') await assert.rejects(async () => adapter.createSession(input), (error: unknown) => {
      assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
      assert.equal(isAgentProviderSessionCleanupErrorFor(error, { ...input }), false);
      retained = error;
      return true;
    });
    else {
      session = await adapter.createSession(input);
      assert.ok(handle);
      assert.deepEqual([callbacks, answers, callbackCompleted], [1, 0, false]);
      if (mode === 'pending-close') await session.close({ reason: 'shutdown' });
      else await assert.rejects(async () => session!.close({ reason: 'shutdown' }), (error: unknown) => {
        assert.ok(error instanceof AgentProviderSessionCleanupError);
        retained = error;
        return true;
      });
    }
    if (retained) {
      assert.equal(hostReleases, 0);
      const first = retained.retryCleanup();
      const second = retained.retryCleanup();
      await retryEntered.promise;
      hostFinished.resolve();
      await Promise.resolve();
      assert.equal(hostReleases, 0);
      producerFinished.resolve();
      await Promise.all([first, second]);
    }
    assert.ok(handle);
    assert.deepEqual(await handle.terminal, { kind: 'session_closed' });
    const late = await handle.respond({ choiceId });
    assert.equal(late.status, 'rejected');
    if (late.status !== 'rejected') throw new Error('Expected retired bound response authority.');
    assert.deepEqual([late.requestState, late.error.code], ['unavailable', 'session_interaction_unavailable']);
    assert.deepEqual([openings, callbacks, answers, callbackCompleted, hostReleases], [1, 1, 0, true, 1]);
    assert.equal(nativeCloses, mode === 'returned-cleanup' ? 2 : 1);
    assert.equal(fake.snapshot().turnIds.length, 0);
    scenarios.push({ scenario: mode, openings, callbacks, answers, nativeCloses, hostReleases, turns: fake.snapshot().turnIds.length, cleanup: 'joined' });
  } finally {
    hostFinished.resolve();
    producerFinished.resolve();
    if (retained) await retained.retryCleanup();
    else await session?.close({ reason: 'shutdown' });
    await registry.dispose();
  }
}
process.stdout.write(JSON.stringify({ proof: 'core-only-session-interactions', evidence: 'synthetic', entrypoints, scenarios }) + '\n');
