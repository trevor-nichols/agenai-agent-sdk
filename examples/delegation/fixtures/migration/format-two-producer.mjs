import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [exampleRoot, root, output] = process.argv.slice(2);
if (!exampleRoot || !root || !output)
  throw new Error('Usage: node --import tsx format-two-producer.mjs /frozen/examples/delegation /new/store /output');
const old = await import('@agen-ai/agent-orchestration');
if (old.createInMemoryDelegationStore().contractVersion !== 2)
  throw new Error('The producer requires the matched version-two public implementation.');
old.parseDelegationRunOutcome({ kind: 'failed', error: { category: 'unknown', code: 'old_shape_probe', message: '', recovery: { kind: 'unknown' } } });
const { delegationSubordinateId } = await import('@agen-ai/agent-orchestration/store-adapter');
const { openSqliteDelegationStore } = await import(pathToFileURL(join(exampleRoot, 'sqlite/index.ts')).href);
const { createSqliteParentInbox, sqliteParentInboxSchema } = await import(pathToFileURL(join(exampleRoot, 'inbox/index.ts')).href);
const { admission, fence, prepareAndDispatch } = await import(pathToFileURL(join(exampleRoot, 'fixtures/store.ts')).href);
const opened = openSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
const owner = await opened.store.acquireOwner();
const inbox = createSqliteParentInbox({ database: opened.database, host: { inspectParent: () => ({ revision: 1, lifecycle: 'idle', resultAccess: true, executionAllowed: true }), acquireTurn: () => { throw new Error('Producer must not dispatch a parent.'); } } });
const ids = [];
for (const outcome of [{ kind: 'failed', error: { category: 'unknown', code: 'legacy_child_failed', message: 'Legacy terminal failure retained verbatim.', recovery: { kind: 'unknown' } } }, { kind: 'recovery_required', reason: 'dispatch_uncertain' }]) {
  const command = admission(owner, 'automatic');
  await opened.store.commit(command);
  await prepareAndDispatch(opened.store, owner, command.taskId, command.admission.runId);
  const request = { requestId: `legacy-request:${command.admission.runId}`, requestKind: 'approval', openedAt: new Date().toISOString(), state: 'waiting' };
  await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId), kind: 'request_state', state: 'opened', request, at: request.openedAt });
  const response = await fence(opened.store, owner, command.taskId, command.admission.runId);
  await opened.store.commit({ ...response, kind: 'request_state', state: 'resolution_intended', request, at: new Date().toISOString() });
  await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId), kind: 'request_state', state: 'resolved', request, at: new Date().toISOString() });
  await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId, response.operationId), kind: 'operation_receipt', disposition: 'completed', at: new Date().toISOString() });
  const receipt = await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId), kind: 'settle', at: new Date().toISOString(), outcome });
  const record = await opened.store.read({ kind: 'notification', notificationId: receipt.notificationId });
  if (record.kind !== 'notification' || !record.notification)
      throw new Error('Missing real legacy notification.');
  const accepted = await inbox.port.accept({ envelope: record.notification.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString() });
  if (accepted.status !== 'accepted')
      throw new Error('Missing real legacy inbox acceptance.');
  const attemptId = delegationSubordinateId(receipt.notificationId, 'delivery-attempt:1');
  await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId, delegationSubordinateId(attemptId, 'claim')), kind: 'delivery_claim', notificationId: receipt.notificationId, expectedNotificationRevision: record.notification.revision, attemptId, at: new Date().toISOString() });
  const claimed = await opened.store.read({ kind: 'notification', notificationId: receipt.notificationId });
  if (claimed.kind !== 'notification' || !claimed.notification)
      throw new Error('Missing claim.');
  await opened.store.commit({ ...await fence(opened.store, owner, command.taskId, command.admission.runId, delegationSubordinateId(attemptId, 'receipt')), kind: 'delivery_receipt', notificationId: receipt.notificationId, expectedNotificationRevision: claimed.notification.revision, attemptId, at: new Date().toISOString(), result: accepted });
  ids.push({ taskId: command.taskId, runId: command.admission.runId, notificationId: receipt.notificationId, inboxId: accepted.inboxId });
}
await inbox.dispose();
await opened.store.releaseOwner(owner);
const db = new DatabaseSync(join(root, 'task.sqlite'), { readOnly: true });
const ownerDb = new DatabaseSync(join(root, 'owner.sqlite'), { readOnly: true });
const ownerHeader = { applicationId: ownerDb.prepare('PRAGMA application_id').get().application_id, userVersion: ownerDb.prepare('PRAGMA user_version').get().user_version };
const ownerSchema = ownerDb.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
ownerDb.close();
const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const snapshot = tables.map(({ name, sql }) => ({ name, sql, rows: db.prepare(`SELECT * FROM ${name}`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { blob: value[0] === 0 ? '' : Buffer.from(value).toString('utf8').trimEnd(), bytes: value.byteLength, empty: value[0] === 0, sha256: createHash('sha256').update(value).digest('hex') } : value]))) }));
writeFileSync(join(output, 'legacy-v2.json'), JSON.stringify({ sourceHead: '45ffbebd798c69bc067c3f4b66567321b14df324', runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform }, ids, taskHeader: { applicationId: db.prepare('PRAGMA application_id').get().application_id, userVersion: db.prepare('PRAGMA user_version').get().user_version }, taskSchema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), ownerHeader, ownerSchema, tables: snapshot }, null, 2) + '\n');
db.close();
