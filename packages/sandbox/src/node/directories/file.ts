// ------------------------------------------------------------------------------------------------
//                file.ts - Descriptor-owned regular file reads with bounded borrowed chunks
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { SandboxOperationError, SandboxStateError } from '../../errors.js';
import { verifyRegularIdentity } from '../hostPath.js';

export class DirectoryFile implements AsyncIterable<Uint8Array> {
  private file: FileHandle | undefined;
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;
  private closing: Promise<void> | undefined;
  private phase: 'ready' | 'reading' | 'closing' | 'closed' = 'ready';
  private signal: AbortSignal | undefined;
  private opened = false;
  private iterated = false;
  private done = false;
  private position = 0;
  private readonly buffer: Uint8Array;

  constructor(private readonly path: string, private readonly fileStats: BigIntStats,
    private readonly ownerSignal: AbortSignal, chunkBytes: number,
    private readonly verifyParents: () => Promise<void>) { this.buffer = new Uint8Array(chunkBytes); }

  open(input: Readonly<{ signal: AbortSignal }>): AsyncIterable<Uint8Array> {
    if (this.opened || this.phase !== 'ready') throw new SandboxStateError('Host input files are once-only and transfer scoped.');
    this.ownerSignal.throwIfAborted();
    this.signal = AbortSignal.any([this.ownerSignal, input.signal]);
    this.opened = true;
    this.phase = 'reading';
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterated || !this.opened) throw new SandboxStateError('Host input bodies admit one iterator after opening.');
    this.iterated = true;
    return { next: () => this.next(), return: async () => { await this.close(); return { done: true, value: undefined }; } };
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.phase !== 'reading' || this.pending) return Promise.reject(new SandboxStateError('Host file reads require one active reader.'));
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    const actual = (async (): Promise<IteratorResult<Uint8Array>> => {
      this.check();
      if (!this.file) {
        await this.verifyParents();
        this.check();
        this.file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        verifyRegularIdentity(await this.file.stat({ bigint: true }), this.fileStats);
        await this.verifyParents();
        verifyRegularIdentity(await lstat(this.path, { bigint: true }), this.fileStats);
        this.check();
      }
      const length = Number(this.fileStats.size);
      if (this.position === length) {
        const { bytesRead } = await this.file.read(this.buffer, 0, 1, this.position);
        this.check();
        if (bytesRead !== 0) throw new SandboxOperationError('input_limit', 'Host input grew beyond its declared length.');
        verifyRegularIdentity(await this.file.stat({ bigint: true }), this.fileStats);
        await this.verifyParents();
        verifyRegularIdentity(await lstat(this.path, { bigint: true }), this.fileStats);
        this.check();
        this.done = true;
        return { done: true, value: undefined };
      }
      const { bytesRead } = await this.file.read(this.buffer, 0, Math.min(this.buffer.byteLength, length - this.position), this.position);
      this.check();
      if (bytesRead === 0) throw new SandboxOperationError('input_limit', 'Host input ended before its declared length.');
      this.position += bytesRead;
      return { done: false, value: this.buffer.subarray(0, bytesRead) };
    })();
    this.pending = actual;
    void actual.then(() => { this.pending = undefined; }, () => { this.pending = undefined; });
    return actual;
  }

  close(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.closing = (async () => {
      await this.pending?.catch(() => {});
      if (this.file) { await this.file.close(); this.file = undefined; }
      this.phase = 'closed';
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private check(): void {
    this.ownerSignal.throwIfAborted();
    this.signal?.throwIfAborted();
    if (this.phase !== 'reading') throw new SandboxStateError('Host file admission is closed.');
  }
}
