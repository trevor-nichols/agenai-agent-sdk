// ------------------------------------------------------------------------------------------------
//                transfer.ts - Streaming workspace transfers with retained actual ownership
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverReady, SandboxDriverTransferOptions } from '../backend/contracts.js';
import { SandboxOperationError } from '../errors.js';
import { TransferBody } from '../files/bytes.js';
import { TransferIterator } from '../files/iterator.js';
import { createMetadataLedger, MetadataCleanupError } from '../files/metadata/index.js';
import type { MetadataLedger } from '../files/metadata/index.js';
import { parseTreeMetadata, transferData } from '../files/parse.js';
import { parseSandboxRelativePath } from '../files/paths.js';
import { TransferCounters } from '../files/quotas.js';
import type { SandboxByteSource, SandboxExportConsumer, SandboxInputTreeEntry, SandboxInputTreeSelection,
  SandboxRelativePath, SandboxTreeSelection, SandboxTreeSource, SandboxTransferSummary } from '../files/types.js';

type Failure = Readonly<{ error: unknown }>;
interface Closable { close(retry?: boolean): Promise<void> }

export interface OwnedTransfer {
  readonly actual: Promise<SandboxTransferSummary>;
  readonly clean: boolean;
  cleanup(): Promise<void>;
}

/** One public iteration with no queued pulls and no swallowed iteration failure. */
class TransferDispatch<Value> implements AsyncIterable<Value> {
  private claimed = false;
  private retired = false;
  private ended = false;
  private pending: Promise<IteratorResult<Value>> | undefined;
  private failure: Failure | undefined;

  constructor(private readonly pull: () => Promise<IteratorResult<Value>>, private readonly interrupt: (error: unknown) => void) {}

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    if (this.claimed || this.retired) throw this.fail('Tree sources are once-only and scoped to the transfer.');
    this.claimed = true;
    return { next: () => this.next(), return: async () => { this.retired = true; return { done: true, value: undefined }; } };
  }

  private fail(message: string): SandboxOperationError {
    const error = new SandboxOperationError('driver_failure', message);
    this.failure ??= { error };
    this.interrupt(error);
    return error;
  }

  private next(): Promise<IteratorResult<Value>> {
    if (this.pending || this.retired) return Promise.reject(this.fail('Concurrent or retired tree pulls are forbidden.'));
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    const actual = Promise.resolve().then(this.pull);
    this.pending = actual;
    void actual.then((result) => { this.pending = undefined; this.ended = result.done === true; },
      (error: unknown) => { this.pending = undefined; this.failure ??= { error }; });
    return actual;
  }

  async finish(): Promise<void> {
    if (this.pending) this.fail('Backend returned with a tree pull still pending.');
    await this.close();
    if (this.failure) throw this.failure.error;
    if (!this.ended) throw this.fail('Backend did not completely consume its tree source.');
  }

  async close(): Promise<void> {
    this.retired = true;
    await this.pending?.catch(() => {});
  }
}

class TransferResources {
  readonly ledgers: MetadataLedger[] = [];
  acquisitionCleanup: Closable | undefined;
  source: Closable | undefined;
  body: TransferBody | undefined;
  entered: Promise<unknown> | undefined;
  dispatch: Closable | undefined;
  clean = false;
  private closing: Promise<void> | undefined;
  private closeFailed = false;

  get cleanupFailed(): boolean { return this.closeFailed; }

  close(retry = false): Promise<void> {
    if (this.closing && (!retry || !this.closeFailed)) return this.closing;
    this.closeFailed = false;
    const actual = this.closeResources(retry);
    this.closing = actual;
    void actual.catch(() => { this.closeFailed = true; });
    return actual;
  }

