// ------------------------------------------------------------------------------------------------
//                channel.ts - Single-flight bounded native frames over controller-owned Docker stdio
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { DockerEngineAttachment } from '../../engine/client.js';
import type { DockerSandboxFilesystemOptions } from '../../policy/config.js';
import { DockerFrameDecoder } from '../../process/framing.js';
import { decodeFilesystemReply, encodeFilesystemRequest, filesystemReplyLength } from './protocol.js';
import type { FilesystemReply, FilesystemRequest } from './protocol.js';

export class FilesystemChannel {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
  private pending: ReturnType<typeof Promise.withResolvers<FilesystemReply>> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatActual: Promise<void> = Promise.resolve();
  private closing = false;
  private failure: SandboxOperationError | undefined;
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private replyKind = 0;

  constructor(private readonly attachment: DockerEngineAttachment, private readonly configuration: DockerSandboxFilesystemOptions,
    private readonly onFailure: (error: SandboxOperationError) => void) {
    const initial = this.receive();
    this.ready = initial.then((reply) => {
      if (reply.kind !== 'ready' || reply.protocol !== configuration.protocol || reply.layout !== configuration.layout
        || reply.uid !== configuration.user.uid || reply.gid !== configuration.user.gid) {
        throw new SandboxOperationError('driver_failure', 'Filesystem readiness does not attest its exact selected layout and user.');
      }
      this.scheduleHeartbeat();
    }).catch((cause: unknown) => { this.fail(cause); throw cause; });
    void this.ready.catch(() => {});
    const pumping = this.pump().catch((cause: unknown) => this.fail(cause));
    this.settled = Promise.all([pumping, attachment.closed.catch((cause: unknown) => this.fail(cause))]).then(() => undefined);
  }

  async request(request: FilesystemRequest, signal: AbortSignal): Promise<FilesystemReply> {
    await this.ready;
    await this.heartbeatActual;
    signal.throwIfAborted();
    const abort = () => this.fail(new SandboxOperationError('cancelled', 'Filesystem operation was cancelled.', { cause: signal.reason }));
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await this.exchange(request);
    } finally { signal.removeEventListener('abort', abort); }
  }

  closeAdmission(): void {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    this.pending?.reject(new SandboxOperationError('cancelled', 'Filesystem control is stopping.'));
    this.pending = undefined;
    this.attachment.stream.destroy();
  }

  async close(): Promise<void> {
    this.closeAdmission();
    await this.settled;
    await this.heartbeatActual;
  }

  interrupt(cause: unknown): void { this.fail(cause); }

  private receive(): Promise<FilesystemReply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new SandboxOperationError('cancelled', 'Filesystem control is closed.'));
    if (this.pending) throw new SandboxStateError('Filesystem control admits exactly one request/reply pair.');
    this.pending = Promise.withResolvers<FilesystemReply>();
    this.timer = setTimeout(() => this.fail(new SandboxOperationError('deadline_exceeded', 'Filesystem helper response lease expired.')),
      this.configuration.control.leaseTimeoutMs);
    this.timer.unref();
    return this.pending.promise;
  }

  private exchange(request: FilesystemRequest): Promise<FilesystemReply> {
    const bytes = encodeFilesystemRequest(request);
    const response = this.receive();
    void response.catch(() => {});
    if (this.pending) this.attachment.stream.write(bytes, (error) => { if (error) this.fail(error); });
    return response;
  }

  private scheduleHeartbeat(): void {
    if (this.closing || this.failure) return;
    this.heartbeatTimer = setTimeout(() => {
      if (this.closing || this.failure) return;
      if (this.pending) { this.scheduleHeartbeat(); return; }
      this.heartbeatActual = this.exchange({ operation: 'heartbeat' }).then((reply) => {
        if (reply.kind !== 'heartbeat') throw new SandboxOperationError('driver_failure', 'Filesystem helper returned an invalid heartbeat.');
      }).catch((cause: unknown) => this.fail(cause)).then(() => this.scheduleHeartbeat());
    }, this.configuration.control.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private fail(cause: unknown): void {
    if (this.closing || this.failure) return;
    this.failure = cause instanceof SandboxOperationError ? cause
      : new SandboxOperationError('driver_failure', 'Filesystem helper control failed.', { cause });
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.attachment.stream.destroy();
    this.onFailure(this.failure);
  }

  private accept(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.closing || this.failure) return;
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
      const pending = this.pending;
      if (!pending) throw new SandboxOperationError('driver_failure', 'Filesystem helper sent an unsolicited response.');
      this.pending = undefined;
      clearTimeout(this.timer);
      pending.resolve(reply);
    }
  }

  private async pump(): Promise<void> {
    const { attachment } = this;
    const decoder = new DockerFrameDecoder();
    if (attachment.head.byteLength > 65536 || attachment.stream.readableHighWaterMark > 65536) {
      throw new SandboxOperationError('output_limit', 'Filesystem attachment exceeds the bounded native receive profile.');
    }
    const deliver = async (channel: 1 | 2, bytes: Uint8Array) => {
      if (channel !== 1) throw new SandboxOperationError('driver_failure', 'Filesystem helper wrote unexpected stderr output.');
      this.accept(bytes);
    };
    await decoder.accept(attachment.head, deliver);
    for await (const bytes of attachment.stream) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) throw new SandboxOperationError('output_limit', 'Filesystem attachment returned invalid or oversized bytes.');
      await decoder.accept(bytes, deliver);
    }
    if (!this.closing && !this.failure) {
      decoder.finish();
      throw new SandboxOperationError('driver_failure', 'Filesystem helper closed before owned shutdown.');
    }
  }
}
