import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProtocolValidationError, parseAgentApprovalOptionId, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderDriver, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { runAgentProviderConformance, type AgentProviderConformanceScenario } from '@agen-ai/agent-runtime/testing';
import { createAcpProviderDriver } from '../src/index.js';
import { createSessionPeer, type SessionPeer } from './fixtures/session-peer.js';
import { fixtureDeferred } from './node-fixtures/host-peer.js';

import { configuration, definition, events, providerKey, selection, turnInput } from './fixtures/session-runtime.js';

function scenario(driver: AgentProviderDriver, resolutionFor: AgentProviderConformanceScenario['resolutionFor']): AgentProviderConformanceScenario {
  return {
    driver, definition, workingDirectory: '/fixture', configuration,
    createSessionId: parseAgentSessionId('conformance:create'), resumeSessionId: parseAgentSessionId('conformance:resume'),
    abortedSessionId: parseAgentSessionId('conformance:aborted'), interruptionSessionId: parseAgentSessionId('conformance:interrupt'),
    turn: turnInput('conformance:turn'), interruptionTurn: turnInput('conformance:held', 'hold'), resolutionFor,
  };
}

function observeConformanceTurn(driver: AgentProviderDriver, observe: (output: AgentProviderOutput) => void) {
  const readerTurnIds: string[] = [];
  const observed: AgentProviderDriver = { ...driver, async materialize(input) {
    const instance = await driver.materialize(input);
    return { ...instance, adapter: { ...instance.adapter, async createSession(context) {
      const session = await instance.adapter.createSession(context);
      return { ...session, startTurn(input) {
        const execution = session.startTurn(input);
        return { ...execution, outputs: { async *[Symbol.asyncIterator]() {
          readerTurnIds.push(input.turnId);
          for await (const output of execution.outputs) { observe(output); yield output; }
        } } };
      } };
    } } };
  } };
  return { driver: observed, readerTurnIds };
}

test('binding callback failure preserves the original error and releases the created native session', { timeout: 3_000 }, async () => {
  let released = 0;
  const peer = createSessionPeer({ owned: true, onRelease: () => { released += 1; } });
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  const original = new Error('binding publication failed');
  try {
    await assert.rejects(async () => registry.requireInstance(definition.instanceId).adapter.createSession({
      sessionId: parseAgentSessionId('fixture:session'), workingDirectory: '/fixture', configuration,
      onBindingCreated: () => { throw original; },
    }), (error) => error === original);
    assert.equal(released, 1);
    assert.equal(peer.stdout.destroyed, true);
  } finally { await registry.dispose(); }
});

test('the public runtime conformance runner validates the real ACP driver and session ports', { timeout: 5_000 }, async () => {
  const peers: SessionPeer[] = [];
  const driver = createAcpProviderDriver({ providerKey, createConnection() {
    const peer = createSessionPeer({ onPrompt(peer, frame) {
      const prompt = frame.params?.prompt as { text: string }[];
      if (prompt[0]?.text === 'hold') return;
      peer.send(peer.permission('conformance:permission', 'tool'));
    }, onResolution(peer) { peer.complete(); } });
    peers.push(peer);
    return peer.lease;
  } });
  try {
    const report = await runAgentProviderConformance(scenario(driver, selection));
    assert.equal(report.providerKey, providerKey);
    assert.ok(report.checks.includes('request_resolution'));
    assert.ok(report.checks.includes('interruption'));
    assert.ok(report.checks.includes('idempotent_disposal'));
  } finally { for (const peer of peers) peer.dispose(); }
});

test('public conformance keeps its original ACP reader active through asynchronous human waiting, native withdrawal and the next answer', { timeout: 5_000 }, async (t) => {
  const aStarted = fixtureDeferred<void>();
  const bStarted = fixtureDeferred<void>();
  const bProgress = fixtureDeferred<void>();
  const mainClosed = fixtureDeferred<void>();
  const outputs: AgentProviderOutput[] = [];
  const peers: SessionPeer[] = [];
  let aSignal: AbortSignal | undefined;
  let aTaskSettled = false;
  const driver = createAcpProviderDriver({ providerKey, createConnection() {
    const isMain = peers.length === 0;
    const peer = createSessionPeer({ owned: true, onRelease: () => { if (isMain) mainClosed.resolve(); }, onPrompt(peer, frame) {
      if ((frame.params?.prompt as { text: string }[])[0]?.text !== 'hold') peer.send(peer.permission('A', 'tool:A'));
    }, onResolution(peer, frame) { if (frame.id === 'B' && frame.result !== undefined) peer.complete(); } });
    peers.push(peer);
    return peer.lease;
  } });
  t.after(() => { for (const peer of peers) peer.dispose(); });
  const observed = observeConformanceTurn(driver, (output) => {
    outputs.push(output);
    if (output.kind === 'event' && output.event.type === 'content.delta' && output.event.payload.delta === 'B is still producing output.') bProgress.resolve();
  });
  const result = runAgentProviderConformance(scenario(observed.driver, async (request, { signal }) => {
    if (aSignal === undefined) {
      aSignal = signal;
      aStarted.resolve();
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); });
      await mainClosed.promise;
      aTaskSettled = true;
      return undefined;
    }
    assert.equal(aSignal.aborted, true);
    assert.equal(signal.aborted, false);
    bStarted.resolve();
    await bProgress.promise;
    return selection(request);
  }));
  const nativeWork = (async () => {
    await aStarted.promise;
    const peer = peers[0]!;
    peer.batch([
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A is still unanswered.' } }),
      { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'A' } },
      peer.permission('B', 'tool:B'),
    ]);
    await bStarted.promise;
    peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B is still producing output.' } }));
  })();
  const [report] = await Promise.all([result, nativeWork]);
  const turnEvents = events(outputs).filter((event) => event.turnId === 'conformance:turn');
  const opened = turnEvents.filter((event) => event.type === 'request.opened');
  assert.equal(opened.length, 2);
  assert.deepEqual(turnEvents.filter((event) => event.type === 'request.unavailable').map((event) => event.payload), [
    { requestId: opened[0]!.payload.request.requestId, reason: 'withdrawn' },
  ]);
  assert.ok(turnEvents.findIndex((event) => event.type === 'request.unavailable') < turnEvents.findIndex((event) => event === opened[1]));
  assert.equal(turnEvents.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal(turnEvents.at(-1)?.type, 'turn.completed');
  assert.equal(turnEvents.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''),
    'A is still unanswered.B is still producing output.');
  assert.equal(aTaskSettled, true);
  assert.deepEqual(observed.readerTurnIds, ['conformance:held', 'conformance:turn']);
  assert.deepEqual(peers[0]!.frames.filter((frame) => !frame.method && frame.result !== undefined).map((frame) => frame.id), ['B']);
  assert.deepEqual(peers[0]!.frames.filter((frame) => frame.id === 'A').map((frame) => frame.error?.code), [-32800]);
  assert.equal(peers[0]!.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.ok(report.checks.includes('request_resolution'));
  assert.ok(report.checks.includes('request_unavailability'));
});