  private async closeResources(retry: boolean): Promise<void> {
    await this.entered?.catch(() => {});
    await this.dispatch?.close();
    const results = await Promise.allSettled([
      this.body?.close(retry), this.source?.close(retry), this.acquisitionCleanup?.close(retry), ...this.ledgers.map((ledger) => ledger.close()),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length !== 0) throw new AggregateError(failures.map((result) => result.reason), 'Transfer cleanup retains unfinished resources.');
    this.clean = true;
  }

  async finishBody(): Promise<void> {
    const body = this.body;
    if (!body) return;
    body.assertComplete();
    await body.close();
    this.body = undefined;
  }
}

function ownTransfer(controller: AbortController, perform: (resources: TransferResources) => Promise<SandboxTransferSummary>): OwnedTransfer {
  const resources = new TransferResources();
  const actual = Promise.resolve().then(async () => {
    let primary: Failure | undefined;
    let summary: SandboxTransferSummary | undefined;
    try { controller.signal.throwIfAborted(); summary = await perform(resources); }
    catch (error) { primary = { error }; controller.abort(error); }
    try { await resources.close(); }
    catch (error) {
      if (primary && error instanceof AggregateError && error.errors.every((cause: unknown) => Object.is(cause, primary.error))) throw primary.error;
      if (primary) throw new AggregateError([primary.error, error], 'Transfer and its cleanup both failed.');
      throw error;
    }
    if (primary) throw primary.error;
    if (!summary) throw new SandboxOperationError('driver_failure', 'Transfer returned no summary.');
    return summary;
  });
  return { actual, get clean() { return resources.clean; }, async cleanup() {
    const retry = resources.cleanupFailed;
    await actual.catch(() => {});
    if (!resources.clean) await resources.close(retry);
  } };
}

async function ledger(ready: SandboxDriverReady, options: SandboxDriverTransferOptions, resources: TransferResources): Promise<MetadataLedger> {
  try {
    const result = await createMetadataLedger({ openSpill: () => ready.openSpill({ signal: options.signal }),
      batchBytes: options.buffers.metadataBatchBytes, fanIn: options.buffers.metadataMergeFanIn, signal: options.signal });
    resources.ledgers.push(result);
    return result;
  } catch (error) {
    if (error instanceof MetadataCleanupError) resources.acquisitionCleanup = {
      close: (retry = false) => retry ? error.retryCleanup() : Promise.reject(error.cleanupError),
    };
    throw error;
  }
}

export function importTree(ready: SandboxDriverReady, entries: SandboxTreeSource, selected: SandboxDriverTransferOptions): OwnedTransfer {
  const controller = new AbortController();
  const options = { ...selected, signal: AbortSignal.any([selected.signal, controller.signal]) };
  return ownTransfer(controller, async (resources) => {
    const metadata = await ledger(ready, options, resources);
    const source = new TransferIterator(entries);
    resources.source = source;
    const counts = new TransferCounters(options.quotas, 'import');
    const admitted = new TransferDispatch<SandboxInputTreeEntry>(async () => {
      options.signal.throwIfAborted();
      await resources.finishBody();
      const next = await source.next();
      options.signal.throwIfAborted();
      if (next.done) return { done: true, value: undefined };
      const entry = parseTreeMetadata(next.value, 'open');
      counts.admit(entry);
      await metadata.append(entry);
      if (entry.kind === 'directory') return { done: false, value: entry };
      const open = entry.body;
      const body = new TransferBody(entry.byteLength, options.buffers.chunkBytes, true, options.signal,
        () => Reflect.apply(open as (...args: unknown[]) => SandboxByteSource, undefined, [{ signal: options.signal }]), (error) => controller.abort(error));
      resources.body = body;
      let opened = false;
      return { done: false, value: Object.freeze({ kind: 'file', path: entry.path, byteLength: entry.byteLength, executable: entry.executable,
        open() {
          if (opened) return body.rejectReuse();
          opened = true;
          return body;
        } }) };
    }, (error) => controller.abort(error));
    resources.dispatch = admitted;
    const summary = await ready.importTree(admitted, options);
    await admitted.finish();
    await resources.finishBody();
    await metadata.finish();
    options.signal.throwIfAborted();
    return counts.verify(summary);
  });
}

async function selection(ready: SandboxDriverReady, input: SandboxTreeSelection, options: SandboxDriverTransferOptions,
  resources: TransferResources, interrupt: (error: unknown) => void): Promise<Readonly<{ selected: SandboxInputTreeSelection; expected?: MetadataLedger; complete?: () => Promise<void> }>> {
  const data = transferData(input, ['kind', 'paths', 'path']);
  if (data.kind === 'workspace' && Reflect.ownKeys(data).length === 1) return { selected: Object.freeze({ kind: 'workspace' }) };
  if (data.kind === 'subtree' && Reflect.ownKeys(data).length === 2) {
    const path = parseSandboxRelativePath(data.path);
    new TransferCounters(options.quotas, 'export').check('maxPaths', 1n);
    return { selected: Object.freeze({ kind: 'subtree', path }) };
  }
  if (data.kind !== 'files' || Reflect.ownKeys(data).length !== 2) throw new SandboxOperationError('input_limit', 'Export requires a workspace, exact-file list or one directory subtree.');
  const expected = await ledger(ready, options, resources);
  const source = new TransferIterator(data.paths as Iterable<string> | AsyncIterable<string>);
  resources.source = source;
  const counts = new TransferCounters(options.quotas, 'export');
  let paths = 0n;
  while (true) {
    options.signal.throwIfAborted();
    const next = await source.next();
    if (next.done) break;
    const path = parseSandboxRelativePath(next.value);
    paths += 1n;
    counts.check('maxPaths', paths);
    await expected.append({ kind: 'file', path });
  }
  await source.close();
  resources.source = undefined;
  await expected.finish();
  const replay = new TransferDispatch<SandboxRelativePath>(async () => {
    options.signal.throwIfAborted();
    const next = await cursor.next();
    return next.done ? { done: true, value: undefined } : { done: false, value: next.value.path };
  }, interrupt);
  const cursor = new TransferIterator(expected.records());
  resources.dispatch = replay;
  resources.source = cursor;
  return { selected: Object.freeze({ kind: 'files', paths: replay }), expected, complete: () => replay.finish() };
}

async function verifySelected(expected: MetadataLedger, observed: MetadataLedger): Promise<void> {
  const left = new TransferIterator(expected.records());
  const right = new TransferIterator(observed.records());
  try {
    while (true) {
      const [wanted, actual] = await Promise.all([left.next(), right.next()]);
      if (wanted.done && actual.done) return;
      if (wanted.done || actual.done || wanted.value.path !== actual.value.path || actual.value.kind !== 'file') {
        throw new SandboxOperationError('driver_failure', 'Backend did not export exactly the selected regular files.');
      }
    }
  } finally { await Promise.all([left.close(), right.close()]); }
}

export function exportTree(ready: SandboxDriverReady, input: SandboxTreeSelection, consume: SandboxExportConsumer,
  selectedOptions: SandboxDriverTransferOptions): OwnedTransfer {
  const controller = new AbortController();
  const options = { ...selectedOptions, signal: AbortSignal.any([selectedOptions.signal, controller.signal]) };
  return ownTransfer(controller, async (resources) => {
    if (typeof consume !== 'function') throw new SandboxOperationError('input_limit', 'Export requires an asynchronous entry consumer.');
    const { selected, expected, complete } = await selection(ready, input, options, resources, (error) => controller.abort(error));
    const metadata = await ledger(ready, options, resources);
    const counts = new TransferCounters(options.quotas, 'export');
    let accepting = true;
    let callback: Promise<void> | undefined;
    let failure: Failure | undefined;
    let subtreeRootSeen = false;
    const deliver: SandboxExportConsumer = (raw) => {
      if (!accepting || callback) {
        const error = new SandboxOperationError('driver_failure', 'Export callbacks must be awaited sequentially within the transfer.');
        failure ??= { error };
        return Promise.reject(error);
      }
      const actual = Promise.resolve().then(async () => {
        options.signal.throwIfAborted();
        const entry = parseTreeMetadata(raw, 'bytes');
        if (selected.kind === 'subtree') {
          if (entry.path === selected.path) {
            if (entry.kind !== 'directory') throw new SandboxOperationError('driver_failure', 'The selected subtree root must be a directory.');
            subtreeRootSeen = true;
          } else if (!entry.path.startsWith(`${selected.path}/`)) {
            throw new SandboxOperationError('driver_failure', 'Backend exported an entry outside the selected subtree.');
          }
        }
        counts.admit(entry);
        await metadata.append(entry);
        if (entry.kind === 'directory') await consume(entry, { signal: options.signal });
        else {
          const body = new TransferBody(entry.byteLength, options.buffers.chunkBytes, false, options.signal,
            () => entry.body as SandboxByteSource, (error) => controller.abort(error));
          resources.body = body;
          await consume(Object.freeze({ kind: 'file', path: entry.path, byteLength: entry.byteLength, executable: entry.executable, bytes: body }), { signal: options.signal });
          await resources.finishBody();
        }
        options.signal.throwIfAborted();
      });
      callback = actual;
      resources.entered = actual;
      void actual.then(() => { callback = undefined; }, (error: unknown) => { callback = undefined; failure ??= { error }; });
      return actual;
    };
    let summary: SandboxTransferSummary;
    try { summary = await ready.exportTree(selected, deliver, options); }
    finally { accepting = false; }
    if (callback) {
      failure ??= { error: new SandboxOperationError('driver_failure', 'Backend returned while its export consumer was still running.') };
      controller.abort(failure.error);
    }
    await callback?.catch(() => {});
    if (failure) throw failure.error;
    await complete?.();
    await resources.source?.close();
    resources.source = undefined;
    await metadata.finish();
    if (selected.kind === 'subtree' && !subtreeRootSeen) throw new SandboxOperationError('driver_failure', 'Backend omitted the selected subtree root directory.');
    if (expected) await verifySelected(expected, metadata);
    options.signal.throwIfAborted();
    return counts.verify(summary);
  });
}
