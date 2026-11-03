import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PreparedExecutable } from './preparedExecutable.js';

interface NativeAuthorityFailure extends Error { readonly claim: 'held' | 'lost' }

interface NativeAuthorityProtocol<Response, Failure extends NativeAuthorityFailure> {
  readonly maximumResponseBytes: number;
  readonly parse: (input: unknown) => Response;
  readonly opened: (response: Response) => boolean;
  readonly closed: (response: Response) => boolean;
  readonly failure: (response: Response) => Failure | undefined;
  readonly error: (reason: string, claim: 'held' | 'lost', cause?: unknown) => Failure;
  readonly isFailure: (cause: unknown) => cause is Failure;
}

/** A single prepared process owns the claim, serialized commands and joined close. */
export class NativeAuthorityProcess<Response, Failure extends NativeAuthorityFailure> {
  readonly opened: Promise<Response>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited = Promise.withResolvers<void>();
  private pending: PromiseWithResolvers<Response> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private bytes = Buffer.alloc(0);
  private failure: Failure | undefined;
  private closedReceipt = false;
  private closeActual: Promise<void> | undefined;
  private executableClose: Promise<void> | undefined;
  private ownsClaim = false;
  private joinedClose = false;

  constructor(path: string, arguments_: readonly string[], private readonly executable: PreparedExecutable,
    private readonly protocol: NativeAuthorityProtocol<Response, Failure>, private readonly onLoss: (error: Failure) => void) {
    const opening = Promise.withResolvers<Response>();
    this.pending = opening;
    this.child = spawn(path, [...arguments_], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => this.lose(protocol.error('unexpected_diagnostic', 'lost')));
    this.child.stdin.on('error', (cause: Error) => this.lose(protocol.error('input_failed', 'lost', cause)));
    this.child.on('error', (cause: Error) => this.lose(protocol.error('process_failed', 'lost', cause)));
    this.child.on('close', (code, signal) => {
      this.ownsClaim = false;
      if (!this.closedReceipt || code !== 0 || signal !== null || this.pending !== undefined || this.bytes.length > 0) {
        this.lose(protocol.error('process_closed', 'lost'));
      }
      void this.closeExecutable().catch((cause: unknown) => this.lose(protocol.error('executable_close', 'lost', cause)));
      this.exited.resolve();
    });
    this.opened = opening.promise.then(async (response) => {
      if (this.failure) throw this.failure;
      this.assertResponse(response);
      if (!protocol.opened(response)) throw protocol.error('opening_response', 'lost');
      this.ownsClaim = true;
      await this.executable.verify();
      if (this.failure) throw this.failure;
      return response;
    }).catch((cause: unknown) => {
      const error = this.failure ?? this.nativeFailure(cause, 'executable_changed');
      if (error.claim === 'lost') this.lose(error);
      throw error;
    });
    void this.opened.catch(() => {});
  }

  get claimed(): boolean { return this.ownsClaim && this.failure === undefined; }
  get closeJoined(): boolean { return this.joinedClose; }

  async verifyExecutable(): Promise<void> {
    if (this.failure) throw this.failure;
    await this.executable.verify();
  }

  request(input: string | Buffer): Promise<Response> {
    const actual = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.pending) throw this.protocolFailure('overlapping_command');
      const response = Promise.withResolvers<Response>();
      this.pending = response;
      this.child.stdin.write(input, (cause) => {
        if (cause) this.lose(this.protocol.error('input_failed', 'lost', cause));
      });
      const result = await response.promise;
      if (this.failure) throw this.failure;
      this.assertResponse(result);
      return result;
    });
    this.tail = actual.then(() => {}, () => {});
    return actual;
  }

  protocolFailure(reason: string): Failure {
    const error = this.protocol.error(reason, 'lost');
    this.lose(error);
    return error;
  }

  close(): Promise<void> {
    if (this.closeActual === undefined) {
      this.closeActual = this.finishClose();
      return this.closeActual;
    }
    if (this.failure === undefined) return this.closeActual;
    return this.closeActual.catch(async (cause: unknown) => {
      await this.joinClose();
      throw cause;
    });
  }

  private async finishClose(): Promise<void> {
    let closeFailure: unknown;
    if (!this.failure) {
      try {
        const response = await this.request('CLOSE\n');
        if (!this.protocol.closed(response)) throw this.protocolFailure('close_response');
        this.closedReceipt = true;
      } catch (error) { closeFailure = error; }
      finally { this.child.stdin.end(); }
    } else this.child.stdin.end();
    await this.joinClose();
    if (this.failure) throw this.failure;
    if (closeFailure !== undefined) throw closeFailure;
  }

  private async joinClose(): Promise<void> {
    await this.exited.promise;
    await this.closeExecutable();
    this.joinedClose = true;
  }

  private closeExecutable(): Promise<void> {
    this.executableClose ??= this.executable.close().catch((cause: unknown) => {
      this.executableClose = undefined;
      throw cause;
    });
    return this.executableClose;
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    if (this.bytes.length + chunk.length > this.protocol.maximumResponseBytes) { this.protocolFailure('response_capacity'); return; }
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
        const response = this.protocol.parse(parsed);
        if (this.protocol.opened(response) || this.protocol.failure(response)?.claim === 'held') this.ownsClaim = true;
        pending.resolve(response);
      } catch (cause) {
        const error = this.protocol.error('invalid_response', 'lost', cause);
        pending.reject(error);
        this.lose(error);
        return;
      }
      newline = this.bytes.indexOf(10);
    }
  }

  private assertResponse(response: Response): void {
    const error = this.protocol.failure(response);
    if (error === undefined) return;
    if (error.claim === 'lost') this.lose(error);
    throw error;
  }

  private nativeFailure(cause: unknown, reason: string): Failure {
    if (this.protocol.isFailure(cause)) return cause;
    return this.protocol.error(reason, 'lost', cause);
  }

  private lose(error: Failure): void {
    if (this.failure) return;
    this.failure = error;
    this.ownsClaim = false;
    this.pending?.reject(error);
    this.pending = undefined;
    this.child.stdin.end();
    this.onLoss(error);
  }
}
