// ------------------------------------------------------------------------------------------------
//                extensionPolicy.test.ts - Optional ACP extension classification at the wire boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  AcpClientError, createAcpClient, createAcpExtensionRegistry,
  type AcpExtensionDirection, type AcpUnknownExtensionPolicy,
} from '../src/index.js';
import { createAcpTestHarness, INITIALIZE_PARAMS, INITIALIZE_RESULT, withTestDeadline } from './harness.js';

async function reason(client: ReturnType<typeof createAcpClient>): Promise<string | undefined> {
  const closed = await withTestDeadline(client.closed, 500);
  assert.equal(closed.kind, 'fatal');
  return closed.error instanceof AcpClientError ? closed.error.reasonCode : undefined;
}

for (const profile of [
  { schemaProfile: 'v0.11.4', schemaChannel: 'stable' },
  { schemaProfile: 'v0.11.4', schemaChannel: 'unstable' },
  { schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable' },
] as const) {
test(`standard policy ignores an optional Grok notification and completes ordinary traffic (${profile.schemaProfile}/${profile.schemaChannel})`, async (t) => {
  let handlerCalls = 0;
  const harness = createAcpTestHarness({
    ...profile,
    unknownExtensionPolicy: 'standard',
    notificationHandlers: { '_x.ai/mcp/servers_updated': () => { handlerCalls += 1; } },
  });
  t.after(() => harness.client.dispose());
  const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
  const wire = await harness.nextOutbound();
  harness.send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated',
    params: { mcpServers: [{ name: 'optional-observation' }] } });
  harness.send({ jsonrpc: '2.0', id: wire.id, result: INITIALIZE_RESULT });
  assert.deepEqual(await withTestDeadline(pending, 500), INITIALIZE_RESULT);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(harness.client.diagnostics(), []);
});
}

test('invalid unknown-extension policies fail before acquiring stream resources', () => {
  for (const invalid of [null, '', 'allow', false, 1, {}, []]) {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    try {
      assert.throws(() => createAcpClient({ stdout, stdin, stderr, schemaChannel: 'stable',
        unknownExtensionPolicy: invalid as AcpUnknownExtensionPolicy }), TypeError);
      assert.equal(stdout.listenerCount('data'), 0);
      assert.equal(stderr.listenerCount('data'), 0);
      assert.equal(stdin.writableLength, 0);
    } finally {
      stdout.destroy(); stdin.destroy(); stderr.destroy();
    }
  }
});

for (const policy of [undefined, 'reject'] as const) {
  test(`unknown extensions remain fatal with ${policy ?? 'default'} policy`, async (t) => {
    for (const kind of ['notification', 'request'] as const) {
      await t.test(kind, async (t) => {
        const harness = createAcpTestHarness({ unknownExtensionPolicy: policy });
        t.after(() => harness.client.dispose());
        harness.send({ jsonrpc: '2.0', method: '_x.ai/optional', params: {},
          ...(kind === 'request' ? { id: 'unsupported' } : {}) });
        assert.equal(await reason(harness.client), 'acp_unknown_critical_extension');
      });
    }
  });
}

for (const policy of ['reject', 'standard'] as const) {
  test(`a connection captures its ${policy} policy at construction`, async (t) => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const options = { stdout, stdin, schemaChannel: 'stable' as const,
      unknownExtensionPolicy: policy as AcpUnknownExtensionPolicy };
    const client = createAcpClient(options);
    t.after(async () => { await client.dispose(); stdout.destroy(); stdin.destroy(); });
    options.unknownExtensionPolicy = policy === 'standard' ? 'reject' : 'standard';
    stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_optional/update' }) + '\n');
    if (policy === 'reject') {
      assert.equal(await reason(client), 'acp_unknown_critical_extension');
    } else {
      await client.notify('session/cancel', { sessionId: 'still-open' });
    }
  });
}

test('unknown requests get only a bounded correlated error, without invoking dictionary handlers', async (t) => {
  let calls = 0;
  const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard', reverseRequestHandlers: {
    '_optional/request': () => { calls += 1; return { unauthorized: true }; },
  } });
  t.after(() => harness.client.dispose());
  for (const [id, method] of [[1, '_optional/request'], ['1', '_optional/request'], ['quote"slash\\', '_']] as const) {
    harness.send({ jsonrpc: '2.0', id, method, params: { privatePayload: 'must-not-be-echoed' } });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
      jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' },
    });
  }
  assert.equal(calls, 0);
  const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
  const wire = await harness.nextOutbound();
  harness.send({ jsonrpc: '2.0', id: wire.id, result: INITIALIZE_RESULT });
  assert.deepEqual(await pending, INITIALIZE_RESULT);
});

