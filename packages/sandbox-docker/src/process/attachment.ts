// ------------------------------------------------------------------------------------------------
//                attachment.ts - Owned multiplex stream pumps - Docker attachment lifetime
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxStreamLimits } from '@agen-ai/sandbox';
import type { DockerEngineAttachment } from '../engine/client.js';
import { DockerFrameDecoder } from './framing.js';
import { DockerInput } from './input.js';
import { DockerOutput } from './output.js';

const RECEIVE_CHUNK_BYTES = 64 * 1024;

export class DockerProcessAttachment {
  readonly stdin: DockerInput;
  readonly stdout: DockerOutput;
  readonly stderr: DockerOutput;
  readonly settled: Promise<void>;
  private closed = false;
  private outputBytes = 0n;

  constructor(private readonly attachment: DockerEngineAttachment, private readonly limits: SandboxStreamLimits,
    failure: (error: Error) => void) {
    const fail = (error: Error) => { if (!this.closed) { this.close(error); failure(error); } };
    this.stdin = new DockerInput(attachment.stream, limits.highWaterMarkBytes, fail);
    this.stdout = new DockerOutput(fail);
    this.stderr = new DockerOutput(fail);
    const pumping = this.pump().catch((cause: unknown) => {
      if (!this.closed) fail(cause instanceof Error ? cause : new SandboxOperationError('stream_failure', 'Docker output failed.', { cause }));
    });
    this.settled = Promise.all([pumping, attachment.closed.catch((cause: unknown) => {
      if (!this.closed) fail(cause instanceof Error ? cause : new SandboxOperationError('stream_failure', 'Docker attachment failed.', { cause }));
    })]).then(() => undefined);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stdin.close(error);
    this.stdout.close(error);
    this.stderr.close(error);
    this.attachment.stream.destroy(error);
  }

  private async pump(): Promise<void> {
    const decoder = new DockerFrameDecoder();
    if (this.attachment.head.byteLength > RECEIVE_CHUNK_BYTES || this.attachment.stream.readableHighWaterMark > RECEIVE_CHUNK_BYTES) {
      throw new SandboxOperationError('output_limit', 'Docker attachment exceeds its bounded native receive profile.');
    }
    const deliver = async (channel: 1 | 2, payload: Uint8Array) => {
      for (let offset = 0; offset < payload.byteLength;) {
        if (this.closed) return;
        const size = Math.min(this.limits.highWaterMarkBytes, payload.byteLength - offset);
        if (this.limits.maxOutputBytes !== undefined && BigInt(size) > BigInt(this.limits.maxOutputBytes) - this.outputBytes) {
          throw new SandboxOperationError('output_limit', 'Docker output exceeded its caller-selected combined byte quota.');
        }
        this.outputBytes += BigInt(size);
        // Copy only the admitted slice: a tiny frame must not retain an entire native socket chunk.
        const bytes = Buffer.from(payload.subarray(offset, offset + size));
        await (channel === 1 ? this.stdout : this.stderr).deliver(bytes);
        offset += size;
      }
    };
    await decoder.accept(this.attachment.head, deliver);
    while (!this.attachment.stream.readableEnded) {
      if (this.closed) return;
      const size = Math.min(this.attachment.stream.readableLength, RECEIVE_CHUNK_BYTES);
      if (size === 0) { await this.receiveReady(); continue; }
      const chunk: unknown = this.attachment.stream.read(size);
      if (!(chunk instanceof Uint8Array)) throw new SandboxOperationError('stream_failure', 'Docker attachment returned non-binary bytes.');
      await decoder.accept(chunk, deliver);
    }
    if (this.closed) return;
    decoder.finish();
    this.stdout.finish();
    this.stderr.finish();
  }

  private receiveReady(): Promise<void> {
    const stream = this.attachment.stream;
    if (stream.readableEnded || stream.readableLength !== 0 || this.closed) return Promise.resolve();
    if (stream.destroyed) return Promise.reject(new SandboxOperationError('stream_failure', 'Docker attachment closed before output EOF.'));
    return new Promise<void>((resolve, reject) => {
      const clear = () => {
        stream.removeListener('readable', ready);
        stream.removeListener('end', ready);
        stream.removeListener('close', closed);
        stream.removeListener('error', failed);
      };
      const ready = () => { clear(); resolve(); };
      const failed = (error: Error) => { clear(); reject(error); };
      const closed = () => {
        clear();
        if (this.closed || stream.readableEnded) resolve();
        else reject(new SandboxOperationError('stream_failure', 'Docker attachment closed before output EOF.'));
      };
      stream.once('readable', ready);
      stream.once('end', ready);
      stream.once('close', closed);
      stream.once('error', failed);
      // Enter Node's bounded receive loop while retaining paused/manual-read ownership.
      stream.read(0);
    });
  }
}
