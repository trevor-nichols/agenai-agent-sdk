// ------------------------------------------------------------------------------------------------
//                records.ts - Bounded normalized domain records and assigned slot encoding
// ------------------------------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import {
  parseDelegationNotificationRecord, parseDelegationPolicyCeiling, parseDelegationRunRecord, parseDelegationTaskRecord,
  type DelegationNotificationRecord, type DelegationOperationRecord, type DelegationPolicyCeiling,
  type DelegationRunRecord, type DelegationRunSummary, type DelegationTaskObservation, type DelegationTaskRecord,
} from '@agen-ai/agent-orchestration';
import { delegationCanonicalJson } from '@agen-ai/agent-orchestration/store-adapter';
import { fail } from './errors.js';

export const CRITICAL_COLUMNS = { cancel: 'cancel_blob', interrupt: 'interrupt_blob', session_close: 'session_close_blob', binding_cleanup: 'binding_cleanup_blob' } as const;
export type CriticalKind = keyof typeof CRITICAL_COLUMNS;
export interface FinalSlot {
  readonly run: DelegationRunSummary;
  readonly task?: DelegationTaskRecord;
  readonly notification?: DelegationNotificationRecord;
  readonly omission?: DelegationTaskObservation;
}

export function immutable<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function encodeSlot(value: unknown, bytes: number): Buffer {
  const encoded = Buffer.from(delegationCanonicalJson(value), 'utf8');
  if (encoded.length > bytes) fail('capacity_exceeded', 'The domain mutation exceeds its physically assigned reference slot.');
  const result = Buffer.alloc(bytes, 0x20);
  encoded.copy(result);
  return result;
}

export function decodeSlot<Value>(input: unknown, bytes: number): Value | undefined {
  if (!(input instanceof Uint8Array) || input.byteLength !== bytes) fail('store_failed', 'A reserved reference slot has an invalid physical size.');
  const buffer = Buffer.from(input);
  if (buffer[0] === 0) return undefined;
  const value = JSON.parse(buffer.toString('utf8')) as Value;
  delegationCanonicalJson(value);
  return value;
}

export function finalSlot(database: DatabaseSync, runId: string): FinalSlot | undefined {
  const row = database.prepare('SELECT final_blob FROM delegation_runs WHERE run_id=?').get(runId);
  return row ? decodeSlot<FinalSlot>(row.final_blob, 32_768) : undefined;
}

export function readTask(database: DatabaseSync, taskId: string): DelegationTaskRecord | undefined {
  const row = database.prepare('SELECT head_run_id FROM delegation_tasks WHERE task_id=?').get(taskId);
  if (!row) return undefined;
  const slot = finalSlot(database, String(row.head_run_id));
  if (!slot?.task || slot.task.taskId !== taskId) fail('store_failed', 'The canonical task head is unavailable.');
  return parseDelegationTaskRecord(slot.task);
}

export function readRun(database: DatabaseSync, runId: string): DelegationRunRecord | undefined {
  const slot = finalSlot(database, runId);
  if (!slot) return undefined;
  const input = database.prepare('SELECT input_json FROM delegation_inputs WHERE run_id=?').get(runId);
  if (!input || typeof input.input_json !== 'string') fail('store_failed', 'An immutable admitted input is unavailable.');
  return parseDelegationRunRecord({ ...slot.run, input: JSON.parse(input.input_json) });
}

export function readCritical(database: DatabaseSync, runId: string): readonly DelegationOperationRecord[] {
  const row = database.prepare('SELECT cancel_blob,interrupt_blob,session_close_blob,binding_cleanup_blob FROM delegation_runs WHERE run_id=?').get(runId);
  return row ? Object.values(CRITICAL_COLUMNS).flatMap((column) => {
    const record = decodeSlot<DelegationOperationRecord>(row[column], 2_048);
    return record ? [record] : [];
  }) : [];
}

export function readOperation(database: DatabaseSync, parentId: string, scopeId: string, operationId: string): DelegationOperationRecord | undefined {
  const ordinary = database.prepare('SELECT data_blob FROM delegation_operations WHERE parent_id=? AND scope_id=? AND operation_id=?').get(parentId, scopeId, operationId);
  if (ordinary) return decodeSlot<DelegationOperationRecord>(ordinary.data_blob, 2_048);
  const critical = database.prepare('SELECT run_id,kind FROM delegation_critical WHERE parent_id=? AND scope_id=? AND operation_id=?').get(parentId, scopeId, operationId);
  return critical ? readCritical(database, String(critical.run_id)).find((record) => record.kind === critical.kind) : undefined;
}

export function readNotification(database: DatabaseSync, notificationId: string): DelegationNotificationRecord | undefined {
  const row = database.prepare('SELECT run_id FROM delegation_notifications WHERE notification_id=?').get(notificationId);
  const value = row ? finalSlot(database, String(row.run_id))?.notification : undefined;
  return value ? parseDelegationNotificationRecord(value) : undefined;
}

export function readCeiling(database: DatabaseSync, ceilingId: string): DelegationPolicyCeiling | undefined {
  const row = database.prepare('SELECT data_json FROM delegation_ceilings WHERE ceiling_id=?').get(ceilingId);
  return row ? parseDelegationPolicyCeiling(JSON.parse(String(row.data_json))) : undefined;
}
