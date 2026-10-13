// ------------------------------------------------------------------------------------------------
//                diagnostics.ts - Bounded redacted ACP stderr capture - Dependencies: streams
// ------------------------------------------------------------------------------------------------

import type { Readable } from 'node:stream';

const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*[^\s,;]+/giu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu;

function redactDiagnostic(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?');
}

export interface AcpStderrDiagnostics {
  readonly snapshot: () => readonly string[];
  readonly dispose: () => void;
}

export function captureAcpStderr(
  stderr: Readable | undefined,
  maxBytes: number,
): AcpStderrDiagnostics {
  if (!stderr) return Object.freeze({ snapshot: () => [], dispose: () => undefined });

  let retained = '';
  const onData = (chunk: Buffer | Uint8Array | string) => {
    retained += Buffer.from(chunk).toString('utf8');
    const retainedBuffer = Buffer.from(retained, 'utf8');
    if (retainedBuffer.byteLength > maxBytes) {
      retained = retainedBuffer.subarray(retainedBuffer.byteLength - maxBytes).toString('utf8');
    }
  };
  stderr.on('data', onData);

  return Object.freeze({
    snapshot: () => Object.freeze(
      redactDiagnostic(retained)
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .slice(-128),
    ),
    dispose: () => {
      stderr.off('data', onData);
      retained = '';
    },
  });
}
