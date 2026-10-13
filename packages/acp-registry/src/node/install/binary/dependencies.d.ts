// @openpgp/unbzip2-stream 2.1.0 ships JavaScript without declarations.
declare module '@openpgp/unbzip2-stream' {
  import type { ReadableStream, ReadableStreamReadResult } from 'node:stream/web';
  interface BzipInput {
    getReader(): {
      read(): Promise<ReadableStreamReadResult<Uint8Array>>;
      abort(reason?: unknown): Promise<void>;
    };
  }
  export default function unbzip2Stream(input: BzipInput, maxDecompressedBytes: number): ReadableStream<Uint8Array>;
}
