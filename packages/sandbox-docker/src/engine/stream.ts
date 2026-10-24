// ------------------------------------------------------------------------------------------------
//                stream.ts - Explicit Unix HTTP transfer ownership - Separate connection/header waits
// ------------------------------------------------------------------------------------------------

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { DockerEngineTransportError, validateEngineRequest } from './contracts.js';
import type { DockerEngineStreamOptions, DockerEngineStreamResponse, DockerEngineStreamResult } from './contracts.js';
import { DockerResponseBody } from './response.js';
import { upload } from './upload.js';

type FailureOrigin = 'request' | 'writer' | 'callback' | 'retirement';

export async function streamEngine<Value>(socketPath: string, method: 'GET' | 'HEAD' | 'PUT', path: string,
  options: DockerEngineStreamOptions, consume: (response: DockerEngineStreamResponse) => Promise<Value>): Promise<DockerEngineStreamResult<Value>> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  validateEngineRequest(path, { timeoutMs: connectTimeoutMs, maxResponseBytes: 0 });
  validateEngineRequest(path, { timeoutMs: headerTimeoutMs, maxResponseBytes: 0 });
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 512 || options.chunkBytes > 65536) throw new TypeError('Engine chunkBytes must be within 512..65536.');
  if (method !== 'PUT' && options.body !== undefined) throw new TypeError('Only PUT transfers accept a request body.');
  if (options.signal?.aborted) throw new DockerEngineTransportError('aborted', 'Engine transfer aborted before dispatch.', { cause: options.signal.reason });
  const controller = new AbortController();
  const ready = Promise.withResolvers<IncomingMessage>();
  const closed = Promise.withResolvers<void>();
  const socketClosed = Promise.withResolvers<void>();
  let response: IncomingMessage | undefined;
  let responseBody: DockerResponseBody | undefined;
  let socket: NonNullable<ClientRequest['socket']> | undefined;
  let failure: { readonly error: unknown; readonly origin: FailureOrigin } | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let result: { readonly value: Value } | undefined;
  let retirementError: unknown;
  let uploadedBytes = 0n;
  const request = httpRequest({ socketPath, method, path, agent: false, maxHeaderSize: 16_384,
    headers: { connection: 'close', ...(options.contentType ? { 'content-type': options.contentType } : {}) } });
  const fail = (error: unknown, origin: FailureOrigin) => {
    if (!failure || failure.origin === 'retirement' && origin === 'callback') failure = { error, origin };
    controller.abort(error);
    ready.reject(error);
    response?.destroy();
    request.destroy();
  };
  const onAbort = () => fail(new DockerEngineTransportError('aborted', 'Engine transfer aborted.', { cause: options.signal?.reason }), 'request');
  request.on('error', (cause: Error) => {
    const malformed = 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('HPE_');
    fail(new DockerEngineTransportError(malformed ? 'invalid_response' : 'connection', 'Engine transfer connection failed.', { cause }), 'request');
  });
  request.once('socket', (acquired) => {
    socket = acquired;
    acquired.once('close', () => socketClosed.resolve());
    if (acquired.readableHighWaterMark > 65_536 || acquired.writableHighWaterMark > 65_536) {
      fail(new DockerEngineTransportError('invalid_response', 'Engine socket exceeds the bounded native buffer profile.'), 'request');
    }
    if (acquired.connecting) acquired.once('connect', () => clearTimeout(connectTimer));
    else clearTimeout(connectTimer);
  });
  request.once('finish', () => {
    if (!response && !failure) headerTimer = setTimeout(() => fail(new DockerEngineTransportError('deadline', 'Engine response-header deadline exceeded.'), 'request'), headerTimeoutMs);
  });
  request.once('response', (incoming) => {
    response = incoming;
    clearTimeout(headerTimer);
    incoming.on('error', (cause: Error) => { if (!controller.signal.aborted) fail(new DockerEngineTransportError('invalid_response', 'Engine response stream failed.', { cause }), 'request'); });
    incoming.once('aborted', () => { if (!controller.signal.aborted) fail(new DockerEngineTransportError('invalid_response', 'Engine response was truncated.'), 'request'); });
    if (incoming.readableHighWaterMark > 65_536) fail(new DockerEngineTransportError('invalid_response', 'Engine response exceeds the bounded native buffer profile.'), 'request');
    ready.resolve(incoming);
  });
  request.once('upgrade', (_incoming, upgraded) => { upgraded.destroy(); fail(new DockerEngineTransportError('invalid_response', 'Unexpected Engine HTTP upgrade.'), 'request'); });
  request.once('close', () => {
    if (!failure && (!response || !request.writableFinished)) fail(new DockerEngineTransportError('connection', 'Engine connection closed before transfer dispatch finished.'), 'request');
    closed.resolve();
  });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const connectTimer = setTimeout(() => fail(new DockerEngineTransportError('deadline', 'Engine connection deadline exceeded.'), 'request'), connectTimeoutMs);
  if (options.signal?.aborted) onAbort();
  const writer = upload(request, options.body, controller.signal, options.chunkBytes).then((bytes) => { uploadedBytes = bytes; }, (error: unknown) => { fail(error, 'writer'); throw error; });
  void writer.catch(() => {});
  try {
    const incoming = await ready.promise;
    responseBody = new DockerResponseBody(incoming, options.chunkBytes, controller.signal, (error) => {
      retirementError ??= error;
      fail(error, 'retirement');
    });
    if (incoming.statusCode === undefined) throw new DockerEngineTransportError('invalid_response', 'Engine response omitted its status.');
    try {
      result = { value: await consume({ statusCode: incoming.statusCode, headers: incoming.headers, rawHeaders: incoming.rawHeaders,
        body: responseBody.body, signal: controller.signal }) };
    } catch (error) { fail(error, 'callback'); }
    try { await responseBody.retire(); } catch (error) { if (!failure) fail(error, 'retirement'); }
    await writer;
  } catch (error) { if (!failure) fail(error, 'request'); }
  finally {
    const writerOutcome = await Promise.allSettled([writer]);
    response?.destroy();
    request.destroy();
    await closed.promise;
    if (socket) await socketClosed.promise;
    clearTimeout(connectTimer);
    clearTimeout(headerTimer);
    options.signal?.removeEventListener('abort', onAbort);
    const outcome = writerOutcome[0];
    if (outcome.status === 'rejected' && failure && outcome.reason !== failure.error && outcome.reason !== retirementError) {
      failure = { error: new AggregateError([failure.error, outcome.reason], 'Engine transfer and request producer cleanup both failed.'), origin: failure.origin };
    }
  }
  if (failure) throw failure.error;
  if (!result) throw new DockerEngineTransportError('invalid_response', 'Engine transfer did not settle its response.');
  return { value: result.value, uploadedBytes, downloadedBytes: responseBody?.bytes ?? 0n };
}
