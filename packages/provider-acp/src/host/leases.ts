import type { MaybePromise } from '@agen-ai/agent-runtime';
import { awaitHost, hostDeadline, ownedRelease } from './lifecycle.js';
import { invalidHostRequest } from './validation.js';

interface LeaseEntry {
  readonly scope: AbortSignal;
  readonly lifetime: AbortController;
  readonly cleanup: () => Promise<void>;
}

/** Own acquisition before awaiting it; only successful release retires ownership. */
export class AcpHostLeases {
  private readonly entries = new Set<LeaseEntry>();
  private readonly used = new WeakSet<object>();
  private closed = false;

  constructor(private readonly timeoutMs: number) {}

  get size(): number { return this.entries.size; }

  async acquire<Lease extends { readonly release: () => MaybePromise<void> }>(
    create: (signal: AbortSignal) => MaybePromise<Lease>,
    signal: AbortSignal,
    scope: AbortSignal = signal,
    observe: (lease: Lease) => void = () => undefined,
  ): Promise<{ readonly lease: Lease; readonly release: () => Promise<void> }> {
    if (this.closed || signal.aborted) throw signal.reason ?? new DOMException('Host facility closed.', 'AbortError');
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal]);
    let release: (() => Promise<void>) | undefined;
    let cleanup: Promise<void> | undefined;
    const acquisition = Promise.resolve().then(() => {
      if (combined.aborted) throw combined.reason;
      return create(combined);
    }).then((lease) => {
      observe(lease);
      if (!lease || typeof lease.release !== 'function' || this.used.has(lease)) throw invalidHostRequest();
      this.used.add(lease);
      release = ownedRelease(async () => { await lease.release(); this.entries.delete(entry); }, this.timeoutMs);
      return { lease, release };
    }).catch((error: unknown) => {
      if (!release) this.entries.delete(entry);
      throw error;
    });
    const entry: LeaseEntry = { scope, lifetime, cleanup: () => {
      // Keep a pending acquisition shared even when a bounded close attempt expires.
      cleanup ??= acquisition.then(({ release }) => release(), () => undefined)
        .catch((error: unknown) => { cleanup = undefined; throw error; });
      return cleanup;
    } };
    this.entries.add(entry);
    try {
      const acquired = await awaitHost(acquisition, combined);
      if (combined.aborted) throw combined.reason;
      return acquired;
    } catch (error) {
      // Failure is retained by this owner and retried by an explicit close.
      void entry.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async close(scope?: AbortSignal): Promise<void> {
    if (scope === undefined) this.closed = true;
    const entries = [...this.entries].filter((entry) => scope === undefined || entry.scope === scope);
    for (const entry of entries) entry.lifetime.abort(new DOMException('Host facility closed.', 'AbortError'));
    const deadline = hostDeadline(new AbortController().signal, this.timeoutMs);
    try {
      const results = await Promise.allSettled(entries.map((entry) => awaitHost(entry.cleanup(), deadline.signal)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'ACP host lease cleanup failed.');
    } finally { deadline.close(); }
  }
}
