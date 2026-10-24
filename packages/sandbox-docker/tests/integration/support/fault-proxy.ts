// ------------------------------------------------------------------------------------------------
//                fault-proxy.ts - Owned finite Unix transport faults - Real Engine forwarding
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';

const HEADER_LIMIT = 16_384;
const REQUEST_LIMIT = 4 * 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const CAPTURE_LIMIT = 64 * 1024;
const CONNECTION_LIMIT = 16;
const OBSERVATION_LIMIT = 512;
const CONNECTION_DEADLINE_MS = 60_000;

export interface ProxyRequest {
  readonly method: string;
  readonly path: string;
}

export interface ProxyObservation extends ProxyRequest {
  readonly status: number;
  readonly upgraded: boolean;
  readonly responsePrefix: string;
}

export interface FaultGate {
  readonly entered: Promise<ProxyRequest>;
  readonly callerClosed: Promise<void>;
  readonly responded: Promise<ProxyObservation>;
  readonly settled: Promise<void>;
  release(): void;
}

interface ArmedFault extends ProxyRequest {
  readonly mode: 'hold_request' | 'hold_reply' | 'drop_reply';
  readonly entered: ReturnType<typeof Promise.withResolvers<ProxyRequest>>;
  readonly callerClosed: ReturnType<typeof Promise.withResolvers<void>>;
  readonly responded: ReturnType<typeof Promise.withResolvers<ProxyObservation>>;
  readonly released: ReturnType<typeof Promise.withResolvers<void>>;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  readonly timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
}

export interface FaultProxy {
  readonly endpoint: string;
  readonly observations: readonly ProxyObservation[];
  arm(input: ProxyRequest & { readonly mode: ArmedFault['mode']; readonly timeoutMs?: number }): FaultGate;
  close(): Promise<void>;
}

function quiet<Value>(promise: Promise<Value>): Promise<Value> {
  void promise.catch(() => {});
  return promise;
}

function closed(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}

function chunkedMessageLength(bytes: Buffer, start: number, payloadLimit: number): number | undefined {
  let cursor = start;
  let payloadBytes = 0;
  for (;;) {
    const end = bytes.indexOf('\r\n', cursor);
    if (end < 0) {
      if (bytes.length - cursor > 16) throw new Error('Fault proxy chunk size line exceeds its framing bound.');
      return undefined;
    }
    const encoded = bytes.subarray(cursor, end).toString('latin1');
    if (!/^(?:0|[1-9a-f][0-9a-f]*)$/iu.test(encoded)) throw new Error('Fault proxy requires canonical chunk sizes without extensions.');
    const size = Number.parseInt(encoded, 16);
    if (!Number.isSafeInteger(size) || size > payloadLimit - payloadBytes) throw new Error('Fault proxy chunked body exceeds its byte limit.');
    cursor = end + 2;
    if (size === 0) {
      if (bytes.length < cursor + 2) return undefined;
      if (bytes.subarray(cursor, cursor + 2).toString('latin1') !== '\r\n') throw new Error('Fault proxy does not admit HTTP trailers.');
      return cursor + 2;
    }
    if (bytes.length < cursor + size + 2) return undefined;
    if (bytes.subarray(cursor + size, cursor + size + 2).toString('latin1') !== '\r\n') throw new Error('Fault proxy chunk payload lacks its exact terminator.');
    payloadBytes += size;
    cursor += size + 2;
  }
}

type ResponseFraming = { readonly kind: 'length'; readonly endOffset: number }
  | { readonly kind: 'chunked' } | { readonly kind: 'eof' };

function responseFraming(header: string, method: string, status: number, headerBytes: number): ResponseFraming {
  const lines = header.split('\r\n').slice(1);
  const lengths = lines.filter((line) => /^content-length:/iu.test(line));
  const encodings = lines.filter((line) => /^transfer-encoding:/iu.test(line));
  const lengthText = lengths[0]?.slice(lengths[0].indexOf(':') + 1).trim();
  const encoding = encodings[0]?.slice(encodings[0].indexOf(':') + 1).trim().toLowerCase();
  if (lengths.length > 1 || encodings.length > 1 || lengthText !== undefined && !/^\d+$/u.test(lengthText)
    || encoding !== undefined && (lengthText !== undefined || encoding !== 'chunked')) {
    throw new Error('Fault proxy requires unambiguous response framing.');
  }
  if (method === 'HEAD' || status === 204 || status === 304) return { kind: 'length', endOffset: headerBytes };
  if (encoding !== undefined) return { kind: 'chunked' };
  if (lengthText === undefined) return { kind: 'eof' };
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || length > RESPONSE_LIMIT - headerBytes) throw new Error('Fault proxy response body exceeds its byte limit.');
  return { kind: 'length', endOffset: headerBytes + length };
}

