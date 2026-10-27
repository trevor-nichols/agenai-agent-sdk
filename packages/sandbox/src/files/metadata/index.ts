// ------------------------------------------------------------------------------------------------
//                index.ts - Incremental metadata ownership - Four spill files and one output reader
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import type { SandboxDriverSpillStore } from '../../backend/spill.js';
import { SandboxStateError, SandboxValidationError } from '../../errors.js';
import { compareRecords, decodeRecord, MAX_RECORD_BYTES, RECORD_HEADER_BYTES } from './records.js';
import { encodeRecord } from './records.js';
import type { EncodedRecord } from './records.js';
import { mergePass, validateRun } from './sort.js';
import type { SortState, SpillFiles } from './sort.js';
import { address, readOffset, readRecord, writeDescriptor, writeOffset, writeRecord } from './storage.js';
import { validateLink } from './links.js';
import type { SandboxRelativePath } from '../types.js';
import type { MetadataLedger, MetadataLedgerOptions, MetadataRecord } from './types.js';

export type { MetadataLedger, MetadataLedgerOptions, MetadataRecord } from './types.js';
export { MetadataConflictError } from './errors.js';

export class MetadataCleanupError extends Error {
  constructor(readonly primaryError: unknown, readonly cleanupError: unknown, private readonly owner: MetadataLedger) {
    super('Metadata spill cleanup remains owned.', { cause: primaryError });
    this.name = 'MetadataCleanupError';
  }
  retryCleanup(): Promise<void> { return this.owner.close(); }
}

class Ledger implements MetadataLedger {
  private phase: 'open' | 'finishing' | 'sealed' | 'failed' | 'closing' | 'closed' = 'open';
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly acquiring: Promise<void>;
  private store: SandboxDriverSpillStore | undefined;
  private files: SpillFiles | undefined;
  private active: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private batch: EncodedRecord[] = [];
  private batchSize = 0;
  private state: SortState = { runs: 0, end: 0, descriptorEnd: 0 };
  private reader: object | undefined;
  private recordCount = 0;

  constructor(private readonly options: MetadataLedgerOptions) {
    this.signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal;
    this.acquiring = this.acquire();
  }

  private async acquire(): Promise<void> {
    this.signal.throwIfAborted();
    const store = await this.options.openSpill();
    this.store = store;
    this.signal.throwIfAborted();
    const first = await store.createFile();
    this.signal.throwIfAborted();
    const second = await store.createFile();
    this.signal.throwIfAborted();
    const third = await store.createFile();
    this.signal.throwIfAborted();
    const fourth = await store.createFile();
    this.signal.throwIfAborted();
    this.files = { data: [first, second], descriptors: [third, fourth] };
  }

  async initialized(): Promise<void> { await this.acquiring; }

  append(record: MetadataRecord): Promise<void> {
    if (this.phase !== 'open' || this.active) return Promise.reject(new SandboxStateError('Metadata append requires an idle open ledger.'));
    const captured = encodeRecord(record);
    return this.enter(async () => {
      const size = RECORD_HEADER_BYTES + captured.key.length + captured.target.length;
      if (this.batchSize + size > this.options.batchBytes) await this.flush();
      this.signal.throwIfAborted();
      this.batch.push(captured);
      this.batchSize += size;
    });
  }

  finish(): Promise<void> {
    if (this.phase !== 'open' || this.active) return Promise.reject(new SandboxStateError('Metadata sealing requires an idle open ledger.'));
    this.phase = 'finishing';
    return this.enter(async () => {
      await this.flush();
      const files = this.readyFiles();
      while (this.state.runs > 1) this.state = await mergePass(files, this.state, this.options.fanIn, this.signal);
      await validateRun(files.data[0], this.state.end, this.signal);
      await this.index();
      this.signal.throwIfAborted();
      this.phase = 'sealed';
    });
  }

  records(): AsyncIterable<MetadataRecord> {
    if (this.phase !== 'sealed' || this.active || this.reader) throw new SandboxStateError('Metadata records require a sealed ledger and one exclusive reader.');
    const identity = {};
    this.reader = identity;
    const cursor = { position: 0, end: this.state.end };
    let returned = false;
    let iterated = false;
    let pending: Promise<IteratorResult<MetadataRecord>> | undefined;
    const release = () => { if (this.reader === identity) this.reader = undefined; };
    const iterator: AsyncIterableIterator<MetadataRecord> = {
      [Symbol.asyncIterator]() {
        if (iterated) throw new SandboxStateError('Metadata records admit one iterator.');
        iterated = true;
        return iterator;
      },
      next: () => {
        if (returned) return Promise.resolve<IteratorResult<MetadataRecord>>({ done: true, value: undefined });
        if (this.phase !== 'sealed' || this.active) return Promise.reject(new SandboxStateError('Metadata reads require an idle sealed ledger.'));
        pending = this.enter<IteratorResult<MetadataRecord>>(async () => {
          const record = await readRecord(this.readyFiles().data[0], cursor);
          this.signal.throwIfAborted();
          if (!record) { returned = true; release(); return { done: true, value: undefined }; }
          return { done: false, value: decodeRecord(record) };
        });
        return pending;
      },
      return: async () => {
        returned = true;
        await pending?.catch(() => {});
        release();
        return { done: true, value: undefined };
      },
    };
    return iterator;
  }

