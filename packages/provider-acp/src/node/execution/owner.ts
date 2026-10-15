import type { AcpConnectionFactoryContext, AcpConnectionLease, AcpConnectionStreams } from '../../contracts.js';
import { AcpProviderConnectionError } from '../../connection/errors.js';
import { NodeAcpExecutionCleanupError } from './errors.js';
import type { NodeAcpExecutionBoundary, NodeAcpExecutionInput, NodeAcpExecutionReservation } from './types.js';

type ReleaseState = Readonly<{ kind: 'idle' | 'complete' }>
  | Readonly<{ kind: 'running'; actual: Promise<void> }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

export class NodeAcpExecutionOwner {
  private state: 'reserved' | 'active' | 'stopping' | 'released' = 'reserved';
  private startup: Promise<AcpConnectionStreams> | undefined;
  private releaseState: ReleaseState = { kind: 'idle' };
  private readonly releaseComplete = Promise.withResolvers<void>();
  private failureNotice = Promise.withResolvers<unknown>();
  private cleanupAttempt: Promise<void> | undefined;
  private observation: Promise<void> | undefined;
  private cleanupWork: () => Promise<void> = () => this.release();
  private onDrained: () => void = () => {};
  private failure: Readonly<{ error: unknown }> | undefined;
  private readonly startReservation: NodeAcpExecutionReservation['start'];
  private readonly releaseReservation: NodeAcpExecutionReservation['release'];

  constructor(reservation: NodeAcpExecutionReservation, private readonly cleanupTimeoutMs: number) {
    const release = reservation.release;
    const start = reservation.start;
    if (typeof release !== 'function' || typeof start !== 'function') {
      throw new TypeError('An execution reservation must provide callable start and release methods.');
    }
    this.startReservation = (context) => Reflect.apply(start, reservation, [context]);
    this.releaseReservation = () => Reflect.apply(release, reservation, []);
  }

  get cleanupPending(): boolean { return this.state === 'stopping'; }
  get cleanupFailure(): Readonly<{ error: unknown }> | undefined { return this.failure; }

  retainCleanup(work: () => Promise<void>): void { this.cleanupWork = work; }
  whenDrained(callback: () => void): void { this.onDrained = callback; }

  start(context: AcpConnectionFactoryContext): Promise<AcpConnectionLease> {
    if (this.state !== 'reserved') return Promise.reject(new TypeError('Execution startup is once-only and cannot follow release.'));
    this.state = 'active';
    this.startup = Promise.resolve().then(() => {
      if (this.state !== 'active') throw new DOMException('Execution startup was stopped.', 'AbortError');
      context.signal?.throwIfAborted();
      return this.startReservation(Object.freeze({ ...context }));
    });
    void this.startup.catch(() => {});
    return this.startup.then((streams) => {
      const stdout = streams.stdout; const stdin = streams.stdin; const stderr = streams.stderr;
      return { ownership: 'owned' as const, stdout, stdin, ...(stderr === undefined ? {} : { stderr }), release: () => this.release() };
    });
  }

  /** Actual release is unbounded here; one outer observation owns the full connection deadline. */
  release(): Promise<void> {
    if (this.state === 'released') return Promise.resolve();
    this.state = 'stopping';
    if (this.releaseState.kind === 'idle') this.beginRelease();
    return this.releaseComplete.promise;
  }

  private beginRelease(): void {
    if (this.releaseState.kind === 'running' || this.releaseState.kind === 'complete') return;
    const operation = Promise.withResolvers<void>();
    const actual = operation.promise.then(async () => {
      await this.startup?.catch(() => undefined);
      this.releaseState = { kind: 'complete' };
      this.releaseComplete.resolve();
    }).catch((error) => {
      this.releaseState = { kind: 'failed', error };
      this.failure = { error };
      this.failureNotice.resolve(error);
    });
    this.releaseState = { kind: 'running', actual };
    try { Promise.resolve(this.releaseReservation()).then(operation.resolve, operation.reject); }
    catch (error) { operation.reject(error); }
  }

  cleanup(): Promise<void> {
    if (this.state === 'released') return Promise.resolve();
    this.state = 'stopping';
    if (this.observation) return this.observation;
    const deadline = performance.now() + this.cleanupTimeoutMs;
    this.failureNotice = Promise.withResolvers<unknown>();
    let initiate: (() => void) | undefined;
    let actual = this.cleanupAttempt;
    if (!actual) {
      const operation = Promise.withResolvers<void>();
      actual = operation.promise.then(() => {
        this.state = 'released';
        this.failure = undefined;
        this.onDrained();
      }).catch((error) => { this.failure = { error }; this.cleanupAttempt = undefined; throw error; });
      this.cleanupAttempt = actual;
      initiate = () => {
        try { Promise.resolve(this.cleanupWork()).then(operation.resolve, operation.reject); }
        catch (error) { operation.reject(error); }
      };
    }
    const cleanup = actual;
    this.observation = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new AcpProviderConnectionError(
        'acp_node_execution_cleanup_timeout', 'The owned Node ACP execution cleanup exceeded its observation deadline.',
      )), Math.max(0, deadline - performance.now()));
      cleanup.then(() => { clearTimeout(timeout); resolve(); }, (error) => { clearTimeout(timeout); reject(error); });
      this.failureNotice.promise.then((error) => { clearTimeout(timeout); reject(error); });
    }).catch((error) => { this.failure ??= { error }; throw error; })
      .finally(() => { this.observation = undefined; });
    // A failed release can be retried while the original full cleanup still awaits native shutdown.
    if (this.releaseState.kind === 'failed') this.beginRelease();
    initiate?.();
    return this.observation;
  }

  retainedError(cause: unknown, cleanupError: unknown): NodeAcpExecutionCleanupError {
    return new NodeAcpExecutionCleanupError({ cause, cleanupError, retryCleanup: () => this.cleanup() });
  }

  joinCleanup(): Promise<void> {
    if (this.cleanupAttempt) return this.cleanupAttempt;
    if (this.state === 'released') return Promise.resolve();
    return Promise.reject(this.failure?.error ?? new Error('Execution cleanup has not started.'));
  }
}

export function executionReservationSource(boundary: NodeAcpExecutionBoundary, input: NodeAcpExecutionInput): () => NodeAcpExecutionOwner {
  const reserve = boundary?.reserve;
  if (typeof reserve !== 'function') throw new TypeError('A Node ACP execution boundary must provide a synchronous reserve method.');
  const used = new WeakSet<object>();
  return () => {
    const reservation: NodeAcpExecutionReservation = Reflect.apply(reserve, boundary, [input]);
    if (!reservation || typeof reservation !== 'object' || 'then' in reservation || used.has(reservation)) {
      throw new TypeError('Execution reserve must return a fresh synchronous inert reservation.');
    }
    used.add(reservation);
    return new NodeAcpExecutionOwner(reservation, 2 * input.shutdownTimeoutMs);
  };
}
