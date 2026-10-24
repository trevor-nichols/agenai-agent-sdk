// ------------------------------------------------------------------------------------------------
//                output.ts - Pull-controlled raw Docker output - Backpressure and reader ownership
// ------------------------------------------------------------------------------------------------

import { Readable } from 'node:stream';
import { SandboxOperationError } from '@agen-ai/sandbox';

export class DockerOutput extends Readable {
  private demand: (() => void) | undefined;
  private complete = false;

  constructor(private readonly failure: (error: Error) => void) {
    super({ highWaterMark: 0 });
    this.on('error', () => {});
  }

  override _read(): void {
    this.demand?.();
    this.demand = undefined;
  }

  async deliver(bytes: Uint8Array): Promise<void> {
    if (this.destroyed) throw new SandboxOperationError('stream_failure', 'Docker output was closed.');
    const requested = Promise.withResolvers<void>();
    this.demand = requested.resolve;
    this.push(bytes);
    if (this.readableLength !== 0) await requested.promise;
    if (this.demand === requested.resolve) this.demand = undefined;
  }

  finish(): void { this.complete = true; this.push(null); }

  close(error?: Error): void { this.complete = true; this.destroy(error); }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.demand?.();
    this.demand = undefined;
    if (!this.complete) this.failure(error ?? new SandboxOperationError('stream_failure', 'Docker output was abandoned.'));
    callback(error);
  }
}