test('public conformance can deliberately leave a native request unanswered without reporting resolution', { timeout: 5_000 }, async (t) => {
  const opened = fixtureDeferred<void>();
  const peers: SessionPeer[] = [];
  const driver = createAcpProviderDriver({ providerKey, createConnection() {
    const peer = createSessionPeer({ onPrompt(peer, frame) {
      if ((frame.params?.prompt as { text: string }[])[0]?.text !== 'hold') peer.send(peer.permission('unanswered', 'tool'));
    }, onResolution(peer, frame) { if (frame.id === 'unanswered' && frame.error?.code === -32800) peer.complete(); } });
    peers.push(peer);
    return peer.lease;
  } });
  t.after(() => { for (const peer of peers) peer.dispose(); });
  const result = runAgentProviderConformance(scenario(driver, () => { opened.resolve(); return undefined; }));
  await opened.promise;
  peers[0]!.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'unanswered' } });
  const report = await result;
  assert.equal(report.checks.includes('request_resolution'), false);
  assert.ok(report.checks.includes('request_unavailability'));
  assert.deepEqual(peers[0]!.frames.filter((frame) => !frame.method && frame.result !== undefined), []);
  assert.equal(peers[0]!.frames.filter((frame) => frame.id === 'unanswered' && frame.error?.code === -32800).length, 1);
});

for (const failureKind of ['human_error', 'invalid_choice'] as const) {
  test(`public conformance preserves ${failureKind}, closes ACP before joining human work and sends no native answer`, { timeout: 5_000 }, async (t) => {
    const aStarted = fixtureDeferred<void>();
    const nativeClosed = fixtureDeferred<void>();
    const settleHuman = fixtureDeferred<void>();
    const original = new Error('Asynchronous human task failed.');
    let aSignal: AbortSignal | undefined;
    let humanSettled = false;
    let conformanceSettled = false;
    let nativeReleases = 0;
    const peer = createSessionPeer({ owned: true, onRelease: () => { nativeReleases += 1; nativeClosed.resolve(); }, onPrompt(peer) {
      peer.send(peer.permission('A', 'tool:A'));
    } });
    const peers = [peer];
    let connections = 0;
    t.after(() => { settleHuman.resolve(); for (const peer of peers) peer.dispose(); });
    const driver = createAcpProviderDriver({ providerKey, createConnection() {
      if (connections++ === 0) return peer.lease;
      const interruptionPeer = createSessionPeer();
      peers.push(interruptionPeer);
      return interruptionPeer.lease;
    } });
    const result = runAgentProviderConformance(scenario(driver, async (request, { signal }) => {
      if (aSignal === undefined) {
        aSignal = signal;
        aStarted.resolve();
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); });
        await settleHuman.promise;
        humanSettled = true;
        return undefined;
      }
      assert.equal(aSignal.aborted, true);
      await Promise.resolve();
      if (failureKind === 'human_error') throw original;
      return { ...selection(request), optionId: parseAgentApprovalOptionId('not-offered') };
    }));
    const outcome = result.then(
      () => { conformanceSettled = true; return { kind: 'completed' as const }; },
      (error: unknown) => { conformanceSettled = true; return { kind: 'failed' as const, error }; },
    );
    await aStarted.promise;
    peer.batch([
      { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'A' } },
      peer.permission('B', 'tool:B'),
    ]);
    await nativeClosed.promise;
    assert.equal(conformanceSettled, false);
    assert.equal(humanSettled, false);
    assert.equal(peer.stdout.destroyed, true);
    settleHuman.resolve();
    const settled = await outcome;
    assert.equal(settled.kind, 'failed');
    if (settled.kind !== 'failed') throw new Error('Expected conformance failure.');
    if (failureKind === 'human_error') assert.equal(settled.error, original);
    else assert.ok(settled.error instanceof AgentProtocolValidationError);
    assert.equal(humanSettled, true);
    assert.deepEqual(peer.frames.filter((frame) => !frame.method && frame.result !== undefined), []);
    assert.equal(nativeReleases, 1);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}
