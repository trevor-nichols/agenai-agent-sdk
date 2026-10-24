// ------------------------------------------------------------------------------------------------
//                api.ts - Finite Docker JSON operations - Internal Engine transport boundary
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { ZodType } from 'zod/v4';
import { DockerEngine, DockerEngineTransportError } from '../engine/client.js';
import type { DockerEngineStreamOptions, DockerEngineStreamResponse, DockerEngineStreamResult } from '../engine/contracts.js';

export class DockerApi {
  constructor(readonly engine: DockerEngine, readonly timeoutMs: number) {}

  async stream<Value>(method: 'GET' | 'HEAD' | 'PUT', path: string, options: DockerEngineStreamOptions,
    consume: (response: DockerEngineStreamResponse) => Promise<Value>): Promise<DockerEngineStreamResult<Value>> {
    try {
      return await this.engine.stream(method, path, options, async (response) => {
        if (response.statusCode !== 200) throw new SandboxOperationError('driver_failure', `Docker transfer returned HTTP ${response.statusCode}.`);
        return consume(response);
      });
    } catch (cause) { throw transportFailure(cause); }
  }

  async upgrade(path: string, body: unknown, signal?: AbortSignal) {
    try {
      return await this.engine.upgrade(path, { body: Buffer.from(JSON.stringify(body)), contentType: 'application/json',
        timeoutMs: this.timeoutMs, maxResponseBytes: 1024 * 1024, signal });
    } catch (cause) { throw transportFailure(cause); }
  }

  async json<Value>(method: 'GET' | 'POST' | 'DELETE', path: string, schema: ZodType<Value>,
    options: { body?: unknown; signal?: AbortSignal; statuses?: readonly number[] } = {}): Promise<Value> {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');
    const response = await this.request(method, path, { ...options, body, maxResponseBytes: 1024 * 1024, contentType: 'application/json' });
    let value: unknown;
    try { value = JSON.parse(Buffer.from(response.body).toString('utf8')); }
    catch (cause) { throw new SandboxOperationError('driver_failure', 'Docker returned invalid JSON.', { cause }); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SandboxOperationError('driver_failure', 'Docker returned an invalid resource response.');
    return parsed.data;
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: {
    body?: Uint8Array; contentType?: 'application/json' | 'application/x-tar'; maxResponseBytes?: number;
    signal?: AbortSignal; statuses?: readonly number[];
  } = {}) {
    let response;
    try {
      response = await this.engine.request(method, path, { timeoutMs: this.timeoutMs,
        maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024, body: options.body, contentType: options.contentType, signal: options.signal });
    } catch (cause) {
      throw transportFailure(cause);
    }
    if (!(options.statuses ?? [200, 201, 204]).includes(response.statusCode)) {
      throw new SandboxOperationError('driver_failure', `Docker resource operation returned HTTP ${response.statusCode}.`);
    }
    return response;
  }
}

function transportFailure(cause: unknown): unknown {
  if (!(cause instanceof DockerEngineTransportError)) return cause;
  const code = cause.code === 'deadline' ? 'deadline_exceeded' : cause.code === 'aborted' ? 'cancelled' : 'driver_failure';
  return new SandboxOperationError(code, 'Docker resource transport did not settle successfully.', { cause });
}