function readRequest(socket: Socket): Promise<{ request: ProxyRequest; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let total: number | undefined;
    let headerEnd: number | undefined;
    let chunked = false;
    let request: ProxyRequest | undefined;
    const finish = (error?: Error) => {
      socket.pause();
      socket.removeListener('data', data);
      socket.removeListener('error', failure);
      socket.removeListener('end', truncated);
      socket.removeListener('close', truncated);
      if (error) reject(error);
      else {
        assert(request);
        resolve({ request, bytes: Buffer.concat(chunks, received) });
      }
    };
    const failure = (error: Error) => finish(error);
    const truncated = () => finish(new Error('Fault proxy request closed before its bounded body completed.'));
    const data = (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > REQUEST_LIMIT + HEADER_LIMIT) { finish(new Error('Fault proxy request exceeds its byte limit.')); return; }
      chunks.push(chunk);
      if (headerEnd === undefined) {
        const bytes = Buffer.concat(chunks, received);
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) {
          if (received > HEADER_LIMIT) finish(new Error('Fault proxy request header exceeds its byte limit.'));
          return;
        }
        if (end + 4 > HEADER_LIMIT) { finish(new Error('Fault proxy request header exceeds its byte limit.')); return; }
        const lines = bytes.subarray(0, end).toString('latin1').split('\r\n');
        const match = /^(GET|HEAD|POST|PUT|DELETE) (\/[^\s]*) HTTP\/1\.1$/u.exec(lines[0] ?? '');
        if (!match) { finish(new Error('Fault proxy requires one explicit Engine HTTP request.')); return; }
        const lengths = lines.slice(1).filter((line) => /^content-length:/iu.test(line));
        const encodings = lines.slice(1).filter((line) => /^transfer-encoding:/iu.test(line));
        const lengthText = lengths[0]?.slice(lengths[0].indexOf(':') + 1).trim() ?? '0';
        const encoding = encodings[0]?.slice(encodings[0].indexOf(':') + 1).trim();
        if (lengths.length > 1 || !/^\d+$/u.test(lengthText) || encodings.length > 1
          || encodings.length > 0 && (lengths.length > 0 || encoding?.toLowerCase() !== 'chunked')) {
          finish(new Error('Fault proxy requires one unambiguous bounded content-length or chunked framing.')); return;
        }
        const length = Number(lengthText);
        if (!Number.isSafeInteger(length) || length > REQUEST_LIMIT) { finish(new Error('Fault proxy request body exceeds its byte limit.')); return; }
        request = { method: match[1]!, path: match[2]! };
        headerEnd = end + 4;
        chunked = encodings.length === 1;
        if (!chunked) total = headerEnd + length;
      }
      if (chunked && total === undefined) {
        try { total = chunkedMessageLength(Buffer.concat(chunks, received), headerEnd, REQUEST_LIMIT); }
        catch (cause) { finish(cause instanceof Error ? cause : new Error('Invalid proxy chunk framing.', { cause })); return; }
      }
      if (total !== undefined && received >= total) {
        // No client sends process input before its upgrade is acknowledged.
        if (received !== total) finish(new Error('Fault proxy received bytes beyond the initial request before dispatch.'));
        else finish();
      }
    };
    socket.on('data', data);
    socket.once('error', failure);
    socket.once('end', truncated);
    socket.once('close', truncated);
    socket.resume();
  });
}

