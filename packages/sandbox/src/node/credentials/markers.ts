// ------------------------------------------------------------------------------------------------
//                markers.ts - Exact credential control reads - Preserve subsequent native output
// ------------------------------------------------------------------------------------------------

import type { Readable } from 'node:stream';
import { SandboxOperationError } from '../../errors.js';

/** Consume only this marker, including when native output arrives in the same chunk. */
export function readCredentialMarker(output: Readable, marker: string, signal: AbortSignal): Promise<void> {
  const expected = Buffer.from(marker, 'ascii');
  return new Promise<void>((resolve, reject) => {
    let offset = 0;
    let complete = false;
    const finish = (error?: SandboxOperationError) => {
      if (complete) return;
      complete = true;
      output.removeListener('readable', read);
      output.removeListener('end', failed);
      output.removeListener('close', failed);
      output.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const failed = (error?: unknown) => finish(new SandboxOperationError(error instanceof SandboxOperationError ? error.code : 'stream_failure',
      'Sandbox credential preparation did not receive its expected control marker.'));
    const aborted = () => finish(new SandboxOperationError('cancelled', 'Sandbox credential preparation was interrupted.'));
    const read = () => {
      if (complete) return;
      try {
        while (offset < expected.byteLength) {
          const chunk: unknown = output.read(Math.min(expected.byteLength - offset, output.readableLength || 1));
          if (chunk === null) break;
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > expected.byteLength - offset) { failed(); return; }
          for (const byte of chunk) {
            if (byte !== expected[offset]) { failed(); return; }
            offset += 1;
          }
        }
        if (offset === expected.byteLength) finish();
        else if (output.destroyed || output.readableEnded) failed(output.errored);
      } catch { failed(); }
    };
    output.on('readable', read);
    output.once('end', failed);
    output.once('close', failed);
    output.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else read();
  });
}
