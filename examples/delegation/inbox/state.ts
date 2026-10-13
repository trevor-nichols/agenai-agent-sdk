import type { DelegationParentScope } from '@agen-ai/agent-orchestration';
import type { SqliteDelegationDatabase } from '../sqlite/index.js';
import type { ParentDestination, ParentInboxHost } from './types.js';

const lifecycles: ReadonlySet<string> = new Set(['idle', 'running', 'busy', 'waiting', 'stopped', 'paused', 'retired']);

export class ParentInboxContext {
  readonly shutdown = new AbortController();
  closing = false;
  releaseFailed = false;
  active: Promise<unknown> | undefined;
  private recovered = false;

  constructor(readonly database: SqliteDelegationDatabase, readonly host: ParentInboxHost) {}

  ensureRecovered(): void {
    if (this.recovered) return;
    while (true) {
      const ids = this.database.read((database) => database.prepare(
        "SELECT inbox_id FROM delegation_parent_inbox WHERE state = 'dispatch_intended' ORDER BY inbox_id LIMIT 100",
      ).all());
      if (ids.length === 0) break;
      this.database.ordinaryTransaction(4096 * ids.length, (database) => {
        const update = database.prepare("UPDATE delegation_parent_inbox SET state = 'recovery_required', reason = 'prior_executor_lost', settled_at = ? WHERE inbox_id = ? AND state = 'dispatch_intended'");
        const at = new Date().toISOString();
        for (const row of ids) {
          if (typeof row.inbox_id !== 'string') throw new Error('The reference parent inbox identity is invalid.');
          update.run(at, row.inbox_id);
        }
      });
    }
    this.recovered = true;
  }

  assertOpen(): void {
    if (this.closing) throw new Error('The reference parent inbox is closing.');
    this.ensureRecovered();
  }

  destination(parent: DelegationParentScope): ParentDestination | undefined {
    const value = this.host.inspectParent(parent);
    if (value && (!Number.isSafeInteger(value.revision) || value.revision < 1 || !lifecycles.has(value.lifecycle)
      || typeof value.resultAccess !== 'boolean' || typeof value.executionAllowed !== 'boolean')) {
      throw new Error('The reference parent authority is invalid.');
    }
    return value;
  }

  assertResultAccess(parent: DelegationParentScope): void {
    const value = this.destination(parent);
    if (!value || value.revision !== parent.revision || !value.resultAccess) {
      throw new Error('Current parent result authority is unavailable.');
    }
  }
}

export function assertDeliveryDeadline(signal: AbortSignal, deadlineAt: string): void {
  signal.throwIfAborted();
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new DOMException('The reference inbox delivery deadline expired.', 'AbortError');
  }
}
