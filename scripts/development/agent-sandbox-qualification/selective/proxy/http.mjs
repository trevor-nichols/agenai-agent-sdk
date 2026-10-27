// ------------------------------------------------------------------------------------------------
//                http.mjs - Backpressured Engine HTTP forwarding and narrowly armed wire faults
// ------------------------------------------------------------------------------------------------

import http from 'node:http';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';

async function write(response, bytes, signal) {
  if (!response.write(bytes)) await once(response, 'drain', { signal });
}

export async function forwardHttp({ request, response, socketPath, record, fault, trace, signal, observeResponse, observeResponseBody }) {
  const cancellation = new AbortController();
  const activeSignal = AbortSignal.any([signal, cancellation.signal]);
  const abort = () => { if (!response.writableFinished) cancellation.abort(new Error('Downstream HTTP observer closed.')); };
  response.on('close', abort);
  let upstream;
  let responseWork;
  let writer;
  let bodyObserver;
  let complete = false;
  let recorded = false;
  try {
    let resolveResponse;
    let rejectResponse;
    const received = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    upstream = http.request({ socketPath, path: request.url, method: request.method, headers: request.headers,
      agent: false, maxHeaderSize: 16 * 1024, signal: activeSignal }, (source) => { source.on('error', () => {}); resolveResponse(source); });
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
        await write(response, chunk, activeSignal);
        record.forwardedBodyBytes += chunk.length;
      }
      complete = true;
      if (fault?.kind === 'late-trailer') {
        await write(response, Buffer.from([1]), activeSignal);
        record.forwardedBodyBytes += 1;
      }
      await writer;
      await trace.finish(record);
      recorded = true;
      response.end();
      await finished(response, { cleanup: true });
    })().finally(() => bodyObserver?.complete({ complete }));
    await responseWork;
  } catch (error) {
    record.failure = { name: error instanceof Error ? error.name : 'ThrownValue', message: String(error instanceof Error ? error.message : error).slice(0, 512) };
    cancellation.abort(error);
    upstream?.destroy(error instanceof Error ? error : new Error('Forwarding failed.'));
    response.destroy(error instanceof Error ? error : new Error('Forwarding failed.'));
    await Promise.allSettled([writer, responseWork]);
    if (!recorded) { await trace.finish(record); recorded = true; }
  } finally {
    response.removeListener('close', abort);
    upstream?.destroy();
    if (fault?.kind === 'drop-response' && !recorded) await trace.finish(record);
  }
}
