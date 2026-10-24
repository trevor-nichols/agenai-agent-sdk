// ------------------------------------------------------------------------------------------------
//                input.ts - Binary Docker stdin forwarding - Independent outbound half-close
// ------------------------------------------------------------------------------------------------

import { Writable, type Duplex } from 'node:stream';
import { SandboxOperationError } from '@agen-ai/sandbox';

type WriteCallback = (error?: Error | null) => void;

export class DockerInput extends Writable {
  private closing = false;
  private active: WriteCallback | undefined;

  constructor(private readonly socket: Duplex, highWaterMark: number, private readonly failure: (error: Error) => void) {
    super({ highWaterMark, decodeStrings: false, autoDestroy: false });
    this.on('error', () => {});
    socket.on('error', (error: Error) => this.close(error));
    socket.once('close', () => {
      if (this.active) this.close(new SandboxOperationError('stream_failure', 'Docker attachment closed before stdin delivery settled.'));
    });
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: WriteCallback): void {
    if (!(chunk instanceof Uint8Array)) { callback(new SandboxOperationError('stream_failure', 'Docker stdin requires binary bytes.')); return; }
    const complete = this.callback(callback);
    try { this.socket.write(chunk, complete); }
    catch (cause) { complete(cause instanceof Error ? cause : new SandboxOperationError('stream_failure', 'Docker stdin write failed.', { cause })); }
  }

  override _final(callback: WriteCallback): void {
    const complete = this.callback(callback);
    try { this.socket.end(complete); }
    catch (cause) { complete(cause instanceof Error ? cause : new SandboxOperationError('stream_failure', 'Docker stdin half-close failed.', { cause })); }
  }

  close(error?: Error): void { this.closing = true; this.destroy(error); }

  override _destroy(error: Error | null, callback: WriteCallback): void {
    this.active?.(error ?? new SandboxOperationError('cancelled', 'Docker stdin closed before its write settled.'));
    if (!this.closing && (!this.writableFinished || error)) {
      this.failure(error ?? new SandboxOperationError('stream_failure', 'Docker stdin was abandoned.'));
    }
    callback(error);
  }

  private callback(callback: WriteCallback): WriteCallback {
    let done = false;
    const complete: WriteCallback = (error) => {
      if (done) return;
      done = true;
      this.active = undefined;
      callback(error);
    };
    this.active = complete;
    return complete;
  }
}
