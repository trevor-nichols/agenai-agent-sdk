import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import test from 'node:test';
import { sqliteParentInboxSchema } from '../inbox/index.js';
import { materializeLegacyStore, materializeFormatTwoStore, legacyFixture, formatTwoFixture } from '../fixtures/migration/materialize.js';
import { temporaryRoot } from '../fixtures/journal.js';
import { startScenario } from '../fixtures/process.js';
import { openSqliteDelegationStore } from '../sqlite/index.js';
import { migrateSqliteDelegationStore } from '../sqlite/migrate.js';

const migrationPeer = new URL('../fixtures/migration/scenario.ts', import.meta.url);
const options = (root: string) => ({ root, inboxSchema: sqliteParentInboxSchema, targetVersion: 2 as const });
const decode = (value: SQLOutputValue | undefined) => JSON.parse(Buffer.from(value as Uint8Array).toString('utf8')) as Record<string, any>;
function encode(value: unknown, bytes = 32_768): Buffer {
  const result = Buffer.alloc(bytes, 0x20); result.write(JSON.stringify(value), 'utf8'); return result;
}
function inspect(root: string, action: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(join(root, 'task.sqlite'));
  try { action(database); } finally { database.close(); }
}
function version(root: string): number {
  const database = new DatabaseSync(join(root, 'task.sqlite'), { readOnly: true });
  try { return Number(database.prepare('PRAGMA user_version').get()?.user_version); } finally { database.close(); }
}
function retainedRows(root: string) {
  const database = new DatabaseSync(join(root, 'task.sqlite'), { readOnly: true });
  try {
    return legacyFixture.tables.map((table) => ({ name: table.name,
      rows: database.prepare(`SELECT * FROM ${table.name} ORDER BY ${Object.keys(table.rows[0] ?? {}).join(',') || '1'}`).all()
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
          value instanceof Uint8Array ? { blob: Buffer.from(value).toString('utf8') } : value]))) }));
  } finally { database.close(); }
}
function parseFinal(row: Record<string, unknown>): Record<string, any> {
  return JSON.parse((row.final_blob as { blob: string }).blob) as Record<string, any>;
}
async function legacyDirectory(t: test.TestContext, format: 1 | 2 = 1) {
  const directory = await temporaryRoot();
  const root = join(directory.root, 'database');
  if (format === 1) materializeLegacyStore(root); else materializeFormatTwoStore(root);
  t.after(() => directory.remove());
  return { root, directory: directory.root };
}
function expectedOutcome(outcome: Record<string, any>) {
  return outcome.kind === 'failed' ? { ...outcome, error: { ...outcome.error, category: 'unknown', recovery: { kind: 'unknown' } } } : outcome;
}

