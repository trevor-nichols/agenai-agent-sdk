import assert from 'node:assert/strict';

import { AcpClientError, AcpRemoteError, AcpRequestError } from '../../src/index.js';
import { createAcpTestHarness, INITIALIZE_PARAMS, INITIALIZE_RESULT } from '../harness.js';

const scenario = process.argv[2];

if (scenario === 'reverse-drain' || scenario === 'notification-drain') {
  let enterHandler!: () => void;
  const entered = new Promise<void>((resolve) => { enterHandler = resolve; });
  const stuckHandler = () => {
    enterHandler();
    return new Promise<never>(() => {});
  };
  let transportDisposed = false;
  const harness = createAcpTestHarness({
    schemaProfile: 'schema-v1.23.0',
    schemaChannel: 'stable',
    limits: { shutdownDrainMs: 250 },
    reverseRequestHandlers: { 'fs/read_text_file': stuckHandler },
    notificationHandlers: { 'session/update': stuckHandler },
    disposeTransport: () => { transportDisposed = true; },
  });
  harness.send(scenario === 'reverse-drain' ? {
    jsonrpc: '2.0', id: 'reverse-1', method: 'fs/read_text_file',
    params: { sessionId: 's', path: '/workspace/file.txt' },
  } : {
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    },
  });
  await entered;
  await harness.client.dispose();
  assert.equal(transportDisposed, true);
  assert.equal((await harness.client.closed).kind, 'disposed');
} else {
  const harness = createAcpTestHarness({
    schemaProfile: 'schema-v1.23.0',
    schemaChannel: 'stable',
    limits: { shutdownDrainMs: 30_000 },
  });
  const controller = new AbortController();
  const pending = harness.client.request('initialize', INITIALIZE_PARAMS, {
    timeoutMs: scenario === 'deadline' ? 250 : 60_000,
    signal: controller.signal,
  });
  const outbound = await harness.nextOutbound();
  switch (scenario) {
    case 'deadline':
      await assert.rejects(pending, (error: unknown) => (
        error instanceof AcpRequestError && error.reasonCode === 'acp_request_deadline_exceeded'
      ));
      break;
    case 'response':
      harness.send({ jsonrpc: '2.0', id: outbound.id, result: INITIALIZE_RESULT });
      assert.deepEqual(await pending, INITIALIZE_RESULT);
      break;
    case 'remote-error':
      harness.send({ jsonrpc: '2.0', id: outbound.id, error: { code: -32603, message: 'failed' } });
      await assert.rejects(pending, AcpRemoteError);
      break;
    case 'abort': {
      const rejected = assert.rejects(pending, (error: unknown) => (
        error instanceof AcpRequestError && error.reasonCode === 'acp_request_aborted'
      ));
      controller.abort();
      await rejected;
      break;
    }
    case 'dispose': {
      const rejected = assert.rejects(pending, (error: unknown) => (
        error instanceof AcpClientError && error.reasonCode === 'acp_client_disposed'
      ));
      await harness.client.dispose();
      await rejected;
      break;
    }
    default:
      throw new Error(`Unknown liveness scenario: ${scenario}`);
  }
  await harness.client.dispose();
}

// Natural exit proves settled operations leave no live deadline or drain timers behind.
process.stdout.write('settled\n');
