// ------------------------------------------------------------------------------------------------
//                input.ts - Bounded binary input forwarding - Node writable streams
// ------------------------------------------------------------------------------------------------

import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { SandboxOperationError } from '../errors.js';

type WriteCallback = (error?: Error | null) => void;

export class SandboxInput extends Writable {
  readonly settled: Promise<void>;
  private admitted = 0n;
  private closing = false;
  private activeWrite: WriteCallback | undefined;

  constructor(private readonly target: Writable, private readonly maximumBytes: number | undefined,
    private readonly maximumBufferedBytes: number, highWaterMark: number, private readonly fail: (error: Error) => void) {
    super({ highWaterMark, decodeStrings: false });
    this.settled = finished(target, { readable: false, cleanup: true }).then(() => undefined, () => undefined);
    this.on('error', () => {});
    target.on('error', (error: Error) => this.destroy(error));
    target.on('close', () => { if (!this.writableFinished) this.destroy(); });
  }

  override write(chunk: unknown, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const error = this.admit(chunk);
    if (error) {
      if (complete) queueMicrotask(() => complete(error));
      this.destroy(error);
      return false;
    }
    return typeof encodingOrCallback === 'string'
      ? super.write(chunk, encodingOrCallback, callback)
      : super.write(chunk, complete);
  }

  override end(chunkOrCallback?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): this {
    if (typeof chunkOrCallback === 'function') return super.end(chunkOrCallback);
    const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (chunkOrCallback !== undefined && chunkOrCallback !== null) this.write(chunkOrCallback);
    return super.end(complete);
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: WriteCallback): void {
    const complete = this.ownCallback(callback);
    try { this.target.write(chunk, complete); }
    catch (error) { complete(error instanceof Error ? error : new SandboxOperationError('stream_failure', 'Sandbox input failed.', { cause: error })); }
  }

  override _final(callback: WriteCallback): void {
    const complete = this.ownCallback(callback);
    try { this.target.end(complete); }
    catch (error) { complete(error instanceof Error ? error : new SandboxOperationError('stream_failure', 'Sandbox input failed.', { cause: error })); }
  }

  override _destroy(error: Error | null, callback: WriteCallback): void {
    this.activeWrite?.(error ?? new SandboxOperationError('cancelled', 'Sandbox input was closed before its pending write settled.'));
    this.target.destroy(error ?? undefined);
    if (!this.closing && (!this.writableFinished || error)) {
      this.fail(error ?? new SandboxOperationError('stream_failure', 'Sandbox input was abandoned.'));
    }
    callback(error);
  }

  close(error?: Error): void {
    this.closing = true;
    this.destroy(error);
  }

  private admit(chunk: unknown): Error | undefined {
    if (!(chunk instanceof Uint8Array)) return new SandboxOperationError('stream_failure', 'Sandbox stdin accepts only binary byte chunks.');
    if (chunk.byteLength > this.maximumBufferedBytes - this.writableLength) {
      return new SandboxOperationError('input_limit', 'Sandbox stdin exceeded its buffered byte limit.');
    }
    const next = this.admitted + BigInt(chunk.byteLength);
    if (this.maximumBytes !== undefined && next > BigInt(this.maximumBytes)) {
      return new SandboxOperationError('input_limit', 'Sandbox stdin exceeded its caller-selected lifetime byte limit.');
    }
    this.admitted = next;
    return undefined;
  }

  private ownCallback(callback: WriteCallback): WriteCallback {
    let settled = false;
    const complete: WriteCallback = (error) => {
      if (settled) return;
      settled = true;
      this.activeWrite = undefined;
      callback(error);
    };
    this.activeWrite = complete;
    return complete;
  }
}
