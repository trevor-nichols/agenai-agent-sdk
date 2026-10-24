// ------------------------------------------------------------------------------------------------
//                reader.ts - One-chunk tar byte cursor - Wire quota and actual source cleanup
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import { unsafeArchive } from '../paths.js';
import type { TarOptions } from './contracts.js';

export class TarReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array();
  private ended = false;
  private received = 0n;
  bytes = 0n;

  constructor(source: AsyncIterable<Uint8Array>, private readonly options: TarOptions) { this.iterator = source[Symbol.asyncIterator](); }

  async take(maximum: number): Promise<Uint8Array | undefined> {
    this.options.signal.throwIfAborted();
    while (!this.current.length && !this.ended) {
      const item = await this.iterator.next();
      this.options.signal.throwIfAborted();
      if (item.done) this.ended = true;
      else {
        if (!(item.value instanceof Uint8Array) || item.value.length > this.options.chunkBytes) unsafeArchive('source chunks exceed the selected byte buffer.');
        this.received += BigInt(item.value.length);
        if (this.options.maxArchiveBytes !== undefined && this.received > this.options.maxArchiveBytes) {
          throw new SandboxOperationError(this.options.limitCode, 'Workspace archive exceeds the caller-selected wire byte quota.');
        }
        this.current = item.value;
      }
    }
    if (this.ended) return undefined;
    const chunk = this.current.subarray(0, maximum);
    this.current = this.current.subarray(chunk.length);
    this.bytes += BigInt(chunk.length);
    return chunk;
  }

  async exact(size: number, eofAllowed = false): Promise<Uint8Array | undefined> {
    const result = new Uint8Array(size);
    let position = 0;
    while (position < size) {
      const chunk = await this.take(size - position);
      if (chunk === undefined) {
        if (eofAllowed && position === 0) return undefined;
        unsafeArchive('unexpected EOF inside framing or payload.');
      }
      result.set(chunk, position);
      position += chunk.length;
    }
    return result;
  }

  async required(size: number): Promise<Uint8Array> {
    const bytes = await this.exact(size);
    if (!bytes) unsafeArchive('unexpected EOF inside framing.');
    return bytes;
  }

  async zeroes(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.take(remaining);
      if (!chunk) unsafeArchive('unexpected EOF inside padding.');
      if (chunk.some((byte) => byte !== 0)) unsafeArchive('nonzero padding or trailer.');
      remaining -= chunk.length;
    }
  }

  async close(): Promise<void> {
    this.current = new Uint8Array();
    if (!this.ended) await this.iterator.return?.();
  }
}
