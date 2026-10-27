// ------------------------------------------------------------------------------------------------
//                network-connections.test.ts - Real socket closure settles an entered connection waiter
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createConnection, createServer, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { awaitEgressConnection } from '../src/helpers/connection.js';

test('connection waiter accepts an actual TCP connection and rejects close without error before connection', { timeout: 5000 }, async () => {
  const server = createServer((socket) => { socket.on('error', () => {}); socket.end('connected'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture.');
  const connected = createConnection({ host: '127.0.0.1', port: address.port });
  const cancelled = new Socket();
  try {
    await awaitEgressConnection(connected);
    assert.equal(connected.remotePort, address.port);
    const pending = awaitEgressConnection(cancelled).then(() => 'connected', () => 'closed');
    cancelled.destroy();
    assert.equal(await Promise.race([pending, delay(100).then(() => 'pending')]), 'closed');
  } finally {
    connected.destroy(); cancelled.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
