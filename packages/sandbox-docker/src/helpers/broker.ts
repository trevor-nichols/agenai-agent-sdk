// ------------------------------------------------------------------------------------------------
//                broker.ts - Unix-only bounded CONNECT and independently admitted numeric peers
// ------------------------------------------------------------------------------------------------

import { Resolver } from 'node:dns/promises';
import { chmod } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { addressAdmission, parseConnect } from '../network/policy.js';
import { EGRESS_SOCKET_PATH, type EgressHelperConfiguration } from './protocol.js';
import { verifyEgressSocketDirectory } from './socketDirectory.js';
import { awaitEgressConnection } from './connection.js';

export interface EgressService { readonly failed: Promise<never>; close(): Promise<void> }

export async function startEgressBroker(configuration: Extract<EgressHelperConfiguration, { role: 'broker' }>, signal: AbortSignal): Promise<EgressService> {
  signal.throwIfAborted();
  await verifyEgressSocketDirectory();
  signal.throwIfAborted();
  const permitted = addressAdmission(configuration.excludedCidrs);
  const sockets = new Set<Socket>();
  const resolvers = new Set<Resolver>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closeActual: Promise<void> | undefined;
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => {});
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    if (closing || sockets.size > 32) { client.destroy(); return; }
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), 5000);
    client.once('close', () => clearTimeout(timer));
    const deny = (status = 403) => client.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    const receive = (chunk: Buffer) => {
      if (header.length + chunk.length > 8192) { client.removeListener('data', receive); deny(431); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.pause();
      client.removeListener('data', receive);
      const actual = (async () => {
        let upstream: Socket | undefined;
        try {
          const endpoint = parseConnect(header.subarray(0, end + 4).toString('latin1'), configuration.destinations);
          const resolver = new Resolver({ timeout: 2000, tries: 1 });
          resolvers.add(resolver);
          const cancel = () => resolver.cancel();
          client.once('close', cancel);
          let answers: ReadonlyArray<Readonly<{ address: string; family: 4 | 6 }>>;
          try {
            const read = async (family: 4 | 6) => {
              try { return (await (family === 4 ? resolver.resolve4(endpoint.hostname) : resolver.resolve6(endpoint.hostname))).map((address) => ({ address, family })); }
              catch (error) {
                if (error instanceof Error && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return [];
                throw error;
              }
            };
            answers = (await Promise.all([read(4), read(6)])).flat();
          } finally { resolver.cancel(); resolvers.delete(resolver); client.removeListener('close', cancel); }
          if (closing || client.destroyed) return;
          if (answers.length === 0 || answers.length > 16 || answers.some((answer) => !permitted(answer.address))) { deny(); return; }
          const pinned = answers[0];
          const connected = track(createConnection({ host: pinned.address, family: pinned.family, port: endpoint.port }));
          upstream = connected;
          client.once('close', () => connected.destroy());
          await awaitEgressConnection(connected);
          if (closing || client.destroyed) { connected.destroy(); return; }
          if (connected.remoteAddress !== pinned.address) throw new Error('Connected peer differs from the admitted numeric address.');
          clearTimeout(timer);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (header.length > end + 4) connected.write(header.subarray(end + 4));
          header = Buffer.alloc(0);
          client.pipe(connected); connected.pipe(client); client.resume();
          connected.once('close', () => client.destroy());
        } catch {
          upstream?.destroy();
          if (!client.destroyed) deny();
        }
      })();
      pending.add(actual);
      void actual.then(() => pending.delete(actual));
    };
    client.on('data', receive);
  });
  server.on('error', (error) => { if (!closing) failed.reject(error); });
  server.once('close', () => { if (!closing) failed.reject(new Error('Egress broker listener closed unexpectedly.')); });
  server.maxConnections = 16;
  const close = (): Promise<void> => {
    closing = true;
    if (!closeActual) closeActual = (async () => {
      for (const resolver of resolvers) resolver.cancel();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve()));
      await Promise.allSettled([...pending]);
      signal.removeEventListener('abort', abort);
    })();
    return closeActual;
  };
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(EGRESS_SOCKET_PATH, resolve); });
    await chmod(EGRESS_SOCKET_PATH, 0o600);
    signal.throwIfAborted();
    return Object.freeze({ failed: failed.promise, close });
  } catch (error) { await close(); throw error; }
}
