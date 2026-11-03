import { observeRetainedOperation, parseCoordinatorOperation } from '../../network/desktop/coordinator/operations.js';
import type { CoordinatorOperation } from '../../network/desktop/coordinator/operations.js';
import type { DockerDesktopCoordinatorOperationOptions } from '../../network/desktop/coordinator/contracts.js';
import { DockerDesktopRecoveryError } from './contracts.js';
import type { DockerDesktopRecoveryController } from './contracts.js';

type ControllerAction = 'open' | 'begin' | 'stopped' | 'finish' | 'close' | 'release';

interface EnteredOperation {
  readonly action: ControllerAction;
  readonly actual: Promise<void>;
}

/** Rejected waits retain the single actual operation for same-phase rejoining. */
export class RecoveryOperations {
  private entered: EnteredOperation | undefined;

  constructor(private readonly owner: DockerDesktopRecoveryController) {}

  get pending(): boolean { return this.entered !== undefined; }

  parse(options?: DockerDesktopCoordinatorOperationOptions): CoordinatorOperation {
    let operation: CoordinatorOperation;
    try { operation = parseCoordinatorOperation(options); }
    catch (cause) { throw new DockerDesktopRecoveryError({ kind: 'invalid_input' }, this.owner, { cause }); }
    if (operation.signal?.aborted) {
      throw new DockerDesktopRecoveryError({ kind: 'interrupted', by: 'signal', effect: 'not_entered' }, this.owner);
    }
    return operation;
  }

  run(action: ControllerAction, operation: CoordinatorOperation, perform: () => Promise<void>): Promise<void> {
    if (this.entered && this.entered.action !== action) {
      return Promise.reject(new DockerDesktopRecoveryError({ kind: 'busy' }, this.owner));
    }
    if (!this.entered) {
      const actual = Promise.resolve().then(perform);
      const entered = { action, actual };
      this.entered = entered;
      const complete = () => { if (this.entered === entered) this.entered = undefined; };
      void actual.then(complete, complete);
    }
    return this.observe(this.entered.actual, operation);
  }

  settle(operation: CoordinatorOperation, additional: readonly Promise<unknown>[]): Promise<void> {
    const cut = [this.entered?.actual, ...additional];
    const actual = Promise.allSettled(cut).then((results) => {
      const failures: unknown[] = [];
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Docker Desktop recovery operations did not all settle successfully.');
    });
    return this.observe(actual, operation);
  }

  private observe<Value>(actual: Promise<Value>, operation: CoordinatorOperation): Promise<Value> {
    return observeRetainedOperation(actual, operation,
      (by) => new DockerDesktopRecoveryError({ kind: 'interrupted', by, effect: 'owned' }, this.owner));
  }
}
