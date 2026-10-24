// ------------------------------------------------------------------------------------------------
//                journal.ts - Ordered recovery checkpoints - Recovery parsing and persistence
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '../errors.js';
import { parseSandboxRecoveryRecord } from '../recovery/parse.js';
import type { SandboxRecoveryPolicy, SandboxRecoveryRecord } from '../recovery/types.js';
import { assertRecoveryContinuation } from './recoveryIdentity.js';

export class RecoveryJournal {
  private tail: Promise<void> = Promise.resolve();
  private failure: { readonly error: unknown } | undefined;
  private record: SandboxRecoveryRecord;

  constructor(record: SandboxRecoveryRecord, private readonly policy: SandboxRecoveryPolicy, private readonly onFailure: (error: unknown) => void) {
    this.record = record;
  }

  get current(): SandboxRecoveryRecord { return this.record; }

  initialize(): Promise<void> { return this.checkpoint(this.record); }

  checkpoint = (input: SandboxRecoveryRecord): Promise<void> => {
    let next: SandboxRecoveryRecord;
    try { next = parseSandboxRecoveryRecord(input); }
    catch (error) { return this.fail(error); }
    const work = this.tail.then(async () => {
      if (this.failure) throw this.failure.error;
      assertRecoveryContinuation(this.record, next, 'checkpoint');
      // Keep acquired identities in memory even when durable persistence fails.
      this.record = next;
      if (this.policy.kind === 'persisted') await this.policy.persist(next);
    }).catch((error: unknown) => {
      if (!this.failure) {
        this.failure = { error: new SandboxOperationError('persistence_failure', 'Sandbox recovery checkpoint failed.', { cause: error }) };
        this.onFailure(this.failure.error);
      }
      throw this.failure.error;
    });
    this.tail = work;
    void work.catch(() => {});
    return work;
  };

  private fail(error: unknown): Promise<never> {
    this.failure ??= { error: new SandboxOperationError('persistence_failure', 'Sandbox recovery checkpoint is invalid.', { cause: error }) };
    this.onFailure(this.failure.error);
    return Promise.reject(this.failure.error);
  }

}
