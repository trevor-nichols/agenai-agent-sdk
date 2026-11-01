import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxProcessExit, SandboxProcessStreams } from '@agen-ai/sandbox';
import { CONCURRENT_PROTOCOL } from './protocol.js';
import type { ConcurrentMemberLabel, ConcurrentProcessIdentity, ConcurrentTlsObservation, ConcurrentWorkflowOptions } from './types.js';

export function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Malformed original-primary observation.');
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
export function integer(value: unknown): number { assert(typeof value === 'number' && Number.isSafeInteger(value) && value > 0); return value; }

function identity(value: unknown, label: ConcurrentMemberLabel, session: string): ConcurrentProcessIdentity {
  const input = record(value);
  assert.equal(input.label, label); assert.equal(input.session, session);
  assert(input.networkNamespace === null || typeof input.networkNamespace === 'string');
  return { label, session, pid: integer(input.pid), platform: text(input.platform), architecture: text(input.architecture),
    node: text(input.node), cwd: text(input.cwd), networkNamespace: input.networkNamespace };
}
export function tlsObservation(value: unknown): ConcurrentTlsObservation {
  const input = record(value); assert.equal(input.authorized, true);
  return { connection: text(input.connection), sequence: integer(input.sequence), status: integer(input.status), authorized: true,
    certificateFingerprint256: text(input.certificateFingerprint256) };
}

export async function observeWithin<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Explicit concurrency observation deadline: ' + description)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Exactly one stdout reader and one stderr reader, retained from dispatch through settlement. */
export class ConcurrentProgramSession {
  readonly readerId = randomUUID();
  private readonly readiness = Promise.withResolvers<void>();
  private readonly errors: unknown[] = [];
  private primaryIdentity: ConcurrentProcessIdentity | undefined;
  private lastHeld: ConcurrentTlsObservation | undefined;
  private lastCounter = 0;
  private pending: Readonly<{ id: number; resolve(value: Record<string, unknown>): void; reject(error: unknown): void }> | undefined;
  private commandId = 0;
  private expectedStop = false;
  private closed = false;
  private failure: Readonly<{ error: unknown }> | undefined;
  private readonly readers: Promise<void>;
  private readonly exited: Promise<void>;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private exitValue: SandboxProcessExit | undefined;

  constructor(private readonly streams: SandboxProcessStreams, readonly label: ConcurrentMemberLabel,
    readonly token: string, private readonly timeoutMs: number, private readonly onOutput: ConcurrentWorkflowOptions['onOutput']) {
    void this.readiness.promise.catch(() => {});
    streams.stdin.on('error', (error: Error) => { if (!this.expectedStop) this.fail(error); });
    this.readers = Promise.all([
      this.read('stdout').catch((error: unknown) => this.fail(error)),
      this.read('stderr').catch((error: unknown) => this.fail(error)),
    ]).then(() => {});
    this.exited = streams.exit.then((exit) => {
      this.exitValue = exit;
      if (!this.expectedStop) this.fail(new Error('Original primary exited during active membership: ' + JSON.stringify(exit)));
    }, (error: unknown) => this.fail(error));
  }

  get identity(): ConcurrentProcessIdentity { assert(this.primaryIdentity, 'Original primary has not become ready.'); return this.primaryIdentity; }
  get counter(): number { return this.lastCounter; }
  get held(): ConcurrentTlsObservation { assert(this.lastHeld, 'Original held TLS has not become ready.'); return this.lastHeld; }

  private fail(error: unknown): void {
    if (!this.errors.includes(error)) this.errors.push(error);
    this.failure ??= { error }; this.readiness.reject(error); this.pending?.reject(error); this.pending = undefined;
  }

