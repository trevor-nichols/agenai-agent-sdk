// ------------------------------------------------------------------------------------------------
//                acp-ownership.ts - Fixture cleanup handles and guarded temporary-root retirement
// ------------------------------------------------------------------------------------------------

import { rm } from 'node:fs/promises';
import type { DelegationCoordinator } from '@agen-ai/agent-orchestration';

export interface FixtureLease { release(): Promise<void> }

export async function withCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let primaryError: unknown;
  let failed = false;
  try { return await operation(); }
  catch (error) { primaryError = error; failed = true; throw error; }
  finally {
    try { await cleanup(); }
    catch (cleanupError) {
      if (failed) throw new AggregateError([primaryError, cleanupError], 'Synthetic fixture operation and cleanup both failed.');
      throw cleanupError;
    }
  }
}

export class FixtureCleanupError extends AggregateError {
  constructor(readonly root: string, readonly responsibilities: readonly string[], errors: readonly unknown[],
    readonly retryCleanup: () => Promise<void>) {
    super(errors, 'Synthetic fixture cleanup remains owned; retain its root and retry the exact cleanup handle.');
    this.name = 'FixtureCleanupError';
  }
}

export class FixtureOwnership {
  private readonly leases = new Map<FixtureLease, string>();
  constructor(readonly root: string) {}

  get responsibilities(): readonly string[] { return [...this.leases.values()]; }

  hold(label: string, cleanup: () => Promise<void>): FixtureLease {
    let complete = false;
    let pending: Promise<void> | undefined;
    const lease: FixtureLease = { release: () => {
      if (complete) return Promise.resolve();
      if (!pending) pending = Promise.resolve().then(cleanup).then(() => {
        complete = true;
        this.leases.delete(lease);
      }).finally(() => { pending = undefined; });
      return pending;
    } };
    this.leases.set(lease, label);
    return lease;
  }

  async unwind(lease: FixtureLease, primaryError: unknown): Promise<never> {
    try { await lease.release(); }
    catch (cleanupError) {
      throw new FixtureCleanupError(this.root, this.responsibilities, [primaryError, cleanupError], () => lease.release());
    }
    throw primaryError;
  }

  async retire(): Promise<void> {
    if (this.leases.size) throw new FixtureCleanupError(this.root, this.responsibilities, [], () => this.retryRetirement());
    await rm(this.root, { recursive: true, force: true });
  }

  private async retryRetirement(): Promise<void> {
    const errors: unknown[] = [];
    for (const lease of [...this.leases.keys()]) {
      try { await lease.release(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new FixtureCleanupError(this.root, this.responsibilities, errors, () => this.retryRetirement());
    await this.retire();
  }
}

export function ownCoordinator(ownership: FixtureOwnership, coordinator: DelegationCoordinator): FixtureLease {
  return ownership.hold('delegation coordinator and its child producers', async () => {
    const receipt = await coordinator.dispose({ mode: 'cancel', timeoutMs: 5_000 });
    if (receipt.status !== 'closed') throw new Error('The managed coordinator still owns nonquiescent cleanup.');
  });
}
