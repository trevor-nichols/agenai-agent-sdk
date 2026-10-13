import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver } from '../src/index.js';
import { collectRemaining, createSessionPeer, takeUntilRequest } from './fixtures/session-peer.js';
import { events, open, selection, turnInput } from './fixtures/session-runtime.js';
import { fixtureDeferred } from './node-fixtures/host-peer.js';

for (const loss of [
  { kind: 'peer exit', reason: 'acp_provider_peer_closed' },
  { kind: 'peer revocation', reason: 'acp_request_revoked' },
  { kind: 'prompt timeout', reason: 'acp_request_deadline_exceeded' },
] as const) {
  test(`${loss.kind} before canonical acceptance returns unavailable without a selected native reply or replay`, { timeout: 3_000 }, async (t) => {
    const released = fixtureDeferred<void>();
    let releases = 0;
    const peer = createSessionPeer({ owned: true, onRelease() { releases += 1; released.resolve(); },
      onPrompt(peer) { peer.send(peer.permission('lost-permission', 'tool')); },
    });
    const { registry, session } = await open(peer, loss.kind === 'prompt timeout' ? { promptTimeoutMs: 100 } : undefined);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const initial = events(await takeUntilRequest(iterator));
    const opened = initial.find((event) => event.type === 'request.opened');
    assert.ok(opened?.type === 'request.opened');
    const resolution = selection(opened.payload.request);
    if (loss.kind === 'peer exit') peer.stdout.end();
    if (loss.kind === 'peer revocation') peer.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'lost-permission' } });
    await released.promise;
    let started = 0;
    assert.deepEqual(await execution.resolveRequest({ resolution, onProviderExecutionStarted() { started += 1; } }), {
      status: 'rejected', requestState: 'unavailable', error: {
        category: 'invalid_request', code: 'acp_request_not_pending',
        message: 'The ACP request callback is no longer available.', recovery: { kind: 'none' },
      },
    });
    assert.equal(started, 1);
    await assert.rejects(execution.resolveRequest({ resolution }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'request_resolution_mismatch');
    await assert.rejects(collectRemaining(iterator),
      (error: unknown) => error instanceof Error && 'reasonCode' in error && error.reasonCode === loss.reason);
    assert.equal(peer.frames.filter((frame) => !frame.method).length, 0);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(initial.filter((event) => event.type === 'request.opened').length, 1);
    assert.equal(initial.filter((event) => event.type === 'turn.completed').length, 0);
    await session.close({ reason: 'shutdown' });
    assert.equal(releases, 1);
    assert.equal(peer.stdout.listenerCount('data'), 0);
  });
}

test('local permission acceptance remains delivered when the later reverse response write fails on the original execution', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(peer.permission('write-failure', 'tool')); } });
  const providerKey = parseAgentProviderKey('receipt-fixture');
  const instanceId = parseAgentInstanceId('receipt:instance');
  const registry = await createAgentProviderRegistry({
    drivers: [createAcpProviderDriver({ providerKey, createConnection: () => peer.lease })],
    definitions: [{ providerKey, instanceId, driverConfiguration: {} }],
  });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const session = await registry.requireInstance(instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('receipt:session'), workingDirectory: '/fixture',
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('receipt:configuration') },
    onBindingCreated() {},
  });
  const execution = session.startTurn({
    turnId: parseAgentTurnId('receipt:turn'), interactionMode: 'default', parts: [{ type: 'text', text: 'Request permission.' }],
  });
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const opened = (await takeUntilRequest(iterator)).find((output) => output.kind === 'event' && output.event.type === 'request.opened');
  assert.ok(opened?.kind === 'event' && opened.event.type === 'request.opened' && opened.event.payload.request.requestKind === 'approval');
  const request = opened.event.payload.request;
  let failedWrite!: () => void;
  const writeFailure = new Promise<void>((resolve) => { failedWrite = resolve; });
  const writeError = new Error('The reverse response was not written.');
  let writeAttempts = 0;
  peer.stdin._write = (_chunk, _encoding, callback) => {
    writeAttempts += 1;
    callback(writeError);
    failedWrite();
  };
  const resolution = {
    requestKind: 'approval' as const, requestId: request.requestId,
    disposition: 'selected' as const, optionId: request.options[0]!.optionId,
  };
  assert.deepEqual(await execution.resolveRequest({ resolution }), { status: 'delivered' });
  await writeFailure;
  await assert.rejects(collectRemaining(iterator), (error: unknown) => error === writeError);
  await assert.rejects(execution.resolveRequest({ resolution }));
  assert.equal(writeAttempts, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(peer.frames.filter((frame) => !frame.method).length, 0);
});
