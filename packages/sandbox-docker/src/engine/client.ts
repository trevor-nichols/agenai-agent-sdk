// ------------------------------------------------------------------------------------------------
//                client.ts - Bounded local Engine HTTP requests - Node HTTP
// ------------------------------------------------------------------------------------------------

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerEngineTransportError, validateEngineRequest, type DockerEngineRequestOptions, type DockerEngineResponse } from './contracts.js';
import { upgradeEngineConnection, type DockerEngineAttachment } from './upgrade.js';
import { streamEngine } from './stream.js';
import type { DockerEngineStreamOptions, DockerEngineStreamResponse, DockerEngineStreamResult } from './contracts.js';

export { DockerEngineTransportError } from './contracts.js';
export type { DockerEngineRequestOptions, DockerEngineResponse, DockerEngineTransportErrorCode } from './contracts.js';
export type { DockerEngineAttachment } from './upgrade.js';

type RequestOutcome =
  | { readonly kind: 'success'; readonly statusCode: number }
  | { readonly kind: 'failure'; readonly error: DockerEngineTransportError };

export class DockerEngine {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith('/') || socketPath.startsWith('//') || /[\u0000-\u001f\u007f]/u.test(socketPath)) {
      throw new TypeError('Engine endpoint must be an explicit absolute Unix socket path');
    }
  }

  upgrade(path: string, options: DockerEngineRequestOptions): Promise<DockerEngineAttachment> {
    return upgradeEngineConnection(this.socketPath, path, options);
  }

  stream<Value>(method: 'GET' | 'HEAD' | 'PUT', path: string, options: DockerEngineStreamOptions,
    consume: (response: DockerEngineStreamResponse) => Promise<Value>): Promise<DockerEngineStreamResult<Value>> {
    return streamEngine(this.socketPath, method, path, options, consume);
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: DockerEngineRequestOptions,
  ): Promise<DockerEngineResponse> {
    const { timeoutMs, maxResponseBytes, contentType, signal } = options;
    validateEngineRequest(path, options);
    if (signal?.aborted) throw new DockerEngineTransportError('aborted', 'Engine request aborted');

    const deadline = performance.now() + timeoutMs;
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    if (performance.now() >= deadline) throw new DockerEngineTransportError('deadline', 'Engine request deadline exceeded');

    return new Promise<DockerEngineResponse>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let upgradedSocket: Duplex | undefined;
      let requestClosed = false;
      let responseClosed = false;
      let upgradedSocketClosed = false;
      let outcome: RequestOutcome | undefined;
      let settled = false;
      let receivedBytes = 0;
      let expectedBytes: number | undefined;
      const chunks: Buffer[] = [];

      const request = httpRequest({
        socketPath: this.socketPath,
        method,
        path,
        agent: false,
        maxHeaderSize: 16_384,
        headers: {
          connection: 'close',
          ...(body === undefined ? {} : { 'content-length': body.byteLength }),
          ...(contentType === undefined ? {} : { 'content-type': contentType }),
        },
      });

      const settleIfClosed = () => {
        if (settled || outcome === undefined || !requestClosed || (response !== undefined && !responseClosed)
          || (upgradedSocket !== undefined && !upgradedSocketClosed)) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (outcome.kind === 'failure') reject(outcome.error);
        else resolve({ statusCode: outcome.statusCode, body: Buffer.concat(chunks, receivedBytes) });
        chunks.length = 0;
      };

      const fail = (error: DockerEngineTransportError) => {
        if (settled || outcome?.kind === 'failure') return;
        outcome = { kind: 'failure', error };
        chunks.length = 0;
        response?.destroy();
        upgradedSocket?.destroy();
        request.destroy();
        settleIfClosed();
      };

      const deadlineExpired = () => {
        if (performance.now() < deadline) return false;
        fail(new DockerEngineTransportError('deadline', 'Engine request deadline exceeded'));
        return true;
      };

      const onAbort = () => fail(new DockerEngineTransportError('aborted', 'Engine request aborted'));
      const timer = setTimeout(() => {
        fail(new DockerEngineTransportError('deadline', 'Engine request deadline exceeded'));
      }, Math.max(1, Math.ceil(deadline - performance.now())));

      request.on('error', (cause: Error) => {
        const malformedResponse = 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('HPE_');
        fail(new DockerEngineTransportError(
          malformedResponse ? 'invalid_response' : 'connection',
          malformedResponse ? 'Engine response has invalid HTTP framing' : 'Engine request connection failed',
          { cause },
        ));
      });
      request.once('close', () => {
        requestClosed = true;
        if (outcome === undefined && response === undefined && upgradedSocket === undefined) {
          fail(new DockerEngineTransportError('connection', 'Engine connection closed before a response'));
        }
        settleIfClosed();
      });
      request.once('upgrade', (_response, socket) => {
        upgradedSocket = socket;
        socket.on('error', () => {});
        socket.once('close', () => {
          upgradedSocketClosed = true;
          settleIfClosed();
        });
        fail(new DockerEngineTransportError('invalid_response', 'Engine response unexpectedly upgraded the connection'));
      });
      request.once('response', (message) => {
        response = message;
        message.on('error', (cause: Error) => {
          fail(new DockerEngineTransportError('invalid_response', 'Engine response stream failed', { cause }));
        });
        message.once('aborted', () => {
          fail(new DockerEngineTransportError('invalid_response', 'Engine response was truncated'));
        });
        message.once('close', () => {
          responseClosed = true;
          if (outcome === undefined) fail(new DockerEngineTransportError('invalid_response', 'Engine response closed before completion'));
          settleIfClosed();
        });
        message.on('data', (chunk: Buffer) => {
          if (outcome !== undefined || deadlineExpired()) return;
          if (chunk.byteLength > maxResponseBytes - receivedBytes) {
            fail(new DockerEngineTransportError('response_limit', 'Engine response exceeds its byte limit'));
            return;
          }
          receivedBytes += chunk.byteLength;
          chunks.push(chunk);
        });
        message.once('end', () => {
          if (outcome !== undefined || deadlineExpired()) return;
          if (!message.complete || (expectedBytes !== undefined && receivedBytes !== expectedBytes)) {
            fail(new DockerEngineTransportError('invalid_response', 'Engine response length is inconsistent'));
            return;
          }
          if (message.statusCode === undefined) {
            fail(new DockerEngineTransportError('invalid_response', 'Engine response has no status code'));
            return;
          }
          outcome = { kind: 'success', statusCode: message.statusCode };
          settleIfClosed();
        });

        if (outcome !== undefined) {
          message.destroy();
          return;
        }
        if (deadlineExpired()) return;
        const contentLength = message.headers['content-length'];
        if (contentLength !== undefined) {
          const length = Number(contentLength);
          if (!/^\d+$/u.test(contentLength) || !Number.isSafeInteger(length)) {
            fail(new DockerEngineTransportError('invalid_response', 'Engine response has an invalid content length'));
            return;
          }
          if (message.statusCode !== 204 && message.statusCode !== 304) expectedBytes = length;
          if (length > maxResponseBytes) {
            fail(new DockerEngineTransportError('response_limit', 'Engine response exceeds its byte limit'));
          }
        }
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (outcome === undefined) request.end(body);
    });
  }
}
