// ------------------------------------------------------------------------------------------------
//                channel.ts - Single-flight helper frames over caller-owned process stdio streams
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { FilesystemRequestPort } from '../../workspace/live/files.js';
import { FilesystemReplyFrames } from '../../workspace/live/frames.js';
import { encodeFilesystemRequest, FILESYSTEM_CHUNK_BYTES, FILESYSTEM_LAYOUT, FILESYSTEM_PROTOCOL } from '../../workspace/live/protocol.js';
import type { FilesystemReply, FilesystemRequest } from '../../workspace/live/protocol.js';
import type { NodeFilesystemHelperInput, NodeFilesystemHelperOutput } from './contracts.js';

export interface FilesystemStreamLimits {
  readonly readyTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly heartbeatMs: number;
}

export class FilesystemStreamChannel implements FilesystemRequestPort {
  readonly ready: Promise<void>;
  private readonly settled: Promise<void>;
  private readonly frames = new FilesystemReplyFrames();
  private pending: ReturnType<typeof Promise.withResolvers<FilesystemReply>> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatActual: Promise<void> = Promise.resolve();
  private accepting = true;
  private closing = false;
  private failure: SandboxOperationError | undefined;

  constructor(private readonly input: NodeFilesystemHelperInput, private readonly output: NodeFilesystemHelperOutput,
    user: Readonly<{ uid: number; gid: number }>, private readonly limits: FilesystemStreamLimits) {
    this.ready = this.receive(limits.readyTimeoutMs).then((reply) => {
      if (reply.kind !== 'ready' || reply.protocol !== FILESYSTEM_PROTOCOL || reply.layout !== FILESYSTEM_LAYOUT
        || reply.uid !== user.uid || reply.gid !== user.gid) {
        throw new SandboxOperationError('driver_failure', 'Filesystem readiness does not attest its exact layout and user.');
      }
      this.scheduleHeartbeat();
    }).catch((cause: unknown) => { this.fail(cause); throw this.failure ?? cause; });
    void this.ready.catch(() => {});
    this.settled = this.pump().catch((cause: unknown) => this.fail(cause));
  }

  get failed(): SandboxOperationError | undefined { return this.failure; }

  async request(request: FilesystemRequest, signal: AbortSignal): Promise<FilesystemReply> {
    if (!this.accepting) throw new SandboxStateError('Filesystem operation admission is closed.');
    await this.ready;
    await this.heartbeatActual;
    if (!this.accepting) throw new SandboxStateError('Filesystem operation admission is closed.');
    signal.throwIfAborted();
    const abort = () => this.fail(new SandboxOperationError('cancelled', 'Filesystem operation was cancelled.', { cause: signal.reason }));
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await this.exchange(request);
    } finally { signal.removeEventListener('abort', abort); }
  }

  interrupt(cause: unknown): void { this.fail(cause); }

  /** Sends the owned close request; the helper exits successfully only after this exact receipt. */
  async close(): Promise<void> {
    if (this.closing) throw new SandboxStateError('Filesystem close was already requested.');
    this.accepting = false;
    clearTimeout(this.heartbeatTimer);
    if (this.failure) throw this.failure;
    try {
      await this.ready;
      await this.heartbeatActual;
      if (this.failure) throw this.failure;
      if (this.pending) throw new SandboxStateError('Filesystem close cannot overlap an entered operation.');
      const reply = await this.exchange({ operation: 'close' });
      if (reply.kind !== 'terminal' || reply.terminal.status !== 'closed' || reply.terminal.effect !== 'none' || reply.terminal.errno !== 0) {
        throw new SandboxOperationError('driver_failure', 'Filesystem helper did not settle its owned close.');
      }
      this.closing = true;
      this.input.end();
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(() => deadline.reject(new SandboxOperationError('deadline_exceeded', 'Filesystem helper output did not end after close.')),
        this.limits.responseTimeoutMs);
      try { await Promise.race([this.settled, deadline.promise]); } finally { clearTimeout(timer); }
      if (this.failure) throw this.failure;
    } catch (cause) {
      this.closing = false;
      this.fail(cause);
      throw this.failure ?? cause;
    }
  }

  private receive(timeoutMs: number): Promise<FilesystemReply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) throw new SandboxStateError('Filesystem control admits exactly one request/reply pair.');
    this.pending = Promise.withResolvers<FilesystemReply>();
    this.timer = setTimeout(() => this.fail(new SandboxOperationError('deadline_exceeded', 'Filesystem helper response deadline expired.')), timeoutMs);
    this.timer.unref();
    return this.pending.promise;
  }

  private exchange(request: FilesystemRequest): Promise<FilesystemReply> {
    const bytes = encodeFilesystemRequest(request);
    const response = this.receive(this.limits.responseTimeoutMs);
    void response.catch(() => {});
    if (this.pending) this.input.write(bytes, (error) => { if (error) this.fail(error); });
    return response;
  }

  private scheduleHeartbeat(): void {
    if (!this.accepting || this.failure) return;
    this.heartbeatTimer = setTimeout(() => {
      if (!this.accepting || this.failure) return;
      if (this.pending) { this.scheduleHeartbeat(); return; }
      this.heartbeatActual = this.exchange({ operation: 'heartbeat' }).then((reply) => {
        if (reply.kind !== 'heartbeat') throw new SandboxOperationError('driver_failure', 'Filesystem helper returned an invalid heartbeat.');
      }).catch((cause: unknown) => this.fail(cause)).then(() => this.scheduleHeartbeat());
    }, this.limits.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private fail(cause: unknown): void {
    if (this.failure) return;
    this.accepting = false;
    this.failure = cause instanceof SandboxOperationError ? cause
      : new SandboxOperationError('driver_failure', 'Filesystem helper control failed.', { cause });
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.input.destroy();
    this.output.destroy();
  }

  private deliver(reply: FilesystemReply): void {
    const pending = this.pending;
    if (!pending) throw new SandboxOperationError('driver_failure', 'Filesystem helper sent an unsolicited response.');
    this.pending = undefined;
    clearTimeout(this.timer);
    pending.resolve(reply);
  }

  private async pump(): Promise<void> {
    for await (const bytes of this.output) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILESYSTEM_CHUNK_BYTES) {
        throw new SandboxOperationError('output_limit', 'Filesystem helper returned invalid or oversized bytes.');
      }
      this.frames.accept(bytes, (reply) => this.deliver(reply), () => !this.failure);
      if (this.closing && bytes.byteLength > 0) throw new SandboxOperationError('driver_failure', 'Filesystem helper wrote after its close receipt.');
    }
    if (this.frames.partial) throw new SandboxOperationError('driver_failure', 'Filesystem helper ended inside a response frame.');
    if (!this.closing && !this.failure) throw new SandboxOperationError('driver_failure', 'Filesystem helper closed before owned shutdown.');
  }
}
