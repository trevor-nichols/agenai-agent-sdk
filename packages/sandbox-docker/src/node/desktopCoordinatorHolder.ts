import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod/v4';
import { COORDINATOR_JOURNAL_LIMITS } from '../network/desktop/coordinator/journal/schema.js';
import type { PreparedExecutable } from './preparedExecutable.js';

const physicalId = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const stateIdentity = { stateDevice: physicalId, stateInode: physicalId };
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opened'), initial: z.enum(['required', 'existing']),
    rootDevice: physicalId, rootInode: physicalId, lockDevice: physicalId, lockInode: physicalId,
    ...stateIdentity, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('snapshot'), text: z.string(), digest, ...stateIdentity, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('committed'), digest, ...stateIdentity }),
  z.strictObject({ kind: z.literal('checked'), fenced: z.boolean() }),
  z.strictObject({ kind: z.literal('cleanup') }),
  z.strictObject({ kind: z.literal('discarded') }),
  z.strictObject({ kind: z.literal('closed') }),
  z.strictObject({ kind: z.literal('failure'), reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    errno: z.number().int().min(0).max(65_535), claim: z.enum(['held', 'lost']) }),
]);
type HolderResponse = z.infer<typeof responseSchema>;
export type DesktopCoordinatorHolderIdentity = Extract<HolderResponse, { kind: 'opened' }>;
export type DesktopCoordinatorHolderSnapshot = Extract<HolderResponse, { kind: 'snapshot' }>;

export class DesktopCoordinatorHolderError extends Error {
  constructor(readonly reason: string, readonly claim: 'held' | 'lost', options?: ErrorOptions) {
    super(`Desktop coordinator native authority failed: ${reason}.`, options);
    this.name = 'DesktopCoordinatorHolderError';
  }
}

const MAX_PAYLOAD = COORDINATOR_JOURNAL_LIMITS.framedBytes - COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes;
const MAX_RESPONSE = 6 * MAX_PAYLOAD + 1_024;

/** One prepared process owns the stable claim and every entered storage command. */
export class DesktopCoordinatorHolder {
  readonly opened: Promise<DesktopCoordinatorHolderIdentity>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited = Promise.withResolvers<void>();
  private pending: PromiseWithResolvers<HolderResponse> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private bytes = Buffer.alloc(0);
  private failure: DesktopCoordinatorHolderError | undefined;
  private closedReceipt = false;
  private closeActual: Promise<void> | undefined;
  private executableClose: Promise<void> | undefined;
  private ownsClaim = false;

  constructor(
    path: string, mode: 'initialize' | 'open' | 'cleanup', engineKey: string,
    private readonly executable: PreparedExecutable,
    private readonly onLoss: (error: DesktopCoordinatorHolderError) => void,
  ) {
    const opening = Promise.withResolvers<HolderResponse>();
    this.pending = opening;
    this.child = spawn(path, [mode, engineKey], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => this.lose(new DesktopCoordinatorHolderError('unexpected_diagnostic', 'lost')));
    this.child.stdin.on('error', (cause: Error) => this.lose(new DesktopCoordinatorHolderError('input_failed', 'lost', { cause })));
    this.child.on('error', (cause: Error) => this.lose(new DesktopCoordinatorHolderError('process_failed', 'lost', { cause })));
    this.child.on('close', (code, signal) => {
      this.ownsClaim = false;
      if (!this.closedReceipt || code !== 0 || signal !== null || this.pending !== undefined || this.bytes.length > 0) {
        this.lose(new DesktopCoordinatorHolderError('process_closed', 'lost'));
      }
      void this.closeExecutable().catch((cause: unknown) => {
        this.lose(new DesktopCoordinatorHolderError('executable_close', 'lost', { cause }));
      });
      this.exited.resolve();
    });
    this.opened = opening.promise.then(async (response) => {
      if (this.failure) throw this.failure;
      this.assertResponse(response);
      if (response.kind !== 'opened') throw new DesktopCoordinatorHolderError('opening_response', 'lost');
      this.ownsClaim = true;
      await this.executable.verify();
      if (this.failure) throw this.failure;
      return Object.freeze(response);
    }).catch((cause: unknown) => {
      const error = this.failure ?? (cause instanceof DesktopCoordinatorHolderError ? cause
        : new DesktopCoordinatorHolderError('executable_changed', 'lost', { cause }));
      if (error.claim === 'lost') this.lose(error);
      throw error;
    });
    void this.opened.catch(() => {});
  }

  get claimed(): boolean { return this.ownsClaim && this.failure === undefined; }

