// ------------------------------------------------------------------------------------------------
//                read.ts - Indexed keyset reads without retained SQLite cursors
// ------------------------------------------------------------------------------------------------

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  DelegationLimits, DelegationOperationRecord, DelegationPage, DelegationStoreReadInput, DelegationStoreReadPage,
  DelegationStoreScanInput, DelegationStoreScanPage, DelegationTargetReference, DelegationTaskObservation,
} from '@agen-ai/agent-orchestration';
import { delegationCursorPrefix, delegationDataBytes, parseDelegationPageCursor,
  parseDelegationStoreReadInput, parseDelegationStoreScanInput, summarizeDelegationRun } from '@agen-ai/agent-orchestration/store-adapter';
import { readCapacity } from './capacity.js';
import type { ReferenceDatabase } from './database.js';
import { fail } from './errors.js';
import { finalSlot, immutable, readNotification, readOperation, readRun, readTask } from './records.js';

export function createReferenceReads(reference: ReferenceDatabase, storeId: string, limits: DelegationLimits) {
  const page = <Row, Value>(query: unknown, rows: readonly Row[], key: (row: Row) => string, load: (row: Row) => Value,
    limit: number, envelopeBytes = 0): DelegationPage<Value> => {
    const items: Value[] = [];
    let bytes = envelopeBytes + 512;
    let hasMore = false;
    for (const row of rows) {
      if (items.length === limit) { hasMore = true; break; }
      const value = load(row);
      const size = delegationDataBytes(value) + 1;
      if (bytes + size > limits.maxPageBytes) {
        if (items.length === 0) fail('capacity_exceeded', 'A complete reference record exceeds this read page budget.');
        hasMore = true;
        break;
      }
      items.push(value);
      bytes += size;
    }
    return { items, ...(hasMore ? { cursor: `${delegationCursorPrefix(storeId, query)}${key(rows[items.length - 1]!)}` } : {}) };
  };
  const numericAfter = (after: string | undefined): number => {
    if (after === undefined) return 0;
    const value = Number(after.slice(0, 16));
    if (!/^\d{16}(?::[a-f0-9-]{36})?$/u.test(after) || !Number.isSafeInteger(value)) fail('stale_revision', 'The reference numeric cursor is invalid.');
    return value;
  };
  const runAfter = (after: string | undefined): readonly SQLInputValue[] => {
    if (after === undefined) return ['', ''];
    const split = after.lastIndexOf(':');
    const at = after.slice(0, split), runId = after.slice(split + 1);
    if (!Number.isFinite(Date.parse(at)) || !/^[a-f0-9-]{36}$/u.test(runId)) fail('stale_revision', 'The reference run cursor is invalid.');
    return [at, runId];
  };
  return {
    read(raw: DelegationStoreReadInput): DelegationStoreReadPage {
      const input = parseDelegationStoreReadInput(raw);
      const limit = Math.min('limit' in input ? input.limit ?? limits.maxPageRecords : limits.maxPageRecords, limits.maxPageRecords);
      return reference.database.read((db) => {
        let result: DelegationStoreReadPage;
        switch (input.kind) {
          case 'capacity': result = { kind: input.kind, capacity: readCapacity(db) }; break;
          case 'run': {
            const run = readRun(db, input.runId);
            result = { kind: input.kind, ...(run?.taskId === input.taskId ? { run } : {}) }; break;
          }
          case 'task': {
            const task = readTask(db, input.taskId);
            const query = { kind: input.kind, taskId: input.taskId };
            const after = numericAfter(parseDelegationPageCursor(storeId, query, input.cursor));
            const rows = db.prepare('SELECT run_id,ordinal FROM delegation_runs WHERE task_id=? AND ordinal>? ORDER BY ordinal,run_id LIMIT ?').all(input.taskId, after, limit + 1);
            result = { kind: input.kind, ...(task ? { view: { task, runs: page(query, rows,
              (row) => `${String(row.ordinal).padStart(16, '0')}:${row.run_id}`, (row) => summarizeDelegationRun(readRun(db, String(row.run_id))!), limit, delegationDataBytes(task)) } } : {}) }; break;
          }
          case 'operation': {
            const operation = readOperation(db, input.parent.parentId, input.parent.scopeId, input.operationId);
            result = { kind: input.kind, ...(operation ? { operation } : {}) }; break;
          }
          case 'operations': {
            const task = readTask(db, input.taskId);
            const query = { kind: input.kind, taskId: input.taskId, runId: input.runId };
            const after = parseDelegationPageCursor(storeId, query, input.cursor) ?? '';
            const rows = db.prepare('SELECT operation_id FROM delegation_operations WHERE run_id=? AND operation_id>? UNION ALL SELECT operation_id FROM delegation_critical WHERE run_id=? AND operation_id>? ORDER BY operation_id LIMIT ?')
              .all(input.runId, after, input.runId, after, limit + 1);
            const run = finalSlot(db, input.runId)?.run;
            result = { kind: input.kind, page: page(query, run?.taskId === input.taskId && task ? rows : [],
              (row) => String(row.operation_id), (row) => readOperation(db, task!.parent.parentId, task!.parent.scopeId, String(row.operation_id)) as DelegationOperationRecord, limit) }; break;
          }
          case 'observations': {
            const query = { kind: input.kind, taskId: input.taskId, runId: input.runId };
            const after = numericAfter(parseDelegationPageCursor(storeId, query, input.cursor));
            const slot = finalSlot(db, input.runId);
            const found = slot?.run.taskId === input.taskId;
            const rows = found ? db.prepare('SELECT data_json FROM delegation_observations WHERE run_id=? AND observation_index>? ORDER BY observation_index LIMIT ?')
              .all(input.runId, after, limit + 1).map((row) => JSON.parse(String(row.data_json)) as DelegationTaskObservation) : [];
            if (found && slot.omission && slot.omission.index > after) rows.push(slot.omission);
            rows.sort((left, right) => left.index - right.index);
            result = { kind: input.kind, page: page(query, rows, (row) => String(row.index).padStart(16, '0'), (row) => row, limit),
              latestIndex: found ? slot.run.observationIndex : 0, gap: found ? slot.run.omittedObservations > 0 : false }; break;
          }
          case 'notification': {
            const notification = readNotification(db, input.notificationId);
            result = { kind: input.kind, ...(notification ? { notification } : {}) }; break;
          }
          case 'ceiling': {
            const query = { kind: input.kind, ceilingId: input.ceilingId };
            const after = parseDelegationPageCursor(storeId, query, input.cursor) ?? '';
            const origin = db.prepare('SELECT origin_json FROM delegation_ceilings WHERE ceiling_id=?').get(input.ceilingId);
            const rows = db.prepare('SELECT target_key,data_json FROM delegation_ceiling_targets WHERE ceiling_id=? AND target_key>? ORDER BY target_key LIMIT ?')
              .all(input.ceilingId, after, limit + 1);
            result = { kind: input.kind, ceilingId: input.ceilingId, ...(origin ? { origin: JSON.parse(String(origin.origin_json)) } : {}),
              page: page(query, rows, (row) => String(row.target_key), (row) => JSON.parse(String(row.data_json)) as DelegationTargetReference, limit, 512) }; break;
          }
        }
        return immutable(result);
      });
    },
    scan(raw: DelegationStoreScanInput): DelegationStoreScanPage {
      const input = parseDelegationStoreScanInput(raw);
      const query = { kind: input.kind };
      const after = parseDelegationPageCursor(storeId, query, input.cursor);
      const limit = Math.min(input.limit ?? limits.maxPageRecords, limits.maxPageRecords);
      return reference.database.read((db: DatabaseSync): DelegationStoreScanPage => {
        if (input.kind === 'eligible_notifications') {
          const rows = db.prepare("SELECT notification_id FROM delegation_notifications WHERE candidate=1 AND notification_id>? AND (state='pending' OR state='claimed' AND owner_epoch<>?) ORDER BY notification_id LIMIT ?")
            .all(after ?? '', reference.currentOwner()!.epoch, limit + 1);
          return immutable({ kind: input.kind, page: page(query, rows, (row) => String(row.notification_id), (row) => readNotification(db, String(row.notification_id))!, limit) });
        }
        const rows = input.kind === 'queued'
          ? db.prepare("SELECT run_id,created_at FROM delegation_runs WHERE phase='queued' AND (created_at,run_id)>(?,?) ORDER BY created_at,run_id LIMIT ?").all(...runAfter(after), limit + 1)
          : db.prepare('SELECT run_id,created_at FROM delegation_runs WHERE unsettled=1 AND owner_epoch<>? AND (created_at,run_id)>(?,?) ORDER BY created_at,run_id LIMIT ?')
            .all(reference.currentOwner()!.epoch, ...runAfter(after), limit + 1);
        return immutable({ kind: input.kind, page: page(query, rows, (row) => `${row.created_at}:${row.run_id}`, (row) => readRun(db, String(row.run_id))!, limit) });
      });
    },
  };
}
