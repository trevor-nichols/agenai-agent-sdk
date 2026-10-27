// ------------------------------------------------------------------------------------------------
//                relay.ts - Bounded loopback transport with no administrative or filesystem requests
// ------------------------------------------------------------------------------------------------

import { createConnection, createServer, type Socket } from 'node:net';
import { EGRESS_SOCKET_PATH } from './protocol.js';
import type { EgressService } from './broker.js';
import { verifyEgressSocketDirectory } from './socketDirectory.js';

export async function startEgressRelay(signal: AbortSignal): Promise<EgressService> {
  signal.throwIfAborted();
  await verifyEgressSocketDirectory();
  signal.throwIfAborted();
  const sockets = new Set<Socket>();
  let closing = false;
  let closeActual: Promise<void> | undefined;
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => {});
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    if (closing || sockets.size > 32) { client.destroy(); return; }
    const upstream = track(createConnection(EGRESS_SOCKET_PATH));
    const timer = setTimeout(() => { client.destroy(); upstream.destroy(); }, 5000);
    upstream.once('connect', () => { clearTimeout(timer); client.pipe(upstream); upstream.pipe(client); });
    client.once('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.once('close', () => { clearTimeout(timer); client.destroy(); });
  });
  server.on('error', (error) => { if (!closing) failed.reject(error); });
  server.once('close', () => { if (!closing) failed.reject(new Error('Egress relay listener closed unexpectedly.')); });
  server.maxConnections = 16;
  const close = (): Promise<void> => {
    closing = true;
    closeActual ??= new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
      signal.removeEventListener('abort', abort);
    });
    return closeActual;
  };
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(3128, '127.0.0.1', resolve); });
    signal.throwIfAborted();
    return Object.freeze({ failed: failed.promise, close });
  } catch (error) { await close(); throw error; }
}
