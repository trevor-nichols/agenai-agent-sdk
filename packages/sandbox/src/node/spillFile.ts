// ------------------------------------------------------------------------------------------------
//                spillFile.ts - One native file lease - Joined I/O and retryable exact cleanup
// ------------------------------------------------------------------------------------------------

import type { FileHandle } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import type { SandboxDriverSpillFile } from '../backend/spill.js';
import { SandboxStateError } from '../errors.js';

function address(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Spill file addresses must be nonnegative safe integers.');
}

function byteRange(buffer: Uint8Array, offset: number, length: number, position: number): void {
  if (!(buffer instanceof Uint8Array)) throw new TypeError('Spill I/O requires a byte buffer.');
  address(offset); address(length); address(position); address(position + length);
  if (offset + length > buffer.byteLength) throw new RangeError('Spill byte range exceeds its buffer.');
}

export class SpillFile implements SandboxDriverSpillFile {
  private file: FileHandle | undefined;
  private path: string | undefined;
  private phase: 'open' | 'closing' | 'closed' = 'open';
  private active: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly admit: () => void, private readonly released: () => void) {}

  attach(file: FileHandle, path: string): void { this.file = file; this.path = path; }

  async unlink(): Promise<void> {
    if (!this.path) return;
    await unlink(this.path);
    this.path = undefined;
  }

  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<Readonly<{ bytesRead: number }>> {
    byteRange(buffer, offset, length, position);
    return this.enter(async (file) => {
      const { bytesRead } = await file.read(buffer, offset, length, position);
      return Object.freeze({ bytesRead });
    });
  }

  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<Readonly<{ bytesWritten: number }>> {
    byteRange(buffer, offset, length, position);
    return this.enter(async (file) => {
      const { bytesWritten } = await file.write(buffer, offset, length, position);
      return Object.freeze({ bytesWritten });
    });
  }

  truncate(size: number): Promise<void> {
    address(size);
    return this.enter((file) => file.truncate(size));
  }

  close(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.closing = (async () => {
      await this.active?.catch(() => {});
      const failures: unknown[] = [];
      try { await this.unlink(); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') this.path = undefined;
        else failures.push(error);
      }
      if (this.file) {
        try { await this.file.close(); this.file = undefined; } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Native spill file cleanup remains owned.');
      this.phase = 'closed';
      this.released();
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private enter<T>(perform: (file: FileHandle) => Promise<T>): Promise<T> {
    this.admit();
    if (this.phase !== 'open' || !this.file || this.path || this.active) {
      return Promise.reject(new SandboxStateError('Spill I/O requires an idle unlinked open file.'));
    }
    const file = this.file;
    const actual = perform(file).finally(() => { if (this.active === actual) this.active = undefined; });
    this.active = actual;
    return actual;
  }
}
