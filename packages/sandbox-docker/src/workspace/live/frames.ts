// ------------------------------------------------------------------------------------------------
//                frames.ts - Bounded reply frame accumulation for the native filesystem helper
// ------------------------------------------------------------------------------------------------

import { decodeFilesystemReply, filesystemReplyLength } from './protocol.js';
import type { FilesystemReply } from './protocol.js';

export class FilesystemReplyFrames {
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private replyKind = 0;

  get partial(): boolean { return this.headerBytes !== 0 || this.payload !== undefined; }

  /** Delivers each complete validated reply; `active` stops delivery after the owner failed or closed. */
  accept(bytes: Uint8Array, deliver: (reply: FilesystemReply) => void, active: () => boolean): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (!active()) return;
      if (!this.payload) {
        const count = Math.min(8 - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes !== 8) continue;
        this.replyKind = this.header.readUInt32BE(0);
        const length = this.header.readUInt32BE(4);
        filesystemReplyLength(this.replyKind, length);
        this.payload = Buffer.alloc(length);
        this.payloadBytes = 0;
        this.headerBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, bytes.byteLength - offset);
      this.payload.set(bytes.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes !== this.payload.length) continue;
      const reply = decodeFilesystemReply(this.replyKind, this.payload);
      this.payload = undefined;
      deliver(reply);
    }
  }
}
