// ------------------------------------------------------------------------------------------------
//                output.ts - Backpressured binary output - Node readable streams
// ------------------------------------------------------------------------------------------------

import { Readable } from 'node:stream';
import { SandboxOperationError } from '../errors.js';

export class SandboxOutput extends Readable {
  private demand: (() => void) | undefined;
  private complete = false;

  constructor(highWaterMark: number, private readonly abandoned: (error: Error) => void) {
    super({ highWaterMark });
    this.on('error', () => {});
  }

  override _read(): void {
    this.demand?.();
    this.demand = undefined;
  }

  async deliver(chunk: Uint8Array): Promise<void> {
    if (this.destroyed) throw new SandboxOperationError('stream_failure', 'Sandbox output is closed.');
    const demand = Promise.withResolvers<void>();
    this.demand = demand.resolve;
    if (this.push(chunk) || this.readableLength < this.readableHighWaterMark) {
      this.demand = undefined;
      return;
    }
    await demand.promise;
  }

  finish(): void {
    this.complete = true;
    this.push(null);
  }

  close(error?: Error): void {
    this.complete = true;
    this.destroy(error);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.demand?.();
    this.demand = undefined;
    if (!this.complete) this.abandoned(error ?? new SandboxOperationError('stream_failure', 'Sandbox output reader was abandoned.'));
    callback(error);
  }
}
