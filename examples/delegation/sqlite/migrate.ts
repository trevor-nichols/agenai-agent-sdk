import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { sqliteParentInboxSchema } from '../inbox/schema.js';
import { fail } from './errors.js';
import { prepareReferenceFiles } from './filesystem.js';
import { acquireReferenceOwnership } from './ownership.js';
import { validateSchema, type SqliteInboxSchema } from './schema.js';
import { createMigrationBackup } from './migration/backup.js';
import { inspectMigrationRecords, migrationContentDigest, preflightMigrationCapacity } from './migration/records.js';

export type SqliteDelegationMigrationResult =
  | Readonly<{ status: 'already_current'; storeId: string } & (
    { sourceVersion: 2; targetVersion: 2 } | { sourceVersion: 3; targetVersion: 3 })>
  | Readonly<{ status: 'migrated'; storeId: string;
    backupRoot: string; sourceDigest: string; targetDigest: string } & (
    { sourceVersion: 1; targetVersion: 2 } | { sourceVersion: 2; targetVersion: 3 })>;

/** Offline only. The caller must quiesce producers; this operation never constructs or dispatches one. */
export async function migrateSqliteDelegationStore(options: Readonly<{
  root: string;
  inboxSchema?: SqliteInboxSchema;
  targetVersion?: 2 | 3;
}>): Promise<SqliteDelegationMigrationResult> {
  const targetVersion = options.targetVersion ?? 3;
  if (targetVersion !== 2 && targetVersion !== 3) fail('store_failed', 'Offline migration requires target format 2 or 3.');
  if (!existsSync(resolve(options.root))) fail('store_failed', 'Offline migration requires an existing reference store.');
  const files = prepareReferenceFiles(options.root, { existingOnly: true });
  const ownership = acquireReferenceOwnership(files);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(files.taskPath, { allowExtension: false, timeout: 0, enableForeignKeyConstraints: true });
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if ((version !== 1 && version !== 2 && version !== 3) || version > targetVersion) {
      fail('store_failed', `Offline migration cannot open unfamiliar task format ${String(version)}.`);
    }
    if (version === 1 && targetVersion === 3) {
      fail('store_failed', 'Format 1 requires the explicit predecessor migration with targetVersion: 2 before migration to format 3.');
    }
    validateSchema(database, options.inboxSchema, version);
    const source = inspectMigrationRecords(database, version, options.inboxSchema !== undefined);
    if (version === targetVersion) return { status: 'already_current', storeId: source.storeId,
      ...(version === 2 ? { sourceVersion: 2, targetVersion: 2 } : { sourceVersion: 3, targetVersion: 3 }) };
    if (version === 3) fail('store_failed', 'Current format cannot enter a predecessor migration.');
    const retained = await createMigrationBackup(database, files, options.inboxSchema, version);
    const rows = version === 1 ? inspectMigrationRecords(database, 1, options.inboxSchema !== undefined, true) : source;
    preflightMigrationCapacity(database, files.root, rows);
    ownership.assertCurrent(); retained.assertCurrent();
    database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA wal_autocheckpoint=0');
    if (database.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('store_failed', 'Offline migration requires synchronous FULL.');
    database.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after backup awaits before changing any retained row.
      validateSchema(database, options.inboxSchema, version);
      if (migrationContentDigest(database, options.inboxSchema !== undefined) !== retained.sourceDigest) {
        fail('store_failed', 'The offline source changed after its consistent backup.');
      }
      for (const row of rows.runs) database.prepare('UPDATE delegation_runs SET final_blob=? WHERE run_id=?').run(row.blob, row.runId);
      for (const row of rows.inbox) database.prepare('UPDATE delegation_parent_inbox SET envelope=?,envelope_digest=? WHERE inbox_id=?')
        .run(row.envelope, row.digest, row.inboxId);
      database.exec(`PRAGMA user_version=${targetVersion}`);
      validateSchema(database, options.inboxSchema, targetVersion);
      inspectMigrationRecords(database, targetVersion, options.inboxSchema !== undefined);
      preflightMigrationCapacity(database, files.root, rows);
      ownership.assertCurrent(); retained.assertCurrent();
      const targetDigest = migrationContentDigest(database, options.inboxSchema !== undefined);
      database.exec('COMMIT');
      return { status: 'migrated', ...(version === 1 ? { sourceVersion: 1, targetVersion: 2 } : { sourceVersion: 2, targetVersion: 3 }), storeId: rows.storeId,
        backupRoot: retained.root, sourceDigest: retained.sourceDigest, targetDigest };
    } catch (error) { if (database.isTransaction) database.exec('ROLLBACK'); throw error; }
  } finally {
    if (database?.isOpen) database.close();
    ownership.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.slice(2);
  if (args[0] !== '--root' || !args[1] || new Set(flags).size !== flags.length
    || flags.some((flag) => flag !== '--inbox' && flag !== '--target-version=2')) {
    throw new Error('Usage: pnpm exec tsx examples/delegation/sqlite/migrate.ts --root /absolute/store [--inbox] [--target-version=2]');
  }
  const result = await migrateSqliteDelegationStore({ root: args[1],
    ...(flags.includes('--inbox') ? { inboxSchema: sqliteParentInboxSchema } : {}),
    ...(flags.includes('--target-version=2') ? { targetVersion: 2 } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
