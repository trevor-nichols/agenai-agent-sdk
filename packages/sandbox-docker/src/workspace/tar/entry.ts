// ------------------------------------------------------------------------------------------------
//                entry.ts - One provisional callback-owned payload - Retired and joined source pulls
// ------------------------------------------------------------------------------------------------

import { archiveError, unsafeArchive } from '../paths.js';
import type { TarHeader, TarOutputEntry } from './contracts.js';
import type { TarReader } from './reader.js';

export async function consumeTarEntry(reader: TarReader, header: TarHeader & { readonly kind: 'file' | 'directory' }, path: string,
  consume: (entry: TarOutputEntry) => Promise<void>, chunkBytes: number): Promise<void> {
  let remaining = header.size;
  let active = true;
  let entered = false;
  let pending: Promise<IteratorResult<Uint8Array>> | undefined;
  let failure: { readonly error: unknown; readonly origin: 'source' | 'ownership' } | undefined;
  const reject = (message: string): Promise<IteratorResult<Uint8Array>> => {
    const error = archiveError(message);
    failure ??= { error, origin: 'ownership' };
    const result = Promise.reject<IteratorResult<Uint8Array>>(error);
    void result.catch(() => {});
    return result;
  };
  const iterator: AsyncIterator<Uint8Array> = {
    next() {
      if (!active) return reject('entry body is retired outside its callback.');
      if (pending) return reject('concurrent entry body pulls are forbidden.');
      const actual = Promise.resolve().then(async (): Promise<IteratorResult<Uint8Array>> => {
        try {
          if (remaining === 0) return { done: true, value: undefined };
          let chunk: Uint8Array | undefined;
          try { chunk = await reader.take(Math.min(remaining, chunkBytes)); }
          catch (error) { failure ??= { error, origin: 'source' }; throw error; }
          if (!active) unsafeArchive('entry callback returned with an active body pull.');
          if (!chunk) unsafeArchive('unexpected EOF inside payload.');
          remaining -= chunk.length;
          return { done: false, value: chunk };
        } catch (error) { failure ??= { error, origin: 'ownership' }; throw error; }
        finally { pending = undefined; }
      });
      pending = actual;
      void actual.catch(() => {});
      return actual;
    },
    async return() {
      active = false;
      await pending?.catch(() => {});
      return { done: true, value: undefined };
    },
  };
  const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() {
    if (!active || entered) unsafeArchive('entry body is single-use and callback-scoped.');
    entered = true;
    return iterator;
  } };
  let callbackFailure: { readonly error: unknown } | undefined;
  try { await consume(Object.freeze({ path, kind: header.kind, size: header.size, mode: header.mode, body })); }
  catch (error) { callbackFailure = { error }; }
  const enteredPull = pending;
  active = false;
  await enteredPull?.catch(() => {});
  if (callbackFailure) {
    if (failure?.origin === 'source' && failure.error !== callbackFailure.error) {
      throw new AggregateError([callbackFailure.error, failure.error], 'Archive callback and entered source pull both failed.');
    }
    throw callbackFailure.error;
  }
  if (failure) throw failure.error;
  if (enteredPull) unsafeArchive('entry callback returned with an active body pull.');
  if (remaining !== 0) unsafeArchive('entry callback must drain its complete body.');
}
