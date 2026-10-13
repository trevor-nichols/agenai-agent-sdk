// ------------------------------------------------------------------------------------------------
//                client.test.ts - Bounded ACP client behavior and adversarial peer coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import {
  AcpClientError,
  AcpProtocolError,
  AcpRequestError,
  createAcpExtensionRegistry,
  type AcpClientCloseResult,
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



test('partial and coalesced frames correlate out-of-order responses', async () => {
  const harness = createAcpTestHarness();
  const first = harness.client.request('initialize', INITIALIZE_PARAMS);
  const second = harness.client.request('initialize', INITIALIZE_PARAMS);
  const firstWire = await harness.nextOutbound();
  const secondWire = await harness.nextOutbound();

  const responseTwo = `${JSON.stringify({
    jsonrpc: '2.0', id: secondWire.id, result: INITIALIZE_RESULT,
  })}\n`;
  const responseOne = `${JSON.stringify({
    jsonrpc: '2.0', id: firstWire.id, result: INITIALIZE_RESULT,
  })}\n`;
  harness.sendRaw(`${responseTwo}${responseOne}`, [3, 7, 11]);

  assert.deepEqual(await second, INITIALIZE_RESULT);
  assert.deepEqual(await first, INITIALIZE_RESULT);
  await harness.client.dispose();
});

test('a namespaced outbound request sequence stays disjoint from numeric reverse IDs', async () => {
  const harness = createAcpTestHarness({
    outboundRequestIdPrefix: 'agenai-grok-',
    reverseRequestHandlers: {
      'fs/read_text_file': () => ({ content: 'reverse-ok' }),
    },
  });
  const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
  const outbound = await harness.nextOutbound();
  assert.equal(outbound.id, 'agenai-grok-1');
  harness.send({
    jsonrpc: '2.0', id: 1, method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  });
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0', id: 1, result: { content: 'reverse-ok' },
  });
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: INITIALIZE_RESULT });
  assert.deepEqual(await pending, INITIALIZE_RESULT);
  await harness.client.dispose();
});

test('known reverse requests dispatch concurrently and validate responses', async () => {
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    reverseRequestHandlers: {
      'fs/read_text_file': async ({ params }) => ({
        content: `read:${(params as { path: string }).path}`,
      }),
    },
  });
  harness.send({
    jsonrpc: '2.0',
    id: 'reverse-1',
    method: 'fs/read_text_file',
    params: { sessionId: 'session-1', path: '/workspace/file.txt' },
  }, [1, 2, 5]);

  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0',
    id: 'reverse-1',
    result: { content: 'read:/workspace/file.txt' },
  });
  await harness.client.dispose();
});

test('a known unsolicited reverse request gets a bounded method-not-found response', async () => {
  const harness = createAcpTestHarness();
  harness.send({
    jsonrpc: '2.0',
    id: 'reverse-unhandled',
    method: 'fs/read_text_file',
    params: { sessionId: 'session-1', path: '/workspace/file.txt' },
  });

  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0',
    id: 'reverse-unhandled',
    error: { code: -32601, message: 'Method not found' },
  });
  await harness.client.dispose();
});

test('explicit extension registration validates inbound and ignorable notifications', async () => {
  const extensions = createAcpExtensionRegistry([
    {
      method: '_x.ai/reverse',
      direction: 'inbound_request',
      validateParams: (value) => Boolean(value && typeof value === 'object'),
      validateResult: (value) => value === 'ok',
    },
    {
      method: '_x.ai/progress',
      direction: 'inbound_notification',
      validateParams: (value) => Boolean(value && typeof value === 'object'),
      safelyIgnorable: true,
    },
  ]);
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    extensions,
    reverseRequestHandlers: { '_x.ai/reverse': () => 'ok' },
  });
  harness.send({ jsonrpc: '2.0', method: '_x.ai/progress', params: { step: 1 } });
  harness.send({ jsonrpc: '2.0', id: 'x1', method: '_x.ai/reverse', params: {} });
  assert.deepEqual(await harness.nextOutbound(), { jsonrpc: '2.0', id: 'x1', result: 'ok' });
  await harness.client.dispose();
});