test('extension registration grants authority only to its exact incoming direction', async (t) => {
  for (const direction of ['outbound_request', 'outbound_notification', 'inbound_request', 'inbound_notification'] satisfies AcpExtensionDirection[]) {
    await t.test(direction, async (t) => {
      let validations = 0;
      let calls = 0;
      const method = '_direction/mapped';
      const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard',
        extensions: createAcpExtensionRegistry([{ method, direction,
          validateParams() { validations += 1; return true; }, validateResult: () => true }]),
        reverseRequestHandlers: { [method]: () => { calls += 1; return {}; } },
        notificationHandlers: { [method]: () => { calls += 1; } },
      });
      t.after(() => harness.client.dispose());
      if (direction !== 'inbound_notification') harness.send({ jsonrpc: '2.0', method, params: {} });
      if (direction !== 'inbound_request') {
        harness.send({ jsonrpc: '2.0', id: 'wrong-direction', method, params: {} });
        assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
          jsonrpc: '2.0', id: 'wrong-direction', error: { code: -32601, message: 'Method not found' },
        });
      }
      assert.equal(validations, 0);
      assert.equal(calls, 0);
    });
  }
});

test('standard policy preserves validated registered handlers and safely-ignorable semantics', async (t) => {
  const observed: string[] = [];
  const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard',
    extensions: createAcpExtensionRegistry([
      { method: '_registered/progress', direction: 'inbound_notification', safelyIgnorable: true,
        validateParams: (value) => value !== null && typeof value === 'object' },
      { method: '_registered/read', direction: 'inbound_request', validateParams: () => true,
        validateResult: (value) => value === 'registered-result' },
    ]),
    notificationHandlers: { '_registered/progress': () => { observed.push('progress'); } },
    reverseRequestHandlers: { '_registered/read': () => { observed.push('read'); return 'registered-result'; } },
  });
  t.after(() => harness.client.dispose());
  harness.send({ jsonrpc: '2.0', method: '_registered/progress', params: {} });
  harness.send({ jsonrpc: '2.0', method: '_unknown/progress', params: {} });
  harness.send({ jsonrpc: '2.0', id: 'read', method: '_registered/read', params: {} });
  assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), {
    jsonrpc: '2.0', id: 'read', result: 'registered-result',
  });
  assert.deepEqual(observed, ['progress', 'read']);
});

test('ignored notifications remain rate-accounted without occupying handler slots', async (t) => {
  const release = Promise.withResolvers<void>();
  const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard',
    limits: { maxNotificationsPerWindow: 3, maxNotificationHandlerConcurrency: 1, shutdownDrainMs: 0 },
    now: () => 1_000,
    extensions: createAcpExtensionRegistry([{ method: '_registered/busy', direction: 'inbound_notification',
      validateParams: () => true }]),
    notificationHandlers: { '_registered/busy': () => release.promise },
  });
  t.after(async () => { release.resolve(); await harness.client.dispose(); });
  harness.send({ jsonrpc: '2.0', method: '_registered/busy', params: {} });
  harness.send({ jsonrpc: '2.0', method: '_ignored/one' });
  harness.send({ jsonrpc: '2.0', method: '_ignored/two' });
  await harness.client.notify('session/cancel', { sessionId: 'still-open' });
  harness.send({ jsonrpc: '2.0', method: '_ignored/three' });
  assert.equal(await reason(harness.client), 'acp_notification_rate_exceeded');
});

