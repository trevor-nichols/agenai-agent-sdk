import { SandboxOperationError } from '../errors.js';
import { transferData } from '../files/parse.js';
import type { SandboxByteSource, SandboxRelativePath } from '../files/types.js';
import { LiveChunks } from './chunks.js';
import type { SandboxDriverFileOptions, SandboxDriverFiles, SandboxDriverReadWriteFiles } from './driver.js';
import { parseFileCount, parseFileEntry, parseFileStatResult, parseFileWriteResult } from './parse.js';
import type { SandboxFileCancellation, SandboxFileListConsumer, SandboxFileListResult, SandboxFileReadConsumer,
  SandboxFileReadResult, SandboxFileStatResult, SandboxFileWriteResult, SandboxLivePath } from './types.js';

export interface OwnedLiveOperation<Result> {
  readonly actual: Promise<Result>;
  readonly clean: boolean;
  interrupt(reason: SandboxFileCancellation): Result;
  cleanup(): Promise<void>;
}

class QuotaExceeded extends SandboxOperationError {
  constructor() { super('input_limit', 'Live file operation exceeded its selected quota.'); }
}

class LiveResources {
  chunks: LiveChunks | undefined;
  callback: Promise<void> | undefined;
  failure: Readonly<{ error: unknown }> | undefined;
  cancellation: SandboxFileCancellation | undefined;
  bytes = 0n;
  entries = 0n;
  clean = false;
  private closing: Promise<void> | undefined;
  private closeFailed = false;

  constructor(readonly controller: AbortController, readonly options: SandboxDriverFileOptions) {}

  fail(error: unknown): void { this.failure ??= { error }; this.controller.abort(error); }
  cancel(reason: SandboxFileCancellation, interrupt: boolean): void {
    this.cancellation ??= reason;
    if (interrupt) this.controller.abort(new SandboxOperationError('cancelled', 'Live callback scope ended before its stream.'));
  }

  addBytes(length: number): void {
    const next = this.bytes + BigInt(length);
    if (this.options.quotas.maxBytes !== undefined && next > this.options.quotas.maxBytes) throw new QuotaExceeded();
    this.bytes = next;
  }
  addEntry(): void {
    if (this.options.quotas.maxEntries !== undefined && this.entries >= this.options.quotas.maxEntries) throw new QuotaExceeded();
    this.entries += 1n;
  }

  enter(perform: () => Promise<void>): Promise<void> {
    if (this.callback) {
      const error = new SandboxOperationError('driver_failure', 'Live callbacks must be sequential and awaited by their backend.');
      this.fail(error);
      return Promise.reject(error);
    }
    const actual = Promise.resolve().then(perform);
    this.callback = actual;
    void actual.then(() => { this.callback = undefined; }, (error: unknown) => { this.callback = undefined; this.fail(error); });
    return actual;
  }

  async finish(): Promise<void> {
    if (this.callback) this.fail(new SandboxOperationError('driver_failure', 'Backend returned before its live callback settled.'));
    await this.callback?.catch(() => {});
    if (this.failure) throw this.failure.error;
  }

  close(): Promise<void> {
    if (this.closing && !this.closeFailed) return this.closing;
    const retry = this.closeFailed;
    this.closeFailed = false;
    const actual = (async () => {
      await this.callback?.catch(() => {});
      await this.chunks?.close(retry);
      this.clean = true;
    })();
    this.closing = actual;
    void actual.catch(() => { this.closeFailed = true; });
    return actual;
  }
}

function own<Result>(controller: AbortController, options: SandboxDriverFileOptions,
  perform: (resources: LiveResources) => Promise<Result>, interrupt: (resources: LiveResources, reason: SandboxFileCancellation) => Result): OwnedLiveOperation<Result> {
  const internal = new AbortController();
  const resources = new LiveResources(internal, { ...options, signal: AbortSignal.any([controller.signal, options.signal, internal.signal]) });
  const actual = Promise.resolve().then(async () => {
    let result: Result | undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    try { resources.options.signal.throwIfAborted(); result = await perform(resources); }
    catch (error) { resources.fail(error); failure = { error }; }
    try { await resources.close(); }
    catch (error) {
      if (failure && Object.is(failure.error, error)) throw failure.error;
      if (failure) throw new AggregateError([failure.error, error], 'Live operation and its cleanup failed.');
      throw error;
    }
    if (failure) {
      if (resources.cancellation) return Object.freeze(interrupt(resources, resources.cancellation));
      throw failure.error;
    }
    if (result === undefined) throw new SandboxOperationError('driver_failure', 'Backend omitted its live operation result.');
    return result;
  });
  return { actual, get clean() { return resources.clean; }, interrupt: (reason) => {
    if (resources.failure) throw resources.failure.error;
    return Object.freeze(interrupt(resources, reason));
  }, async cleanup() {
    await actual.catch(() => {});
    if (!resources.clean) await resources.close();
  } };
}

export function statFile(port: SandboxDriverFiles, path: SandboxLivePath, controller: AbortController,
  options: SandboxDriverFileOptions): OwnedLiveOperation<SandboxFileStatResult> {
  return own(controller, options, async (resources) => parseFileStatResult(await port.stat(path, resources.options), path),
    (_resources, reason) => ({ kind: 'cancelled', reason }));
}