for (const hostileCase of [
  { name: 'invalid JSON', bytes: '{not-json}\n', reason: 'acp_json_invalid' },
  { name: 'stdout pollution', bytes: 'debug output\n', reason: 'acp_json_invalid' },
  { name: 'batch', bytes: '[]\n', reason: 'acp_batch_or_non_object_denied' },
  {
    name: 'prototype-pollution key',
    bytes: '{"jsonrpc":"2.0","method":"x","__proto__":{}}\n',
    reason: 'acp_json_prototype_key_denied',
  },
] as const) {
  test(`rejects hostile ${hostileCase.name} frames`, async () => {
    const harness = createAcpTestHarness();
    harness.sendRaw(hostileCase.bytes);
    assert.equal(await fatalReason(harness.client.closed), hostileCase.reason);
  });
}

test('rejects invalid UTF-8 and oversized unterminated frames before JSON parsing', async () => {
  const invalidUtf8 = createAcpTestHarness();
  invalidUtf8.sendRaw(Buffer.from([0xc3, 0x28, 0x0a]));
  assert.equal(await fatalReason(invalidUtf8.client.closed), 'acp_stdout_utf8_invalid');

  const oversized = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { maxInboundFrameBytes: 1_024 },
  });
  oversized.sendRaw(Buffer.alloc(1_025, 0x61));
  assert.equal(await fatalReason(oversized.client.closed), 'acp_stdout_frame_too_large');
});

test('bounds trusted outbound frames independently from untrusted inbound frames', async () => {
  assert.throws(
    () =>
      createAcpTestHarness({
        limits: {
          maxOutboundFrameBytes: 4_096,
          maxOutboundBufferedBytes: 4_096,
        },
      }),
    /maximum-sized frame and its delimiter/u,
  );
  const extensions = createAcpExtensionRegistry([
    {
      method: '_agenai/test_large_outbound',
      direction: 'outbound_request',
      validateParams: (value) => Boolean(value && typeof value === 'object'),
      validateResult: (value) => value === 'accepted',
    },
  ]);
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    extensions,
    limits: {
      maxInboundFrameBytes: 1_024,
      maxOutboundFrameBytes: 4_096,
      maxOutboundBufferedBytes: 4_097,
    },
  });
  const pending = harness.client.request(
    '_agenai/test_large_outbound',
    { payload: 'x'.repeat(2_048) },
  );
  const outbound = await harness.nextOutbound();
  assert.equal(
    (outbound.params as { payload: string }).payload.length,
    2_048,
  );
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: 'accepted' });
  assert.equal(await pending, 'accepted');

  harness.sendRaw(Buffer.alloc(1_025, 0x61));
  assert.equal(await fatalReason(harness.client.closed), 'acp_stdout_frame_too_large');
});

test('duplicate and cross-direction request IDs fail closed without payload leakage', async () => {
  let releaseReverse!: () => void;
  const reverseGate = new Promise<void>((resolve) => { releaseReverse = resolve; });
  const duplicate = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { shutdownDrainMs: 0 },
    reverseRequestHandlers: {
      'fs/read_text_file': async () => {
        await reverseGate;
        return { content: 'done' };
      },
    },
  });
  const reverseMessage = {
    jsonrpc: '2.0', id: 'same', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  };
  duplicate.send(reverseMessage);
  duplicate.send(reverseMessage);
  assert.equal(await fatalReason(duplicate.client.closed), 'acp_duplicate_reverse_request_id');
  releaseReverse();

  const collision = createAcpTestHarness();
  const pending = collision.client.request('initialize', INITIALIZE_PARAMS);
  const outbound = await collision.nextOutbound();
  collision.send({
    jsonrpc: '2.0', id: outbound.id, method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  });
  assert.equal(await fatalReason(collision.client.closed), 'acp_request_id_direction_collision');
  await assert.rejects(pending);
});

