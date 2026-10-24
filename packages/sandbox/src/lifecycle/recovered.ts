// ------------------------------------------------------------------------------------------------
//                recovered.ts - Reconciled cleanup ownership - Driver cleanup and bounded waits
// ------------------------------------------------------------------------------------------------

import { SandboxCleanupError } from '../errors.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import { parseSandboxRecoveryRecord } from '../recovery/parse.js';
import type { SandboxCleanupOwner, SandboxRecoveryRecord } from '../recovery/types.js';
import { actualOperation, observe } from './observation.js';
import { assertRecoveryContinuation } from './recoveryIdentity.js';

/** Recovery grants cleanup only, using the driver that verified the original identities. */
export class RecoveredSandboxOwner implements SandboxCleanupOwner {
  private stopActual: Promise<void> | undefined;
  private destroyActual: Promise<void> | undefined;
  private stopObservation: Promise<void> | undefined;
  private destroyObservation: Promise<void> | undefined;

  constructor(private readonly driver: SandboxCleanupOwner, private record: SandboxRecoveryRecord) {}

  get recoveryRecord(): SandboxRecoveryRecord {
    const next = parseSandboxRecoveryRecord(this.driver.recoveryRecord);
    assertRecoveryContinuation(this.record, next, 'reconciliation');
    this.record = next;
    return next;
  }

  stop(): Promise<void> {
    this.stopObservation ??= observe(this.beginStop(), SANDBOX_LIMITS.cleanupMs).catch((cause: unknown) => {
      throw new SandboxCleanupError('Recovered sandbox compute cleanup failed.', { cause, operation: 'stop', owner: this });
    }).finally(() => { this.stopObservation = undefined; });
    return this.stopObservation;
  }

  destroy(): Promise<void> {
    this.destroyActual ??= this.beginStop().then(() => {
      void this.recoveryRecord;
      return this.driver.destroy();
    }).catch((error: unknown) => {
      this.destroyActual = undefined;
      throw error;
    });
    this.destroyObservation ??= observe(this.destroyActual, SANDBOX_LIMITS.cleanupMs).catch((cause: unknown) => {
      throw new SandboxCleanupError('Recovered sandbox destruction failed.', { cause, operation: 'destroy', owner: this });
    }).finally(() => { this.destroyObservation = undefined; });
    return this.destroyObservation;
  }

  private beginStop(): Promise<void> {
    if (!this.stopActual) {
      const dispatch = Promise.withResolvers<void>();
      const actual = dispatch.promise.catch((error: unknown) => {
        this.stopActual = undefined;
        throw error;
      });
      this.stopActual = actual;
      actualOperation(() => {
        void this.recoveryRecord;
        return this.driver.stop();
      }).then(dispatch.resolve, dispatch.reject);
    }
    return this.stopActual;
  }
}
