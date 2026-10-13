// ------------------------------------------------------------------------------------------------
//                database.ts - Guarded synchronous example transactions and producer ownership
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DelegationOperationError, parseDelegationOwnerToken, type DelegationOwnerToken, type DelegationStoreCapacity } from '@agen-ai/agent-orchestration';
import { assertPhysicalCapacity, readCapacity } from './capacity.js';
import { fail, sqliteFailure } from './errors.js';
import type { ReferenceFiles } from './filesystem.js';
import type { ReferenceOwnership } from './ownership.js';

export interface SqliteDelegationDatabase {
  assertCurrent(): void;
  read<Value>(action: (database: DatabaseSync) => Value): Value;
  ordinaryTransaction<Value>(bytes: number, action: (database: DatabaseSync) => Value): Value;
  retainProducer(): () => void;
}

function synchronous<Value>(value: Value): Value {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') fail('store_failed', 'Reference database callbacks must complete synchronously.');
  return value;
}

function isFatalSqliteError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'errcode' in error
    && typeof error.errcode === 'number' && [5, 6, 7, 8, 10, 11, 13, 14, 15, 26].includes(error.errcode & 0xff);
}

export function createReferenceDatabase(connection: DatabaseSync, files: ReferenceFiles, ownership: ReferenceOwnership, storeId: string) {
  let owner: DelegationOwnerToken | undefined;
  let failed = false;
  let closed = false;
  let acquired = false;
  let producers = 0;
  const databaseFailure = (error: unknown): never => {
    if (isFatalSqliteError(error)) { failed = true; return sqliteFailure(error); }
    throw error;
  };
  const guard = (requireOwner = true) => {
    if (closed) fail('owner_lost', 'The reference database handle is closed.');
    if (failed) fail('store_failed', 'The failed reference owner retains its lock until producers quiesce or the process terminates.');
    try {
      ownership.assertCurrent();
      if (!connection.isOpen || (requireOwner && !owner)) fail('owner_lost', 'The reference store has no current acquired owner.');
      if (owner) {
        const retained = connection.prepare('SELECT owner_epoch,owner_nonce FROM delegation_state WHERE singleton=1').get();
        if (retained?.owner_epoch !== owner.epoch || retained.owner_nonce !== owner.nonce) fail('owner_lost', 'The persisted owner fence changed.');
      }
    } catch (error) { failed = true; if (error instanceof DelegationOperationError) throw error; fail('owner_lost', 'The reference owner or stable database files are unavailable.'); }
  };
  const transaction = <Value>(ordinaryBytes: number, assignedWriteBytes: number,
    action: (database: DatabaseSync) => Value, capacity?: DelegationStoreCapacity, requireOwner = true, checkCapacity = true): Value => {
    guard(requireOwner);
    if (connection.isTransaction) fail('store_failed', 'Nested reference transactions are unsupported.');
    try {
      connection.exec('BEGIN IMMEDIATE');
      if (checkCapacity) assertPhysicalCapacity(connection, files.root, capacity ?? readCapacity(connection), ordinaryBytes, assignedWriteBytes);
      const result = synchronous(action(connection));
      guard(requireOwner);
      if (checkCapacity) assertPhysicalCapacity(connection, files.root, readCapacity(connection), 0, assignedWriteBytes);
      connection.exec('COMMIT');
      // A checkpoint failure cannot retract the FULL commit just acknowledged.
      try { connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { failed = true; }
      return result;
    } catch (error) {
      if (connection.isOpen && connection.isTransaction) {
        try { connection.exec('ROLLBACK'); } catch { failed = true; }
      }
      return databaseFailure(error);
    }
  };
  const database: SqliteDelegationDatabase = Object.freeze({
    assertCurrent: () => guard(),
    read<Value>(action: (database: DatabaseSync) => Value): Value {
      guard();
      let queryOnly = false;
      try {
        connection.exec('PRAGMA query_only=ON');
        queryOnly = true;
        const result = synchronous(action(connection));
        guard();
        return result;
      } catch (error) { return databaseFailure(error); }
      finally {
        if (queryOnly) {
          try { connection.exec('PRAGMA query_only=OFF'); }
          catch (error) { failed = true; sqliteFailure(error); }
        }
      }
    },
    ordinaryTransaction<Value>(bytes: number, action: (database: DatabaseSync) => Value): Value { return transaction(bytes, 0, action); },
    retainProducer() {
      guard();
      producers += 1;
      let retained = true;
      return () => { if (retained) { retained = false; producers -= 1; } };
    },
  });
  return {
    database,
    domainTransaction<Value>(action: (database: DatabaseSync) => Value): Value { return transaction(0, 0, action, undefined, true, false); },
    assertCapacity(database: DatabaseSync, capacity: DelegationStoreCapacity, ordinaryBytes: number, assignedWriteBytes: number): void {
      assertPhysicalCapacity(database, files.root, capacity, ordinaryBytes, assignedWriteBytes);
    },
    assertCurrent: () => guard(),
    currentOwner: () => owner,
    acquireOwner(): DelegationOwnerToken {
      guard(false);
      if (owner) fail('owner_lost', 'This reference handle already has an acquired owner.');
      const token = transaction(0, 4_096, (db) => {
        const row = db.prepare('SELECT owner_epoch FROM delegation_state WHERE singleton=1').get();
        const token = parseDelegationOwnerToken({ storeId, epoch: Number(row?.owner_epoch) + 1, nonce: randomUUID() });
        db.prepare('UPDATE delegation_state SET owner_epoch=?,owner_nonce=? WHERE singleton=1').run(token.epoch, token.nonce);
        return token;
      }, undefined, false);
      owner = token;
      acquired = true;
      return token;
    },
    closeUnused(): void {
      if (acquired || producers !== 0) fail('owner_lost', 'An acquired reference owner must be released after coordinator quiescence.');
      if (closed) return;
      if (connection.isOpen) connection.close();
      ownership.release();
      closed = true;
    },
    releaseOwner(token: DelegationOwnerToken): void {
      if (!owner || token.storeId !== owner.storeId || token.epoch !== owner.epoch || token.nonce !== owner.nonce) {
        fail('owner_lost', 'The reference release token is stale.');
      }
      if (producers !== 0 || (connection.isOpen && connection.isTransaction)) fail('recovery_required', 'Live reference producers still retain local ownership.');
      if (connection.isOpen) connection.close();
      ownership.release();
      closed = true;
      owner = undefined;
    },
  };
}

export type ReferenceDatabase = ReturnType<typeof createReferenceDatabase>;