test('outstanding and reverse-request concurrency remain independently bounded', async () => {
  const outbound = createAcpTestHarness({ limits: { maxOutstandingRequests: 1 } });
  const firstRequest = outbound.client.request('initialize', INITIALIZE_PARAMS);
  const firstWire = await outbound.nextOutbound();
  await assert.rejects(
    outbound.client.request('initialize', INITIALIZE_PARAMS),
    (error: unknown) => (
      error instanceof AcpClientError
      && error.reasonCode === 'acp_outstanding_request_limit_exceeded'
    ),
  );
  outbound.send({ jsonrpc: '2.0', id: firstWire.id, result: INITIALIZE_RESULT });
  await firstRequest;
  await outbound.client.dispose();

  let releaseReverse!: () => void;
  const reverseGate = new Promise<void>((resolve) => { releaseReverse = resolve; });
  const inbound = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { maxInboundRequestConcurrency: 1 },
    reverseRequestHandlers: {
      'fs/read_text_file': async () => {
        await reverseGate;
        return { content: 'done' };
      },
    },
  });
  inbound.send({
    jsonrpc: '2.0', id: 'first', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  });
  inbound.send({
    jsonrpc: '2.0', id: 'second', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/b' },
  });
  assert.deepEqual(await inbound.nextOutbound(), {
    jsonrpc: '2.0', id: 'second',
    error: { code: -32000, message: 'Inbound request limit reached' },
  });
  releaseReverse();
  assert.deepEqual(await inbound.nextOutbound(), {
    jsonrpc: '2.0', id: 'first', result: { content: 'done' },
  });
  await inbound.client.dispose();
});

test('request dispatch observation follows local admission and precedes the wire write', async () => {
  let dispatches = 0;
  const observeDispatch = () => {
    dispatches += 1;
  };

  const closed = createAcpTestHarness();
  await closed.client.dispose();
  await assert.rejects(
    closed.client.request('initialize', INITIALIZE_PARAMS, {
      onRequestDispatch: observeDispatch,
    }),
    (error: unknown) => error instanceof AcpClientError
      && error.reasonCode === 'acp_client_closed',
  );

  const invalid = createAcpTestHarness();
  await assert.rejects(
    invalid.client.request('initialize', {}, {
      onRequestDispatch: observeDispatch,
    }),
    (error: unknown) => error instanceof AcpProtocolError
      && error.reasonCode === 'acp_method_payload_invalid',
  );
  await invalid.client.dispose();

  const aborted = createAcpTestHarness();
  const controller = new AbortController();
  controller.abort('test_pre_dispatch_abort');
  await assert.rejects(
    aborted.client.request('initialize', INITIALIZE_PARAMS, {
      signal: controller.signal,
      onRequestDispatch: observeDispatch,
    }),
    (error: unknown) => error instanceof AcpRequestError
      && error.reasonCode === 'acp_request_aborted',
  );
  await aborted.client.dispose();

  const capacity = createAcpTestHarness({ limits: { maxOutstandingRequests: 1 } });
  const admitted = capacity.client.request('initialize', INITIALIZE_PARAMS);
  const admittedWire = await capacity.nextOutbound();
  await assert.rejects(
    capacity.client.request('initialize', INITIALIZE_PARAMS, {
      onRequestDispatch: observeDispatch,
    }),
    (error: unknown) => error instanceof AcpClientError
      && error.reasonCode === 'acp_outstanding_request_limit_exceeded',
  );
  capacity.send({ jsonrpc: '2.0', id: admittedWire.id, result: INITIALIZE_RESULT });
  await admitted;
  await capacity.client.dispose();
  assert.equal(dispatches, 0);

  const observerFailure = createAcpTestHarness({
    limits: { maxOutstandingRequests: 1 },
  });
  const observerError = new Error('durable request dispatch observation failed');
  await assert.rejects(
    observerFailure.client.request('initialize', INITIALIZE_PARAMS, {
      onRequestDispatch: () => {
        throw observerError;
      },
    }),
    (error: unknown) => error === observerError,
  );
  const successful = observerFailure.client.request('initialize', INITIALIZE_PARAMS, {
    onRequestDispatch: observeDispatch,
  });
  const successfulWire = await observerFailure.nextOutbound();
  assert.equal(successfulWire.id, 2);
  assert.equal(dispatches, 1);
  observerFailure.send({
    jsonrpc: '2.0',
    id: successfulWire.id,
    result: INITIALIZE_RESULT,
  });
  await successful;
  await observerFailure.client.dispose();
});

