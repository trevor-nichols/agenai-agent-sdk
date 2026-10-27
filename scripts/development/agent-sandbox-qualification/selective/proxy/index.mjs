// ------------------------------------------------------------------------------------------------
//                index.mjs - Explicit owned Unix trace endpoint with finite forwarding concurrency
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { RequestTrace } from './trace.mjs';
import { forwardHttp } from './http.mjs';
import { forwardUpgrade } from './upgrade.mjs';

export async function createTraceProxy({ socketPath, upstreamEndpoint, tracePath, observeResponse, observeResponseBody, observeUpgrade }) {
  const trace = await RequestTrace.create(tracePath);
  const cancellation = new AbortController();
  const active = new Set();
  const sockets = new Set();
  const failures = [];
  let armed;
  const server = http.createServer({ maxHeaderSize: 16 * 1024, highWaterMark: 64 * 1024 });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.on('connection', (socket) => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const enter = (request, response, head) => {
    if (active.size >= 16) { response.destroy(new Error('Qualification forwarding concurrency exceeded sixteen requests.')); return; }
    const record = trace.begin(request.method, request.url);
    let fault;
    if (armed && armed.method === request.method && armed.target === request.url) { fault = armed; armed = undefined; }
    const work = head === undefined
      ? forwardHttp({ request, response, socketPath: upstreamEndpoint.slice(7), record, fault, trace, signal: cancellation.signal, observeResponse, observeResponseBody })
      : forwardUpgrade({ request, socket: response, head, socketPath: upstreamEndpoint.slice(7), record, trace, signal: cancellation.signal, observeUpgrade });
    active.add(work);
    void work.then(() => active.delete(work), (error) => { failures.push(error); active.delete(work); response.destroy(); });
  };
  server.on('request', (request, response) => enter(request, response));
  server.on('upgrade', (request, socket, head) => enter(request, socket, head));
  let identity;
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    await chmod(socketPath, 0o600);
    identity = await lstat(socketPath, { bigint: true });
  } catch (error) {
    const cleanup = [];
    if (server.listening) cleanup.push(new Promise((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve())));
    cleanup.push(trace.close());
    const failures = (await Promise.allSettled(cleanup)).filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Trace endpoint acquisition and cleanup failed.');
    throw error;
  }
  let closing;
  let serverClosed = false;
  let traceClosed = false;
  let socketRemoved = false;
  return {
    endpoint: `unix://${socketPath}`, tracePath,
    setRow(row) { assert(typeof row === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(row)); trace.row = row; },
    arm(fault) {
      assert(!armed && ['late-trailer', 'stall', 'drop-response'].includes(fault.kind));
      return new Promise((resolve) => { armed = { ...fault, onEnter: resolve }; });
    },
    summary: (row) => trace.summary(row),
    async idle() { while (active.size) await Promise.allSettled([...active]); if (failures.length) throw new AggregateError(failures, 'Trace forwarding work failed.'); },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        const closure = serverClosed ? Promise.resolve() : new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        cancellation.abort(new Error('Owned trace proxy closing.'));
        for (const socket of sockets) socket.destroy();
        while (active.size) await Promise.allSettled([...active]);
        await closure; serverClosed = true;
        if (!traceClosed) { await trace.close(); traceClosed = true; }
        if (!socketRemoved) {
          try {
            const current = await lstat(socketPath, { bigint: true });
            assert(current.isSocket() && current.dev === identity.dev && current.ino === identity.ino, 'Trace socket identity changed; preserved.');
            await unlink(socketPath);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          socketRemoved = true;
        }
        if (failures.length) throw new AggregateError(failures, 'Trace forwarding work failed.');
        assert.equal(armed, undefined, 'An armed qualification fault was never exercised.');
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