  private async read(stream: 'stdout' | 'stderr'): Promise<void> {
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of this.streams[stream]) {
        assert(chunk instanceof Uint8Array);
        const bytes = Uint8Array.from(chunk);
        if (stream === 'stdout') { this.stdoutBytes += bytes.length; assert(this.stdoutBytes <= 4 * 1024 ** 2, 'Original stdout exceeded 4 MiB.'); }
        else { this.stderrBytes += bytes.length; assert(this.stderrBytes <= 64 * 1024, 'Original stderr exceeded 64 KiB.'); }
        await this.onOutput?.({ member: this.label, readerId: this.readerId, stream, bytes });
        if (stream === 'stderr') { this.fail(new Error('Original primary stderr: ' + Buffer.from(bytes).toString('utf8'))); continue; }
        pending = Buffer.concat([pending, bytes]); assert(pending.length <= 96 * 1024);
        for (;;) {
          const end = pending.indexOf(10); if (end < 0) break;
          assert(end <= CONCURRENT_PROTOCOL.frameBytes, 'Original stdout frame exceeded 32 KiB.');
          const frame = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end))));
          pending = pending.subarray(end + 1); this.accept(frame);
        }
      }
    } catch (error) {
      if (!(this.expectedStop && error instanceof SandboxOperationError && error.code === 'cancelled')) throw error;
    }
    assert.equal(pending.length, 0, 'Original output ended inside a protocol frame.');
    if (stream === 'stdout') { this.closed = true; if (!this.expectedStop) throw new Error('Original stdout ended during active membership.'); }
  }

  private accept(frame: Record<string, unknown>): void {
    if (frame.kind === 'ready') {
      assert.equal(this.primaryIdentity, undefined, 'Original primary emitted duplicate readiness.');
      this.primaryIdentity = identity(frame.identity, this.label, this.token); this.readiness.resolve();
    } else if (frame.kind === 'tick') {
      assert.equal(frame.label, this.label); assert.equal(frame.session, this.token);
      assert.equal(frame.pid, this.identity.pid); assert.equal(frame.counter, this.lastCounter + 1); this.lastCounter = integer(frame.counter);
    } else if (frame.kind === 'held') {
      const value = tlsObservation(frame); assert.equal(value.sequence, (this.lastHeld?.sequence ?? 0) + 1);
      if (this.lastHeld) { assert.equal(value.connection, this.lastHeld.connection); assert.equal(value.certificateFingerprint256, this.lastHeld.certificateFingerprint256); }
      this.lastHeld = value;
    } else {
      assert.equal(frame.kind, 'reply'); assert(this.pending && frame.id === this.pending.id, 'Reply lost its original command owner.');
      const pending = this.pending; this.pending = undefined; pending.resolve(record(frame.result));
    }
  }

  async ready(): Promise<void> { await observeWithin(this.readiness.promise, this.timeoutMs, 'original primary readiness'); }

  async request(command: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.failure) throw this.failure.error;
    assert(!this.expectedStop && !this.closed && !this.pending);
    assert(++this.commandId <= CONCURRENT_PROTOCOL.commands, 'Original-primary command capacity exhausted.');
    const result = Promise.withResolvers<Record<string, unknown>>(); void result.promise.catch(() => {});
    this.pending = { id: this.commandId, ...result };
    try {
      const bytes = Buffer.from(JSON.stringify({ ...command, id: this.commandId }) + '\n');
      assert(bytes.length <= CONCURRENT_PROTOCOL.commandBytes);
      await observeWithin(new Promise<void>((resolve, reject) => this.streams.stdin.write(bytes,
        (error) => error ? reject(error) : resolve())), this.timeoutMs, 'original stdin acknowledgement');
      return await observeWithin(result.promise, this.timeoutMs + 1000, 'original reply');
    } catch (error) { this.fail(error); throw error; }
  }

  async progress(previousCounter = this.counter, previousHeld = this.lastHeld?.sequence): Promise<void> {
    const deadline = performance.now() + this.timeoutMs + 1500;
    while (this.counter < previousCounter + 3 || (previousHeld !== undefined && (this.lastHeld?.sequence ?? 0) <= previousHeld)) {
      if (this.failure) throw this.failure.error;
      assert(!this.closed && !this.exitValue, 'Original primary lost continuity.');
      assert(performance.now() < deadline, 'Original primary stopped fresh file/output/TLS work.');
      await delay(25);
    }
    if (this.failure) throw this.failure.error;
  }

  beginStop(): void { this.expectedStop = true; }
  async settle(): Promise<Readonly<{ exit: SandboxProcessExit | undefined; failure: AggregateError | undefined }>> {
    await Promise.all([this.readers, this.exited]);
    return { exit: this.exitValue, failure: this.errors.length ? new AggregateError(this.errors, 'Original reader failures retained.') : undefined };
  }
}
