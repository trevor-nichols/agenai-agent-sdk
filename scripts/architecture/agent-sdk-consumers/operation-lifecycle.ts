import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { parseAgentConfigurationRevisionId, parseAgentOperationId, parseAgentOperationInvocationId,
  parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { validateAgentProviderAdapter } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';

const fake = createFakeAgentProvider();
const instance = await fake.driver.materialize(fake.definition);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}
const entered = deferred(); const release = deferred();
let dispatches = 0; let nativeCloses = 0;
const adapter = validateAgentProviderAdapter(instance.capabilities, { ...instance.adapter,
  async createSession(context) {
    const session = await instance.adapter.createSession(context);
    assert.equal(session.operations.kind, 'supported');
    if (session.operations.kind !== 'supported') throw new Error('Missing operation fixture.');
    return { ...session, async close(input) { nativeCloses += 1; await session.close(input); },
      operations: { ...session.operations, async invokeOperation(input) {
        input.onProviderExecutionStarted?.(); dispatches += 1; entered.resolve(); await release.promise;
        return { invocationId: input.invocation.invocationId, status: 'completed' as const };
      } } };
  } });
const session = await adapter.createSession({ sessionId: parseAgentSessionId('packed-operation-session'),
  workingDirectory: '/packed/workspace', configuration: { kind: 'selected', catalogRevision: 1, selections: [],
    revision: parseAgentConfigurationRevisionId('packed-operation-config') }, onBindingCreated() {} });
try {
  assert.equal(session.operations.kind, 'supported');
  if (session.operations.kind !== 'supported') throw new Error('Missing validated operations.');
  const pending = session.operations.invokeOperation({ invocation: { invocationId: parseAgentOperationInvocationId('packed-operation'),
    operationId: parseAgentOperationId('fake.session.reset'), expectedRevision: 1, values: [] },
    observationTurnId: parseAgentTurnId('packed-operation-observation') });
  await entered.promise;
  assert.throws(() => session.startTurn({ turnId: parseAgentTurnId('overlapping-turn'), interactionMode: 'default',
    parts: [{ type: 'text', text: 'Must not be dispatched.' }] }), { code: 'concurrent_turn' });
  let closed = false;
  const closing = Promise.resolve(session.close({ reason: 'idle' })).then(() => { closed = true; });
  await setImmediate();
  assert.equal(nativeCloses, 1);
  assert.equal(closed, false);
  release.resolve();
  assert.equal((await pending).status, 'completed');
  await closing;
  assert.equal(dispatches, 1);
  assert.equal(fake.snapshot().turnIds.length, 0);
  process.stdout.write(JSON.stringify({ proof: 'packed-operation-lifecycle', evidence: 'synthetic',
    dispatches, nativeCloses, overlappingTurns: 0, cleanup: 'joined' }) + '\n');
} finally { release.resolve(); await session.close({ reason: 'idle' }); await instance.dispose(); }