/** Each connection carries one request, matching the public transport's agent:false contract. */
export async function createFaultProxy(options: { readonly upstreamEndpoint: string; readonly directory: string }): Promise<FaultProxy> {
  assert(options.upstreamEndpoint.startsWith('unix:///'));
  assert(path.isAbsolute(options.directory));
  const socketPath = path.join(options.directory, 'engine.sock');
  assert(Buffer.byteLength(socketPath) < 104, 'Fault proxy needs a short owned Unix socket path.');
  const connections = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  const faults: ArmedFault[] = [];
  const observations: ProxyObservation[] = [];
  const failures: Error[] = [];
  let closing = false;
  let closeActual: Promise<void> | undefined;

  const ownSocket = (socket: Socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    return socket;
  };

  async function forward(downstream: Socket): Promise<void> {
    let upstream: Socket | undefined;
    let fault: ArmedFault | undefined;
    let request: ProxyRequest | undefined;
    let responseBytes = 0;
    let prefix = Buffer.alloc(0);
    let headerEnd: number | undefined;
    let status: number | undefined;
    let upgraded = false;
    let responseComplete = false;
    let framing: ResponseFraming | undefined;
    const chunkedResponse: Buffer[] = [];
    const responseChunks: Buffer[] = [];
    const pendingHeader: Buffer[] = [];
    const deadline = setTimeout(() => {
      const error = new Error('Fault proxy connection exceeded its finite lifetime.');
      failures.push(error);
      fault?.released.resolve();
      upstream?.destroy(error);
      downstream.destroy(error);
    }, CONNECTION_DEADLINE_MS);
    try {
      const input = await readRequest(downstream);
      request = input.request;
      fault = faults.find((candidate) => !candidate.claimed && candidate.method === request?.method && candidate.path === request.path);
      if (fault) {
        fault.claimed = true;
        downstream.once('close', () => fault?.callerClosed.resolve());
        fault.entered.resolve(request);
      }
      if (fault?.mode === 'hold_request') await fault.released.promise;
      if (closing) return;
      upstream = ownSocket(createConnection({ path: options.upstreamEndpoint.slice(7), allowHalfOpen: true }));
      const upstreamClosed = closed(upstream);
      const reply = Promise.withResolvers<void>();
      quiet(reply.promise);
      const snapshot = (): ProxyObservation => {
        assert(request && status !== undefined && headerEnd !== undefined);
        return { ...request, status, upgraded, responsePrefix: prefix.subarray(headerEnd, headerEnd + 1024).toString('utf8') };
      };
      const observe = () => {
        const observation = snapshot();
        assert(observations.length < OBSERVATION_LIMIT, 'Fault proxy observation census exceeded its bound.');
        observations.push(observation);
        fault?.responded.resolve(observation);
      };
      upstream.on('data', (chunk: Buffer) => {
        try {
          responseBytes += chunk.byteLength;
          if (responseBytes > RESPONSE_LIMIT) { upstream?.destroy(new Error('Fault proxy upstream bytes exceed their lifetime bound.')); return; }
          if (prefix.byteLength < CAPTURE_LIMIT) prefix = Buffer.concat([prefix, chunk.subarray(0, CAPTURE_LIMIT - prefix.byteLength)]);
          if (fault?.mode === 'hold_reply') responseChunks.push(chunk);
          let outgoing = chunk;
          if (headerEnd === undefined) {
            pendingHeader.push(chunk);
            const end = prefix.indexOf('\r\n\r\n');
            if (end < 0) {
              if (prefix.byteLength > HEADER_LIMIT) upstream?.destroy(new Error('Fault proxy response header exceeds its bound.'));
              return;
            }
            if (end + 4 > HEADER_LIMIT) { upstream?.destroy(new Error('Fault proxy response header exceeds its bound.')); return; }
            const match = /^HTTP\/1\.[01] (\d{3}) /u.exec(prefix.subarray(0, end).toString('latin1'));
            if (!match) { upstream?.destroy(new Error('Fault proxy upstream returned an invalid status line.')); return; }
            headerEnd = end + 4;
            status = Number(match[1]);
            outgoing = Buffer.concat(pendingHeader);
            pendingHeader.length = 0;
            upgraded = status === 101;
            if (upgraded) {
              downstream.pipe(upstream!, { end: true });
              downstream.resume();
              observe();
            } else framing = responseFraming(prefix.subarray(0, end).toString('latin1'), request!.method, status, headerEnd);
          }
          if (fault?.mode !== 'hold_reply' && fault?.mode !== 'drop_reply' && !downstream.destroyed && !downstream.write(outgoing)) upstream?.pause();
          if (framing?.kind === 'chunked') chunkedResponse.push(outgoing);
          const endOffset = framing?.kind === 'length' ? framing.endOffset : framing?.kind === 'chunked'
            ? chunkedMessageLength(Buffer.concat(chunkedResponse, responseBytes), headerEnd!, RESPONSE_LIMIT - headerEnd!) : undefined;
          if (endOffset !== undefined && responseBytes >= endOffset) {
            if (responseBytes !== endOffset) { upstream?.destroy(new Error('Fault proxy received bytes beyond its single HTTP response.')); return; }
            responseComplete = true;
            observe();
            reply.resolve();
            upstream?.end();
          }
        } catch (cause) {
          upstream?.destroy(cause instanceof Error ? cause : new Error('Invalid fault proxy response framing.', { cause }));
        }
      });
      downstream.on('drain', () => upstream?.resume());
      upstream.once('error', reply.reject);
      upstream.once('end', () => {
        if (status === undefined) { reply.reject(new Error('Fault proxy upstream ended without an HTTP response.')); return; }
        if (!responseComplete) {
          if (!upgraded && framing?.kind !== 'eof') { reply.reject(new Error('Fault proxy upstream ended inside its framed response.')); return; }
          responseComplete = true;
          if (!upgraded) observe();
        }
        reply.resolve();
        if (fault?.mode !== 'hold_reply' && fault?.mode !== 'drop_reply') downstream.end();
        upstream?.end();
      });
      upstream.once('close', () => {
        if (!responseComplete && !upgraded) reply.reject(new Error('Fault proxy upstream closed before its response completed.'));
        else reply.resolve();
      });
      downstream.once('close', () => {
        if (fault) upstream?.resume();
        else upstream?.destroy();
      });
      await new Promise<void>((resolve, reject) => { upstream!.once('connect', resolve); upstream!.once('error', reject); });
      upstream.write(input.bytes);
      // Only a confirmed hijack owns more client input. Ordinary HTTP finishes the write side
      // after its complete framed response, so keep-alive does not retain an owned request.
      if (fault?.mode === 'drop_reply') {
        await Promise.race([reply.promise, fault.released.promise]);
        await fault.released.promise;
        downstream.destroy();
        if (upgraded) upstream.destroy();
        else await reply.promise;
      } else {
        await reply.promise;
        if (fault?.mode === 'hold_reply') {
          await fault.released.promise;
          if (!downstream.destroyed) downstream.end(Buffer.concat(responseChunks, responseBytes));
        }
      }
      await upstreamClosed;
      if (!downstream.destroyed && !upgraded) downstream.end();
      if (upgraded && !downstream.destroyed) downstream.destroy();
      await closed(downstream);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Client cancellation before dispatch is ordinary. An uncertain upstream result is not.
      if (upstream && !closing) failures.push(error);
      fault?.entered.reject(error);
      fault?.responded.reject(error);
      downstream.destroy();
    } finally {
      clearTimeout(deadline);
      upstream?.destroy();
      downstream.destroy();
      await Promise.all([...(upstream ? [closed(upstream)] : []), closed(downstream)]);
      if (fault) { clearTimeout(fault.timer); fault.settled.resolve(); }
    }
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    ownSocket(socket);
    if (closing || handlers.size >= CONNECTION_LIMIT) { socket.destroy(); return; }
    const handler = forward(socket);
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });

  return {
    endpoint: `unix://${socketPath}`,
    observations,
    arm(input) {
      assert(!closing);
      assert(input.path.startsWith('/v1.52/'));
      assert(faults.length < 16, 'Fault proxy gate census exceeded its bound.');
      assert(!faults.some((candidate) => !candidate.claimed && candidate.method === input.method && candidate.path === input.path));
      const timeoutMs = input.timeoutMs ?? 30_000;
      assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 45_000);
      const entered = Promise.withResolvers<ProxyRequest>();
      const callerClosed = Promise.withResolvers<void>();
      const responded = Promise.withResolvers<ProxyObservation>();
      const released = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        const error = new Error(`Fault proxy gate exceeded its finite deadline: ${input.method} ${input.path}`);
        failures.push(error);
        entered.reject(error); callerClosed.reject(error); responded.reject(error); released.resolve();
      }, timeoutMs);
      const fault: ArmedFault = { ...input, entered, callerClosed, responded, released, settled, timer, claimed: false };
      faults.push(fault);
      return { entered: quiet(entered.promise), callerClosed: quiet(callerClosed.promise), responded: quiet(responded.promise), settled: quiet(settled.promise), release: () => released.resolve() };
    },
    close() {
      closeActual ??= (async () => {
        closing = true;
        for (const fault of faults) { clearTimeout(fault.timer); fault.released.resolve(); }
        const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        for (const socket of connections) socket.destroy();
        await Promise.all([serverClosed, ...handlers]);
        await unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        if (failures.length) throw new AggregateError(failures, 'Fault proxy retained upstream forwarding failures.');
      })();
      return closeActual;
    },
  };
}
