// ------------------------------------------------------------------------------------------------
//                index.ts - Incremental metadata ownership - Four spill files and one output reader
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverSpillStore } from '../../backend/spill.js';
import { SandboxStateError } from '../../errors.js';
import { compareRecords, decodeRecord, MAX_RECORD_BYTES, RECORD_HEADER_BYTES } from './records.js';
import { encodeRecord } from './records.js';
import type { EncodedRecord } from './records.js';
import { mergePass, validateRun } from './sort.js';
import type { SortState, SpillFiles } from './sort.js';
import { address, readRecord, writeDescriptor, writeRecord } from './storage.js';
import type { MetadataLedger, MetadataLedgerOptions, MetadataRecord } from './types.js';

export type { MetadataLedger, MetadataLedgerOptions, MetadataRecord } from './types.js';
export { MetadataConflictError } from './records.js';

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
      const size = RECORD_HEADER_BYTES + captured.key.length;
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
    throw new RangeError('Metadata batch working set must be between 1029 bytes and 4 MiB.');
  }
  if (!Number.isSafeInteger(options.fanIn) || options.fanIn < 2 || options.fanIn > 32) throw new RangeError('Metadata merge fan-in must be between 2 and 32.');
  const ledger = new Ledger(options);
  try { await ledger.initialized(); return ledger; }
  catch (primaryError) {
    try { await ledger.close(); } catch (cleanupError) { throw new MetadataCleanupError(primaryError, cleanupError, ledger); }
    throw primaryError;
  }
}
