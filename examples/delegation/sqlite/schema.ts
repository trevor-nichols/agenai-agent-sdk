// ------------------------------------------------------------------------------------------------
//                schema.ts - Version-three reference tables and fixed physical slots
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseDelegationLimits, type DelegationLimits, type DelegationStoreCapacity } from '@agen-ai/agent-orchestration';
import { delegationCanonicalJson } from '@agen-ai/agent-orchestration/store-adapter';
import { fail } from './errors.js';

export const PAGE_BYTES = 4_096;
export const MAX_DATABASE_BYTES = 536_870_912;
import { APPLICATION_ID, tables, indexes } from './layout.js';

export interface SqliteInboxSchema {
  readonly tables: readonly string[];
  readonly indexes?: readonly string[];
  initialize(database: DatabaseSync): void;
  validate(database: DatabaseSync): void;
}

export const EMPTY_CAPACITY: DelegationStoreCapacity = { tasks: 0, runs: 0, activeRuns: 0, queuedRuns: 0,
  retainedInputBytes: 0, observationBytes: 0, ordinaryOperations: 0, reservedBytes: 0, criticalSlots: 0 };

function schemaCallback(action: (() => void) | undefined): void {
  const result: unknown = action?.();
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    fail('store_failed', 'Reference schema callbacks must complete synchronously.');
  }
}

export function validateSchema(database: DatabaseSync, inbox?: SqliteInboxSchema, version: 1 | 2 | 3 = 3): void {
  if (database.prepare('PRAGMA user_version').get()?.user_version !== version
    || database.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
    || database.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES
    || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
    fail('store_failed', 'The reference SQLite header or schema version is unfamiliar.');
  }
  const actual = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const expected = [...Object.keys(tables), ...(inbox?.tables ?? [])].sort();
  if (actual.length !== expected.length || actual.some((row, index) => row.name !== expected[index])) fail('store_failed', 'The task database contains unfamiliar tables.');
  for (const [name, sql] of Object.entries(tables)) {
    if (actual.find((row) => row.name === name)?.sql !== sql) fail('store_failed', 'A reference table definition changed.');
  }
  const actualIndexes = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
  const coreIndexes = indexes.map((sql) => ({ sql, name: sql.split(' ')[2]! }));
  const expectedIndexes = [...coreIndexes.map((index) => index.name), ...(inbox?.indexes ?? [])].sort();
  if (actualIndexes.length !== expectedIndexes.length || actualIndexes.some((row, index) => row.name !== expectedIndexes[index])
    || coreIndexes.some((index) => actualIndexes.find((row) => row.name === index.name)?.sql !== index.sql)) {
    fail('store_failed', 'The reference index inventory or definition changed.');
  }
  const executable = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','view')").all();
  if (executable.length !== 0) fail('store_failed', 'The reference database cannot contain triggers or views.');
  schemaCallback(inbox ? () => inbox.validate(database) : undefined);
}

export function initializeSchema(database: DatabaseSync, initial: boolean, configured?: Partial<DelegationLimits>, inbox?: SqliteInboxSchema): {
  readonly storeId: string; readonly limits: DelegationLimits;
} {
  // Inspect retained files before any pragma that can change their on-disk format.
  if (!initial) validateSchema(database, inbox);
  database.exec(`PRAGMA busy_timeout=0; PRAGMA page_size=${PAGE_BYTES}; PRAGMA max_page_count=${MAX_DATABASE_BYTES / PAGE_BYTES}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0; PRAGMA trusted_schema=OFF`);
  if (initial) {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of Object.values(tables)) database.exec(sql);
      for (const sql of indexes) database.exec(sql);
      schemaCallback(inbox ? () => inbox.initialize(database) : undefined);
      const limits = parseDelegationLimits(configured ?? {});
      database.prepare('INSERT INTO delegation_state VALUES(1,?,0,NULL,?,?)')
        .run(randomUUID(), delegationCanonicalJson(limits), delegationCanonicalJson(EMPTY_CAPACITY));
      database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=3`);
      validateSchema(database, inbox);
      database.exec('COMMIT');
    } catch (error) { if (database.isTransaction) database.exec('ROLLBACK'); throw error; }
  }
  if (database.prepare('PRAGMA max_page_count').get()?.max_page_count !== MAX_DATABASE_BYTES / PAGE_BYTES
    || database.prepare('PRAGMA synchronous').get()?.synchronous !== 2
    || database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
    fail('store_failed', 'The reference SQLite connection configuration is unavailable.');
  }
  const state = database.prepare('SELECT store_id,limits_json FROM delegation_state WHERE singleton=1').get();
  if (!state || typeof state.store_id !== 'string' || typeof state.limits_json !== 'string') fail('store_failed', 'The reference store header is unavailable.');
  const limits = parseDelegationLimits(JSON.parse(state.limits_json));
  if (configured && delegationCanonicalJson(limits) !== delegationCanonicalJson(parseDelegationLimits(configured))) {
    fail('store_failed', 'Reopening a retained store cannot change its configured limits.');
  }
  return { storeId: state.store_id, limits };
}
