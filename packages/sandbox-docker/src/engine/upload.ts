// ------------------------------------------------------------------------------------------------
//                upload.ts - One backpressured request producer - Exact entered iterator cleanup
// ------------------------------------------------------------------------------------------------

import type { ClientRequest } from 'node:http';
import type { DockerEngineStreamOptions } from './contracts.js';
import { DockerEngineTransportError } from './contracts.js';

export async function upload(request: ClientRequest, input: DockerEngineStreamOptions['body'], signal: AbortSignal,
  chunkBytes: number): Promise<bigint> {
  let bytes = 0n;
  if (input !== undefined) {
    const source = typeof input === 'function' ? input(signal) : input;
    const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    let done = false;
    let primary: { readonly error: unknown } | undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        const item = await iterator.next();
        signal.throwIfAborted();
        if (item.done) { done = true; break; }
        const chunk = item.value;
        if (!(chunk instanceof Uint8Array) || chunk.length > chunkBytes) throw new DockerEngineTransportError('invalid_response', 'Engine upload chunks exceed the selected byte buffer.');
        if (chunk.length === 0) continue;
        await new Promise<void>((resolve, reject) => { request.write(chunk, (error) => error ? reject(error) : resolve()); });
        bytes += BigInt(chunk.length);
      }
    } catch (error) { primary = { error }; }
    finally {
      if (!done) {
        try { await iterator.return?.(); }
        catch (error) {
          if (primary) throw new AggregateError([primary.error, error], 'Engine upload and producer cleanup both failed.');
          throw error;
        }
      }
    }
    if (primary) throw primary.error;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => { request.end((error?: Error | null) => error ? reject(error) : resolve()); });
  return bytes;
}
