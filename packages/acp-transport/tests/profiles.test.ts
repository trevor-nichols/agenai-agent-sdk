// ------------------------------------------------------------------------------------------------
//                profiles.test.ts - Explicit ACP schema selection and negotiation lifecycle
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  AcpClientError,
  AcpProtocolError,
  AcpRequestError,
  createAcpClient,
  type AcpClient,
  type AcpClientCloseResult,
  type AcpSchemaProfile,
} from '../src/index.js';
import {
  createAcpTestHarness,
  INITIALIZE_PARAMS,
  INITIALIZE_RESULT,
  withTestDeadline,
} from './harness.js';

async function fatalReason(closed: Promise<AcpClientCloseResult>): Promise<string | undefined> {
  const result = await closed;
  assert.equal(result.kind, 'fatal');
  return result.error instanceof AcpClientError ? result.error.reasonCode : undefined;
}


for (const selection of [
  { schemaProfile: 'unknown', schemaChannel: 'stable', reason: 'acp_schema_profile_unsupported' },
  { schemaProfile: 'schema-v1.23.0', schemaChannel: 'unstable', reason: 'acp_schema_channel_unsupported' },
] as const) {
  test(`invalid schema selection ${selection.schemaProfile}/${selection.schemaChannel} has no stream side effects`, async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let client: AcpClient | undefined;
    try {
      assert.throws(() => {
        client = createAcpClient({
          stdout, stdin, stderr,
          schemaChannel: selection.schemaChannel,
          schemaProfile: selection.schemaProfile as AcpSchemaProfile,
        });
      }, (error: unknown) => error instanceof AcpProtocolError
        && error.reasonCode === selection.reason);
      assert.equal(stdout.listenerCount('data'), 0);
      assert.equal(stderr.listenerCount('data'), 0);
      assert.equal(stdin.listenerCount('error'), 0);
    } finally {
      await client?.dispose();
    }
  });
}

for (const profile of ['v0.11.4', 'schema-v1.23.0'] as const) {
  test(`${profile} rejects unsupported initialization versions before dispatch and on response`, async () => {
    const harness = createAcpTestHarness({ schemaChannel: 'stable', schemaProfile: profile });
    try {
      let dispatched = false;
      await assert.rejects(harness.client.request('initialize', { protocolVersion: 2 }, {
        timeoutMs: 100,
        onRequestDispatch: () => { dispatched = true; },
      }), (error: unknown) => error instanceof AcpProtocolError
        && error.reasonCode === 'acp_protocol_version_unsupported');
      assert.equal(dispatched, false);
      const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
      const wire = await harness.nextOutbound();
      harness.send({
        jsonrpc: '2.0', id: wire.id, result: { ...INITIALIZE_RESULT, protocolVersion: 2 },
      });
      await assert.rejects(pending, (error: unknown) => error instanceof AcpProtocolError
        && error.reasonCode === 'acp_protocol_version_unsupported');
      assert.equal(await fatalReason(harness.client.closed), 'acp_protocol_version_unsupported');
    } finally {
      await harness.client.dispose();
    }
  });
}

test('modern stable request cancellation reaches the peer after local abort', async () => {
  const harness = createAcpTestHarness({ schemaChannel: 'stable', schemaProfile: 'schema-v1.23.0' });
  const controller = new AbortController();
  try {
    const pending = harness.client.request('initialize', INITIALIZE_PARAMS, { signal: controller.signal });
    const wire = await harness.nextOutbound();
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof AcpRequestError
      && error.reasonCode === 'acp_request_aborted');
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
      jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: wire.id },
    });
  } finally {
    await harness.client.dispose();
  }
});

test('modern stable peer cancellation aborts the exact reverse request and preserves the connection', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const harness = createAcpTestHarness({
    schemaChannel: 'stable', schemaProfile: 'schema-v1.23.0',
    reverseRequestHandlers: {
      'fs/read_text_file': async ({ signal }) => {
        entered();
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { content: 'unreachable' };
      },
    },
  });
  try {
    harness.send({
      jsonrpc: '2.0', id: 'read-1', method: 'fs/read_text_file',
      params: { sessionId: 's', path: '/workspace/file.txt' },
    });
    await withTestDeadline(started, 500);
    harness.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'read-1' } });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
      jsonrpc: '2.0', id: 'read-1', error: { code: -32800, message: 'Request cancelled' },
    });
    const next = harness.client.request('initialize', INITIALIZE_PARAMS);
    const wire = await harness.nextOutbound();
    harness.send({ jsonrpc: '2.0', id: wire.id, result: INITIALIZE_RESULT });
    assert.deepEqual(await next, INITIALIZE_RESULT);
  } finally {
    await harness.client.dispose();
  }
});

for (const unknownExtensionPolicy of ['reject', 'standard'] as const) {
  test(`legacy stable still rejects peer request cancellation with ${unknownExtensionPolicy} extensions`, async () => {
    const harness = createAcpTestHarness({ schemaChannel: 'stable', unknownExtensionPolicy });
    harness.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'read-1' } });
    assert.equal(await fatalReason(harness.client.closed), 'acp_unstable_notification_denied');
  });
}
