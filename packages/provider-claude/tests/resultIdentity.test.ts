import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderContractError, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import type { WorkerEvent } from '../src/node/process.js';
import { openValidatedSession, ran, RESULT, scriptedTools, scriptedWorker, startText } from './support/session.js';

const result = (input: number): Extract<WorkerEvent, { type: 'result' }> => {
  const counts = { input, output: 1, cacheRead: 0, cacheCreation: 0, cache5m: 0, cache1h: 0 };
  return { ...RESULT, resultIndex: 0, usage: counts, modelUsage: { entries: 1, models: [{ model: 'claude-test', ...counts }] } };
};
const identityConflict = (cause: unknown) => cause instanceof AgentProviderContractError && cause.code === 'usage_identity_conflict';
const usageCount = (outputs: AgentProviderOutput[]) => outputs.filter((output) => output.kind === 'event' && output.event.type === 'usage.observed').length;

for (const timing of ['queued', 'joining-tool', 'after-usage'] as const) {
  test(`conflicting results fail and fence the session when ${timing}, preserving only delivered usage`, async (t) => {
    const worker = scriptedWorker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const tools = scriptedTools(async () => { entered.resolve(); await release.promise; return ran; });
    const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
    t.after(() => session.close({ reason: 'idle' }));
    const outputs: AgentProviderOutput[] = [];
    const execution = startText(session, 'one');
    const consuming = (async () => {
      for await (const output of execution.outputs) {
        outputs.push(output);
        if (timing === 'after-usage' && usageCount(outputs) === 1) worker.emit(result(200));
      }
    })();
    const rejected = assert.rejects(consuming, identityConflict);
    await worker.next('prompt');
    if (timing === 'joining-tool') {
      worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'true' }, nativeRef: 'tool-1' });
      await entered.promise;
    }
    worker.emit(result(100));
    if (timing === 'queued') worker.emit(result(200));
    if (timing === 'joining-tool') {
      // Yield to the reader so it consumes the first result and waits for the entered tool.
      await new Promise<void>((resolve) => setImmediate(resolve));
      worker.emit(result(200));
      release.resolve();
    }
    await rejected;
    assert.equal(usageCount(outputs), timing === 'after-usage' ? 1 : 0);
    assert.equal(outputs.some((output) => output.kind === 'event' && output.event.type === 'turn.completed'), false);
    assert.throws(() => startText(session, 'two'));
    if (timing === 'joining-tool') assert.equal(worker.sent.filter((message) => message.type === 'tool_result').length, 1);
    await session.close({ reason: 'idle' });
    assert.equal(worker.closes, 1);
    assert.equal(tools.closes, 1);
  });
}

test('identical repeated results emit one pair of usage observations and leave the session usable', async (t) => {
  const worker = scriptedWorker();
  const tools = scriptedTools(async () => { throw new Error('No tool expected.'); });
  const session = await openValidatedSession({ worker: worker.worker, tools: tools.tools });
  t.after(() => session.close({ reason: 'idle' }));
  for (const [turn, index] of [['one', 0], ['two', 1]] as const) {
    const outputs: AgentProviderOutput[] = [];
    const consuming = (async () => { for await (const output of startText(session, turn).outputs) outputs.push(output); })();
    await worker.next('prompt');
    const report = { ...result(100 * (index + 1)), resultIndex: index };
    worker.emit(report);
    worker.emit(structuredClone(report));
    await consuming;
    assert.equal(usageCount(outputs), 2);
    const terminal = outputs.at(-1);
    assert.equal(terminal?.kind === 'event' && terminal.event.type === 'turn.completed' && terminal.event.payload.outcome, 'completed');
  }
});