// This is the format contract owner: actual baseline rows cross the offline boundary and another process reads them.
test('actual format-one task/inbox rows migrate together, preserve historical data, and reopen without dispatch', { timeout: 30_000 }, async (t) => {
  const { root, directory } = await legacyDirectory(t);
  const before = retainedRows(root);
  const ownerBytes = readFileSync(join(root, 'owner.sqlite'));
  assert.throws(() => openSqliteDelegationStore(options(root)), /schema version is unfamiliar/);
  const result = await migrateSqliteDelegationStore(options(root));
  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') throw new Error('Expected migration.');
  assert.equal(version(root), 2);
  assert.ok(readFileSync(join(root, 'owner.sqlite')).equals(ownerBytes), 'Owner database identity and format remain unchanged.');
  assert.equal(version(join(result.backupRoot, 'store')), 1);
  assert.deepEqual(retainedRows(join(result.backupRoot, 'store')), before);
  assert.equal(readdirSync(root).some((name) => name.includes('backup') || name.endsWith('.json')), false);
  assert.ok(result.backupRoot.startsWith(join(directory, '.database-format1-backup-')));
  const report = JSON.parse(readFileSync(join(result.backupRoot, 'report.json'), 'utf8')) as { sourceDigest: string; taskFileSha256: string };
  assert.equal(report.sourceDigest, result.sourceDigest);
  assert.equal(report.taskFileSha256, createHash('sha256').update(readFileSync(join(result.backupRoot, 'store/task.sqlite'))).digest('hex'));
  const after = retainedRows(root);
  for (const table of before) {
    const changed = after.find((candidate) => candidate.name === table.name)!;
    if (!['delegation_runs', 'delegation_parent_inbox'].includes(table.name)) assert.deepEqual(changed, table, `${table.name} historical rows remain byte-identical`);
    else for (const [index, oldRow] of table.rows.entries()) {
      const newRow = changed.rows[index]!;
      if (table.name === 'delegation_runs') {
        const { final_blob: _old, ...oldFields } = oldRow;
        const { final_blob: _new, ...newFields } = newRow;
        assert.deepEqual(newFields, oldFields, 'All indexed columns and critical receipts survive.');
        const oldFinal = parseFinal(oldRow); const newFinal = parseFinal(newRow);
        const expected = structuredClone(oldFinal);
        expected.run.outcome = expectedOutcome(expected.run.outcome);
        expected.notification.envelope.outcome = expectedOutcome(expected.notification.envelope.outcome);
        assert.deepEqual(newFinal, expected, 'Only explicit unknown failure fields change.');
      } else {
        const { envelope: oldEncoded, envelope_digest: _old, ...oldFields } = oldRow;
        const { envelope: newEncoded, envelope_digest: newDigest, ...newFields } = newRow;
        assert.deepEqual(newFields, oldFields, 'Inbox IDs, state, dispatch evidence and timestamps survive.');
        const oldEnvelope = JSON.parse(String(oldEncoded)); const next = JSON.parse(String(newEncoded));
        assert.deepEqual(next, { ...oldEnvelope, outcome: expectedOutcome(oldEnvelope.outcome) });
        assert.equal(newDigest, createHash('sha256').update(String(newEncoded)).digest('hex'), 'Stored canonical envelope and digest agree.');
      }
    }
  }
  assert.deepEqual(await migrateSqliteDelegationStore(options(root)), {
    status: 'already_current', sourceVersion: 2, targetVersion: 2, storeId: before.find((table) => table.name === 'delegation_state')!.rows[0]!.store_id,
  });
  assert.deepEqual(retainedRows(root), after, 'Already-current validation performs no record mutation.');
  await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
  const child = startScenario(root, 'reopen', {}, migrationPeer); t.after(() => child.stop());
  const reopened = await child.complete() as { rows: Record<string, any>[]; providerInvocations: number };
  assert.equal(reopened.providerInvocations, 0);
  assert.equal(reopened.rows.length, 2);
  for (const row of reopened.rows) {
    const original = legacyFixture.ids.find((id) => id.runId === row.id.runId)!;
    assert.equal(row.entry.inboxId, original.inboxId); assert.equal(row.entry.state, 'pending');
    assert.equal(row.redelivery.inboxId, original.inboxId); assert.equal(row.redelivery.acceptedAt, row.entry.acceptedAt);
    assert.deepEqual(row.run.run.outcome, row.notification.notification.envelope.outcome);
    assert.deepEqual(row.entry.envelope, row.notification.notification.envelope);
  }
  assert.deepEqual(reopened.rows.map((row) => row.run.run.outcome), [
    { kind: 'failed', error: { category: 'unknown', code: 'legacy_child_failed', message: 'Legacy terminal failure retained verbatim.', recovery: { kind: 'unknown' } } },
    { kind: 'recovery_required', reason: 'dispatch_uncertain' },
  ]);
});


test('task-only version-one stores retain their explicit absence of inbox tables', async (t) => {
  const { root } = await legacyDirectory(t);
  inspect(root, (db) => { db.exec('DROP TABLE delegation_parent_inbox'); });
  const result = await migrateSqliteDelegationStore({ root, targetVersion: 2 });
  assert.equal(result.status, 'migrated'); assert.equal(version(root), 2);
  inspect(root, (db) => {
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='delegation_parent_inbox'").get()?.count, 0);
  });
  await migrateSqliteDelegationStore({ root });
  const opened = openSqliteDelegationStore({ root });
  opened.closeUnused();
  await assert.rejects(migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema }), /unfamiliar tables/);
});

for (const stage of ['before_commit', 'after_commit'] as const) {
  test(`SIGKILL ${stage} leaves one complete paired format and a restorable old backup`, { timeout: 30_000 }, async (t) => {
    const { root, directory } = await legacyDirectory(t);
    const before = retainedRows(root);
    const child = startScenario(root, stage, {}, migrationPeer); t.after(() => child.stop());
    await child.wait(stage); await child.kill();
    assert.equal(version(root), stage === 'before_commit' ? 1 : 2);
    const backup = join(directory, readdirSync(directory).find((name) => name.startsWith('.database-format1-backup-'))!, 'store');
    assert.equal(version(backup), 1); assert.deepEqual(retainedRows(backup), before);
    if (stage === 'before_commit') assert.deepEqual(retainedRows(root), before);
    const resumed = await migrateSqliteDelegationStore(options(root));
    assert.equal(resumed.status, stage === 'before_commit' ? 'migrated' : 'already_current');
    await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
    const reopened = startScenario(root, 'reopen', {}, migrationPeer); t.after(() => reopened.stop());
    assert.equal((await reopened.complete() as { providerInvocations: number }).providerInvocations, 0);
  });
}

