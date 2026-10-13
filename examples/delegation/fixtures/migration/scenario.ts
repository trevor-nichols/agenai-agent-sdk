import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDelegationCoordinator } from '@agen-ai/agent-orchestration';
import { openSqliteDelegationStore } from '../../sqlite/index.js';
import { migrateSqliteDelegationStore } from '../../sqlite/migrate.js';
import { createSqliteParentInbox, sqliteParentInboxSchema } from '../../inbox/index.js';
import { legacyFixture, formatTwoFixture } from './materialize.js';
import { createReferenceHost } from '../host.js';

const [root, requestedMode] = process.argv.slice(2);
const sourceFormat = requestedMode?.endsWith('_v2') ? 2 : 1;
const mode = requestedMode?.replace(/_v2$/u, '');
const fixture = sourceFormat === 2 ? formatTwoFixture : legacyFixture;
if (!root || !mode) throw new Error('A reference root and migration scenario are required.');
try {
  if (mode === 'before_commit' || mode === 'after_commit') {
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql === 'COMMIT') {
        if (mode === 'after_commit') original.call(this, sql);
        process.send?.({ event: mode });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error('Crash qualification requires SIGKILL at the real migration COMMIT boundary.');
      }
      return original.call(this, sql);
    };
    await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema, targetVersion: sourceFormat === 1 ? 2 : 3 });
  } else if (mode === 'reopen') {
    const opened = openSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
    const owner = await opened.store.acquireOwner();
    let providerInvocations = 0;
    const inbox = createSqliteParentInbox({ database: opened.database,
      host: { inspectParent: () => ({ revision: 1, lifecycle: 'idle', resultAccess: true, executionAllowed: true }),
        acquireTurn() { providerInvocations += 1; throw new Error('Reopen must not dispatch a provider.'); } } });
    try {
      const rows = [];
      for (const id of fixture.ids) {
        const run = await opened.store.read({ kind: 'run', taskId: id.taskId, runId: id.runId });
        const task = await opened.store.read({ kind: 'task', taskId: id.taskId });
        const notification = await opened.store.read({ kind: 'notification', notificationId: id.notificationId });
        assert.equal(run.kind, 'run'); assert.equal(task.kind, 'task'); assert.equal(notification.kind, 'notification');
        assert.ok(notification.notification);
        const entry = inbox.inspect({ parent: notification.notification.envelope.parent, storeId: opened.store.storeId, notificationId: id.notificationId });
        const redelivery = await inbox.port.accept({ envelope: notification.notification.envelope, signal: new AbortController().signal,
          deadlineAt: new Date(Date.now() + 10_000).toISOString() });
        const historicalReceipts = [];
        if (sourceFormat === 2) {
          assert.ok(run.run); assert.ok(task.view);
          const operations = await opened.store.read({ kind: 'operations', taskId: id.taskId, runId: id.runId });
          assert.equal(operations.kind, 'operations');
          for (const operation of operations.page.items.filter((record) => record.kind === 'request_resolution')) {
            assert.equal(operation.disposition, 'completed');
            const duplicate = await opened.store.commit({ owner, kind: 'operation_receipt', operationId: operation.operationId,
              inputDigest: operation.inputDigest, taskId: id.taskId, runId: id.runId,
              expectedTaskRevision: task.view.task.revision, expectedRunRevision: run.run.revision,
              disposition: 'completed', at: operation.at, ...(operation.message ? { message: operation.message } : {}) });
            assert.deepEqual(duplicate, { ...operation.receipt, duplicate: true });
            const after = await opened.store.read({ kind: 'operation', parent: operation.parent, operationId: operation.operationId });
            assert.equal(after.kind, 'operation'); assert.deepEqual(after.operation, operation);
            historicalReceipts.push(duplicate);
          }
        }
        rows.push({ id, run, task, notification, entry, redelivery, historicalReceipts });
      }
      process.send?.({ event: 'complete', detail: { rows, providerInvocations } });
    } finally { await inbox.dispose(); await opened.store.releaseOwner(owner); }
  } else if (mode === 'recover_history') {
    const opened = openSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
    let childInvocations = 0;
    let parentInvocations = 0;
    let routedRequests = 0;
    const reference = await createReferenceHost({ root, onInvoke() { childInvocations += 1; }, onRequest() { routedRequests += 1; } });
    const inbox = createSqliteParentInbox({ database: opened.database,
      host: { inspectParent: () => ({ revision: 1, lifecycle: 'idle', resultAccess: true, executionAllowed: true }),
        acquireTurn() { parentInvocations += 1; throw new Error('Historical collection must not dispatch a parent.'); } } });
    const coordinator = await createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits, parentDelivery: inbox.port });
    try {
      assert.deepEqual((await coordinator.recover({ limit: 100 })).recovered, []);
      const runs = [];
      for (const id of fixture.ids) {
        const row = await opened.store.read({ kind: 'run', taskId: id.taskId, runId: id.runId });
        assert.equal(row.kind, 'run'); assert.ok(row.run);
        runs.push({ phase: row.run.phase, requestState: row.run.pendingRequest?.state });
      }
      process.send?.({ event: 'complete', detail: { childInvocations, parentInvocations, routedRequests, runs } });
    } finally {
      assert.equal((await coordinator.dispose({ mode: 'drain', timeoutMs: 1_000 })).status, 'closed');
      await inbox.dispose(); await reference.registry.dispose();
    }
  } else if (mode === 'owner') {
    const opened = openSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
    const owner = await opened.store.acquireOwner();
    process.send?.({ event: 'owned' });
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
    await opened.store.releaseOwner(owner);
  } else throw new Error('Unknown migration scenario.');
  process.disconnect?.();
} catch (error) {
  process.send?.({ event: 'error', detail: { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined } });
  process.exitCode = 1; process.disconnect?.();
}
