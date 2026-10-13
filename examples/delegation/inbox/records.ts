import { parseDelegationCompletionEnvelope, parseDelegationParentScope } from '@agen-ai/agent-orchestration';
import type { DelegationParentScope } from '@agen-ai/agent-orchestration';
import type { SQLOutputValue } from 'node:sqlite';
import type { ParentInboxState, ParentInboxView } from './types.js';

type Row = Record<string, SQLOutputValue>;
const states: ReadonlySet<string> = new Set(['pending', 'dispatch_intended', 'acknowledged', 'recovery_required', 'dismissed']);

export function parentKey(parent: DelegationParentScope): string {
  const parsed = parseDelegationParentScope(parent);
  return JSON.stringify([parsed.parentId, parsed.scopeId]);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error('The reference parent inbox record is invalid.');
  return value;
}

export function readInboxRow(row: Row): ParentInboxView {
  const encoded = text(row, 'envelope');
  if (Buffer.byteLength(encoded) > 12_288) throw new Error('The reference parent inbox record exceeds its bound.');
  const envelope = parseDelegationCompletionEnvelope(JSON.parse(encoded));
  const state = text(row, 'state');
  if (!states.has(state) || row.store_id !== envelope.storeId || row.notification_id !== envelope.notificationId
    || row.parent_key !== parentKey(envelope.parent) || row.parent_revision !== envelope.parent.revision || row.policy !== envelope.policy) {
    throw new Error('The reference parent inbox record identity is invalid.');
  }
  return Object.freeze({
    inboxId: text(row, 'inbox_id'), envelope, acceptedAt: text(row, 'accepted_at'), state: state as ParentInboxState,
    ...(row.dispatch_id === null ? {} : { dispatchId: text(row, 'dispatch_id') }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: text(row, 'dispatched_at') }),
    ...(row.settled_at === null ? {} : { settledAt: text(row, 'settled_at') }),
    ...(row.reason === null ? {} : { reason: text(row, 'reason') }),
  });
}
