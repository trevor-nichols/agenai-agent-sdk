import type { DatabaseSync } from 'node:sqlite';

const tableSql = `CREATE TABLE delegation_parent_inbox (
  store_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  parent_key TEXT NOT NULL,
  parent_revision INTEGER NOT NULL CHECK (parent_revision > 0),
  policy TEXT NOT NULL CHECK (policy IN ('next_turn','automatic')),
  envelope_digest TEXT NOT NULL,
  envelope TEXT NOT NULL CHECK (length(CAST(envelope AS BLOB)) <= 12288),
  inbox_id TEXT NOT NULL UNIQUE,
  accepted_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','dispatch_intended','acknowledged','recovery_required','dismissed')),
  dispatch_id TEXT,
  dispatched_at TEXT,
  settled_at TEXT,
  reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) <= 256),
  PRIMARY KEY (store_id, notification_id)
) STRICT`;
const parentIndexSql = 'CREATE INDEX delegation_parent_inbox_parent ON delegation_parent_inbox(parent_key,state,policy,accepted_at,inbox_id)';
const stateIndexSql = 'CREATE INDEX delegation_parent_inbox_state ON delegation_parent_inbox(state,inbox_id)';
const expected = new Map([
  ['delegation_parent_inbox', tableSql],
  ['delegation_parent_inbox_parent', parentIndexSql],
  ['delegation_parent_inbox_state', stateIndexSql],
]);
const normalize = (sql: string) => sql.replace(/\s+/gu, ' ').trim();

/** The example owns these exact tables in the same database as the child store. */
export const sqliteParentInboxSchema = Object.freeze({
  tables: Object.freeze(['delegation_parent_inbox']),
  indexes: Object.freeze(['delegation_parent_inbox_parent', 'delegation_parent_inbox_state']),
  initialize(database: DatabaseSync): void {
    for (const sql of expected.values()) database.exec(sql);
  },
  validate(database: DatabaseSync): void {
    for (const [name, sql] of expected) {
      const row = database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name);
      if (typeof row?.sql !== 'string' || normalize(row.sql) !== normalize(sql)) {
        throw new Error('The reference parent inbox schema is unsupported.');
      }
    }
  },
});
