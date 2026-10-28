import type { Readable, Writable } from 'node:stream';
import { SandboxCleanupError } from '@agen-ai/sandbox';
import type { SandboxProcessExit, SandboxProcessReservation } from '@agen-ai/sandbox';
import { captureSandboxRecipeFields, parseSandboxCliPrompt } from './input.js';

export interface SandboxCliRunInput {
  readonly stdin: 'none' | Readonly<{ kind: 'utf8'; text: string }>;
  readonly signal?: AbortSignal;
}

export interface SandboxCliResult {
  /** This is the original leader receipt, independent of whole-sandbox quiescence. */
  readonly receipt: SandboxProcessExit;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export type SandboxCliFailureCode = 'cancelled' | 'process_failed' | 'output_limit' | 'cleanup_failed';

export class SandboxCliRunError extends Error {
  constructor(readonly code: SandboxCliFailureCode, readonly receipt: SandboxProcessExit | undefined,
    private readonly cleanup: () => Promise<void>, readonly cleanupFailure?: unknown) {
    super('The sandbox CLI run did not complete successfully; no native diagnostics are retained.');
    this.name = 'SandboxCliRunError';
    // Retain original cleanup ownership without making backend errors part of JSON reports.
    Object.defineProperty(this, 'cleanup', { enumerable: false });
    Object.defineProperty(this, 'cleanupFailure', { enumerable: false });
  }

  retryCleanup(): Promise<void> { return this.cleanup(); }
}

/** Consume one native CLI invocation. Native output is discarded, never interpreted as authentication. */
export async function runSandboxCli(reservation: SandboxProcessReservation, input: SandboxCliRunInput): Promise<SandboxCliResult> {
  const fields = captureSandboxRecipeFields(input, ['stdin'], ['signal']);
  let text: string | undefined;
  if (fields.stdin !== 'none') {
    const stdin = captureSandboxRecipeFields(fields.stdin, ['kind', 'text']);
    if (stdin.kind !== 'utf8') throw new TypeError('Unsupported sandbox CLI stdin selection.');
    text = parseSandboxCliPrompt(stdin.text);
  }
  if (fields.signal !== undefined && !(fields.signal instanceof AbortSignal)) throw new TypeError('Invalid sandbox CLI cancellation signal.');
  const signal = fields.signal;
  let receipt: SandboxProcessExit | undefined;
  let stdoutBytes = 0; let stderrBytes = 0;
  let failure: SandboxCliFailureCode | undefined;
  let work: Promise<unknown>[] = [];
  let stopWork: Promise<void> | undefined;
  const cleanupFailed = Promise.withResolvers<void>();
  const stop = () => {
    stopWork ??= reservation.stop();
    // A failed physical cleanup is retryable only through the same reservation.
    void stopWork.catch(() => { cleanupFailed.resolve(); });
    return stopWork;
  };
  const cleanup = async () => {
    if (stopWork) {
      try { await stopWork; } catch { stopWork = undefined; }
    }
    await stop();
    await Promise.allSettled(work);
  };
  const fail = (code: SandboxCliFailureCode) => { failure ??= code; void stop(); };
  const abort = () => fail('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  const drain = async (source: Readable, stream: 'stdout' | 'stderr') => {
    let bytes = 0; let lines = 0;
    const limit = stream === 'stdout' ? 8 * 1024 * 1024 : 1024 * 1024;
    try {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) { fail('process_failed'); return; }
        bytes += chunk.byteLength;
        if (stream === 'stdout') stdoutBytes = bytes; else stderrBytes = bytes;
        if (stream === 'stdout') for (const byte of chunk) if (byte === 10) lines++;
        if (bytes > limit || lines > 4096) { fail('output_limit'); return; }
      }
    } catch { if (!stopWork) fail('process_failed'); }
  };
  try {
    if (signal?.aborted) { fail('cancelled'); throw new Error('Cancelled.'); }
    const streams = await reservation.start(signal === undefined ? undefined : { signal });
    work = [drain(streams.stdout, 'stdout'), drain(streams.stderr, 'stderr')];
    if (signal?.aborted) abort();
    const writing = finishInput(streams.stdin, text).catch(() => { if (!stopWork) fail('process_failed'); });
    work.push(writing);
    const leader = streams.exit.then((observed) => { receipt = observed; });
    work.push(leader);
    // Failed stop cannot wait forever for a leader whose original owner is still live.
    await Promise.race([leader, cleanupFailed.promise]);
    if (receipt?.kind === 'unavailable') failure ??= signal?.aborted ? 'cancelled' : 'process_failed';
  } catch (error) {
    failure ??= signal?.aborted ? 'cancelled' : 'process_failed';
    if (error instanceof SandboxCleanupError) {
      // Credential preparation may already have attempted and failed original-owner cleanup.
      stopWork = Promise.reject(error); void stopWork.catch(() => {});
    }
  }
  finally { signal?.removeEventListener('abort', abort); }

  // A leader exit cannot establish descendant quiescence. Stop before returning or exporting.
  try { await stop(); }
  catch (cleanupFailure) { throw new SandboxCliRunError(failure ?? 'cleanup_failed', receipt, cleanup, cleanupFailure); }
  await Promise.allSettled(work);
  if (failure || receipt === undefined) throw new SandboxCliRunError(failure ?? 'process_failed', receipt, cleanup);
  return Object.freeze({ receipt, stdoutBytes, stderrBytes });
}

function finishInput(stdin: Writable, text: string | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = () => { reject(new Error('Sandbox CLI input failed.')); };
    stdin.once('error', failed);
    const done = (error?: Error | null) => { stdin.off('error', failed); if (error) failed(); else resolve(); };
    try { if (text === undefined) stdin.end(done); else stdin.end(Buffer.from(text, 'utf8'), done); }
    catch { stdin.off('error', failed); failed(); }
  });
}