test('duplicate IDs fail closed while rejection responses remain in flight', async () => {
  const duplicateReason = async (
    closed: Promise<AcpClientCloseResult>,
  ): Promise<string | null | undefined> => Promise.race([
    fatalReason(closed),
    delay(50, null),
  ]);

  let releaseReverse!: () => void;
  const reverseGate = new Promise<void>((resolve) => { releaseReverse = resolve; });
  const concurrency = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { maxInboundRequestConcurrency: 1, shutdownDrainMs: 0 },
    reverseRequestHandlers: {
      'fs/read_text_file': async () => {
        await reverseGate;
        return { content: 'done' };
      },
    },
  });
  concurrency.send({
    jsonrpc: '2.0', id: 'active', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  });
  const rejected = JSON.stringify({
    jsonrpc: '2.0', id: 'rejected', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/b' },
  });
  concurrency.sendRaw(`${rejected}\n${rejected}\n`);
  assert.equal(
    await duplicateReason(concurrency.client.closed),
    'acp_duplicate_reverse_request_id',
  );
  releaseReverse();

  const missingHandler = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { shutdownDrainMs: 0 },
  });
  const missing = JSON.stringify({
    jsonrpc: '2.0', id: 'missing', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  });
  missingHandler.sendRaw(`${missing}\n${missing}\n`);
  assert.equal(
    await duplicateReason(missingHandler.client.closed),
    'acp_duplicate_reverse_request_id',
  );
});

test('a rejected inbound ID may be reused after its response settles', async () => {
  const harness = createAcpTestHarness({ schemaChannel: 'unstable' });
  const request = {
    jsonrpc: '2.0', id: 'sequential', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/a' },
  };
  harness.send(request);
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0', id: 'sequential',
    error: { code: -32601, message: 'Method not found' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.send(request);
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0', id: 'sequential',
    error: { code: -32601, message: 'Method not found' },
  });
  await harness.client.dispose();
});

test('async notification handlers have an independent concurrency bound', async () => {
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const extensions = createAcpExtensionRegistry([{
    method: '_x.ai/progress',
    direction: 'inbound_notification',
    validateParams: () => true,
  }]);
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    extensions,
    limits: { maxNotificationHandlerConcurrency: 1, shutdownDrainMs: 0 },
    notificationHandlers: { '_x.ai/progress': () => handlerGate },
  });

  harness.send({ jsonrpc: '2.0', method: '_x.ai/progress', params: { step: 1 } });
  await delay(0);
  harness.send({ jsonrpc: '2.0', method: '_x.ai/progress', params: { step: 2 } });
  assert.equal(
    await fatalReason(harness.client.closed),
    'acp_notification_concurrency_exceeded',
  );
  releaseHandler();
});

test('request IDs and JSON structure are rejected at their configured bounds', async () => {
  const requestId = createAcpTestHarness({ limits: { maxRequestIdBytes: 8 } });
  requestId.send({ jsonrpc: '2.0', id: '123456789', result: INITIALIZE_RESULT });
  assert.equal(await fatalReason(requestId.client.closed), 'acp_request_id_invalid');

  const nested = createAcpTestHarness({ limits: { maxJsonDepth: 4 } });
  nested.sendRaw('{"jsonrpc":"2.0","method":"session/update","params":{"a":{"b":{"c":{"d":1}}}}}\n');
  assert.equal(await fatalReason(nested.client.closed), 'acp_json_depth_limit_exceeded');
});

