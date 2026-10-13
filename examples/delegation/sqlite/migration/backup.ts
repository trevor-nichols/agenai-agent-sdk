import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fail } from '../errors.js';
import { syncDirectory, type ReferenceFiles } from '../filesystem.js';
import { validateSchema, type SqliteInboxSchema } from '../schema.js';
import { inspectMigrationRecords, migrationContentDigest } from './records.js';

function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** SQLite's online backup API includes committed WAL pages; copying only task.sqlite would lose them. */
export async function createMigrationBackup(database: DatabaseSync, files: ReferenceFiles, inboxSchema: SqliteInboxSchema | undefined, sourceVersion: 1 | 2) {
  const parent = dirname(files.root);
  const root = mkdtempSync(join(parent, `.${basename(files.root)}-format${sourceVersion}-backup-`));
  const identity = lstatSync(root, { bigint: true });
  const assertCurrent = () => {
    files.assertCurrent();
    const retained = lstatSync(root, { bigint: true });
    if (!retained.isDirectory() || retained.dev !== identity.dev || retained.ino !== identity.ino
      || retained.uid !== BigInt(process.getuid!()) || (retained.mode & 0o777n) !== 0o700n) {
      fail('store_failed', 'The private migration backup directory changed.');
    }
  };
  const store = join(root, 'store');
  mkdirSync(store, { mode: 0o700 });
  syncDirectory(parent);
  syncDirectory(root);
  const taskPath = join(store, 'task.sqlite');
  const descriptor = openSync(taskPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(descriptor);
  const sourceDigest = migrationContentDigest(database, inboxSchema !== undefined);
  await backup(database, taskPath);
  assertCurrent();
  copyFileSync(files.ownerPath, join(store, 'owner.sqlite'), constants.COPYFILE_EXCL);
  syncFile(taskPath); syncFile(join(store, 'owner.sqlite')); syncDirectory(store);
  const retained = new DatabaseSync(taskPath, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
  try {
    validateSchema(retained, inboxSchema, sourceVersion);
    inspectMigrationRecords(retained, sourceVersion, inboxSchema !== undefined);
    if (migrationContentDigest(retained, inboxSchema !== undefined) !== sourceDigest) {
      fail('store_failed', 'The synchronized source-format backup differs from the inspected source.');
    }
  } finally { retained.close(); }
  syncDirectory(store);
  const report = {
    sourceFormat: `agenai.delegation.sqlite.v${sourceVersion}`, targetFormat: `agenai.delegation.sqlite.v${sourceVersion + 1}`,
    sourceDigest, digestDefinition: 'SHA256 of sorted exact SQL inventory and sorted typed row values including padded blob bytes; excludes SQLite page layout and user_version.',
    taskFileSha256: createHash('sha256').update(readFileSync(taskPath)).digest('hex'),
    ownerFileSha256: createHash('sha256').update(readFileSync(join(store, 'owner.sqlite'))).digest('hex'),
    runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, filesystem: '0xef53' },
    state: 'backup_validated',
  };
  writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  syncFile(join(root, 'report.json')); syncDirectory(root);
  assertCurrent();
  return { root, sourceDigest, assertCurrent };
}
