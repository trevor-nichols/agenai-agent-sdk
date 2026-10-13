// ------------------------------------------------------------------------------------------------
//                ownership.ts - Separate lifetime SQLite writer ownership
// ------------------------------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.js';
import type { ReferenceFiles } from './filesystem.js';

const OWNER_APPLICATION_ID = 0x4147444f;
const OWNER_TABLE_SQL = 'CREATE TABLE owner_lock (singleton INTEGER PRIMARY KEY CHECK(singleton=1))';

export interface ReferenceOwnership {
  assertCurrent(): void;
  release(): void;
}

export function acquireReferenceOwnership(files: ReferenceFiles): ReferenceOwnership {
  files.assertCurrent();
  const connection = new DatabaseSync(files.ownerPath, { allowExtension: false, timeout: 0 });
  try {
    connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch {
    connection.close();
    return fail('owner_lost', 'Another live local process owns this reference store.');
  }
  try {
    if (files.initial) {
      connection.exec(`PRAGMA application_id=${OWNER_APPLICATION_ID}; PRAGMA user_version=1; ${OWNER_TABLE_SQL}; INSERT INTO owner_lock VALUES(1); COMMIT; BEGIN IMMEDIATE`);
    } else {
      const application = connection.prepare('PRAGMA application_id').get();
      const version = connection.prepare('PRAGMA user_version').get();
      const schema = connection.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
      const row = connection.prepare('SELECT singleton FROM owner_lock').all();
      if (application?.application_id !== OWNER_APPLICATION_ID || version?.user_version !== 1
        || schema.length !== 1 || schema[0]?.type !== 'table' || schema[0].name !== 'owner_lock'
        || schema[0].sql !== OWNER_TABLE_SQL || row.length !== 1 || row[0]?.singleton !== 1) {
        fail('store_failed', 'The exclusive-owner database schema is unfamiliar.');
      }
    }
    files.assertCurrent();
  } catch (error) {
    if (connection.isOpen && connection.isTransaction) connection.exec('ROLLBACK');
    connection.close();
    throw error;
  }
  let released = false;
  return {
    assertCurrent() {
      if (released || !connection.isOpen || !connection.isTransaction) fail('owner_lost', 'The exclusive local SQLite transaction is unavailable.');
      files.assertCurrent();
    },
    release() {
      if (released) return;
      if (connection.isOpen && connection.isTransaction) connection.exec('ROLLBACK');
      if (connection.isOpen) connection.close();
      released = true;
    },
  };
}
