import assert from 'node:assert/strict';
import { parseAgentCapabilities } from '@agen-ai/agent-protocol';
import { createAgentEventOutput, createAgentProviderRegistry, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';
import { AgentGenerationCleanupError } from '@agen-ai/agent-runtime/generation';
import { generateAndSaveTitle } from '../generate-title.js';

// This deterministic public-SPI fixture exercises the example without credentials or model claims.
const template = createFakeAgentProvider();
const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
  ...template.capabilities,
  configuration: { kind: 'managed' },
  turns: { ...template.capabilities.turns, structuredOutput: {
    kind: 'supported', mechanism: 'native', schemaProfile: 'agenai.output-schema.v1', scope: 'turn',
    maxSchemaBytes: 16_384, maxOutputBytes: 16_384, resume: false, branch: false,
  } },
}) });
let starts = 0;
const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
  const instance = await fake.driver.materialize(definition);
  return { ...instance, adapter: { ...instance.adapter, async createSession(context) {
    const session = await instance.adapter.createSession(context);
    return { ...session, startTurn(turn) {
      starts += 1;
      const base = { protocolVersion: 13, sessionId: context.sessionId, turnId: turn.turnId, occurredAt: '2026-10-21T12:00:00.000Z' };
      return { turnId: turn.turnId, outputs: (async function* () {
        yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
        yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: {
          outcome: 'completed', structuredOutput: { kind: 'json', value: { title: 'Planning a garden' } },
        } });
      })(), async resolveRequest() { throw new Error('The title fixture does not request permissions.'); } };
    } };
  } } };
} };
const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] });
const saved = new Map<string, string>();
let cleanupRetained = false;
try {
  const result = await generateAndSaveTitle({ instance: registry.requireInstance(fake.definition.instanceId),
    conversationId: 'conversation:1', firstPrompt: 'Help me plan a small vegetable garden.', workingDirectory: process.cwd(),
    async saveTitle(conversationId, title) { saved.set(conversationId, title); },
  });
  assert.deepEqual(result, { kind: 'saved', title: 'Planning a garden' });
  assert.equal(saved.get('conversation:1'), 'Planning a garden');
  assert.equal(starts, 1);
  assert.equal(fake.snapshot().instanceDisposeCount, 0, 'Generation borrows the instance.');
} catch (error) {
  if (error instanceof AgentGenerationCleanupError) {
    // Production callers retain this owner for an explicit retry; this fixture quiesces before disposal.
    cleanupRetained = true;
    await error.retryCleanup();
    cleanupRetained = false;
  }
  throw error;
} finally {
  if (!cleanupRetained) await registry.dispose();
}
assert.equal(fake.snapshot().instanceDisposeCount, 1);
console.log(JSON.stringify({ example: 'generate-title', title: saved.get('conversation:1'), turns: starts, cleanup: 'closed' }));