test('standard policy does not turn malformed or recognized messages into unknown extensions', async (t) => {
  const cases = [
    { name: 'bad JSON', raw: 'not-json\n', reason: 'acp_json_invalid' },
    { name: 'unknown notification envelope', raw: '{"jsonrpc":"2.0","method":"_optional","extra":1}\n', reason: 'acp_notification_envelope_invalid' },
    { name: 'unknown request ID', raw: '{"jsonrpc":"2.0","id":null,"method":"_optional"}\n', reason: 'acp_request_id_invalid' },
    { name: 'hostile JSON', raw: '{"jsonrpc":"2.0","method":"_optional","params":{"__proto__":{}}}\n', reason: 'acp_json_prototype_key_denied' },
    { name: 'unknown ordinary request', raw: '{"jsonrpc":"2.0","id":1,"method":"vendor/unknown"}\n', reason: 'acp_unsolicited_request' },
    { name: 'unknown ordinary notification', raw: '{"jsonrpc":"2.0","method":"vendor/unknown"}\n', reason: 'acp_unsolicited_notification' },
    { name: 'core wrong direction', raw: '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}\n', reason: 'acp_unsolicited_request' },
    { name: 'core request as notification', raw: '{"jsonrpc":"2.0","method":"fs/read_text_file","params":{"sessionId":"s","path":"/tmp/a"}}\n', reason: 'acp_unsolicited_notification' },
    { name: 'core notification as request', raw: '{"jsonrpc":"2.0","id":1,"method":"session/update","params":{}}\n', reason: 'acp_unsolicited_request' },
    { name: 'invalid core payload', raw: '{"jsonrpc":"2.0","method":"session/update","params":{}}\n', reason: 'acp_method_payload_invalid' },
    { name: 'unknown protocol notification', raw: '{"jsonrpc":"2.0","method":"$/unknown"}\n', reason: 'acp_unknown_critical_extension' },
    { name: 'protocol notification as request', raw: '{"jsonrpc":"2.0","id":1,"method":"$/cancel_request","params":{"requestId":1}}\n', reason: 'acp_unknown_critical_extension' },
    { name: 'invalid protocol control', raw: '{"jsonrpc":"2.0","method":"$/cancel_request","params":{}}\n', reason: 'acp_method_payload_invalid' },
    { name: 'orphan response', raw: '{"jsonrpc":"2.0","id":1,"result":{}}\n', reason: 'acp_orphan_or_late_response' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard' });
      t.after(() => harness.client.dispose());
      harness.sendRaw(scenario.raw);
      assert.equal(await reason(harness.client), scenario.reason);
    });
  }
  for (const direction of ['inbound_request', 'inbound_notification'] as const) {
    await t.test(`invalid registered ${direction}`, async (t) => {
      let calls = 0;
      const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard',
        extensions: createAcpExtensionRegistry([{ method: '_registered/invalid', direction,
          safelyIgnorable: true, validateParams: () => false, validateResult: () => true }]),
        notificationHandlers: { '_registered/invalid': () => { calls += 1; } },
        reverseRequestHandlers: { '_registered/invalid': () => { calls += 1; return {}; } },
      });
      t.after(() => harness.client.dispose());
      harness.send({ jsonrpc: '2.0', method: '_registered/invalid', params: {},
        ...(direction === 'inbound_request' ? { id: 'invalid' } : {}) });
      assert.equal(await reason(harness.client), 'acp_extension_params_invalid');
      assert.equal(calls, 0);
    });
  }
});

test('unknown notification tolerance still applies the frame and JSON depth bounds', async (t) => {
  for (const scenario of [
    { name: 'frame', limits: { maxInboundFrameBytes: 1_024 },
      params: { text: 'x'.repeat(2_000) }, reason: 'acp_stdout_frame_too_large' },
    { name: 'depth', limits: { maxJsonDepth: 4 },
      params: { a: { b: { c: { d: 1 } } } }, reason: 'acp_json_depth_limit_exceeded' },
  ]) {
    await t.test(scenario.name, async (t) => {
      const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard', limits: scenario.limits });
      t.after(() => harness.client.dispose());
      harness.send({ jsonrpc: '2.0', method: '_ignored/invalid', params: scenario.params });
      assert.equal(await reason(harness.client), scenario.reason);
    });
  }
});

test('registered notifications retain missing-handler and handler-failure behavior', async (t) => {
  for (const handlerPresent of [false, true]) {
    await t.test(handlerPresent ? 'handler failure' : 'missing handler', async (t) => {
      const failure = new Error('registered callback failed');
      let validations = 0;
      const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard',
        extensions: createAcpExtensionRegistry([
          { method: '_registered/ignored', direction: 'inbound_notification', safelyIgnorable: true,
            validateParams() { validations += 1; return true; } },
          { method: '_registered/required', direction: 'inbound_notification',
            validateParams() { validations += 1; return true; } },
        ]),
        notificationHandlers: handlerPresent ? { '_registered/required': () => { throw failure; } } : {},
      });
      t.after(() => harness.client.dispose());
      harness.send({ jsonrpc: '2.0', method: '_registered/ignored', params: {} });
      await harness.client.notify('session/cancel', { sessionId: 'still-open' });
      harness.send({ jsonrpc: '2.0', method: '_registered/required', params: {} });
      if (handlerPresent) assert.equal((await withTestDeadline(harness.client.closed, 500)).error, failure);
      else assert.equal(await reason(harness.client), 'acp_notification_handler_missing');
      assert.equal(validations, 2);
    });
  }
});

test('standard policy leaves unknown outbound methods denied', async (t) => {
  const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard' });
  t.after(() => harness.client.dispose());
  for (const action of [() => harness.client.request('_optional/outbound', {}),
    () => harness.client.notify('_optional/outbound', {})]) {
    await assert.rejects(action, (error: unknown) => error instanceof AcpClientError
      && error.reasonCode === 'acp_outbound_method_not_registered');
  }
  await harness.client.notify('session/cancel', { sessionId: 'still-open' });
});
