import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentProviderKey, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { lifecycleFixture, turn } from './fixtures/lifecycle.js';

test('the controlled Grok owner delivers one authoritative prompt-usage delta through the validated runtime', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'usage');
  const registry = await createAgentProviderRegistry({ drivers: [f.provider.driver],
    definitions: [{ providerKey: parseAgentProviderKey('grok'), instanceId: f.profile.instanceId, driverConfiguration: {} }] });
  const instance = registry.requireInstance(f.profile.instanceId);
  assert.equal(instance.capabilities.tokenUsage.kind, 'supported');
  const session = await instance.adapter.createSession({ sessionId: parseAgentSessionId('session:usage'), workingDirectory: '/workspace/work',
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('revision:usage') }, approvalPolicy: { kind: 'host' },
    onBindingCreated() {} });
  const events = (await Array.fromAsync(session.startTurn(turn).outputs)).flatMap((output) => output.kind === 'event' ? [output.event] : []);
  const exact = (value: number) => ({ kind: 'exact', value });
  const unsupported = { kind: 'unavailable', reasons: ['unsupported'] };
  assert.deepEqual(events.flatMap((event) => event.type === 'usage.observed' ? [event.payload.measurement] : []), [{
    kind: 'delta', coverage: { kind: 'complete' }, attribution: { kind: 'unknown' }, counters: {
      inputTokens: exact(1629), cacheReadInputTokens: exact(512), cacheCreationInputTokens: exact(0),
      cacheCreationFiveMinuteInputTokens: unsupported, cacheCreationOneHourInputTokens: unsupported,
      outputTokens: exact(26), reasoningOutputTokens: exact(25), modelCalls: exact(1), turns: exact(1) } }]);
  assert.equal(events.at(-1)?.type, 'turn.completed');
  await session.close({ reason: 'shutdown' });
  await registry.dispose();
});