test('consistent migration backup includes committed WAL frames', { timeout: 30_000 }, async (t) => {
  const { root } = await legacyDirectory(t);
  const keeper = new DatabaseSync(join(root, 'task.sqlite'));
  t.after(() => keeper.close());
  keeper.exec('PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL');
  const at = '2026-10-11T21:00:00.000Z';
  keeper.prepare('UPDATE delegation_parent_inbox SET accepted_at=?').run(at);
  assert.ok(readFileSync(join(root, 'task.sqlite-wal')).length > 32);
  const result = await migrateSqliteDelegationStore(options(root));
  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') throw new Error('Expected migration.');
  const backup = new DatabaseSync(join(result.backupRoot, 'store/task.sqlite'), { readOnly: true });
  try { assert.deepEqual(backup.prepare('SELECT accepted_at FROM delegation_parent_inbox').all().map((row) => row.accepted_at), [at, at]); }
  finally { backup.close(); }
});

const refusals: readonly Readonly<{ name: string; expected: RegExp; alter: (database: DatabaseSync) => void }>[] = [
  { name: 'newer version', expected: /unfamiliar task format 3/, alter: (db) => db.exec('PRAGMA user_version=3') },
  { name: 'unfamiliar physical schema', expected: /unfamiliar tables/, alter: (db) => db.exec('CREATE TABLE unfamiliar (value TEXT) STRICT') },
  { name: 'nonsettled run', expected: /non-settled runs/, alter(db) {
    const row = db.prepare('SELECT * FROM delegation_runs ORDER BY run_id LIMIT 1').get()!; const value = decode(row.final_blob);
    value.run.phase = 'running'; delete value.run.outcome; delete value.run.settledAt;
    db.prepare("UPDATE delegation_runs SET phase='running',unsettled=1,final_blob=? WHERE run_id=?").run(encode(value), String(row.run_id));
  } },
  { name: 'claimed notification', expected: /claimed notifications/, alter(db) {
    const row = db.prepare('SELECT * FROM delegation_runs ORDER BY run_id LIMIT 1').get()!; const value = decode(row.final_blob);
    value.notification.state = 'claimed'; value.notification.claim = { ownerEpoch: 1, attemptId: randomUUID() };
    db.prepare('UPDATE delegation_runs SET final_blob=? WHERE run_id=?').run(encode(value), String(row.run_id));
    db.prepare("UPDATE delegation_notifications SET state='claimed',owner_epoch=1,candidate=1 WHERE run_id=?").run(String(row.run_id));
  } },
  { name: 'dispatch-intended inbox', expected: /dispatch-intended inbox/, alter: (db) => { db.exec("UPDATE delegation_parent_inbox SET state='dispatch_intended'"); } },
  { name: 'mismatched inbox digest', expected: /paired task\/envelope, digest/, alter: (db) => { db.exec("UPDATE delegation_parent_inbox SET envelope_digest=printf('%064d',0)"); } },
  { name: 'mismatched task and inbox content', expected: /paired task\/envelope, digest/, alter(db) {
    const row = db.prepare('SELECT * FROM delegation_parent_inbox LIMIT 1').get()!; const envelope = JSON.parse(String(row.envelope));
    envelope.settledAt = '2026-10-11T19:00:00.000Z'; const encoded = canonical(envelope);
    db.prepare('UPDATE delegation_parent_inbox SET envelope=?,envelope_digest=? WHERE inbox_id=?')
      .run(encoded, createHash('sha256').update(encoded).digest('hex'), String(row.inbox_id));
  } },
];
function canonical(value: unknown): string {
  const order = (data: unknown): unknown => Array.isArray(data) ? data.map(order) : data && typeof data === 'object'
    ? Object.fromEntries(Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, order(child)])) : data;
  return JSON.stringify(order(value));
}
for (const refusal of refusals) test(`offline migration refuses ${refusal.name} without changing retained rows`, async (t) => {
  const { root } = await legacyDirectory(t); inspect(root, refusal.alter);
  const before = retainedRows(root); const oldVersion = version(root);
  await assert.rejects(migrateSqliteDelegationStore(options(root)), refusal.expected);
  assert.equal(version(root), oldVersion); assert.deepEqual(retainedRows(root), before);
});

