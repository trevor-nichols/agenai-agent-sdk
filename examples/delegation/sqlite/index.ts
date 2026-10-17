// ------------------------------------------------------------------------------------------------
//                index.ts - Explicit local SQLite reference store construction
// ------------------------------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import type { DelegationLimits, DelegationOwnerToken, DelegationStore, DelegationStoreCommand,
  DelegationStoreReadInput, DelegationStoreScanInput } from '@agen-ai/agent-orchestration';
import { createReferenceCommit } from './commit.js';
import { createReferenceDatabase, type SqliteDelegationDatabase } from './database.js';
import { sqliteFailure } from './errors.js';
import { prepareReferenceFiles } from './filesystem.js';
import { acquireReferenceOwnership } from './ownership.js';
import { createReferenceReads } from './read.js';
import { initializeSchema, type SqliteInboxSchema } from './schema.js';

export type { SqliteDelegationDatabase } from './database.js';
export type { SqliteInboxSchema } from './schema.js';

export interface SqliteDelegationStoreHandle {
  readonly store: DelegationStore;
  readonly database: SqliteDelegationDatabase;
  assertCurrent(): void;
  closeUnused(): void;
}

/** Explicitly opens the qualified local reference. Importing this module performs no I/O. */
export function openSqliteDelegationStore(options: {
  readonly root: string;
  readonly limits?: Partial<DelegationLimits>;
  readonly inboxSchema?: SqliteInboxSchema;
}): SqliteDelegationStoreHandle {
  const files = prepareReferenceFiles(options.root);
  const ownership = acquireReferenceOwnership(files);
  let connection: DatabaseSync | undefined;
  try {
    connection = new DatabaseSync(files.taskPath, { allowExtension: false, timeout: 0, enableForeignKeyConstraints: true });
    const { storeId, limits } = initializeSchema(connection, files.initial, options.limits, options.inboxSchema);
    files.captureAuxiliary();
    const reference = createReferenceDatabase(connection, files, ownership, storeId);
    const reads = createReferenceReads(reference, storeId, limits);
    const commit = createReferenceCommit(reference, storeId, limits);
    const store: DelegationStore = Object.freeze({
      contractVersion: 4, persistence: 'durable', storeId, limits,
      async acquireOwner() { return reference.acquireOwner(); },
      async releaseOwner(owner: DelegationOwnerToken) { reference.releaseOwner(owner); },
      async commit(command: DelegationStoreCommand) { return commit(command); },
      async read(input: DelegationStoreReadInput) { return reads.read(input); },
      async scan(input: DelegationStoreScanInput) { return reads.scan(input); },
    });
    return Object.freeze({ store, database: reference.database, assertCurrent: reference.assertCurrent, closeUnused: reference.closeUnused });
  } catch (error) {
    if (connection?.isOpen) connection.close();
    ownership.release();
    return sqliteFailure(error);
  }
}
