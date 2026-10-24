// ------------------------------------------------------------------------------------------------
//                bytes.ts - Bounded single-file body ownership and byte-array convenience
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '../errors.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import type { SandboxByteSource, SandboxTreeEntry } from './types.js';
import { parseTreeMetadata, transferData } from './parse.js';
import { TransferIterator } from './iterator.js';

type Failure = Readonly<{ error: unknown }>;
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;

function actualByteLength(bytes: Uint8Array): number {
  if (!byteLengthGetter) throw new TypeError('Typed-array byte length is unavailable.');
  return Reflect.apply(byteLengthGetter, bytes, []) as number;
}

export class TransferBody implements AsyncIterable<Uint8Array> {
  private source: TransferIterator<Uint8Array> | undefined;
  private used = false;
  private retired = false;
  private remaining: number;
  private eof = false;
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;
  private failure: Failure | undefined;

  constructor(byteLength: number, private readonly chunkBytes: number, private readonly requireEof: boolean,
    private readonly signal: AbortSignal, private open: (() => SandboxByteSource) | undefined,
    private readonly interrupt: (error: unknown) => void) { this.remaining = byteLength; }

  get complete(): boolean { return this.remaining === 0 && (!this.requireEof || this.eof) && !this.pending && !this.failure; }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.used || this.retired) return this.rejectIterator('File bodies are single-use and scoped to their entry.');
    this.used = true;
    return { next: () => this.next(), return: async () => { await this.close(); return { done: true, value: undefined }; } };
  }

  private rejectIterator(message: string): never {
    const error = new SandboxOperationError('driver_failure', message);
    this.failure ??= { error };
    this.interrupt(error);
    throw error;
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.pending) {
      try { this.rejectIterator('Concurrent file body pulls are forbidden.'); } catch (error) { return Promise.reject(error); }
    }
    if (this.retired) return Promise.reject(new SandboxOperationError('driver_failure', 'File body scope has ended.'));
    const actual = (async (): Promise<IteratorResult<Uint8Array>> => {
      this.signal.throwIfAborted();
      if (this.remaining === 0 && (!this.requireEof || this.eof)) return { done: true, value: undefined };
      const open = this.open;
      if (!open) throw new SandboxOperationError('driver_failure', 'File body scope has ended.');
      this.source ??= new TransferIterator(open());
      const result = await this.source.next();
      this.signal.throwIfAborted();
      if (result.done) {
        if (this.remaining !== 0) throw new SandboxOperationError('driver_failure', 'File body ended before its declared byteLength.');
        this.eof = true;
        return { done: true, value: undefined };
      }
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) throw new SandboxOperationError('driver_failure', 'File bodies require Uint8Array chunks.');
      const length = actualByteLength(chunk);
      if (length > this.chunkBytes || length > this.remaining) throw new SandboxOperationError('driver_failure', 'File body chunk exceeds its bounded buffer or declared byteLength.');
      const bytes = new Uint8Array(length);
      Uint8Array.prototype.set.call(bytes, chunk);
      this.remaining -= bytes.byteLength;
      return { done: false, value: bytes };
    })();
    this.pending = actual;
    void actual.then(() => { this.pending = undefined; }, (error: unknown) => {
      this.pending = undefined; this.failure ??= { error }; this.interrupt(error);
    });
    return actual;
  }

  assertComplete(): void {
    if (this.failure) throw this.failure.error;
    if (!this.complete) throw new SandboxOperationError('driver_failure', 'File body was not completely consumed before its owner returned.');
  }

  rejectReuse(): never { return this.rejectIterator('Input file open is once-only.'); }

  async close(retry = false): Promise<void> {
    this.retired = true;
    await this.pending?.catch(() => {});
    await this.source?.close(retry);
    this.source = undefined;
    this.open = undefined;
  }
}

/** Borrows caller-owned bytes; keep them unchanged until the transfer settles. Yields bounded views. */
export function fileFromBytes(path: string, bytes: Uint8Array, options: Readonly<{ executable?: boolean; chunkBytes?: number }> = {}): Extract<SandboxTreeEntry, { kind: 'file' }> {
  if (!(bytes instanceof Uint8Array)) throw new SandboxOperationError('input_limit', 'fileFromBytes requires a byte array.');
  const selected = transferData(options, ['executable', 'chunkBytes']);
  const chunkBytes = selected.chunkBytes ?? SANDBOX_LIMITS.maxTransferChunkBytes;
  if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > SANDBOX_LIMITS.maxTransferChunkBytes) throw new SandboxOperationError('input_limit', 'fileFromBytes chunkBytes must fit the transfer buffer bound.');
  const byteLength = actualByteLength(bytes);
  if (!bufferGetter || !byteOffsetGetter) throw new TypeError('Typed-array backing storage is unavailable.');
  const buffer = Reflect.apply(bufferGetter, bytes, []) as ArrayBufferLike;
  const byteOffset = Reflect.apply(byteOffsetGetter, bytes, []) as number;
  const executable = selected.executable ?? false;
  if (typeof executable !== 'boolean') throw new SandboxOperationError('input_limit', 'fileFromBytes executable must be boolean.');
  const candidate = { kind: 'file' as const, path, executable, byteLength,
    open({ signal }: Readonly<{ signal: AbortSignal }>) {
      return { *[Symbol.iterator]() {
        for (let offset = 0; offset < byteLength; offset += chunkBytes) {
          signal.throwIfAborted();
          yield new Uint8Array(buffer, byteOffset + offset, Math.min(chunkBytes, byteLength - offset));
        }
      } };
    } };
  parseTreeMetadata(candidate, 'open');
  return Object.freeze(candidate);
}