export function listFiles(port: SandboxDriverFiles, path: SandboxLivePath, consume: SandboxFileListConsumer, controller: AbortController,
  options: SandboxDriverFileOptions): OwnedLiveOperation<SandboxFileListResult> {
  return own(controller, options, async (resources) => {
    const options = resources.options;
    let accepting = true;
    const deliver: SandboxFileListConsumer = (raw) => {
      if (!accepting) return Promise.reject(new SandboxOperationError('driver_failure', 'Live listing callback scope has ended.'));
      return resources.enter(async () => {
        options.signal.throwIfAborted();
        const entry = parseFileEntry(raw);
        const name = path === '.' ? entry.path : entry.path.startsWith(`${path}/`) ? entry.path.slice(path.length + 1) : '';
        if (!name || name.includes('/')) throw new SandboxOperationError('driver_failure', 'Live listing must deliver only the selected directory’s direct children.');
        resources.addEntry();
        await consume(entry, { signal: options.signal });
        options.signal.throwIfAborted();
      });
    };
    let result: SandboxFileListResult;
    try { result = await port.list(path, deliver, options); }
    finally { accepting = false; }
    await resources.finish();
    return Object.freeze({ ...parseFileCount(result, 'entries', resources.entries), entries: resources.entries });
  }, (resources, reason) => ({ kind: 'cancelled', reason, entries: resources.entries }));
}

export function readFile(port: SandboxDriverFiles, path: SandboxRelativePath, consume: SandboxFileReadConsumer, controller: AbortController,
  options: SandboxDriverFileOptions): OwnedLiveOperation<SandboxFileReadResult> {
  return own(controller, options, async (resources) => {
    const options = resources.options;
    let accepting = true;
    let delivered = false;
    let complete = false;
    let length = 0;
    const deliver: SandboxFileReadConsumer = (raw) => {
      if (!accepting || delivered) {
        const error = new SandboxOperationError('driver_failure', 'A read can borrow one file within its operation scope.');
        if (accepting) resources.fail(error);
        return Promise.reject(error);
      }
      delivered = true;
      return resources.enter(async () => {
        options.signal.throwIfAborted();
        const data = transferData(raw, ['entry', 'chunks']);
        const entry = parseFileEntry(data.entry);
        if (entry.kind !== 'file' || entry.path !== path) throw new SandboxOperationError('driver_failure', 'Live reads require metadata for the selected regular file.');
        length = entry.byteLength;
        const chunks = new LiveChunks(data.chunks as AsyncIterable<Uint8Array>, options.chunkBytes, options.signal,
          (size) => {
            if (resources.bytes + BigInt(size) > BigInt(length)) throw new SandboxOperationError('driver_failure', 'Live read exceeded its initial file length.');
            resources.addBytes(size);
          }, (error) => resources.fail(error));
        resources.chunks = chunks;
        let returned = false;
        try {
          await consume(Object.freeze({ entry: { ...entry, kind: 'file' }, chunks }), { signal: options.signal });
          returned = true;
        }
        finally {
          complete = chunks.complete;
          if (!complete && returned && !resources.failure) resources.cancel('callback_closed', chunks.pulling);
          await chunks.close();
        }
        chunks.assertHealthy();
      });
    };
    let result: SandboxFileReadResult;
    try { result = await port.readFile(path, deliver, options); }
    finally { accepting = false; }
    await resources.finish();
    const observation = parseFileCount(result, 'bytes', resources.bytes);
    if (delivered && !complete) return Object.freeze({ kind: 'cancelled', reason: 'callback_closed', bytes: resources.bytes });
    if (observation.kind === 'completed' && (!delivered || resources.bytes !== BigInt(length))) throw new SandboxOperationError('driver_failure', 'A complete read requires its entire admitted file and callback to settle.');
    return Object.freeze({ ...observation, bytes: resources.bytes });
  }, (resources, reason) => ({ kind: 'cancelled', reason, bytes: resources.bytes }));
}

export function writeFile(port: SandboxDriverReadWriteFiles, path: SandboxRelativePath, source: SandboxByteSource, mode: 'create' | 'replace',
  controller: AbortController, options: SandboxDriverFileOptions): OwnedLiveOperation<SandboxFileWriteResult> {
  return own(controller, options, async (resources) => {
    const options = resources.options;
    // A backend can pull one bounded chunk before rejecting its quota. Only admitted bytes are written.
    const chunks = new LiveChunks(source, options.chunkBytes, options.signal, (length) => { resources.bytes += BigInt(length); }, (error) => resources.fail(error));
    resources.chunks = chunks;
    const raw = await port.writeFile(path, chunks, { ...options, mode });
    const result = parseFileWriteResult(raw, resources.bytes);
    if (options.quotas.maxBytes !== undefined && result.bytes !== null && result.bytes > options.quotas.maxBytes) throw new SandboxOperationError('driver_failure', 'Backend write exceeded its selected byte quota.');
    chunks.assertHealthy();
    if ((result.kind === 'completed' || result.kind === 'changed') && !chunks.complete) throw new SandboxOperationError('driver_failure', 'Backend published without consuming its complete write source.');
    await chunks.close();
    return result;
  }, (_resources, reason) => ({ kind: 'cancelled', reason, effect: 'unknown', bytes: null }));
}
