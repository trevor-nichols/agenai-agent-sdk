import type { SqliteDelegationDatabase } from '../sqlite/index.js';
import { createAcceptancePort } from './acceptance.js';
import { dispatchPending } from './dispatch.js';
import { parentKey, readInboxRow } from './records.js';
import { ParentInboxContext } from './state.js';
import type { ParentInboxHost, SqliteParentInbox } from './types.js';

export { sqliteParentInboxSchema } from './schema.js';
export type { ParentDestination, ParentDispatchReceipt, ParentInboxHost, ParentInboxState, ParentInboxView, ParentLifecycle, ParentTurnLease, SqliteParentInbox } from './types.js';

const ownedDatabases = new WeakSet<SqliteDelegationDatabase>();

export function createSqliteParentInbox(options: Readonly<{
  database: SqliteDelegationDatabase;
  host: ParentInboxHost;
}>): SqliteParentInbox {
  if (ownedDatabases.has(options.database)) throw new Error('This reference database already has its parent inbox owner.');
  ownedDatabases.add(options.database);
  const context = new ParentInboxContext(options.database, options.host);
  return Object.freeze({
    port: createAcceptancePort(context),
    inspect(input) {
      context.assertOpen();
      context.assertResultAccess(input.parent);
      return context.database.read((database) => {
        const row = database.prepare('SELECT * FROM delegation_parent_inbox WHERE store_id = ? AND notification_id = ?')
          .get(input.storeId, input.notificationId);
        if (!row) return undefined;
        const retained = readInboxRow(row);
        if (parentKey(retained.envelope.parent) !== parentKey(input.parent) || retained.envelope.parent.revision !== input.parent.revision) {
          throw new Error('The reference inbox record belongs to another parent scope.');
        }
        return retained;
      });
    },
    async dispatchPending(input) {
      if (context.active) throw new Error('The reference inbox already has an active dispatch page.');
      const pending = Promise.resolve().then(() => dispatchPending(context, input));
      context.active = pending;
      try { return await pending; } finally { context.active = undefined; }
    },
    async dispose(input = {}) {
      const timeoutMs = input.timeoutMs ?? 10_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('The inbox shutdown timeout must be finite.');
      context.closing = true;
      context.shutdown.abort(new DOMException('The reference parent inbox is closing.', 'AbortError'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([context.active?.catch(() => undefined) ?? Promise.resolve(), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      } finally { if (timer) clearTimeout(timer); }
      return { status: context.active || context.releaseFailed ? 'recovery_required' : 'closed' };
    },
  } satisfies SqliteParentInbox);
}
