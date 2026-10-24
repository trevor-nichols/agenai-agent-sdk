// ------------------------------------------------------------------------------------------------
//                framing.ts - Strict incremental Docker multiplex frames - Binary stream boundary
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';

export const DOCKER_FRAME_LIMIT = 1024 * 1024;

export class DockerFrameDecoder {
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private remaining = 0;
  private channel: 1 | 2 = 1;

  async accept(bytes: Uint8Array, deliver: (channel: 1 | 2, bytes: Uint8Array) => Promise<void>): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.remaining === 0) {
        const copied = Math.min(8 - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + copied), this.headerBytes);
        this.headerBytes += copied;
        offset += copied;
        if (this.headerBytes !== 8) continue;
        const channel = this.header[0];
        if ((channel !== 1 && channel !== 2) || this.header[1] !== 0 || this.header[2] !== 0 || this.header[3] !== 0) {
          throw new SandboxOperationError('stream_failure', 'Docker output contains an invalid multiplex header.');
        }
        this.remaining = this.header.readUInt32BE(4);
        this.headerBytes = 0;
        this.channel = channel;
        if (this.remaining > DOCKER_FRAME_LIMIT) throw new SandboxOperationError('output_limit', 'Docker declared an oversized output frame.');
        if (this.remaining === 0) continue;
      }
      const size = Math.min(this.remaining, bytes.byteLength - offset);
      if (size === 0) continue;
      await deliver(this.channel, bytes.subarray(offset, offset + size));
      offset += size;
      this.remaining -= size;
    }
  }

  finish(): void {
    if (this.headerBytes !== 0 || this.remaining !== 0) {
      throw new SandboxOperationError('stream_failure', 'Docker output ended inside a multiplex frame.');
    }
  }
}
