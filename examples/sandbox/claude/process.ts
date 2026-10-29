// ------------------------------------------------------------------------------------------------
//                process.ts - Synchronous .273 facade over one asynchronous sandbox process
// ------------------------------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { Sandbox, SandboxProcessStreams } from '@agen-ai/sandbox';
import { reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import { ClaudeInput } from './input.js';
import type { ClaudeProcessSettlement, ClaudeSavedCredential } from './types.js';

export function createClaudeProcess(sandbox: Sandbox, options: SpawnOptions,
  file?: Readonly<{ credential: ClaudeSavedCredential; bytes: Uint8Array }>) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) environment[key] = value;
  const process = { executable: options.command, args: options.args, cwd: options.cwd ?? sandbox.workspace, env: environment };
  const reservation = file === undefined ? sandbox.reserveProcess(process) : reserveSandboxCredentialProcess(sandbox, {
    bootstrapExecutable: file.credential.bootstrapExecutable, preparationTimeoutMs: file.credential.preparationTimeoutMs,
    file: { name: '.credentials.json', bytes: file.bytes }, process,
  });
  const events = new EventEmitter();
  const output = new PassThrough({ highWaterMark: 16 * 1024 });
  const ready = Promise.withResolvers<SandboxProcessStreams>();
  const diagnostics: Uint8Array[] = [];
  let diagnosticBytes = 0; let outputBytes = 0; let outputLines = 0;
  let failure: Error | undefined;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let killed = false; let terminal = false; let closing = false;
  let stopWork: Promise<void> | undefined;
  let cleanupWork: Promise<void> | undefined;

  const stop = () => {
    if (!stopWork) {
      const dispatched = reservation.stop();
      killed = true;
      stopWork = dispatched.catch((error: unknown) => { stopWork = undefined; throw error; });
    }
    return stopWork;
  };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    if (terminal) return;
    terminal = true;
    // Dispatch and retain physical cleanup before notifying consumer callbacks.
    void stop().catch(() => {});
    input.destroy(failure); output.destroy();
    const observed = failure;
    queueMicrotask(() => { events.emit('error', observed); });
  };
  const input = new ClaudeInput(ready.promise, fail);
  const rejectChunk = (error: Error): never => { fail(error); throw error; };
  input.on('error', fail); output.on('error', fail);
  output.on('close', () => { if (!closing && !terminal) fail(new Error('Claude stdout consumer closed before drainage.')); });
  input.on('close', () => { if (!closing && !terminal && !input.writableFinished) fail(new Error('Claude stdin consumer closed before EOF.')); });
  // The bridge owns the error even if a supplied SDK rejects before registering its listener.
  events.on('error', () => {});
  const child: SpawnedProcess = {
    stdin: input, stdout: output,
    get killed() { return killed; }, get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    kill(signal) {
      if (terminal || killed || (signal !== 'SIGTERM' && signal !== 'SIGKILL')) return false;
      void stop().catch(fail); return true;
    },
    on: (event, listener) => { events.on(event, listener); },
    once: (event, listener) => { events.once(event, listener); },
    off: (event, listener) => { events.off(event, listener); },
  };
  const abort = () => { child.kill('SIGTERM'); };
  options.signal.addEventListener('abort', abort, { once: true });
  const settled = Promise.resolve().then(async (): Promise<ClaudeProcessSettlement> => {
    try {
      if (options.signal.aborted) { abort(); options.signal.throwIfAborted(); }
      const streams = await reservation.start({ signal: options.signal }); ready.resolve(streams);
      const stdout = (async () => {
        for await (const chunk of streams.stdout) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > 64 * 1024) rejectChunk(new Error('Invalid Claude sandbox stdout chunk.'));
          outputBytes += chunk.byteLength;
          for (const byte of chunk) if (byte === 10) outputLines++;
          if (outputBytes > 8 * 1024 * 1024 || outputLines > 4096) rejectChunk(new Error('Claude sandbox stdout exceeded its byte or frame bound.'));
          await new Promise<void>((resolve, reject) => {
            const closed = () => { reject(new Error('Claude stdout consumer closed before drainage.')); };
            output.once('close', closed);
            output.write(chunk, (error) => {
              output.off('close', closed); if (error) reject(error); else resolve();
            });
          });
        }
      })();
      const stderr = (async () => {
        for await (const chunk of streams.stderr) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > 64 * 1024) rejectChunk(new Error('Invalid Claude sandbox stderr chunk.'));
          if (diagnosticBytes + chunk.byteLength > 1024 * 1024) rejectChunk(new Error('Claude sandbox stderr exceeded 1 MiB.'));
          diagnosticBytes += chunk.byteLength;
          diagnostics.push(Buffer.from(chunk));
        }
      })();
      const drained = Promise.allSettled([stdout, stderr]);
      void stdout.catch((error: unknown) => { if (!closing && !killed) fail(error); });
      void stderr.catch((error: unknown) => { if (!closing && !killed) fail(error); });
      const receipt = await streams.exit;
      if (receipt.kind === 'unavailable') fail(new Error('Claude sandbox exit receipt unavailable; no exit code or signal is inferred.'));
      const drains = await drained;
      for (const result of drains) if (result.status === 'rejected' && !closing && !killed) fail(result.reason);
      if (failure) return { kind: 'failed', error: failure, receipt };
      if (receipt.kind === 'exited') exitCode = receipt.code;
      else if (receipt.kind === 'signaled') {
        if (receipt.signal !== 'SIGTERM' && receipt.signal !== 'SIGKILL') throw new Error('Unmapped Claude native signal receipt.');
        signalCode = receipt.signal;
      }
      output.end();
      if (!terminal) { terminal = true; events.emit('exit', exitCode, signalCode); }
      return { kind: 'receipt', receipt };
    } catch (error) {
      ready.reject(error); fail(error); return { kind: 'failed', error: failure ?? new Error(String(error)) };
    } finally { options.signal.removeEventListener('abort', abort); }
  });
  void ready.promise.catch(() => {});
  const cleanup = () => {
    if (!cleanupWork) {
      closing = true; input.destroy(); output.destroy();
      cleanupWork = (async () => { await stop(); await settled; })().catch((error: unknown) => { cleanupWork = undefined; throw error; });
    }
    return cleanupWork;
  };
  return { child, settled, cleanup, get stderr(): Uint8Array { return Buffer.concat(diagnostics, diagnosticBytes); } };
}
