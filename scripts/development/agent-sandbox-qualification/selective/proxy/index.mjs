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

export async function createTraceProxy({ socketPath, upstreamEndpoint, tracePath, observeRequest, observeResponse, observeResponseBody, observeRequestSettled, observeUpgrade,
  maxConnections = 16, maxActiveRequests = 16, maxPendingRequests = 0 }) {
  for (const limit of [maxConnections, maxActiveRequests]) assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 64,
    'Qualification proxy capacity must be an integer from one through sixty-four.');
  assert(Number.isSafeInteger(maxPendingRequests) && maxPendingRequests >= 0 && maxPendingRequests <= 64,
    'Qualification pending request capacity must be an integer from zero through sixty-four.');
  const admission = { limits: { connections: maxConnections, activeRequests: maxActiveRequests, pendingRequests: maxPendingRequests },
    connections: { accepted: 0, rejected: 0, current: 0, highWater: 0 },
    requests: { accepted: 0, rejected: 0, current: 0, highWater: 0 },
    pendingRequests: { accepted: 0, promoted: 0, cancelled: 0, rejected: 0, current: 0, retiring: 0, highWater: 0 } };
  const capacity = () => structuredClone(admission);
  const trace = await RequestTrace.create(tracePath, capacity);
  const cancellation = new AbortController();
  const active = new Set();
  const pending = new Set(), waiting = new Set(), owned = new Set();
  const sockets = new Set();
  const failures = [];
  let armed;
  let admissionClosed = false;
  const server = http.createServer({ maxHeaderSize: 16 * 1024, highWaterMark: 64 * 1024 });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  const admit = (boundary, limit, request) => {
    const counter = admission[boundary === 'connection' ? 'connections' : 'requests'];
    if (counter.current >= limit) {
      counter.rejected++;
      void trace.rejected(boundary, request).catch((error) => failures.push(error));
      return false;
    }
    counter.accepted++; counter.current++; counter.highWater = Math.max(counter.highWater, counter.current);
    return true;
  };
  server.on('connection', (socket) => {
    if (!admit('connection', maxConnections)) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); admission.connections.current--; });
  });
  const activate = (job) => {
    job.state = 'active'; active.add(job); admission.requests.current++;
    admission.requests.highWater = Math.max(admission.requests.highWater, admission.requests.current);
    job.ready.resolve({ kind: 'dispatch' });
  };
  const pump = () => {
    while (!admissionClosed && active.size < maxActiveRequests && waiting.size) {
      const job = waiting.values().next().value; waiting.delete(job);
      pending.delete(job); admission.pendingRequests.current--; admission.pendingRequests.promoted++;
      job.record.waiting.releasedAt = new Date().toISOString(); activate(job);
    }
  };
  const cancelQueued = (job, reason) => {
    if (job.state !== 'queued') return;
    waiting.delete(job);
    job.state = 'queued_retirement'; admission.pendingRequests.cancelled++; admission.pendingRequests.retiring++;
    job.ready.resolve({ kind: 'cancelled', reason });
    pump();
  };
  const notForwarded = async (job, reason, error) => {
    job.response.destroy(); await job.closed;
    job.record.failure = error ? { name: error.name ?? 'ThrownValue', message: String(error.message ?? error).slice(0, 512) }
      : { name: 'QualificationPreDispatchCancellation', code: 'pre_dispatch_cancelled', message: `Original request retired before upstream acquisition: ${reason}.` };
    job.record.terminal = { kind: 'http_not_forwarded', upstreamAcquisition: 'not_entered',
      downstreamResponseClosed: job.response.closed === true, reason };
    return trace.finish(job.record);
  };
  const enter = (request, response, head) => {
    const queued = active.size >= maxActiveRequests;
    if (admissionClosed || queued && pending.size >= maxPendingRequests) {
      admission.requests.rejected++; if (queued) admission.pendingRequests.rejected++;
      void trace.rejected('request', request).catch((error) => failures.push(error));
      response.destroy(new Error('Qualification forwarding concurrency exceeded its admitted request capacity.')); return;
    }
    admission.requests.accepted++;
    const job = { request, response, head, record: trace.begin(request.method, request.url), ready: Promise.withResolvers(), state: 'new', closed: null };
    const closed = () => { cancelQueued(job, 'downstream_closed'); };
    job.closed = response.closed ? Promise.resolve() : new Promise((resolve) => response.once('close', resolve));
    response.once('close', closed);
    if (queued) {
      job.state = 'queued'; pending.add(job); waiting.add(job); request.pause();
      if (head !== undefined) response.pause();
      job.record.waiting = { enteredAt: new Date().toISOString() };
      admission.pendingRequests.accepted++; admission.pendingRequests.current++;
      admission.pendingRequests.highWater = Math.max(admission.pendingRequests.highWater, admission.pendingRequests.current);
      if (response.closed) cancelQueued(job, 'downstream_closed');
    } else activate(job);
    const work = (async () => {
      let receipt, forwardingEntered = false;
      try {
        if (observeRequest) await observeRequest({ method: request.method, target: request.url, traceId: job.record.id });
        const decision = await job.ready.promise;
        if (decision.kind === 'cancelled') receipt = await notForwarded(job, decision.reason);
        else {
          let fault;
          if (armed && armed.method === request.method && armed.target === request.url) { fault = armed; armed = undefined; }
          forwardingEntered = true;
          receipt = await (head === undefined
            ? forwardHttp({ request, response, socketPath: upstreamEndpoint.slice(7), record: job.record, fault, trace,
              signal: cancellation.signal, observeResponse, observeResponseBody })
            : forwardUpgrade({ request, socket: response, head, socketPath: upstreamEndpoint.slice(7), record: job.record,
              trace, signal: cancellation.signal, observeUpgrade }));
        }
      } catch (error) {
        failures.push(error);
        if (!forwardingEntered) { cancelQueued(job, 'request_observer_failed'); receipt = await notForwarded(job, 'request_observer_failed', error); }
        else response.destroy();
      }
      if (receipt) { try { await observeRequestSettled?.(receipt); } catch (error) { failures.push(error); } }
    })();
    owned.add(work);
    const settled = () => {
      response.removeListener('close', closed);
      if (active.delete(job)) admission.requests.current--;
      if (pending.delete(job)) {
        admission.pendingRequests.current--;
        if (job.state === 'queued_retirement') admission.pendingRequests.retiring--;
      }
      job.state = 'settled'; owned.delete(work); pump();
    };
    void work.then(settled, (error) => { failures.push(error); response.destroy(); settled(); });
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
    capacity,
    async idle() { while (owned.size) await Promise.allSettled([...owned]); await trace.idle(); if (failures.length) throw new AggregateError(failures, 'Trace forwarding work failed.'); },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        admissionClosed = true;
        const closure = serverClosed ? Promise.resolve() : new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        for (const job of pending) cancelQueued(job, 'proxy_closing');
        cancellation.abort(new Error('Owned trace proxy closing.'));
        for (const socket of sockets) socket.destroy();
        while (owned.size) await Promise.allSettled([...owned]);
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
