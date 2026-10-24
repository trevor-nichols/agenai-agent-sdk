// ------------------------------------------------------------------------------------------------
//                iterator.ts - Once-owned pulls and joined iterator retirement
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '../errors.js';

export class TransferIterator<Value> {
  private readonly iterator: Iterator<Value> | AsyncIterator<Value>;
  private pending: Promise<IteratorResult<Value>> | undefined;
  private closing: Promise<void> | undefined;
  private closeFailed = false;
  private ended = false;

  constructor(source: Iterable<Value> | AsyncIterable<Value>) {
    if (source === null || (typeof source !== 'object' && typeof source !== 'function')) throw new SandboxOperationError('driver_failure', 'Expected an iterable transfer source.');
    const asyncMethod = source[Symbol.asyncIterator as keyof typeof source];
    const method = asyncMethod ?? source[Symbol.iterator as keyof typeof source];
    if (typeof method !== 'function') throw new SandboxOperationError('driver_failure', 'Expected an iterable transfer source.');
    this.iterator = Reflect.apply(method, source, []) as Iterator<Value> | AsyncIterator<Value>;
    if (this.iterator === null || (typeof this.iterator !== 'object' && typeof this.iterator !== 'function')) throw new SandboxOperationError('driver_failure', 'Transfer iterator construction failed.');
  }

  get done(): boolean { return this.ended; }
  get pulling(): boolean { return this.pending !== undefined; }

  next(): Promise<IteratorResult<Value>> {
    if (this.pending || this.closing) return Promise.reject(new SandboxOperationError('driver_failure', 'Concurrent or retired transfer pulls are forbidden.'));
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    const actual = Promise.resolve().then(() => this.iterator.next()).then((result) => {
      if (result === null || typeof result !== 'object') throw new SandboxOperationError('driver_failure', 'Transfer iterator returned an invalid result.');
      if (result.done) { this.ended = true; return { done: true as const, value: undefined }; }
      return { done: false as const, value: result.value };
    });
    this.pending = actual;
    void actual.then(() => { this.pending = undefined; }, () => { this.pending = undefined; });
    return actual;
  }

  close(retry = false): Promise<void> {
    if (this.closing && (!retry || !this.closeFailed)) return this.closing;
    this.closeFailed = false;
    const closing = (async () => {
      await this.pending?.catch(() => {});
      if (!this.ended && this.iterator.return !== undefined) await this.iterator.return();
      this.ended = true;
    })();
    this.closing = closing;
    void closing.catch(() => { this.closeFailed = true; });
    return closing;
  }
}
