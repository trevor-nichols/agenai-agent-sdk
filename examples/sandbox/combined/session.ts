import assert from 'node:assert/strict';
import type { SandboxProcessStreams } from '@agen-ai/sandbox';

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Malformed controlled-program observation.');
  return Object.fromEntries(Object.entries(value));
}

export interface CombinedHttpsFixture {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
  readonly bodySha256: string;
}

export interface CombinedForbiddenFixture {
  readonly hostname: string;
  readonly address: string;
  readonly port: number;
  readonly probe: string;
  /** Retained in caller evidence; the caller independently proves this exact listener reachable. */
  readonly marker: string;
}

export interface CombinedNetworkObservation {
  readonly positive: Readonly<{
    status: number; bodyBytes: number; bodySha256: string; authorized: true; certificateFingerprint256: string;
  }>;
  readonly forbidden: Readonly<{
    direct: Readonly<{ connected: false; code: string | null; message: string }>;
    proxyStatus: 403;
  }>;
}

/** One bounded stdout reader and one stderr reader for the fixed controlled program. */
export class CombinedProgramSession {
  private readonly queue: unknown[] = [];
  private waiter: Readonly<{ resolve(value: unknown): void; reject(error: unknown): void }> | undefined;
  private failure: Readonly<{ error: unknown }> | undefined;
  private phase: 'active' | 'stopping' = 'active';
  private ended = false;
  private readonly readers: Promise<void>;
  private readonly errors: unknown[] = [];
  private readerFailure: AggregateError | undefined;

  constructor(private readonly streams: SandboxProcessStreams, private readonly timeoutMs: number) {
    streams.stdin.on('error', (error: Error) => this.fail(error));
    const stdout = this.readStdout().catch((error: unknown) => this.fail(error));
    const stderr = this.readStderr().catch((error: unknown) => this.fail(error));
    this.readers = Promise.all([stdout, stderr]).then(() => {});
  }

  private fail(error: unknown): void {
    this.errors.push(error);
    this.failure ??= { error };
    this.waiter?.reject(error); this.waiter = undefined;
  }

  private async readStdout(): Promise<void> {
    let pending = Buffer.alloc(0); let total = 0;
    try {
      for await (const chunk of this.streams.stdout) {
        const bytes: Uint8Array = chunk;
        total += bytes.byteLength;
        assert(total <= 64 * 1024, 'Controlled-program stdout exceeded 64 KiB.');
        pending = Buffer.concat([pending, bytes]);
        for (;;) {
          const end = pending.indexOf(10); if (end < 0) break;
          const value: unknown = JSON.parse(pending.subarray(0, end).toString('utf8'));
          pending = pending.subarray(end + 1);
          if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(value); }
          else { assert(this.queue.length < 4, 'Controlled-program observation queue exceeded its bound.'); this.queue.push(value); }
        }
      }
    } catch (error) { if (!this.expectedStopClose(error)) throw error; }
    assert.equal(pending.length, 0, 'Controlled-program stdout ended inside an observation.');
    this.ended = true;
    if (this.waiter) this.fail(new Error('Controlled program ended before its expected observation.'));
  }

  private async readStderr(): Promise<void> {
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for await (const chunk of this.streams.stderr) {
        const data: Uint8Array = chunk; bytes += data.byteLength;
        assert(bytes <= 64 * 1024, 'Controlled-program stderr exceeded 64 KiB.'); chunks.push(data);
      }
    } catch (error) { if (!this.expectedStopClose(error)) throw error; }
    assert.equal(bytes, 0, `Controlled program wrote stderr: ${Buffer.concat(chunks).toString('utf8')}`);
  }

  private expectedStopClose(error: unknown): boolean {
    return this.phase === 'stopping' && error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE';
  }

  private async next(): Promise<Record<string, unknown>> {
    if (this.failure) throw this.failure.error;
    if (this.queue.length) return record(this.queue.shift());
    assert(!this.ended, 'Controlled program ended before its expected observation.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return record(await new Promise<unknown>((resolve, reject) => {
        this.waiter = { resolve, reject };
        timer = setTimeout(() => {
          const error = new Error('Explicit controlled-program observation deadline.');
          this.fail(error);
        }, this.timeoutMs);
      }));
    } finally { clearTimeout(timer); }
  }

  private async send(command: object): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(command)}\n`);
    assert(bytes.byteLength <= 16 * 1024, 'Controlled-program command exceeded 16 KiB.');
    await new Promise<void>((resolve, reject) => this.streams.stdin.write(bytes, (error) => error ? reject(error) : resolve()));
  }

  async ready(): Promise<void> { assert.deepEqual(await this.next(), { kind: 'ready' }); }

  async network(positive: CombinedHttpsFixture, forbidden: CombinedForbiddenFixture): Promise<CombinedNetworkObservation> {
    await this.send({ kind: 'network', positive, forbidden });
    const observation = await this.next(); assert.equal(observation.kind, 'network');
    const allowed = record(observation.positive); const denied = record(observation.forbidden); const direct = record(denied.direct);
    assert.equal(allowed.status, positive.status); assert.equal(allowed.bodyBytes, positive.bodyBytes);
    assert.equal(allowed.bodySha256, positive.bodySha256); assert.equal(allowed.authorized, true);
    assert(typeof allowed.certificateFingerprint256 === 'string');
    assert.equal(direct.connected, false); assert(direct.code === null || typeof direct.code === 'string'); assert(typeof direct.message === 'string');
    assert.equal(denied.proxyStatus, 403);
    return { positive: { status: positive.status, bodyBytes: positive.bodyBytes, bodySha256: positive.bodySha256,
      authorized: true, certificateFingerprint256: allowed.certificateFingerprint256 },
    forbidden: { direct: { connected: false, code: direct.code, message: direct.message }, proxyStatus: 403 } };
  }

  async verify(): Promise<void> { await this.send({ kind: 'verify' }); assert.deepEqual(await this.next(), { kind: 'verified' }); }
  finish(): void { this.streams.stdin.end(); }
  beginStop(): void {
    this.phase = 'stopping';
  }
  async settle(): Promise<AggregateError | undefined> {
    await this.readers;
    if (this.errors.length) this.readerFailure ??= new AggregateError(this.errors, 'Controlled-program readers failed.');
    return this.readerFailure;
  }
  async join(): Promise<void> {
    const failure = await this.settle();
    if (failure) throw failure;
  }
}