  get(path: SandboxRelativePath): Promise<MetadataRecord | undefined> {
    if (this.phase !== 'sealed' || this.active) return Promise.reject(new SandboxStateError('Metadata lookup requires an idle sealed ledger.'));
    return this.enter(() => this.lookup(path));
  }

  validateSymlinks(options: Readonly<{ root?: SandboxRelativePath }> = {}): Promise<void> {
    if (this.phase !== 'sealed' || this.active || this.reader) return Promise.reject(new SandboxStateError('Link validation requires a sealed ledger without a replay owner.'));
    const root = options.root;
    return this.enter(async () => {
      const cursor = { position: 0, end: this.state.end };
      for (;;) {
        this.signal.throwIfAborted();
        const encoded = await readRecord(this.readyFiles().data[0], cursor);
        if (!encoded) return;
        const record = decodeRecord(encoded);
        if (root !== undefined && (record.path === root ? record.kind !== 'directory' : !record.path.startsWith(`${root}/`))) {
          throw new SandboxValidationError([{ code: 'invalid_input', path: ['path'], message: 'Metadata lies outside its selected publication directory.' }]);
        }
        if (record.kind === 'symlink') await validateLink(record, (path) => this.lookup(path), root, this.signal);
      }
    });
  }

  private async lookup(path: SandboxRelativePath): Promise<MetadataRecord | undefined> {
    const key = encodeRecord({ kind: 'directory', path }).key;
    let low = 0; let high = this.recordCount - 1;
    const files = this.readyFiles();
    while (low <= high) {
      this.signal.throwIfAborted();
      const ordinal = low + Math.floor((high - low) / 2);
      const position = await readOffset(files.data[1], ordinal);
      const record = await readRecord(files.data[0], { position, end: this.state.end });
      if (!record) throw new Error('Metadata index did not point at a record.');
      const comparison = Buffer.compare(record.key, key);
      if (comparison === 0) return decodeRecord(record);
      if (comparison < 0) low = ordinal + 1; else high = ordinal - 1;
    }
    return undefined;
  }

  private async index(): Promise<void> {
    const files = this.readyFiles();
    await files.data[1].truncate(0);
    const cursor = { position: 0, end: this.state.end };
    let ordinal = 0;
    for (;;) {
      this.signal.throwIfAborted();
      const position = cursor.position;
      if (!await readRecord(files.data[0], cursor)) break;
      await writeOffset(files.data[1], ordinal, position);
      ordinal = address(ordinal + 1);
    }
    this.recordCount = ordinal;
  }

  close(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.controller.abort(new SandboxStateError('Metadata ledger is closing.'));
    this.closing = (async () => {
      await this.acquiring.catch(() => {});
      await this.active?.catch(() => {});
      this.batch = [];
      this.batchSize = 0;
      await this.store?.close();
      this.phase = 'closed';
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private enter<T>(perform: () => Promise<T>): Promise<T> {
    const actual = Promise.resolve().then(() => { this.signal.throwIfAborted(); return perform(); }).catch((error: unknown) => {
      if (this.phase !== 'closing' && this.phase !== 'closed') this.phase = 'failed';
      throw error;
    }).finally(() => { if (this.active === actual) this.active = undefined; });
    this.active = actual;
    return actual;
  }

  private async flush(): Promise<void> {
    if (!this.batch.length) return;
    const files = this.readyFiles();
    this.batch.sort(compareRecords);
    let end = this.state.end;
    for (const record of this.batch) {
      this.signal.throwIfAborted();
      end = await writeRecord(files.data[0], record, end);
    }
    const descriptorEnd = await writeDescriptor(files.descriptors[0], this.state.descriptorEnd, this.state.end, end);
    this.state = { runs: address(this.state.runs + 1), end, descriptorEnd };
    this.batch = [];
    this.batchSize = 0;
  }

  private readyFiles(): SpillFiles {
    if (!this.files) throw new SandboxStateError('Metadata spill acquisition has not settled.');
    return this.files;
  }
}

export async function createMetadataLedger(options: MetadataLedgerOptions): Promise<MetadataLedger> {
  if (!Number.isSafeInteger(options.batchBytes) || options.batchBytes < MAX_RECORD_BYTES || options.batchBytes > 4 * 1024 * 1024) {
    throw new RangeError(`Metadata batch working set must be between ${MAX_RECORD_BYTES} bytes and 4 MiB.`);
  }
  if (!Number.isSafeInteger(options.fanIn) || options.fanIn < 2 || options.fanIn > 32) throw new RangeError('Metadata merge fan-in must be between 2 and 32.');
  const ledger = new Ledger(options);
  try { await ledger.initialized(); return ledger; }
  catch (primaryError) {
    try { await ledger.close(); } catch (cleanupError) { throw new MetadataCleanupError(primaryError, cleanupError, ledger); }
    throw primaryError;
  }
}