test('a valid old 2KiB failure that exceeds the richer format is refused without truncation', async (t) => {
  const { root, directory } = await legacyDirectory(t);
  const error = { code: 'legacy_child_failed', message: 'x'.repeat(2_048 - Buffer.byteLength(JSON.stringify({ code: 'legacy_child_failed', message: '' }))) };
  assert.equal(Buffer.byteLength(JSON.stringify(error)), 2_048);
  inspect(root, (db) => {
    const row = db.prepare('SELECT * FROM delegation_runs WHERE run_id=?').get(legacyFixture.ids[0]!.runId)!; const value = decode(row.final_blob);
    value.run.outcome.error = error; value.notification.envelope.outcome.error = error;
    db.prepare('UPDATE delegation_runs SET final_blob=? WHERE run_id=?').run(encode(value), String(row.run_id));
    const envelope = canonical(value.notification.envelope);
    db.prepare('UPDATE delegation_parent_inbox SET envelope=?,envelope_digest=? WHERE notification_id=?')
      .run(envelope, createHash('sha256').update(envelope).digest('hex'), legacyFixture.ids[0]!.notificationId);
  });
  const before = retainedRows(root);
  await assert.rejects(migrateSqliteDelegationStore(options(root)), /target format 2 preflight failed/);
  assert.equal(version(root), 1); assert.deepEqual(retainedRows(root), before);
  const backup = join(directory, readdirSync(directory).find((name) => name.startsWith('.database-format1-backup-'))!, 'store');
  assert.deepEqual(retainedRows(backup), before, 'The precise refusal retains its lossless old backup.');
});

test('an exclusive live owner blocks migration and current-format no-op still validates paired records', { timeout: 30_000 }, async (t) => {
  const { root } = await legacyDirectory(t); await migrateSqliteDelegationStore(options(root));
  await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
  const child = startScenario(root, 'owner', {}, migrationPeer); t.after(() => child.stop());
  await child.wait('owned');
  await assert.rejects(migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema }), /Another live local process owns this reference store/);
  await child.kill();
  inspect(root, (db) => { db.exec("UPDATE delegation_parent_inbox SET envelope_digest=printf('%064d',0)"); });
  await assert.rejects(migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema }), /paired task\/envelope, digest/);
  assert.equal(version(root), 3);
});

// Format two completed a continuation stream. The migration preserves that stronger historical truth.
test('real format-two request receipts migrate without rewriting history or restoring callbacks', { timeout: 30_000 }, async (t) => {
  const { root } = await legacyDirectory(t, 2);
  const before = retainedRows(root);
  assert.throws(() => openSqliteDelegationStore(options(root)), /schema version is unfamiliar/);
  const result = await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') throw new Error('Expected migration.');
  assert.equal(result.sourceVersion, 2); assert.equal(result.targetVersion, 3);
  assert.equal(result.sourceDigest, result.targetDigest, 'Only the format header advances; exact retained values are unchanged.');
  assert.equal(version(root), 3); assert.equal(version(join(result.backupRoot, 'store')), 2);
  assert.deepEqual(retainedRows(root), before);
  assert.deepEqual(retainedRows(join(result.backupRoot, 'store')), before);
  const operations = before.find((table) => table.name === 'delegation_operations')!.rows
    .map((row) => JSON.parse((row.data_blob as { blob: string }).blob)).filter((operation) => operation.kind === 'request_resolution');
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map((operation) => operation.disposition), ['completed', 'completed']);
  await assert.rejects(migrateSqliteDelegationStore(options(root)), /unfamiliar task format 3/, 'The current migrator refuses an obsolete target version.');
  const again = await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
  assert.equal(again.status, 'already_current'); assert.equal(again.sourceVersion, 3); assert.equal(again.targetVersion, 3);
  assert.deepEqual(retainedRows(root), before);
  const child = startScenario(root, 'reopen_v2', {}, migrationPeer); t.after(() => child.stop());
  const reopened = await child.complete() as { rows: Record<string, any>[]; providerInvocations: number };
  assert.equal(reopened.providerInvocations, 0); assert.equal(reopened.rows.length, formatTwoFixture.ids.length);
  for (const row of reopened.rows) {
    assert.equal(row.run.run.phase, 'settled'); assert.equal(row.run.run.pendingRequest.state, 'unavailable');
    assert.deepEqual(row.entry.envelope, row.notification.notification.envelope);
    assert.equal(row.entry.inboxId, row.redelivery.inboxId);
    assert.equal(row.historicalReceipts.length, 1);
    assert.equal(row.historicalReceipts[0].duplicate, true);
  }
  const recovery = startScenario(root, 'recover_history_v2', {}, migrationPeer); t.after(() => recovery.stop());
  assert.deepEqual(await recovery.complete(), { childInvocations: 0, parentInvocations: 0, routedRequests: 0,
    runs: [{ phase: 'settled', requestState: 'unavailable' }, { phase: 'settled', requestState: 'unavailable' }] });
  const afterRecovery = retainedRows(root);
  for (const historical of before) {
    const current = afterRecovery.find((table) => table.name === historical.name)!;
    if (historical.name === 'delegation_state') {
      const previous = historical.rows[0]!;
      assert.equal(current.rows[0]!.owner_epoch, Number(previous.owner_epoch) + 2);
      assert.deepEqual({ ...current.rows[0], owner_epoch: previous.owner_epoch, owner_nonce: previous.owner_nonce }, previous,
        'Fresh process ownership may advance; retained capacity and store identity must not change.');
    } else assert.deepEqual(current, historical, 'Current duplicate receipts and coordinator recovery cannot rewrite historical rows.');
  }
});

