// ------------------------------------------------------------------------------------------------
//                spill.ts - Four explicit anonymous POSIX files - Acquisition and cleanup ownership
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SandboxDriverSpillFile, SandboxDriverSpillStore } from '../backend/spill.js';
import { SandboxStateError } from '../errors.js';
import { invalidInput } from '../internal/data.js';
import { parseOperationOptions } from '../internal/operations.js';
import { parseSandboxSpillDirectory, verifySandboxSpillDirectory } from './spillDirectory.js';
import { SpillFile } from './spillFile.js';

export interface SandboxSpillStoreOptions {
  readonly directory: string;
  readonly signal?: AbortSignal;
}

export class SandboxSpillCleanupError extends Error {
  constructor(readonly primaryError: unknown, readonly cleanupError: unknown, readonly owner: SandboxDriverSpillStore) {
    super('Spill acquisition failed and its exact cleanup remains owned.', { cause: primaryError });
    this.name = 'SandboxSpillCleanupError';
  }
  retryCleanup(): Promise<void> { return this.owner.close(); }
}

class SpillStore implements SandboxDriverSpillStore {
  private phase: 'open' | 'closing' | 'closed' = 'open';
  private readonly files = new Set<SpillFile>();
  private acquiring: Promise<SandboxDriverSpillFile> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly directory: string, private readonly signal: AbortSignal | undefined) {}

  createFile(): Promise<SandboxDriverSpillFile> {
    this.admit();
    if (this.acquiring || this.files.size === 4) return Promise.reject(new SandboxStateError('Spill store admits four files and one acquisition at a time.'));
    const path = join(this.directory, `agenai-metadata-${randomUUID()}`);
    const file = new SpillFile(() => this.admit(), () => this.files.delete(file));
    this.files.add(file);
    const actual = (async () => {
      try {
        file.attach(await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600), path);
        await file.unlink();
        this.admit();
        return file;
      } catch (primaryError) {
        try { await file.close(); }
        catch (cleanupError) { throw new SandboxSpillCleanupError(primaryError, cleanupError, this); }
        throw primaryError;
      }
    })().finally(() => { if (this.acquiring === actual) this.acquiring = undefined; });
    this.acquiring = actual;
    return actual;
  }

  close(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.closing = (async () => {
      await this.acquiring?.catch(() => {});
      const failures: unknown[] = [];
      for (const file of this.files) {
        try { await file.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Spill store retains unresolved file cleanup.');
      this.phase = 'closed';
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private admit(): void {
    if (this.phase !== 'open') throw new SandboxStateError('Spill store admission is closed.');
    this.signal?.throwIfAborted();
  }
}

export async function createSandboxSpillStore(input: SandboxSpillStoreOptions): Promise<SandboxDriverSpillStore> {
  if (!input || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Reflect.ownKeys(input).some((key) => key !== 'directory' && key !== 'signal')) invalidInput('Spill options require only an explicit directory and optional signal');
  const directory = Object.getOwnPropertyDescriptor(input, 'directory');
  const signal = Object.getOwnPropertyDescriptor(input, 'signal');
  if (!directory || !('value' in directory) || !directory.enumerable
    || (signal && (!('value' in signal) || !signal.enumerable))) invalidInput('Spill options require enumerable data properties');
  const root = parseSandboxSpillDirectory(directory.value);
  const options = parseOperationOptions(signal ? { signal: signal.value } : undefined);
  await verifySandboxSpillDirectory(root, options);
  return new SpillStore(root, options.signal);
}
