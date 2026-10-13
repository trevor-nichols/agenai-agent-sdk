import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentCapabilities } from '@agen-ai/agent-protocol';
import { createAgentProviderSessionCleanupError, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';
import { approveSyntheticRequest, runExampleSession } from '../run-session.js';

// Existing successful examples cannot observe who owns a failed session close.
for (const phase of ['opening', 'close'] as const) {
  const template = createFakeAgentProvider();
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...template.capabilities, configuration: { kind: 'managed' },
  }) });
  const workingDirectory = await mkdtemp(join(tmpdir(), `session-cleanup-${phase}-`));
  let cleanupAttempts = 0;
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      return { ...instance, adapter: { ...instance.adapter, async createSession(input) {
        const session = await instance.adapter.createSession(input);
        if (phase === 'opening') {
          throw createAgentProviderSessionCleanupError({
            providerKey: fake.driver.providerKey, openingInput: input,
            errors: [new Error('Opening failed with native cleanup retained.')],
            async retryCleanup() {
              cleanupAttempts += 1;
              if (cleanupAttempts === 1) throw new Error('Native cleanup is still pending.');
              await session.close({ reason: 'shutdown' });
            },
          });
        }
        return { ...session, async close(input) {
          cleanupAttempts += 1;
          if (cleanupAttempts <= 2) throw new Error('Native cleanup is still pending.');
          await session.close(input);
        } };
      } } };
    },
  };
  try {
    let retained: unknown;
    try { await runExampleSession(driver, workingDirectory, approveSyntheticRequest); }
    catch (error) { retained = error; }
    assert.equal(fake.snapshot().instanceDisposeCount, 0, `${phase}: disposal must wait for session cleanup`);
    assert.equal(cleanupAttempts, phase === 'opening' ? 0 : 1, 'Failed opening propagation must not retry cleanup');
    assert.ok(retained instanceof Error && 'retryCleanup' in retained && typeof retained.retryCleanup === 'function',
      'The caller must retain an executable cleanup owner');
    await assert.rejects(retained.retryCleanup(), /Native cleanup is still pending/u);
    assert.equal(fake.snapshot().instanceDisposeCount, 0, 'Failed retry must retain instance ownership');
    await retained.retryCleanup();
    assert.equal(fake.snapshot().instanceDisposeCount, 1);
    assert.equal(Object.values(fake.snapshot().closeCounts).reduce((sum, count) => sum + count, 0), 1);
    await retained.retryCleanup();
    assert.equal(fake.snapshot().instanceDisposeCount, 1, 'Completed cleanup remains idempotent');
    assert.equal(cleanupAttempts, phase === 'opening' ? 2 : 3);
  } finally {
    // The controlled provider owns no native process; failed assertions leave no producer.
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ example: 'session-cleanup', openingRetry: true, closeRetry: true, cleanup: 'closed' }));
