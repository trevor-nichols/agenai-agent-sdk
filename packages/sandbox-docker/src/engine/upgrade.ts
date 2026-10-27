// ------------------------------------------------------------------------------------------------
//                upgrade.ts - Owned Engine attach/exec handshake and duplex handoff - Node HTTP
// ------------------------------------------------------------------------------------------------

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerEngineTransportError, validateEngineRequest, type DockerEngineRequestOptions } from './contracts.js';

export interface DockerEngineAttachment {
  readonly stream: Duplex;
  readonly head: Uint8Array;
  readonly closed: Promise<void>;
}

type HandshakeOutcome =
  | { readonly kind: 'handed_off' }
  | { readonly kind: 'failure'; readonly error: DockerEngineTransportError };

export async function upgradeEngineConnection(
  socketPath: string,
  path: string,
  options: DockerEngineRequestOptions,
): Promise<DockerEngineAttachment> {
  validateEngineRequest(path, options);
  const { timeoutMs, maxResponseBytes, signal } = options;
  if (options.body === undefined ? options.contentType !== undefined : options.contentType !== 'application/json') {
    throw new TypeError('Engine upgrade accepts no body or explicit JSON request bytes');
  }
  if (signal?.aborted) throw new DockerEngineTransportError('aborted', 'Engine upgrade aborted');

  const deadline = performance.now() + timeoutMs;
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  if (performance.now() >= deadline) throw new DockerEngineTransportError('deadline', 'Engine upgrade deadline exceeded');

  return new Promise<DockerEngineAttachment>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let socket: Duplex | undefined;
    let requestClosed = false;
    let responseClosed = false;
    let socketClosed = false;
    let outcome: HandshakeOutcome | undefined;
    let settled = false;
    let receivedBytes = 0;
    const closed = Promise.withResolvers<void>();
    void closed.promise.catch(() => {});
    let socketError: DockerEngineTransportError | undefined;

    const request = httpRequest({
      socketPath,
      method: 'POST',
      path,
      agent: false,
      maxHeaderSize: 16_384,
      headers: {
        connection: 'Upgrade',
        upgrade: 'tcp',
        'content-type': body === undefined ? 'text/plain' : 'application/json',
        'content-length': body?.byteLength ?? 0,
      },
    });

    const clearHandshake = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settleFailureIfClosed = () => {
      if (settled || outcome?.kind !== 'failure' || !requestClosed
        || (response !== undefined && !responseClosed) || (socket !== undefined && !socketClosed)) return;
      settled = true;
      clearHandshake();
      reject(outcome.error);
    };

    const fail = (error: DockerEngineTransportError) => {
      if (outcome !== undefined) return;
      outcome = { kind: 'failure', error };
      response?.destroy();
      socket?.destroy();
      request.destroy();
      settleFailureIfClosed();
    };

    const deadlineExpired = () => {
      if (performance.now() < deadline) return false;
      fail(new DockerEngineTransportError('deadline', 'Engine upgrade deadline exceeded'));
      return true;
    };

    const onAbort = () => fail(new DockerEngineTransportError('aborted', 'Engine upgrade aborted'));
    const timer = setTimeout(() => {
      fail(new DockerEngineTransportError('deadline', 'Engine upgrade deadline exceeded'));
    }, Math.max(1, Math.ceil(deadline - performance.now())));

    request.once('socket', (connection) => {
      socket = connection;
      connection.on('error', (cause: Error) => {
        socketError ??= new DockerEngineTransportError('connection', 'Engine upgraded connection failed', { cause });
        fail(socketError);
      });
      connection.once('close', () => {
        socketClosed = true;
        if (socketError === undefined) closed.resolve();
        else closed.reject(socketError);
        if (outcome === undefined) fail(new DockerEngineTransportError('connection', 'Engine connection closed before upgrade'));
        settleFailureIfClosed();
      });
      if (outcome?.kind === 'failure') connection.destroy();
    });
    request.on('error', (cause: Error) => {
      const malformedResponse = 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('HPE_');
      fail(new DockerEngineTransportError(
        malformedResponse ? 'invalid_response' : 'connection',
        malformedResponse ? 'Engine upgrade has invalid HTTP framing' : 'Engine upgrade connection failed',
        { cause },
      ));
    });
    request.once('close', () => {
      requestClosed = true;
      if (outcome === undefined && response === undefined) {
        fail(new DockerEngineTransportError('connection', 'Engine connection closed before upgrade'));
      }
      settleFailureIfClosed();
    });
    request.once('upgrade', (message, connection, head) => {
      if (outcome !== undefined) {
        connection.destroy();
        return;
      }
      if (deadlineExpired()) return;
      const connectionTokens = message.headers.connection?.split(',').map((token) => token.trim().toLowerCase());
      if (message.statusCode !== 101 || !connectionTokens?.includes('upgrade') || message.headers.upgrade?.toLowerCase() !== 'tcp') {
        fail(new DockerEngineTransportError('invalid_response', 'Engine upgrade requires HTTP 101 with the tcp protocol'));
        return;
      }
      if (connection.destroyed) {
        fail(new DockerEngineTransportError('connection', 'Engine upgraded connection is already closed'));
        return;
      }
      if (head.byteLength > 65_536) {
        fail(new DockerEngineTransportError('response_limit', 'Engine upgrade head exceeds its byte limit'));
        return;
      }
      connection.pause();
      outcome = { kind: 'handed_off' };
      settled = true;
      clearHandshake();
      resolve({ stream: connection, head: Buffer.from(head), closed: closed.promise });
    });
    request.once('response', (message) => {
      response = message;
      message.on('error', (cause: Error) => {
        fail(new DockerEngineTransportError('invalid_response', 'Engine upgrade response stream failed', { cause }));
      });
      message.once('aborted', () => {
        fail(new DockerEngineTransportError('invalid_response', 'Engine upgrade response was truncated'));
      });
      message.once('close', () => {
        responseClosed = true;
        if (outcome === undefined) fail(new DockerEngineTransportError('invalid_response', 'Engine upgrade response closed before completion'));
        settleFailureIfClosed();
      });
      message.on('data', (chunk: Buffer) => {
        if (outcome !== undefined || deadlineExpired()) return;
        if (chunk.byteLength > maxResponseBytes - receivedBytes) {
          fail(new DockerEngineTransportError('response_limit', 'Engine upgrade response exceeds its byte limit'));
          return;
        }
        receivedBytes += chunk.byteLength;
      });
      message.once('end', () => {
        if (outcome !== undefined || deadlineExpired()) return;
        fail(new DockerEngineTransportError('invalid_response', `Engine upgrade requires HTTP 101, received ${message.statusCode}`));
      });
      if (outcome !== undefined) {
        message.destroy();
        return;
      }
      if (deadlineExpired()) return;
      const contentLength = message.headers['content-length'];
      if (contentLength !== undefined && Number(contentLength) > maxResponseBytes) {
        fail(new DockerEngineTransportError('response_limit', 'Engine upgrade response exceeds its byte limit'));
      }
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (outcome === undefined) request.end(body);
  });
}