for (const stage of ['before_commit', 'after_commit'] as const) {
  test(`format-two SIGKILL ${stage} preserves historical receipts and converges on format three`, { timeout: 30_000 }, async (t) => {
    const { root, directory } = await legacyDirectory(t, 2);
    const before = retainedRows(root);
    const child = startScenario(root, `${stage}_v2`, {}, migrationPeer); t.after(() => child.stop());
    await child.wait(stage); await child.kill();
    assert.equal(version(root), stage === 'before_commit' ? 2 : 3);
    assert.deepEqual(retainedRows(root), before);
    const backup = join(directory, readdirSync(directory).find((name) => name.startsWith('.database-format2-backup-'))!, 'store');
    assert.equal(version(backup), 2); assert.deepEqual(retainedRows(backup), before);
    const result = await migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema });
    assert.equal(result.status, stage === 'before_commit' ? 'migrated' : 'already_current');
    assert.equal(version(root), 3); assert.deepEqual(retainedRows(root), before);
  });
}

const requestRefusals = [
  { name: 'unresolved callback authority', alter(db: DatabaseSync) {
    const row = db.prepare('SELECT * FROM delegation_runs ORDER BY run_id LIMIT 1').get()!;
    const value = decode(row.final_blob); value.run.pendingRequest.state = 'resolution_intended';
    db.prepare('UPDATE delegation_runs SET final_blob=? WHERE run_id=?').run(encode(value), String(row.run_id));
  }, expected: /live request authority/ },
  { name: 'outstanding response intent', alter(db: DatabaseSync) {
    const row = db.prepare("SELECT * FROM delegation_operations WHERE json_extract(CAST(data_blob AS TEXT),'$.kind')='request_resolution' LIMIT 1").get()!;
    const value = decode(row.data_blob); value.disposition = 'intent';
    db.prepare('UPDATE delegation_operations SET data_blob=? WHERE operation_id=?').run(encode(value, 2_048), String(row.operation_id));
  }, expected: /outstanding request intents/ },
  ...refusals.filter((refusal) => ['nonsettled run', 'claimed notification', 'dispatch-intended inbox'].includes(refusal.name)),
];
for (const refusal of requestRefusals) test(`format-two migration refuses ${refusal.name} without changing history`, async (t) => {
  const { root } = await legacyDirectory(t, 2); inspect(root, refusal.alter);
  const before = retainedRows(root);
  await assert.rejects(migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema }), refusal.expected);
  assert.equal(version(root), 2); assert.deepEqual(retainedRows(root), before);
});

test('format-one input must complete the explicit predecessor before current migration', async (t) => {
  const { root } = await legacyDirectory(t); const before = retainedRows(root);
  await assert.rejects(migrateSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema }), /explicit predecessor/);
  assert.equal(version(root), 1); assert.deepEqual(retainedRows(root), before);
});
