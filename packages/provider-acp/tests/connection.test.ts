import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { initializeAcpConnection } from '../src/connection/initialize.js';
import { resolveAcpProviderLimits } from '../src/limits.js';
import { createStreamPeer } from './node-fixtures/peer.js';

test('a stopped listener reentering connection close shares the published cleanup operation', async () => {
  const peer = createStreamPeer();
  let releases = 0;
  const connection = await initializeAcpConnection({
    source: { kind: 'factory', create: () => ({
      ...peer.lease, ownership: 'owned', release() {
        releases += 1; peer.stdout.destroy(); peer.stdin.destroy();
      },
    }) },
    context: { instanceId: parseAgentInstanceId('connection:fixture') },
    unknownExtensionPolicy: 'standard',
    limits: resolveAcpProviderLimits(),
    usedStreams: new WeakSet(),
  });
  let reentered: Promise<void> | undefined;
  connection.stopped.addEventListener('abort', () => { reentered = connection.close(); }, { once: true });
  const closing = connection.close();
  assert.equal(connection.stopped.aborted, true);
  assert.equal(reentered, closing);
  await closing;
  await connection.close();
  assert.equal(releases, 1);
});
