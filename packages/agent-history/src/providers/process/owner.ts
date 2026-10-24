import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHistoryError } from '../../lifecycle/errors.js';

interface EnteredOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface HistoryProcessOperation {
  readonly root: string;
  readonly signal: AbortSignal;
  ownCleanup(cleanup: () => Promise<void>): void;
}

export class HistoryProcessOwner {
  private closed = false;
  private readonly entered = new Set<EnteredOperation>();

  private constructor(private readonly root: string) {}

  static async create(temporaryRoot: string, prefix: string): Promise<HistoryProcessOwner> {
    return new HistoryProcessOwner(await mkdtemp(join(temporaryRoot, prefix)));
  }

  async run<T>(operation: (context: HistoryProcessOperation) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.closed) throw new AgentHistoryError('closed', 'Native history source is closing or requires cleanup.');
    signal.throwIfAborted();
    const settled = Promise.withResolvers<void>();
    const entry: EnteredOperation = { controller: new AbortController(), settled: settled.promise };
    const abort = () => entry.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.entered.add(entry);
    try {
      const root = await mkdtemp(join(this.root, 'read-'));
      let nativeCleanup: (() => Promise<void>) | undefined;
      entry.cleanup = async () => { await nativeCleanup?.(); await rm(root, { recursive: true, force: true }); };
      entry.controller.signal.throwIfAborted();
      return await operation({ root, signal: entry.controller.signal,
        ownCleanup: (cleanup) => { nativeCleanup = cleanup; },
      });
    } finally {
      signal.removeEventListener('abort', abort);
      try {
        await entry.cleanup?.();
        this.entered.delete(entry);
      } catch {
        this.closed = true;
        throw new AgentHistoryError('cleanup_failed', 'Native history cleanup is incomplete; close the source and retain cleanup responsibility.');
      } finally { settled.resolve(); }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const entered = [...this.entered];
    for (const entry of entered) entry.controller.abort();
    await Promise.all(entered.map((entry) => entry.settled));
    for (const entry of this.entered) {
      await entry.cleanup?.();
      this.entered.delete(entry);
    }
    await rm(this.root, { recursive: true, force: true });
  }
}