  async read(): Promise<DesktopCoordinatorHolderSnapshot> {
    const response = await this.request('READ\n');
    if (response.kind !== 'snapshot' || Buffer.byteLength(response.text) > MAX_PAYLOAD
      || createHash('sha256').update(response.text).digest('hex') !== response.digest) {
      throw this.protocolFailure('snapshot_response');
    }
    return Object.freeze(response);
  }

  async check(): Promise<void> {
    if (this.failure) throw this.failure;
    await this.executable.verify();
    const response = await this.request('CHECK\n');
    if (response.kind !== 'checked') throw this.protocolFailure('check_response');
    if (response.fenced) throw new DesktopCoordinatorHolderError('storage_fenced', 'held');
  }

  async commit(text: string): Promise<void> {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length < 1 || payload.length > MAX_PAYLOAD || !text.isWellFormed()) {
      throw new TypeError('Coordinator snapshot exceeds its native framing contract.');
    }
    const input = Buffer.concat([Buffer.from(`COMMIT ${payload.length}\n`), payload, Buffer.from('\n')]);
    const response = await this.request(input);
    if (response.kind !== 'committed' || response.digest !== createHash('sha256').update(payload).digest('hex')) {
      throw this.protocolFailure('commit_response');
    }
  }

  async enterCleanup(): Promise<void> {
    const response = await this.request('CLEANUP\n');
    if (response.kind !== 'cleanup') throw this.protocolFailure('cleanup_response');
  }

  async discardUnpublishedTemp(): Promise<void> {
    const response = await this.request('DISCARD_TEMP\n');
    if (response.kind !== 'discarded') throw this.protocolFailure('discard_response');
  }

  close(): Promise<void> {
    this.closeActual ??= this.finishClose();
    return this.closeActual;
  }

  private async finishClose(): Promise<void> {
    let closeFailure: unknown;
    if (!this.failure) {
      try {
        const response = await this.request('CLOSE\n');
        if (response.kind !== 'closed') throw this.protocolFailure('close_response');
        this.closedReceipt = true;
      } catch (error) { closeFailure = error; }
      finally { this.child.stdin.end(); }
    } else this.child.stdin.end();
    await this.exited.promise;
    await this.closeExecutable();
    if (this.failure) throw this.failure;
    if (closeFailure !== undefined) throw closeFailure;
  }

  private closeExecutable(): Promise<void> {
    this.executableClose ??= this.executable.close().catch((cause: unknown) => {
      this.executableClose = undefined;
      throw cause;
    });
    return this.executableClose;
  }

  private request(input: string | Buffer): Promise<HolderResponse> {
    const actual = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.pending) throw this.protocolFailure('overlapping_command');
      const response = Promise.withResolvers<HolderResponse>();
      this.pending = response;
      this.child.stdin.write(input, (cause) => {
        if (cause) this.lose(new DesktopCoordinatorHolderError('input_failed', 'lost', { cause }));
      });
      const result = await response.promise;
      if (this.failure) throw this.failure;
      this.assertResponse(result);
      return result;
    });
    this.tail = actual.then(() => {}, () => {});
    return actual;
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    if (this.bytes.length + chunk.length > MAX_RESPONSE) { this.protocolFailure('response_capacity'); return; }
    this.bytes = Buffer.concat([this.bytes, chunk]);
    let newline = this.bytes.indexOf(10);
    while (newline !== -1) {
      const line = this.bytes.subarray(0, newline);
      this.bytes = this.bytes.subarray(newline + 1);
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) { this.protocolFailure('unsolicited_response'); return; }
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        const response = responseSchema.parse(parsed);
        if (response.kind === 'opened' || response.kind === 'failure' && response.claim === 'held') this.ownsClaim = true;
        pending.resolve(response);
      } catch (cause) {
        const error = new DesktopCoordinatorHolderError('invalid_response', 'lost', { cause });
        pending.reject(error);
        this.lose(error);
        return;
      }
      newline = this.bytes.indexOf(10);
    }
  }

  private assertResponse(response: HolderResponse): void {
    if (response.kind !== 'failure') return;
    const error = new DesktopCoordinatorHolderError(response.reason, response.claim);
    if (response.claim === 'lost') this.lose(error);
    throw error;
  }

  private protocolFailure(reason: string): DesktopCoordinatorHolderError {
    const error = new DesktopCoordinatorHolderError(reason, 'lost');
    this.lose(error);
    return error;
  }

  private lose(error: DesktopCoordinatorHolderError): void {
    if (this.failure) return;
    this.failure = error;
    this.ownsClaim = false;
    this.pending?.reject(error);
    this.pending = undefined;
    this.child.stdin.end();
    this.onLoss(error);
  }
}
