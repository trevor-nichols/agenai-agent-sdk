import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { failure } from './evidence.mjs';

const limits = Object.freeze({ requests: 4096, active: 16, chunks: 1024, responseBytes: 4 * 1024 ** 2, bodyBytes: 48 * 1024 ** 2 });
const scope = 'Passive copies of data events emitted by this process Node HTTP responses on the original Unix socket for selected GETs only. No extra request, socket, proxy, data listener, read, resume or replay is introduced. Copying and asynchronous evidence writes can perturb timing; this is diagnostic evidence, not an uninstrumented timing result.';
const selectedTarget = /^(?:\/v1\.52)?\/(?:info|networks(?:\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255})?|containers\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}\/json)$/u;

export async function installEngineCapture({ socketPath, evidence }) {
  assert(typeof socketPath === 'string' && socketPath.startsWith('/'));
  await mkdir(join(evidence.directory, 'engine-capture'), { mode: 0o700 });
  const originalRequest = http.request; const originalGet = http.get;
  const active = new Map(); const instrumented = new WeakSet(); const writes = [];
  const record = { format: 'agenai.desktop-coordinator-engine-capture.v1', scope, limits,
    socketPath, startedAt: new Date().toISOString(), entries: [], failures: [], bodyBytes: 0,
    skippedRequests: 0, completeness: 'open' };
  let closed = false;
  const failed = (error) => { if (record.failures.length < 16) record.failures.push(failure(error)); };
  const instrument = (request, options) => {
    if (closed || !options || typeof options !== 'object' || options.socketPath !== socketPath
      || String(options.method ?? 'GET').toUpperCase() !== 'GET' || !selectedTarget.test(options.path)) return request;
    if (instrumented.has(request)) return request;
    instrumented.add(request);
    if (record.entries.length >= limits.requests || active.size >= limits.active) {
      record.skippedRequests += 1;
      failed(new Error('Passive Engine capture request or in-flight bound exhausted.'));
      return request;
    }
    const entry = { sequence: record.entries.length + 1, pid: process.pid, method: 'GET', target: options.path,
      requestedAt: new Date().toISOString(), status: null, responseAt: null, finishedAt: null,
      responseBytes: 0, capturedBytes: 0, complete: false, terminal: null, body: null };
    record.entries.push(entry);
    const started = performance.now(); let chunks = []; let response; let responseEmit; let finished = false;
    const requestEmit = request.emit;
    const finish = (terminal) => {
      if (finished) return;
      finished = true;
      entry.finishedAt = new Date().toISOString(); entry.elapsedMs = performance.now() - started; entry.terminal = terminal;
      entry.complete = terminal === 'end' && response.complete === true && entry.responseBytes === entry.capturedBytes;
      if (!entry.complete) failed(new Error(`Selected Engine response was not completely captured (${terminal}).`));
      request.emit = requestEmit;
      if (response) response.emit = responseEmit;
      active.delete(request);
      const bytes = Buffer.concat(chunks, entry.capturedBytes); chunks = [];
      const writing = evidence.file(`engine-capture/${String(entry.sequence).padStart(5, '0')}-body.json`, bytes, limits.responseBytes)
        .then((body) => { entry.body = body; }).catch(failed);
      writes.push(writing);
    };
    active.set(request, finish);
    request.emit = function capturedRequestEvent(event, ...args) {
      if (event === 'response') {
        response = args[0]; responseEmit = response.emit;
        entry.status = response.statusCode; entry.responseAt = new Date().toISOString();
        entry.contentType = response.headers['content-type'] ?? null;
        response.emit = function capturedResponseEvent(kind, ...values) {
          if (kind === 'data') {
            try {
              const chunk = values[0];
              assert(chunk instanceof Uint8Array, 'Selected Engine data was not an original byte chunk.');
              entry.responseBytes += chunk.byteLength;
              const count = Math.min(chunk.byteLength, limits.responseBytes - entry.capturedBytes, limits.bodyBytes - record.bodyBytes);
              if (count > 0 && chunks.length < limits.chunks) {
                chunks.push(Buffer.from(chunk.subarray(0, count))); entry.capturedBytes += count; record.bodyBytes += count;
              }
            } catch (error) { failed(error); }
          }
          if (kind === 'error') entry.error = failure(values[0]);
          const result = Reflect.apply(responseEmit, this, [kind, ...values]);
          if (kind === 'end' || kind === 'close') finish(kind === 'end' ? 'end' : 'response_close');
          return result;
        };
      }
      if (event === 'error') entry.error = failure(args[0]);
      const result = Reflect.apply(requestEmit, this, [event, ...args]);
      if (event === 'close' && !response) finish('request_close');
      return result;
    };
    return request;
  };
  http.request = function capturedRequest(...args) { return instrument(Reflect.apply(originalRequest, this, args), args[0]); };
  http.get = function capturedGet(...args) { return instrument(Reflect.apply(originalGet, this, args), args[0]); };
  syncBuiltinESMExports();
  return {
    completedSince(target, after) {
      return record.entries.filter((entry) => entry.complete && entry.status === 200 && target.test(entry.target)
        && Date.parse(entry.finishedAt) > after).length;
    },
    async close() {
      if (closed) return;
      closed = true;
      http.request = originalRequest; http.get = originalGet; syncBuiltinESMExports();
      for (const finish of [...active.values()]) finish('capture_closed');
      await Promise.all(writes);
      record.finishedAt = new Date().toISOString();
      record.completeness = record.failures.length || record.skippedRequests ? 'failed' : 'complete';
      const index = await evidence.file('engine-capture/index.json', record);
      return { index, scope, limits, requests: record.entries.length, bodyBytes: record.bodyBytes,
        skippedRequests: record.skippedRequests, completeness: record.completeness, failures: record.failures };
    },
  };
}
