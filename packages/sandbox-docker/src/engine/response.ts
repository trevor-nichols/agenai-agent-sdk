// ------------------------------------------------------------------------------------------------
//                response.ts - Callback-scoped HTTP byte reader - Bounded pulls and actual retirement
// ------------------------------------------------------------------------------------------------

import type { IncomingMessage } from 'node:http';
import { DockerEngineTransportError } from './contracts.js';

function invalid(message: string) { return new DockerEngineTransportError('invalid_response', message); }

async function waitReadable(response: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('readable', ready);
      response.removeListener('end', ready);
      response.removeListener('error', failed);
      response.removeListener('close', closed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); response.readableEnded ? resolve() : reject(invalid('Engine response closed before EOF.')); };
    response.once('readable', ready);
    response.once('end', ready);
    response.once('error', failed);
    response.once('close', closed);
    if (response.readableEnded || response.readableLength) ready();
    else if (response.destroyed) closed();
  });
}

export class DockerResponseBody {
  private active = true;
  private entered = false;
  private drained = false;
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;
  private failure: { readonly error: unknown } | undefined;
  bytes = 0n;

  constructor(private readonly response: IncomingMessage, private readonly chunkBytes: number,
    private readonly signal: AbortSignal, private readonly interrupt: (error: unknown) => void) {}

  readonly body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => {
    if (!this.active || this.entered) throw invalid('Engine response body is single-use and callback-scoped.');
    this.entered = true;
    return { next: () => this.next(), return: async () => {
      this.active = false;
      if (!this.drained) this.interrupt(invalid('Engine response body was abandoned.'));
      await this.pending?.catch(() => {});
      return { done: true, value: undefined };
    } };
  } };

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (!this.active || this.pending) {
      const error = invalid(this.pending ? 'Concurrent Engine response pulls are forbidden.' : 'Engine response body is retired.');
      this.failure ??= { error };
      const rejected = Promise.reject<IteratorResult<Uint8Array>>(error);
      void rejected.catch(() => {});
      return rejected;
    }
    const actual = Promise.resolve().then(async (): Promise<IteratorResult<Uint8Array>> => {
      try {
        for (;;) {
          this.signal.throwIfAborted();
          const available = this.response.readableLength;
          const chunk: unknown = this.response.read(available ? Math.min(this.chunkBytes, available) : this.chunkBytes);
          if (!this.active) throw invalid('Engine callback returned with an active body pull.');
          if (chunk !== null) {
            if (!(chunk instanceof Uint8Array) || chunk.length > this.chunkBytes) throw invalid('Engine response chunks exceed the selected byte buffer.');
            this.bytes += BigInt(chunk.length);
            return { done: false, value: chunk };
          }
          if (this.response.readableEnded) {
            if (!this.response.complete) throw invalid('Engine response HTTP framing is incomplete.');
            this.drained = true;
            return { done: true, value: undefined };
          }
          await waitReadable(this.response);
        }
      } catch (error) { this.failure ??= { error }; throw error; }
      finally { this.pending = undefined; }
    });
    this.pending = actual;
    void actual.catch(() => {});
    return actual;
  }

  async retire(): Promise<void> {
    const entered = this.pending;
    this.active = false;
    if (!this.drained || entered) this.interrupt(this.failure ? this.failure.error : invalid('Engine response callback must drain and join its body.'));
    await entered?.catch(() => {});
    if (this.failure) throw this.failure.error;
    if (!this.drained || entered) throw invalid('Engine response callback did not drain and join its body.');
  }
}
