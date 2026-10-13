import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fixture from './legacy-v1.json' with { type: 'json' };
import formatTwo from './legacy-v2.json' with { type: 'json' };

export { fixture as legacyFixture, formatTwo as formatTwoFixture };

/** Reconstructs the actual old producer's serialized values, verifying every original padded blob digest. */
export function materializeLegacyStore(root: string): void { materialize(root, fixture); }
export function materializeFormatTwoStore(root: string): void { materialize(root, formatTwo); }

function materialize(root: string, retained: typeof fixture | typeof formatTwo): void {
  mkdirSync(root, { mode: 0o700, recursive: true });
  chmodSync(root, 0o700);
  for (const name of ['task', 'owner'] as const) {
    const path = join(root, `${name}.sqlite`);
    closeSync(openSync(path, 'wx', 0o600));
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    database.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=${name === 'task' ? 'WAL' : 'DELETE'}; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON`);
    const header = name === 'task' ? retained.taskHeader : retained.ownerHeader;
    const schema = name === 'task' ? retained.taskSchema : retained.ownerSchema;
    for (const entry of schema) if (entry.type === 'table' && entry.sql) database.exec(entry.sql);
    for (const entry of schema) if (entry.type === 'index' && entry.sql) database.exec(entry.sql);
    if (name === 'task') for (const table of retained.tables) for (const row of table.rows) {
      const values: SQLInputValue[] = Object.values(row).map((value) => {
        if (value && typeof value === 'object' && 'blob' in value) {
          const bytes = Buffer.alloc(value.bytes, value.empty ? 0 : 0x20);
          if (!value.empty) bytes.write(value.blob, 'utf8');
          assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256, 'Retained real legacy slot digest');
          return bytes;
        }
        return value as SQLInputValue;
      });
      database.prepare(`INSERT INTO ${table.name} (${Object.keys(row).join(',')}) VALUES (${values.map(() => '?').join(',')})`).run(...values);
    }
    else database.exec('INSERT INTO owner_lock VALUES(1)');
    database.exec(`PRAGMA application_id=${header.applicationId}; PRAGMA user_version=${header.userVersion}; COMMIT`);
    database.close();
  }
}
