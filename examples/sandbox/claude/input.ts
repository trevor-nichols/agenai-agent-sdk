// ------------------------------------------------------------------------------------------------
//                input.ts - Bounded synchronous writable admission, including end payloads
// ------------------------------------------------------------------------------------------------

import { Writable } from 'node:stream';
import type { SandboxProcessStreams } from '@agen-ai/sandbox';

type Callback = (error?: Error | null) => void;

export class ClaudeInput extends Writable {
  constructor(private readonly ready: Promise<SandboxProcessStreams>, private readonly fail: (error: Error) => void) {
    super({ highWaterMark: 8 * 1024 });
  }

  private admit(chunk: unknown, encoding: BufferEncoding | undefined, callback?: Callback): boolean {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new TypeError('Claude input requires bytes or a string.');
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (this.writableLength + length <= 64 * 1024) return true;
    const error = new Error('Claude sandbox input staging exceeded 64 KiB.');
    this.fail(error); this.destroy(error);
    queueMicrotask(() => callback?.(error));
    return false;
  }

  override write(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | Callback, callback?: Callback): boolean {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!this.admit(chunk, encoding, done)) return false;
    return super.write(chunk, encoding ?? 'utf8', done);
  }

  override end(callback?: Callback): this;
  override end(chunk: string | Uint8Array, callback?: Callback): this;
  override end(chunk: string | Uint8Array, encoding: BufferEncoding, callback?: Callback): this;
  override end(chunkOrCallback?: string | Uint8Array | Callback, encodingOrCallback?: BufferEncoding | Callback, callback?: Callback): this {
    const chunk = typeof chunkOrCallback === 'function' ? undefined : chunkOrCallback;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof chunkOrCallback === 'function' ? chunkOrCallback
      : typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (chunk !== undefined && !this.admit(chunk, encoding, done)) return this;
    return chunk === undefined ? super.end(done) : super.end(chunk, encoding ?? 'utf8', done);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Callback): void {
    this.ready.then(({ stdin }) => { stdin.write(chunk, callback); }, callback);
  }

  override _final(callback: Callback): void {
    this.ready.then(({ stdin }) => { stdin.end(callback); }, callback);
  }
}
