import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AcpRemoteError, type AcpJsonValue, type AcpResponseReceived } from '../src/index.js';
import { createAcpTestHarness, withTestDeadline } from './harness.js';

function update(text: string) {
  return { jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'native-session',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  } };
}

test('dispatch exposes the exact request identity before synchronous peer traffic and never on rejected admission', async () => {
  const harness = createAcpTestHarness({ schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable', outboundRequestIdPrefix: 'auth-' });
  let admittedId: string | number | undefined;
  let dispatches = 0;
  let writes = 0;
  harness.stdin.on('data', (chunk: Buffer) => {
    const wire = JSON.parse(chunk.toString('utf8')) as { id: string | number };
    writes += 1;
    assert.equal(admittedId, wire.id);
    harness.send({ jsonrpc: '2.0', id: wire.id, result: {} });
  });
  try {
    const request = harness.client.request('authenticate', { methodId: 'login' }, {
      onRequestDispatch: (context) => { admittedId = context.requestId; dispatches += 1; },
    });
    assert.deepEqual(await withTestDeadline(request, 500), {});
    assert.equal(admittedId, 'auth-1');
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(harness.client.request('authenticate', { methodId: 'login' }, {
      signal: canceled.signal, onRequestDispatch: () => { dispatches += 1; },
    }), { reasonCode: 'acp_request_aborted' });
    const refusal = new Error('Request scope registration refused');
    await assert.rejects(harness.client.request('authenticate', { methodId: 'login' }, {
      onRequestDispatch: () => { throw refusal; },
    }), (error: unknown) => error === refusal);
    assert.equal(dispatches, 1);
    assert.equal(writes, 1);
  } finally {
    await harness.client.dispose();
  }
});

test('aborting during request scope registration never writes the abandoned request', async () => {
  const harness = createAcpTestHarness({ schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable' });
  const controller = new AbortController();
  const frames: { method: string }[] = [];
  harness.stdin.on('data', (chunk: Buffer) => { frames.push(JSON.parse(chunk.toString('utf8')) as { method: string }); });
  try {
    await assert.rejects(harness.client.request('authenticate', { methodId: 'login' }, {
      signal: controller.signal, onRequestDispatch: () => { controller.abort(); },
    }), { reasonCode: 'acp_request_aborted' });
    await harness.client.notify('session/cancel', { sessionId: 'writer-barrier' });
    assert.equal(frames.some((frame) => frame.method === 'authenticate'), false);
  } finally {
    await harness.client.dispose();
  }
});

test('coalesced updates, reverse requests and responses admit in wire order without waiting for output', async () => {
  const admitted: string[] = [];
  let releaseOutput!: () => void;
  let releaseRequest!: (result: AcpJsonValue) => void;
  const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
  const reverse = new Promise<AcpJsonValue>((resolve) => { releaseRequest = resolve; });
  const harness = createAcpTestHarness({
    schemaChannel: 'stable', schemaProfile: 'schema-v1.23.0',
    notificationHandlers: { 'session/update': ({ params }) => {
      admitted.push((params as { update: { content: { text: string } } }).update.content.text);
      return output;
    } },
    reverseRequestHandlers: { 'fs/read_text_file': () => {
      admitted.push('B');
      return reverse;
    } },
  });
  const pending = harness.client.request('session/prompt', {
    sessionId: 'native-session', prompt: [{ type: 'text', text: 'hello' }],
  }, { onResponseReceived: () => { admitted.push('D'); } });
  try {
    const wire = await harness.nextOutbound();
    harness.sendRaw([
      update('A'),
      { jsonrpc: '2.0', id: 'read', method: 'fs/read_text_file',
        params: { sessionId: 'native-session', path: '/workspace/file' } },
      update('C'),
      { jsonrpc: '2.0', id: wire.id, result: { stopReason: 'end_turn' } },
      update('E'),
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(''));
    assert.deepEqual(admitted, ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(await withTestDeadline(pending, 500), { stopReason: 'end_turn' });
    releaseRequest({ content: 'file' });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
      jsonrpc: '2.0', id: 'read', result: { content: 'file' },
    });
  } finally {
    releaseOutput();
    releaseRequest({ content: 'file' });
    await harness.client.dispose();
    await pending.catch(() => undefined);
  }
});

test('remote response admission retains the exact error before later wire updates', async () => {
  const admitted: string[] = [];
  let received: AcpResponseReceived | undefined;
  const harness = createAcpTestHarness({
    notificationHandlers: { 'session/update': () => { admitted.push('update'); } },
  });
  try {
    const pending = harness.client.request('initialize', { protocolVersion: 1 }, {
      onResponseReceived: (response) => { received = response; admitted.push('error'); },
    });
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof AcpRemoteError
      && received?.kind === 'error' && received.error === error && error.code === -32603);
    const wire = await harness.nextOutbound();
    harness.sendRaw([
      { jsonrpc: '2.0', id: wire.id, error: { code: -32603, message: 'Unavailable' } },
      update('after'),
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(''));
    await rejected;
    assert.deepEqual(admitted, ['error', 'update']);
  } finally {
    await harness.client.dispose();
  }
});

test('response admission failure rejects the request and stops later frame delivery', async () => {
  const failure = new Error('provider output capacity exhausted');
  let updates = 0;
  const harness = createAcpTestHarness({
    notificationHandlers: { 'session/update': () => { updates += 1; } },
  });
  try {
    const pending = harness.client.request('session/prompt', {
      sessionId: 'native-session', prompt: [],
    }, { onResponseReceived: () => { throw failure; } });
    const rejected = assert.rejects(pending, (error: unknown) => error === failure);
    const wire = await harness.nextOutbound();
    harness.sendRaw([
      { jsonrpc: '2.0', id: wire.id, result: { stopReason: 'end_turn' } }, update('after'),
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(''));
    await rejected;
    assert.deepEqual(await harness.client.closed, { kind: 'fatal', error: failure });
    assert.equal(updates, 0);
  } finally {
    await harness.client.dispose();
  }
});

test('local abort and malformed result never report a received valid response', async () => {
  let admissions = 0;
  const harness = createAcpTestHarness();
  try {
    const controller = new AbortController();
    controller.abort();
    const options = { onResponseReceived: () => { admissions += 1; } };
    await assert.rejects(harness.client.request('initialize', { protocolVersion: 1 }, {
      ...options, signal: controller.signal,
    }), { reasonCode: 'acp_request_aborted' });
    const pending = harness.client.request('initialize', { protocolVersion: 1 }, options);
    const rejected = assert.rejects(pending, { reasonCode: 'acp_method_payload_invalid' });
    const wire = await harness.nextOutbound();
    harness.send({ jsonrpc: '2.0', id: wire.id, result: { protocolVersion: 'invalid' } });
    await rejected;
    assert.equal(admissions, 0);
  } finally {
    await harness.client.dispose();
  }
});

test('disposal inside reverse admission aborts the currently admitted request', async () => {
  let wasAborted: boolean | undefined;
  let releases = 0;
  const harness = createAcpTestHarness({
    disposeTransport: () => { releases += 1; },
    reverseRequestHandlers: { 'fs/read_text_file': ({ signal }) => {
      signal.addEventListener('abort', () => { void harness.client.dispose(); }, { once: true });
      void harness.client.dispose();
      wasAborted = signal.aborted;
      return { content: 'unused' };
    } },
  });
  try {
    harness.send({ jsonrpc: '2.0', id: 'read', method: 'fs/read_text_file',
      params: { sessionId: 'native-session', path: '/workspace/file' } });
    assert.equal(wasAborted, true);
    assert.deepEqual(await withTestDeadline(harness.client.closed, 500), { kind: 'disposed' });
    assert.equal(releases, 1);
  } finally {
    await harness.client.dispose();
  }
});