test('orphan and late responses fail closed', async () => {
  const orphan = createAcpTestHarness();
  orphan.send({ jsonrpc: '2.0', id: 99, result: INITIALIZE_RESULT });
  assert.equal(await fatalReason(orphan.client.closed), 'acp_orphan_or_late_response');

  const late = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { defaultRequestTimeoutMs: 10 },
  });
  const request = late.client.request('initialize', INITIALIZE_PARAMS);
  const wire = await late.nextOutbound();
  await assert.rejects(withTestDeadline(request, 1_000), (error: unknown) => (
    error instanceof AcpRequestError && error.reasonCode === 'acp_request_deadline_exceeded'
  ));
  const cancellation = await late.nextOutbound();
  assert.equal(cancellation.method, '$/cancel_request');
  late.send({ jsonrpc: '2.0', id: wire.id, result: INITIALIZE_RESULT });
  assert.equal(await fatalReason(late.client.closed), 'acp_orphan_or_late_response');
});

test('abort wins deterministically and emits pinned unstable request cancellation', async () => {
  const harness = createAcpTestHarness();
  const controller = new AbortController();
  const request = harness.client.request('initialize', INITIALIZE_PARAMS, {
    signal: controller.signal,
  });
  await harness.nextOutbound();
  controller.abort();
  await assert.rejects(request, (error: unknown) => (
    error instanceof AcpRequestError && error.reasonCode === 'acp_request_aborted'
  ));
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1 },
  });
  await harness.client.dispose();
});

test('peer exit, unknown critical extensions, and notification floods terminate cleanly', async () => {
  const exited = createAcpTestHarness();
  exited.stdout.end();
  const exitResult = await exited.client.closed;
  assert.equal(exitResult.kind, 'peer_closed');

  const unknown = createAcpTestHarness();
  unknown.send({ jsonrpc: '2.0', method: '_x.ai/unreviewed', params: {} });
  assert.equal(await fatalReason(unknown.client.closed), 'acp_unknown_critical_extension');

  let clock = 1_000;
  const flood = createAcpTestHarness({
    schemaChannel: 'unstable',
    now: () => clock,
    limits: { maxNotificationsPerWindow: 1 },
    extensions: createAcpExtensionRegistry([{
      method: '_x.ai/progress',
      direction: 'inbound_notification',
      validateParams: () => true,
      safelyIgnorable: true,
    }]),
  });
  flood.send({ jsonrpc: '2.0', method: '_x.ai/progress', params: {} });
  flood.send({ jsonrpc: '2.0', method: '_x.ai/progress', params: {} });
  assert.equal(await fatalReason(flood.client.closed), 'acp_notification_rate_exceeded');
  clock += 1;
});

test('internal fatal shutdown contains transport-disposal failures', async () => {
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    disposeTransport: () => {
      throw new Error('injected transport disposal failure');
    },
  });
  harness.sendRaw('not-json\n');
  assert.equal(await fatalReason(harness.client.closed), 'acp_json_invalid');
  await delay(0);
});

test('stderr diagnostics are bounded, redacted, and detached on disposal', async () => {
  const harness = createAcpTestHarness({
    schemaChannel: 'unstable',
    limits: { maxStderrBufferedBytes: 1_024 },
  });
  harness.stderr.write('authorization=Bearer-super-secret\napi_key=xai-secret-value\n');
  await delay(0);
  assert.deepEqual(harness.client.diagnostics(), [
    'authorization=[REDACTED]',
    'api_key=[REDACTED]',
  ]);
  await harness.client.dispose();
  harness.stderr.write('token=after-disposal\n');
  assert.deepEqual(harness.client.diagnostics(), []);
});
