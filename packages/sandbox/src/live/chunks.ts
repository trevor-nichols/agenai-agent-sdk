import { SandboxOperationError } from '../errors.js';
import { TransferIterator } from '../files/iterator.js';
import type { SandboxByteSource } from '../files/types.js';

const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get;

/** One borrowed stream, one outstanding pull, copied bounded chunks and joined retirement. */
export class LiveChunks implements AsyncIterable<Uint8Array> {
  private iterator: TransferIterator<Uint8Array> | undefined;
  private claimed = false;
  private retired = false;
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;
  private ended = false;
  private failure: Readonly<{ error: unknown }> | undefined;

  constructor(private readonly source: SandboxByteSource, private readonly bound: number,
    private readonly signal: AbortSignal, private readonly admit: (length: number) => void,
    private readonly fail: (error: unknown) => void) {}

  get complete(): boolean { return this.ended && !this.pending && !this.failure; }
  get pulling(): boolean { return this.pending !== undefined; }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.claimed || this.retired) throw this.violation('Live byte streams are once-only and scoped to their callback or write.');
    this.claimed = true;
    return { next: () => this.next(), return: async () => { await this.close(); return { done: true, value: undefined }; } };
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.pending || this.retired) return Promise.reject(this.violation('Concurrent or retired live byte pulls are forbidden.'));
    const actual = Promise.resolve().then(async (): Promise<IteratorResult<Uint8Array>> => {
      this.signal.throwIfAborted();
      this.iterator ??= new TransferIterator(this.source);
      const next = await this.iterator.next();
      this.signal.throwIfAborted();
      if (next.done) { this.ended = true; return { done: true, value: undefined }; }
      if (!(next.value instanceof Uint8Array) || !byteLength) throw new SandboxOperationError('stream_failure', 'Live file chunks require byte arrays.');
      const length: number = Reflect.apply(byteLength, next.value, []);
      if (length > this.bound) throw new SandboxOperationError('stream_failure', 'Live file chunk exceeds its working buffer bound.');
      this.admit(length);
      const chunk = new Uint8Array(length);
      Uint8Array.prototype.set.call(chunk, next.value);
      return { done: false, value: chunk };
    });
    this.pending = actual;
    void actual.then(() => { this.pending = undefined; }, (error: unknown) => {
      this.pending = undefined;
      this.failure ??= { error };
      this.fail(error);
    });
    return actual;
  }

  private violation(message: string): SandboxOperationError {
    const error = new SandboxOperationError('stream_failure', message);
    if (!this.retired) { this.failure ??= { error }; this.fail(error); }
    return error;
  }

  async close(retry = false): Promise<void> {
    this.retired = true;
    await this.pending?.catch(() => {});
    await this.iterator?.close(retry);
  }

  assertHealthy(): void { if (this.failure) throw this.failure.error; }
}
