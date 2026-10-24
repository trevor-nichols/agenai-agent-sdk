// ------------------------------------------------------------------------------------------------
//                contracts.ts - Internal Engine transport contracts and admission - Node HTTP
// ------------------------------------------------------------------------------------------------

import type { IncomingHttpHeaders } from 'node:http';
import type { SandboxByteSource } from '@agen-ai/sandbox';

export interface DockerEngineRequestOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly body?: Uint8Array;
  readonly contentType?: 'application/json' | 'application/x-tar';
  readonly signal?: AbortSignal;
}

export interface DockerEngineStreamOptions {
  readonly body?: SandboxByteSource | ((signal: AbortSignal) => SandboxByteSource);
  readonly contentType?: 'application/json' | 'application/x-tar';
  readonly signal?: AbortSignal;
  readonly chunkBytes: number;
  readonly connectTimeoutMs?: number;
  readonly headerTimeoutMs?: number;
}

export interface DockerEngineStreamResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

export interface DockerEngineStreamResult<Value> {
  readonly value: Value;
  readonly uploadedBytes: bigint;
  readonly downloadedBytes: bigint;
}

export interface DockerEngineResponse {
  readonly statusCode: number;
  readonly body: Uint8Array;
}

export type DockerEngineTransportErrorCode =
  | 'deadline'
  | 'aborted'
  | 'response_limit'
  | 'invalid_response'
  | 'connection';

export class DockerEngineTransportError extends Error {
  constructor(readonly code: DockerEngineTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerEngineTransportError';
  }
}

export function validateEngineRequest(path: string, { timeoutMs, maxResponseBytes }: DockerEngineRequestOptions): void {
  if (!path.startsWith('/') || path.startsWith('//') || !/^[\x21-\x7e]+$/u.test(path) || /[\\#]/u.test(path) || path.length > 16_384) {
    throw new TypeError('Engine request path must be a bounded HTTP origin-form target');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('Engine request timeout must be a finite timer duration');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    throw new TypeError('Engine response limit must be a nonnegative safe integer');
  }
}
