// ------------------------------------------------------------------------------------------------
//                sequence.ts - Bounded physical operation ownership and finite-cut settlement
// ------------------------------------------------------------------------------------------------

export type DesktopCoordinatorSequenceFailure =
  | Readonly<{ kind: 'capacity_exhausted'; resource: 'ordinary' | 'queue' }>
  | Readonly<{ kind: 'cancelled' }>;

export class DesktopCoordinatorSequenceError extends Error {
  readonly failure: DesktopCoordinatorSequenceFailure;

  constructor(failure: DesktopCoordinatorSequenceFailure) {
    super(failure.kind === 'cancelled' ? 'Coordinator request was cancelled before dispatch.' : 'Coordinator sequence queue capacity is exhausted.');
    this.name = 'DesktopCoordinatorSequenceError';
    this.failure = Object.freeze({ ...failure });
  }
}

type WorkKind = 'ordinary' | 'cleanup' | 'observation';
interface SequenceWork {
  readonly kind: WorkKind;
  readonly completion: Promise<void>;
  readonly complete: () => void;
  readonly execute: () => Promise<void>;
  readonly detachAbort: () => void;
}
interface RunOptions { readonly signal?: AbortSignal }

function sameFrontier(left: ReadonlySet<SequenceWork>, right: ReadonlySet<SequenceWork>): boolean {
  return left.size === right.size && [...left].every((work) => right.has(work));
}

export class DesktopCoordinatorSequence {
  #entered: SequenceWork | undefined;
  #queued: SequenceWork[] = [];
  #observation: Readonly<{ work: SequenceWork; result: Promise<void> }> | undefined;
  #observationBeforeCaller = false;
  #frontiers: Set<SequenceWork>[] = [];

  run<Value>(kind: 'ordinary' | 'cleanup', perform: () => Promise<Value>, options?: RunOptions): Promise<Value>;
  // Maintenance is one shared physical observation. Its callers observe cancellation above this owner.
  run(kind: 'observation', perform: () => Promise<void>): Promise<void>;
  run(kind: WorkKind, perform: () => Promise<unknown>, options?: RunOptions): Promise<unknown> {
    if (kind === 'observation') {
      if (this.#observation) return this.#observation.result;
      const observation = this.createWork(kind, async () => { await perform(); });
      this.#observation = { work: observation.work, result: observation.result };
      this.dispatch();
      return observation.result;
    }
    if (options?.signal?.aborted) return Promise.reject(new DesktopCoordinatorSequenceError({ kind: 'cancelled' }));
    if (kind === 'ordinary' && this.#queued.filter((work) => work.kind === 'ordinary').length >= 12) {
      return Promise.reject(new DesktopCoordinatorSequenceError({ kind: 'capacity_exhausted', resource: 'ordinary' }));
    }
    if (this.#queued.length >= 16) {
      return Promise.reject(new DesktopCoordinatorSequenceError({ kind: 'capacity_exhausted', resource: 'queue' }));
    }
    const request = this.createWork(kind, perform, options?.signal);
    this.#queued.push(request.work);
    this.dispatch();
    return request.result;
  }

  settle(): Promise<void> {
    const owned = [...this.#queued];
    if (this.#entered) owned.push(this.#entered);
    if (this.#observation && this.#observation.work !== this.#entered) owned.push(this.#observation.work);
    const frontier = new Set(owned.filter((work) => work.kind !== 'observation'));
    const previous = this.#frontiers.at(-1);
    if (frontier.size > 0 && (!previous || !sameFrontier(previous, frontier))) this.#frontiers.push(frontier);
    return Promise.all(owned.map((work) => work.completion)).then(() => {});
  }

  private createWork<Value>(kind: WorkKind, perform: () => Promise<Value>, signal?: AbortSignal) {
    const result = Promise.withResolvers<Value>();
    const completion = Promise.withResolvers<void>();
    const cancel = () => {
      const index = this.#queued.indexOf(work);
      if (index === -1) return;
      this.#queued.splice(index, 1);
      work.detachAbort();
      this.retire(work);
      result.reject(new DesktopCoordinatorSequenceError({ kind: 'cancelled' }));
      this.dispatch();
    };
    const work: SequenceWork = {
      kind, completion: completion.promise, complete: completion.resolve,
      detachAbort: () => signal?.removeEventListener('abort', cancel),
      execute: async () => {
        let outcome: { kind: 'fulfilled'; value: Value } | { kind: 'rejected'; cause: unknown };
        try { outcome = { kind: 'fulfilled', value: await perform() }; }
        catch (cause) { outcome = { kind: 'rejected', cause }; }
        this.#entered = undefined;
        this.retire(work);
        if (outcome.kind === 'fulfilled') result.resolve(outcome.value);
        else result.reject(outcome.cause);
        // Publish the original result before another effect enters, including failure/fence observers.
        queueMicrotask(() => this.dispatch());
      },
    };
    signal?.addEventListener('abort', cancel, { once: true });
    return { work, result: result.promise };
  }

  private retire(work: SequenceWork): void {
    if (this.#observation?.work === work) this.#observation = undefined;
    for (const frontier of this.#frontiers) frontier.delete(work);
    // Remaining cuts are nested. Removing empty/identical cuts bounds them by the owned caller cells.
    this.#frontiers = this.#frontiers.filter((frontier, index, frontiers) => frontier.size > 0
      && (index === 0 || !sameFrontier(frontier, frontiers[index - 1])));
    work.complete();
  }

  private dispatch(): void {
    if (this.#entered) return;
    const frontier = this.#frontiers[0];
    const eligible = (work: SequenceWork) => !frontier || frontier.has(work);
    const caller = this.#queued.find((work) => work.kind === 'cleanup' && eligible(work))
      ?? this.#queued.find(eligible);
    const observation = this.#observation?.work;
    let next: SequenceWork;
    // Health stays fresh across cuts, but repeated maintenance cannot starve a pending caller.
    if (observation && (!caller || !this.#observationBeforeCaller)) {
      next = observation;
      this.#observationBeforeCaller = true;
    } else if (caller) {
      next = caller;
      this.#queued.splice(this.#queued.indexOf(caller), 1);
      this.#observationBeforeCaller = false;
    } else return;
    this.#entered = next;
    next.detachAbort();
    void next.execute();
  }
}
