// ------------------------------------------------------------------------------------------------
//                requestHistory.ts - Independent raw SQLite history and format evidence
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatThreeFixture } from './migration/materialize.js';

function rows(database: DatabaseSync, sql: string, ...values: string[]) {
  return database.prepare(sql).all(...values).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value])));
}

export function rawRequestHistory(database: DatabaseSync, operationId: string, runId: string) {
  const operation = database.prepare('SELECT data_blob FROM delegation_operations WHERE operation_id=?').get(operationId)?.data_blob;
  assert.ok(operation instanceof Uint8Array);
  const state = database.prepare('SELECT store_id,owner_epoch,owner_nonce,limits_json FROM delegation_state WHERE singleton=1').get();
  assert.ok(state);
  const pendingRun = database.prepare('SELECT phase,unsettled FROM delegation_runs WHERE run_id=?').get(runId);
  assert.ok(pendingRun);
  return { format: Number(database.prepare('PRAGMA user_version').get()?.user_version), state: { ...state },
    schema: rows(database, "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
    operationBlob: Buffer.from(operation).toString('hex'), pendingRun: { ...pendingRun },
    historical: formatThreeFixture.ids.map((id) => ({
      runs: rows(database, 'SELECT * FROM delegation_runs WHERE run_id=?', id.runId),
      tasks: rows(database, 'SELECT * FROM delegation_tasks WHERE task_id=?', id.taskId),
      inputs: rows(database, 'SELECT * FROM delegation_inputs WHERE run_id=?', id.runId),
      operations: rows(database, 'SELECT * FROM delegation_operations WHERE run_id=? ORDER BY operation_id', id.runId),
      critical: rows(database, 'SELECT * FROM delegation_critical WHERE run_id=? ORDER BY kind', id.runId),
      observations: rows(database, 'SELECT * FROM delegation_observations WHERE run_id=? ORDER BY observation_index', id.runId),
      notifications: rows(database, 'SELECT * FROM delegation_notifications WHERE run_id=?', id.runId),
    })) };
}

export function inspectRequestHistory(root: string, operationId: string, runId: string) {
  const database = new DatabaseSync(join(root, 'database/task.sqlite'), { readOnly: true });
  try { return rawRequestHistory(database, operationId, runId); } finally { database.close(); }
}

export type RawRequestHistory = ReturnType<typeof rawRequestHistory>;

export function assertRetainedRequestHistory(current: RawRequestHistory, previous: RawRequestHistory) {
  assert.equal(current.format, 3);
  assert.deepEqual(current.schema, previous.schema, 'Opening and recovery must not migrate the exact format-three layout.');
  assert.equal(current.operationBlob, previous.operationBlob, 'The padded accepted-answer operation slot must remain byte-identical.');
  assert.deepEqual(current.historical, previous.historical, 'Original V10 settled slots, receipt bytes, inputs and observations must remain byte-identical.');
  const { owner_epoch: _currentEpoch, owner_nonce: _currentNonce, ...currentState } = current.state;
  const { owner_epoch: _previousEpoch, owner_nonce: _previousNonce, ...previousState } = previous.state;
  assert.deepEqual(currentState, previousState, 'Store identity and configured limits must not change with ownership.');
}
