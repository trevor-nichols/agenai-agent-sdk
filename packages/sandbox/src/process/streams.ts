// ------------------------------------------------------------------------------------------------
//                streams.ts - Owned process stream pumps - Node streams and byte limits
// ------------------------------------------------------------------------------------------------

import { Readable, Writable } from 'node:stream';
import { SandboxOperationError } from '../errors.js';
import type { SandboxStreamLimits } from '../policy/types.js';
import type { SandboxProcessStreams } from './types.js';
import { parseSandboxProcessExit } from './parse.js';
import { SandboxInput } from './input.js';
import { SandboxOutput } from './output.js';

export interface OwnedProcessStreams {
  readonly streams: SandboxProcessStreams;
  readonly settled: Promise<void>;
  close(error?: Error): void;
}

export function ownProcessStreams(raw: SandboxProcessStreams, limits: SandboxStreamLimits,
  onFailure: (error: Error) => void): OwnedProcessStreams {
  if (!(raw.stdin instanceof Writable) || !(raw.stdout instanceof Readable) || !(raw.stderr instanceof Readable)
    || raw.stdin.writableObjectMode || raw.stdout.readableObjectMode || raw.stderr.readableObjectMode
    || raw.stdout.readableEncoding !== null || raw.stderr.readableEncoding !== null) {
    throw new SandboxOperationError('stream_failure', 'The backend must supply distinct binary Node stdin, stdout and stderr streams.');
  }
  if (Object.is(raw.stdout, raw.stderr) || Object.is(raw.stdin, raw.stdout) || Object.is(raw.stdin, raw.stderr)) {
    throw new SandboxOperationError('stream_failure', 'Sandbox standard streams must remain separate.');
  }
  let outputBytes = 0n;
  let closed = false;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    if (closed || failure) return;
    failure = error;
    close(error);
    onFailure(error);
  };
  const stdin = new SandboxInput(raw.stdin, limits.maxStdinBytes, limits.maxBufferedInputBytes, limits.highWaterMarkBytes, fail);
  const stdout = new SandboxOutput(limits.highWaterMarkBytes, fail);
  const stderr = new SandboxOutput(limits.highWaterMarkBytes, fail);
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    stdin.close(error);
    stdout.close(error);
    stderr.close(error);
    raw.stdout.destroy(error);
    raw.stderr.destroy(error);
  };
  const pump = async (source: Readable, target: SandboxOutput) => {
    try {
      for await (const chunk of source) {
        if (closed) return;
        if (!(chunk instanceof Uint8Array)) throw new SandboxOperationError('stream_failure', 'Backend output contained a non-binary chunk.');
        if (limits.maxOutputBytes !== undefined && outputBytes + BigInt(chunk.byteLength) > BigInt(limits.maxOutputBytes)) {
          throw new SandboxOperationError('output_limit', 'Sandbox output exceeded its caller-selected combined lifetime byte limit.');
        }
        if (chunk.byteLength + stdout.readableLength + stderr.readableLength > limits.maxBufferedOutputBytes) {
          throw new SandboxOperationError('output_limit', 'Sandbox output exceeded its aggregate buffered byte limit.');
        }
        outputBytes += BigInt(chunk.byteLength);
        await target.deliver(chunk);
      }
      if (!closed) target.finish();
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error : new SandboxOperationError('stream_failure', 'Sandbox output failed.', { cause: error }));
    }
  };
  const pumps = Promise.all([pump(raw.stdout, stdout), pump(raw.stderr, stderr)]).then(() => undefined);
  const exit = Promise.resolve(raw.exit).then(parseSandboxProcessExit);
  void exit.catch((error: unknown) => fail(error instanceof Error ? error : new SandboxOperationError('driver_failure', 'Sandbox leader exit failed.', { cause: error })));
  const settled = Promise.all([pumps, stdin.settled, exit.then(() => undefined, () => undefined)]).then(() => undefined);
  return Object.freeze({ streams: Object.freeze({ stdin, stdout, stderr, exit }), settled, close });
}
