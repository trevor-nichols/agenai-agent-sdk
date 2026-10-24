// ------------------------------------------------------------------------------------------------
//                standardSessionOperations.test.ts - Stable method selection and schema proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACP_PROTOCOL_VERSION,
  AcpProtocolError,
  AcpRequestError,
  createAcpStandardSessionOperations,
  type AcpJsonValue,
  type AcpStandardNewSessionParams,
} from '../src/index.js';
import {
  createAcpTestHarness,
  INITIALIZE_RESULT,
} from './harness.js';

async function completeRequest(input: {
  readonly pending: Promise<AcpJsonValue>;
  readonly harness: ReturnType<typeof createAcpTestHarness>;
  readonly expectedMethod: string;
  readonly expectedParams: Record<string, unknown>;
  readonly result: AcpJsonValue;
}): Promise<void> {
  const outbound = await input.harness.nextOutbound();
  assert.equal(outbound.method, input.expectedMethod);
  assert.deepEqual(outbound.params, input.expectedParams);
  input.harness.send({
    jsonrpc: '2.0',
    id: outbound.id,
    result: input.result,
  });
  assert.deepEqual(await input.pending, input.result);
}

test('standard operations select exact pinned methods and preserve standard parameters', async () => {
  const harness = createAcpTestHarness({ schemaChannel: 'stable' });
  const operations = createAcpStandardSessionOperations(harness.client);
  assert.equal(Object.isFrozen(operations), true);

  const initializeParams = {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: 'agenai-test', version: '0.1.0' },
    _meta: { fixture: 'initialize' },
  };
  await completeRequest({
    pending: operations.initialize(initializeParams, { timeoutMs: 5_000 }),
    harness,
    expectedMethod: 'initialize',
    expectedParams: initializeParams,
    result: INITIALIZE_RESULT,
  });

  const newSessionParams = {
    cwd: '/workspace',
    mcpServers: [],
    _meta: { fixture: 'new' },
  };
  await completeRequest({
    pending: operations.newSession(newSessionParams),
    harness,
    expectedMethod: 'session/new',
    expectedParams: newSessionParams,
    result: { sessionId: 'session-1' },
  });

  const loadSessionParams = {
    cwd: '/workspace',
    mcpServers: [],
    sessionId: 'session-1',
    _meta: { fixture: 'load' },
  };
  await completeRequest({
    pending: operations.loadSession(loadSessionParams),
    harness,
    expectedMethod: 'session/load',
    expectedParams: loadSessionParams,
    result: {},
  });

  const promptParams = {
    sessionId: 'session-1',
    prompt: [{ type: 'text' as const, text: 'hello' }],
    _meta: { fixture: 'prompt' },
  };
  await completeRequest({
    pending: operations.prompt(promptParams),
    harness,
    expectedMethod: 'session/prompt',
    expectedParams: promptParams,
    result: { stopReason: 'end_turn' },
  });

  const cancelParams = {
    sessionId: 'session-1',
    _meta: { fixture: 'cancel' },
  };
  await operations.cancel(cancelParams);
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: cancelParams,
  });
  await harness.client.dispose();
});

test('standard operations retain pinned schema rejection and request cancellation', async () => {
  const harness = createAcpTestHarness({ schemaChannel: 'unstable' });
  const operations = createAcpStandardSessionOperations(harness.client);
  await assert.rejects(
    operations.newSession({ cwd: '/workspace' } as unknown as AcpStandardNewSessionParams),
    (error: unknown) => error instanceof AcpProtocolError
      && error.reasonCode === 'acp_method_payload_invalid',
  );

  const controller = new AbortController();
  const prompt = operations.prompt(
    {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'cancel me' }],
    },
    { signal: controller.signal },
  );
  const outbound = await harness.nextOutbound();
  assert.equal(outbound.method, 'session/prompt');
  controller.abort();
  await assert.rejects(
    prompt,
    (error: unknown) => error instanceof AcpRequestError
      && error.reasonCode === 'acp_request_aborted',
  );
  assert.deepEqual(await harness.nextOutbound(), {
    jsonrpc: '2.0',
    method: '$/cancel_request',
    params: { requestId: outbound.id },
  });
  await harness.client.dispose();
});

test('standard discovery and deletion retain exact schema-profile admission and opaque cursors', async () => {
  for (const profile of ['v0.11.4', 'schema-v1.23.0'] as const) {
    const harness = createAcpTestHarness({ schemaChannel: 'stable', schemaProfile: profile });
    const operations = createAcpStandardSessionOperations(harness.client);
    try {
      await completeRequest({
        pending: operations.listSessions({ cwd: '/workspace', cursor: 'opaque/next?x=1' }),
        harness,
        expectedMethod: 'session/list',
        expectedParams: { cwd: '/workspace', cursor: 'opaque/next?x=1' },
        result: { sessions: [{ sessionId: 'saved-1', cwd: '/workspace', title: 'Saved session' }], nextCursor: 'opaque-final' },
      });
      if (profile === 'schema-v1.23.0') {
        await completeRequest({
          pending: operations.deleteSession({ sessionId: 'saved-1' }),
          harness,
          expectedMethod: 'session/delete',
          expectedParams: { sessionId: 'saved-1' },
          result: {},
        });
      } else {
        await assert.rejects(operations.deleteSession({ sessionId: 'saved-1' }),
          (error: unknown) => error instanceof Error && 'reasonCode' in error
            && error.reasonCode === 'acp_outbound_method_not_registered');
      }
    } finally { await harness.client.dispose(); }
  }
});
