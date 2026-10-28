// ------------------------------------------------------------------------------------------------
//                process.ts - Owned credential prefix - One original process and cleanup owner
// ------------------------------------------------------------------------------------------------

import type { Writable } from 'node:stream';
import type { OperationOptions, Sandbox } from '../../contracts.js';
import { SandboxCleanupError, SandboxOperationError, SandboxStateError } from '../../errors.js';
import { parseOperationOptions } from '../../internal/operations.js';
import { actualOperation, observe, settled } from '../../lifecycle/observation.js';
import { parseSandboxProcessSpec } from '../../process/parse.js';
import type { SandboxProcessReservation, SandboxProcessStreams } from '../../process/types.js';
import type { SandboxCleanupOwner } from '../../recovery/types.js';
import { readCredentialMarker } from './markers.js';
import { SANDBOX_CREDENTIAL_HEADER_BYTES, SANDBOX_CREDENTIAL_HELLO, SANDBOX_CREDENTIAL_MAGIC,
  SANDBOX_CREDENTIAL_MAX_BYTES, SANDBOX_CREDENTIAL_MAX_NAME_BYTES, SANDBOX_CREDENTIAL_PREPARED } from './protocol.js';
import type { SandboxCredentialProcessInput } from './types.js';

/** Reserve the existing process owner; preparation never grants a second execution or retry. */
export function reserveSandboxCredentialProcess(sandbox: Sandbox, input: SandboxCredentialProcessInput): SandboxProcessReservation {
  const fields = dataFields(input, ['bootstrapExecutable', 'process', 'file', 'preparationTimeoutMs']);
  const file = dataFields(fields.file, ['name', 'bytes']);
  if (typeof file.name !== 'string' || file.name.length > SANDBOX_CREDENTIAL_MAX_NAME_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file.name)) invalid('file.name');
  if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1 || file.bytes.byteLength > SANDBOX_CREDENTIAL_MAX_BYTES) invalid('file.bytes');
  if (!Number.isInteger(fields.preparationTimeoutMs) || typeof fields.preparationTimeoutMs !== 'number'
    || fields.preparationTimeoutMs < 1 || fields.preparationTimeoutMs > 60_000) invalid('preparationTimeoutMs');
  const timeoutMs = fields.preparationTimeoutMs;
  const native = parseSandboxProcessSpec(fields.process);
  const spec = parseSandboxProcessSpec({ executable: fields.bootstrapExecutable,
    args: [native.executable, ...native.args], env: native.env, cwd: native.cwd });
  const frame = Buffer.alloc(SANDBOX_CREDENTIAL_HEADER_BYTES + file.name.length + file.bytes.byteLength);
  try {
    frame.write(SANDBOX_CREDENTIAL_MAGIC, 0, 'ascii');
    frame.writeUInt16BE(file.name.length, 4);
    frame.writeUInt32BE(file.bytes.byteLength, 8);
    frame.write(file.name, SANDBOX_CREDENTIAL_HEADER_BYTES, 'ascii');
    frame.set(file.bytes, SANDBOX_CREDENTIAL_HEADER_BYTES + file.name.length);
  } catch { frame.fill(0); invalid('file.bytes'); }

  let reservation: SandboxProcessReservation;
  try { reservation = sandbox.reserveProcess(spec); }
  catch (error) { frame.fill(0); throw error; }
  let state: 'reserved' | 'started' | 'closed' = 'reserved';
  let actual: Promise<SandboxProcessStreams> | undefined;
  let controller: AbortController | undefined;
  const cleanup = async (operation: 'stop' | 'destroy'): Promise<void> => {
    state = 'closed';
    controller?.abort(interrupted());
    if (!actual) frame.fill(0);
    try { await sandbox[operation](); }
    catch {
      // The facade retains the original physical owner and the still-entered prefix work.
      throw new SandboxCleanupError('Sandbox credential preparation cleanup did not settle successfully.', {
        cause: new SandboxOperationError('driver_failure', 'Sandbox credential preparation cleanup failed.'),
        owner: cleanupOwner, operation,
      });
    }
    await settled(actual);
    frame.fill(0);
  };
  const cleanupOwner: SandboxCleanupOwner = Object.freeze({
    get recoveryRecord() { return sandbox.recoveryRecord; },
    stop: () => cleanup('stop'), destroy: () => cleanup('destroy'),
  });
  return Object.freeze({ id: reservation.id, stopScope: reservation.stopScope,
    start(options?: OperationOptions): Promise<SandboxProcessStreams> {
      const parsed = parseOperationOptions(options);
      if (state !== 'reserved') return Promise.reject(new SandboxStateError('Credential process startup is once-only and cannot follow cleanup.'));
      state = 'started';
      controller = new AbortController();
      const preparationController = controller;
      const signal = preparationController.signal;
      const abort = () => preparationController.abort(interrupted());
      parsed.signal?.addEventListener('abort', abort, { once: true });
      if (parsed.signal?.aborted) abort();
      actual = actualOperation(async () => {
        signal.throwIfAborted();
        const streams = await reservation.start({ signal });
        signal.throwIfAborted();
        await readCredentialMarker(streams.stdout, SANDBOX_CREDENTIAL_HELLO, signal);
        for (let offset = 0; offset < frame.byteLength;) {
          signal.throwIfAborted();
          const length = Math.min(frame.byteLength - offset, streams.stdin.writableHighWaterMark, 65_536);
          if (length < 1) throw new SandboxOperationError('stream_failure', 'Sandbox credential preparation requires bounded writable input.');
          await writePrefix(streams.stdin, frame.subarray(offset, offset + length));
          offset += length;
        }
        // Every entered write has acknowledged before this private buffer is released.
        signal.throwIfAborted();
        frame.fill(0);
        await readCredentialMarker(streams.stdout, SANDBOX_CREDENTIAL_PREPARED, signal);
        signal.throwIfAborted();
        return streams;
      });
      return observe(actual, timeoutMs, { signal,
        onInterrupt: (error) => preparationController.abort(new SandboxOperationError(
          error.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled', 'Sandbox credential preparation was interrupted.')),
      }).finally(() => parsed.signal?.removeEventListener('abort', abort)).catch(async (error: unknown) => {
        const failure = preparationFailure(error);
        await cleanupOwner.stop();
        throw failure;
      });
    },
    stop: cleanupOwner.stop,
  });
}

function writePrefix(input: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try { input.write(bytes, (error) => error ? reject(preparationFailure(error)) : resolve()); }
    catch { reject(new SandboxOperationError('stream_failure', 'Sandbox credential preparation input failed.')); }
  });
}

function interrupted(): SandboxOperationError {
  return new SandboxOperationError('cancelled', 'Sandbox credential preparation was interrupted.');
}

function preparationFailure(error: unknown): SandboxOperationError {
  return new SandboxOperationError(error instanceof SandboxOperationError ? error.code : 'stream_failure',
    'Sandbox credential preparation did not complete successfully.');
}

function invalid(field: string): never { throw new TypeError(`Invalid sandbox credential process ${field}.`); }

function dataFields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object'
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Reflect.ownKeys(input).length !== keys.length) invalid('fields');
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid(key);
    fields[key] = descriptor.value;
  }
  return fields;
}
