import { AgentHistoryCleanupError, AgentHistoryError, OperationFailure } from './errors.js';
import type { AgentHistoryDriverContext, AgentHistoryMutationResult } from '../contracts/index.js';

interface OperationContext<Value> {
  readonly signal: AbortSignal;
  markDispatched(): void;
  recordResult(value: Value): void;
}

interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

interface OwnerOptions {
  readonly concurrentReads: number;
  readonly deadlineMs: number;
  readonly maximumDeadlineMs: number;
  readonly cleanupDeadlineMs: number;
  readonly dispose: () => Promise<void>;
}

type Lifecycle =
  | { readonly kind: 'open' }
  | { readonly kind: 'closing'; readonly promise: Promise<void> }
  | { readonly kind: 'cleanup_failed' }
  | { readonly kind: 'closed' };

interface EnteredOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

export class HistoryOwner {
  private state: Lifecycle = { kind: 'open' };
  private readonly entered = new Set<EnteredOperation>();
  private mutationEntered = false;
  private mutationUncertain = false;
  private nativeDisposal: Promise<void> | undefined;

  constructor(private readonly options: OwnerOptions) {}

  fenceMutations(): void {
    this.mutationUncertain = true;
  }

  run<T>(kind: 'read', options: OperationOptions, perform: (context: AgentHistoryDriverContext) => Promise<T>): Promise<T>;
  run(kind: 'mutation', options: OperationOptions, perform: (context: OperationContext<AgentHistoryMutationResult>) => Promise<AgentHistoryMutationResult>): Promise<AgentHistoryMutationResult>;
  async run<T>(kind: 'read' | 'mutation', options: OperationOptions, perform: (context: OperationContext<T>) => Promise<T>): Promise<T> {
    if (this.state.kind !== 'open') throw new AgentHistoryError('closed', 'History source is closing or closed.');
    if (options.signal?.aborted) throw new AgentHistoryError('cancelled', 'History operation was cancelled before dispatch.');
    const deadlineMs = options.deadlineMs ?? this.options.deadlineMs;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > this.options.maximumDeadlineMs) {
      throw new AgentHistoryError('invalid_input', 'History deadline is outside the supported range.');
    }
    if (this.mutationEntered || this.entered.size >= this.options.concurrentReads || (kind === 'mutation' && this.entered.size > 0)) {
      throw new AgentHistoryError('busy', 'History source operation capacity is occupied.');
    }
    if (kind === 'mutation' && this.mutationUncertain) {
      throw new AgentHistoryError('unsupported_scope', 'A previous mutation has an unknown outcome; reopen after inspecting native state.');
    }
    const controller = new AbortController();
    let dispatched = false;
    const settlement = Promise.withResolvers<void>();
    const entry: EnteredOperation = { controller, settled: settlement.promise };
    this.entered.add(entry);
    if (kind === 'mutation') this.mutationEntered = true;
    const abort = () => controller.abort(new AgentHistoryError('cancelled', 'History operation was cancelled.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new AgentHistoryError('deadline_exceeded', 'History operation exceeded its deadline.')), deadlineMs);
    const interrupted = Promise.withResolvers<never>();
    let receipt: { readonly value: T } | undefined;
    let interruptedBeforeReceipt = false;
    const onAbort = () => {
      interruptedBeforeReceipt = receipt === undefined;
      interrupted.reject(controller.signal.reason instanceof AgentHistoryError
        ? controller.signal.reason : new AgentHistoryError('cancelled', 'History operation was cancelled.'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return perform({ signal: controller.signal, markDispatched: () => { controller.signal.throwIfAborted(); dispatched = true; },
        recordResult: (value) => {
          if (kind !== 'mutation' || receipt !== undefined) throw new AgentHistoryError('native_failure', 'Only one mutation receipt may be recorded.');
          receipt = { value };
        },
      });
    });
    const release = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      options.signal?.removeEventListener('abort', abort);
      this.entered.delete(entry);
      if (kind === 'mutation') this.mutationEntered = false;
      settlement.resolve();
    };
    void work.then(release, () => {
      if (kind === 'mutation' && dispatched && (receipt === undefined || interruptedBeforeReceipt)) this.mutationUncertain = true;
      release();
    });
    try {
      return await Promise.race([work, interrupted.promise]);
    } catch (error) {
      if (receipt !== undefined && !interruptedBeforeReceipt) return receipt.value;
      const normalized = error instanceof AgentHistoryError ? error : new AgentHistoryError('native_failure', 'The native history operation failed.');
      if (kind === 'mutation' && dispatched) this.mutationUncertain = true;
      throw new OperationFailure(normalized, dispatched);
    }
  }

  close(): Promise<void> {
    if (this.state.kind === 'closed') return Promise.resolve();
    if (this.state.kind === 'closing') return this.state.promise;
    const promise = Promise.resolve().then(() => this.dispose());
    this.state = { kind: 'closing', promise };
    for (const entry of this.entered) entry.controller.abort(new AgentHistoryError('closed', 'History source is closing.'));
    return promise;
  }

  private async dispose(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.nativeDisposal ??= Promise.resolve().then(this.options.dispose).catch((error: unknown) => {
        this.nativeDisposal = undefined;
        throw error;
      });
      const cleanup = this.nativeDisposal.then(async () => {
        await Promise.all([...this.entered].map((entry) => entry.settled));
      });
      await Promise.race([cleanup, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('History cleanup deadline exceeded')), this.options.cleanupDeadlineMs);
      })]);
      this.state = { kind: 'closed' };
    } catch {
      this.state = { kind: 'cleanup_failed' };
      throw new AgentHistoryCleanupError(() => this.close());
    } finally {
      clearTimeout(timer);
    }
  }
}
