// ------------------------------------------------------------------------------------------------
//                http.mjs - Backpressured Engine HTTP forwarding and narrowly armed wire faults
// ------------------------------------------------------------------------------------------------

import http from 'node:http';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';

export async function forwardHttp({ request, response, socketPath, record, fault, trace, signal, observeResponse, observeResponseBody }) {
  // First-wins abort reason: identity proves the client closed before any upstream failure or proxy-side cancellation,
  // so the proxy's own cancellation must reach this controller before the sockets it destroys report closing.
  const cancellation = new AbortController();
  const activeSignal = cancellation.signal;
  const proxyCancelled = () => cancellation.abort(signal.reason);
  if (signal.aborted) proxyCancelled(); else signal.addEventListener('abort', proxyCancelled, { once: true });
  const downstreamClosed = new Error('Downstream HTTP observer closed.');
  const abandoned = () => cancellation.signal.reason === downstreamClosed;
  const abort = () => { if (!response.writableFinished) cancellation.abort(downstreamClosed); };
  response.on('close', abort);
  // A chunk the downstream socket accepted is forwarded, even when the client closes while the proxy awaits drain.
  const write = async (bytes) => {
    if (response.destroyed) abort();
    activeSignal.throwIfAborted();
    const accepted = response.write(bytes);
    record.forwardedBodyBytes += bytes.length;
    if (!accepted) await once(response, 'drain', { signal: activeSignal });
  };
  let upstream;
  let responseWork;
  let writer;
  let upstreamClosed;
  let receipt;
  let bodyObserver;
  let complete = false;
  const responseClosed = response.closed ? Promise.resolve() : new Promise((resolve) => response.once('close', resolve));
  if (response.closed) cancellation.abort(new Error('Downstream HTTP observer already closed.'));
  try {
    let resolveResponse;
    let rejectResponse;
    const received = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    upstream = http.request({ socketPath, path: request.url, method: request.method, headers: request.headers,
      agent: false, maxHeaderSize: 16 * 1024, signal: activeSignal }, (source) => { source.on('error', () => {}); resolveResponse(source); });
    upstreamClosed = upstream.closed ? Promise.resolve() : new Promise((resolve) => upstream.once('close', resolve));
    upstream.once('error', rejectResponse);
    writer = pipeline(request, async function* (source) {
      for await (const chunk of source) { record.uploadedBytes += chunk.length; yield chunk; }
    }, upstream, { signal: activeSignal });
    void writer.catch(() => {});
    responseWork = (async () => {
      const source = await received;
      record.status = source.statusCode;
      record.fault = fault?.kind ?? null;
      await observeResponse?.({ method: request.method, target: request.url, status: source.statusCode });
      bodyObserver = await observeResponseBody?.({ method: request.method, target: request.url, status: source.statusCode, traceId: record.id });
      fault?.onEnter();
      if (fault?.kind === 'drop-response') {
        for await (const chunk of source) record.upstreamBodyBytes += chunk.length;
        await writer;
        response.destroy(new Error('Qualification discarded an exact cleanup acknowledgement.'));
        return;
      }
      const headers = { ...source.headers };
      if (fault?.kind === 'late-trailer') delete headers['content-length'];
      response.writeHead(source.statusCode, headers);
      if (fault?.kind === 'stall') {
        response.flushHeaders();
        await new Promise((_, reject) => {
          if (activeSignal.aborted) reject(activeSignal.reason);
          else activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true });
        });
      }
      for await (const chunk of source) {
        activeSignal.throwIfAborted();
        record.upstreamBodyBytes += chunk.length;
        await bodyObserver?.body(chunk);
        await write(chunk);
      }
      complete = true;
      if (fault?.kind === 'late-trailer') await write(Buffer.from([1]));
      await writer;
      response.end();
      await finished(response, { cleanup: true });
    })().finally(() => bodyObserver?.complete({ complete, abandoned: abandoned() }));
    await responseWork;
  } catch (error) {
    record.failure = { name: error instanceof Error ? error.name : 'ThrownValue', message: String(error instanceof Error ? error.message : error).slice(0, 512),
      ...(typeof error?.code === 'string' ? { code: error.code.slice(0, 128) } : {}) };
    cancellation.abort(error);
    upstream?.destroy(error instanceof Error ? error : new Error('Forwarding failed.'));
    response.destroy(error instanceof Error ? error : new Error('Forwarding failed.'));
    await Promise.allSettled([writer, responseWork]);
  } finally {
    signal.removeEventListener('abort', proxyCancelled);
    response.removeListener('close', abort);
    upstream?.destroy();
    await Promise.allSettled([writer, responseWork, upstreamClosed, responseClosed]);
    record.terminal = { kind: 'http', upstreamRequestClosed: upstream?.closed === true, downstreamResponseClosed: response.closed === true,
      downstreamAbandoned: abandoned() };
    receipt = await trace.finish(record);
  }
  return receipt;
}
